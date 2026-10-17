<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import ContentNotice from '../../components/ContentNotice.vue'
import LoadingBar from '../../components/LoadingBar.vue'
import { useContentTranslation } from '../../lib/content'
import { fitClass } from '../../lib/fit'
import HopList from '../../components/HopList.vue'
import HomePill from '../../components/HomePill.vue'
import { auditGroupsOf, fetchHcDetail, fetchItemDetail, relatedOf } from '../../lib/data'
import { enableShare, shareQuery } from '../../lib/share'
import { findParentItem, mergeAtNote, resolveGuide } from '../../lib/guide'
import { auditRuleText, categoryLabel, drugKindText, hcKindText, localeClass, payLabel, pharmacopoeiaText, t } from '../../lib/i18n'
import { loadItemSpecs, type NhcSpecItem } from '../../lib/nhcSpec'
import { mpCatalogItem, mpKgItemSymptoms, mpPharmacopoeia, type KgItemSymptoms, type PharmacopoeiaHit } from '../../lib/api'
import { decorateHistory, drawerPrice, historyTitle, levelLabel, priceText, sortHistory } from '../../lib/price'
import { hospitalLevel } from '../../lib/session'
import { catalogCached, catalogReady } from '../../lib/store'
import { catalogBar } from '../../lib/progress'
import { routeValue } from '../../lib/route'
import { applyChrome, themeMode } from '../../lib/theme'
import {
  currentPriceOf,
  currentUseHint,
  isEffectivelyStopped,
  isUpcoming,
  isUpcomingExecute,
  laterDateText,
  nextPriceOf,
  priceByLevel,
} from '../../lib/status'
import { isConsumable, isDrug, isLimitedDrug, type AuditGroup, type HcDetail, type HcLink, type HcVariant, type ItemDetail, type SearchItem } from '../../lib/types'

const item = ref<SearchItem | null>(null)
const { ct } = useContentTranslation(true)

// 相关症状：只对实验室诊断项目取。拿不到就不显示，不影响详情其余部分。
const kgSymptoms = ref<KgItemSymptoms | null>(null)
const KG_TIER_TAG: Record<string, string> = { category: '同类推断', curated: '人工整理' }
const kgTierTag = computed(() => KG_TIER_TAG[kgSymptoms.value?.tier || ''] || '')
watch(
  () => (item.value && item.value.cat1 === '实验室诊断' ? item.value.id : ''),
  (id) => {
    kgSymptoms.value = null
    if (!id) return
    mpKgItemSymptoms(id)
      .then((res) => {
        if (item.value && item.value.id === id && res.found && res.symptoms && res.symptoms.length) kgSymptoms.value = res
      })
      .catch(() => {})
  },
  { immediate: true },
)
function openSymptom(word: string) {
  uni.navigateTo({ url: `/pages/symptom/symptom?q=${encodeURIComponent(word)}` })
}
const detail = ref<ItemDetail | null>(null)
const parent = ref<SearchItem | null>(null)
const parentDetail = ref<ItemDetail | null>(null)
const hops = ref<Array<{ item: SearchItem; rel: string }>>([])
const byNameMap = shallowRef(new Map<string, SearchItem>())
const byIdMap = shallowRef(new Map<string, SearchItem>())
const error = ref('')
// 目录已经在本页/列表页载入时，条目本身（名称、价格、关联）是现成的，
// 只有内涵说明要走网络。这两件事分开记，详见模板开头。
const detailError = ref('')
const loading = ref(true)
const requestedId = ref('')
const requestedDrug = ref('')
const catalogWarnings = ref(false)
const mergeOpen = ref(false)
const histOpen = ref(false)
/** 本条目对应的技术规范（定价的上游）。多条时直接在本页列出，逐条进规范页。 */
const specCodes = ref<string[]>([])
const specRows = ref<NhcSpecItem[]>([])
/** 药品在《中国药典》2025年版里的出处。药典库在服务端，按药品名单条问。 */
const pharmaHits = ref<PharmacopoeiaHit[]>([])
/** 耗材明细（规格、价格、版本沿革）另走一个分片；服务项目和药品这边一直是空的。 */
const hcDetail = ref<HcDetail | null>(null)
/** 耗材分片里那几个长列表的展开状态，键是区块名。 */
const hcOpen = ref<Record<string, boolean>>({})
/** 医保智能审核规则原文，只服务项目用。 */
const auditLinks = shallowRef<HcLink[]>([])
const auditOpen = ref(false)

/** 标题太长就降一档字号，和卡片同一个分档（见 lib/fit.ts），但缩得少一点。 */
const nameFit = computed(() => (item.value ? fitClass(ct(item.value.name)) : ''))
const drug = computed(() => isDrug(item.value))
const consumable = computed(() => isConsumable(item.value))
const guide = computed(() => {
  if (!item.value) return null
  return resolveGuide(item.value, detail.value, parent.value, parentDetail.value)
})

const stopped = computed(() => (item.value ? isEffectivelyStopped(item.value) : false))
const upcoming = computed(() => (item.value ? isUpcoming(item.value) : false))
const pending = computed(() => (item.value ? isUpcomingExecute(item.value) : false))
const note = computed(() => detail.value?.priceNote || '')
/** 类别级「使用说明」。目录里是按大类给的（旧章有「本章说明」、整合类有「使用说明」），
 *  不是每条项目都有，所以有才显示、没有不占位。 */
const usageNote = computed(() => (item.value?.usageNote || '').trim())
/** 超过 5 行才折起：短说明（如眼科类那条）直接看全，不摆一个没必要的「展开」。 */
const usageLong = computed(() => usageNote.value.length > 180)
const usageOpen = ref(false)

/**
 * 挂网产品的价格口径。
 * priceNote 是「挂网价：企业申报…（共 N 个规格，其中 M 个填了这项）」，中文整句没法翻，
 * 所以这里从 variants 重算同样的两个数 —— 实测 143/143 个注册证的 (N, M) 都和原文一致。
 */
const hcPriceLabel = computed(() => item.value?.hcPriceLabel || '')
const hcFilled = computed(() => {
  const rows = hcDetail.value?.variants || []
  const label = hcPriceLabel.value
  return { total: rows.length, filled: rows.filter((row) => row.price && row.priceLabel === label).length }
})
/** 同一个注册证下各规格的价格口径不一样时，只在有出入时才提一句。 */
const hcMixedLabels = computed(() => {
  const labels = new Set<string>()
  ;(hcDetail.value?.variants || []).forEach((row) => {
    if (row.price) labels.add(row.priceLabel)
  })
  return labels.size > 1
})
/** 企业：挂网产品的分片里是列表，带量采购只有条目上那一个，取到哪个用哪个。 */
const hcMakers = computed(() => {
  const rows = hcDetail.value?.makers || []
  if (rows.length) return rows
  return item.value?.hcMaker ? [item.value.hcMaker] : []
})
const hcSellers = computed(() => {
  const rows = hcDetail.value?.sellers || []
  if (rows.length) return rows
  return item.value?.hcSeller ? [item.value.hcSeller] : []
})
/** 分片还没到时上面几个都是空的，模板里一律走这几个常量视图，省去满页的 ?. 和 || []。 */
const hcVersionRows = computed(() => hcDetail.value?.history || [])
const hcSpecRows = computed(() => hcDetail.value?.specs || [])
const hcVariantRows = computed(() => hcDetail.value?.variants || [])
const hcCodeRows = computed(() => hcDetail.value?.codes || [])
const hcLotSpecRows = computed(() => hcDetail.value?.lotSpecs || [])
const hcAreas = computed(() => hcDetail.value?.area || [])
/** 挂网产品一行规格下面的小字：单位、批次、公布日期、耗材编码，有哪个写哪个。 */
function hcVariantMeta(row: HcVariant): string {
  const bits = [row.unit]
  if (row.batch) bits.push(t('hc.detail.batchNo', { batch: row.batch }))
  if (row.noticedAt) bits.push(t('hc.detail.noticedAt', { date: row.noticedAt }))
  if (row.code) bits.push(row.code)
  return bits.filter(Boolean).join(' · ')
}

/** 医保智能审核规则：只有收费项目会被命中，一个项目最多 210 条（腹腔镜辅助操作）。 */
const auditGroups = computed<AuditGroup[]>(() => {
  if (!item.value || drug.value || consumable.value) return []
  return auditGroupsOf(item.value.id, auditLinks.value)
})
const auditCount = computed(() => {
  let n = 0
  auditGroups.value.forEach((group) => {
    n += group.rows.length
  })
  return n
})
/** 单边记录的条数：这些涉及的项目在现行目录里查不到编码，只能列出来、点不进去。 */
const auditOneSided = computed(() => {
  let n = 0
  auditGroups.value.forEach((group) => {
    group.rows.forEach((row) => {
      if (!auditName(row.otherId)) n += 1
    })
  })
  return n
})
const AUDIT_GROUPS = 3
const AUDIT_ROWS = 5
const auditShownGroups = computed(() => (auditOpen.value ? auditGroups.value : auditGroups.value.slice(0, AUDIT_GROUPS)))
const auditRestGroups = computed(() => (auditOpen.value ? 0 : Math.max(0, auditGroups.value.length - AUDIT_GROUPS)))

/** 长列表按区块名折叠：耗材的规格、编码动辄几十上百条，一次全铺会把页面撑得很长。 */
function hcShown<T>(rows: T[], key: string, limit: number): T[] {
  return hcOpen.value[key] || rows.length <= limit ? rows : rows.slice(0, limit)
}
/** 折叠按钮上的字：没超出一屏就是空串，按钮不画；展开了就写「收起」。 */
function hcMore(rows: unknown[], key: string, limit: number): string {
  if (rows.length <= limit) return ''
  return hcOpen.value[key] ? t('hc.detail.less') : t('hc.detail.more', { count: rows.length - limit })
}
function hcToggle(key: string) {
  const next: Record<string, boolean> = {}
  Object.keys(hcOpen.value).forEach((k) => { next[k] = hcOpen.value[k] })
  next[key] = !next[key]
  hcOpen.value = next
}
function auditRows(group: AuditGroup) {
  return auditOpen.value ? group.rows : group.rows.slice(0, AUDIT_ROWS)
}
function auditRowRest(group: AuditGroup) {
  return auditOpen.value ? 0 : Math.max(0, group.rows.length - AUDIT_ROWS)
}

const livePrice = computed(() => {
  if (!item.value) return ''
  return pending.value ? nextPriceOf(item.value, hospitalLevel.value) : currentPriceOf(item.value, hospitalLevel.value)
})

const nowUse = computed(() => (item.value && pending.value ? currentUseHint(item.value) : []))

const mergeNames = computed(() => {
  const names = item.value?.mergeFrom || []
  if (mergeOpen.value || names.length <= 8) return names
  return names.slice(0, 6)
})

const historyRows = computed(() => {
  if (!item.value || !detail.value?.history?.length) return { shown: [], extra: 0 }
  const decorated = decorateHistory(detail.value.history, item.value, (name) => byNameMap.value.get(name))
  const originals = decorated.filter((row) => row.event.startsWith('原'))
  const mains = decorated.filter((row) => !row.event.startsWith('原'))
  const shownOriginals = histOpen.value || originals.length <= 4 ? originals : originals.slice(0, 3)
  return {
    shown: sortHistory([...mains, ...shownOriginals]),
    extra: originals.length > 4 && !histOpen.value ? originals.length - 3 : 0,
  }
})

function findByName(name: string) {
  return byNameMap.value.get(name)
}

function findById(id: string) {
  return byIdMap.value.get(id)
}

/** 审核规则里对面那一条的名称。单边记录（b 为空）和查不到编码的都返回空串。 */
function auditName(id: string): string {
  const hit = findById(id)
  return hit ? hit.name : ''
}

function successorNote(id: string, stopAt: string) {
  const hit = findById(id)
  if (!hit) return ''
  return ` · ${t('result.fromDate', { date: laterDateText(stopAt) })} ${priceText(priceByLevel(hit, hospitalLevel.value))}`
}

function nowUseNote(name: string) {
  const hit = findByName(name)
  if (!hit) return ''
  return `（${hit.code} · ${t('detail.currentUse')} ${priceText(currentPriceOf(hit, hospitalLevel.value))}）`
}

function detailUrl(target: SearchItem) {
  const key = isDrug(target) ? 'drug' : 'id'
  return `/pages/detail/detail?${key}=${encodeURIComponent(target.id)}`
}

function openByName(name: string) {
  const hit = findByName(name)
  if (hit) uni.redirectTo({ url: detailUrl(hit) })
}

function openItem(id: string) {
  const hit = findById(id)
  if (hit) uni.redirectTo({ url: detailUrl(hit) })
  else uni.redirectTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
}

function copyCode() {
  if (!item.value) return
  uni.setClipboardData({
    data: drug.value ? item.value.name : item.value.code || item.value.name,
    success: () => uni.showToast({ title: drug.value ? t('detail.copiedName') : t('detail.copiedCode'), icon: 'success' }),
  })
}

function copyText(text: string) {
  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ title: t('detail.copiedCode'), icon: 'success' }),
  })
}

function openGraph() {
  const cur = item.value
  if (!cur) return
  uni.navigateTo({ url: `/pages/graph/graph?id=${encodeURIComponent(cur.id)}` })
}

function openGuide() {
  const cur = item.value
  if (!cur) return
  uni.navigateTo({ url: `/pages/guide/guide?id=${encodeURIComponent(cur.id)}` })
}

/** 规范页一次只讲一条，所以多条时也直接进规范页，不绕道关联网络。 */
function openSpec(code: string) {
  uni.navigateTo({ url: `/pages/spec/spec?code=${encodeURIComponent(code)}` })
}

function openLabel() {
  const cur = item.value
  if (!cur) return
  uni.navigateTo({ url: `/pages/label/label?drug=${encodeURIComponent(cur.id)}` })
}

onShow(() => {
  applyChrome()
})

async function loadDetail() {
  loading.value = true
  error.value = ''
  detailError.value = ''
  const drugId = requestedDrug.value
  const id = requestedId.value
  // 结果变量声明在 try 外面：留在块里的话，压缩后可能和模块级引用（applyChrome 等）
  // 撞名，微信开发者工具降级 ES5 时提升成 var 会把上面的引用顶成 undefined。
  let found: SearchItem | undefined
  let detailTasks: Array<Promise<ItemDetail>> = []
  let details: ItemDetail[] = []
  let data: Awaited<ReturnType<typeof catalogReady>> | null = null
  let itemSpecs: Awaited<ReturnType<typeof loadItemSpecs>> | null = null
  let pharma: Awaited<ReturnType<typeof mpPharmacopoeia>> | null = null
  let preview: Awaited<ReturnType<typeof mpCatalogItem>> | null = null
  // 内涵分片、技术规范、药典出处这三件事只认「是哪一条」，不认整份目录。
  // 目录是好几兆，它们各自几十 KB，所以一知道条目就发出去、和目录同时在路上，
  // 不再排在 await catalogPromise 后面白等。声明同样留在 try 外面（见上一条）。
  let previewHit: SearchItem | undefined
  let pharmaName = ''
  let specsPromise: Promise<Awaited<ReturnType<typeof loadItemSpecs>>> | null = null
  let pharmaPromise: Promise<Awaited<ReturnType<typeof mpPharmacopoeia>> | null> | null = null
  let hcPromise: Promise<HcDetail> | null = null
  let firstDetail: Promise<ItemDetail> | null = null
  let parentItem: SearchItem | null = null
  try {
    // 目录还没下完时，先按 id 问服务端要这一条，把名称和价格画出来。
    // 整份目录是好几兆的包，点一条详情不该白等它全部到齐。
    // 关联、父项和审核规则仍要等目录，它们依赖整本关系表，不是这一条能给的。
    // 先把目录下载发起去，再决定要不要问这一条：目录已在内存里时不再多走一趟；
    // 没缓存时，这一条和整包同时在路上，哪条先到就先画哪条。
    const catalogPromise = catalogReady()
    const knownId = drugId || id
    // 目录已经在内存里（先在首页搜过）时不必多走这一趟；重试时条目已经在手上，同理。
    previewHit = item.value || undefined
    // knownId 为空说明路由上既没带 id 也没带 drug（分享链接被截断、或从历史里点了
    // 一条已经没了的记录）。以前这里照样发一趟 ?id=，服务端只能回 200 + 空，
    // 白等一个来回；线上日志里那两条 `GET /api/catalog-search?id= HTTP/1.1` 就是它。
    if (!previewHit && knownId && !catalogCached()) {
      try {
        preview = await mpCatalogItem(knownId)
      } catch {
        preview = null
      }
      previewHit = preview?.item || undefined
    }
    found = previewHit
    if (found && !(drugId && !isDrug(found))) {
      item.value = found
      // 条目一确定就把不依赖目录的几件事发出去，和整包下载并行。
      // 药品只有药典出处（说明书在 pages/label，没有分片、也没有技术规范链）；
      // 耗材有自己的一份分片；收费项目有内涵分片加技术规范链。
      if (isDrug(found)) {
        pharmaName = found.name
        pharmaPromise = mpPharmacopoeia([pharmaName]).catch(() => null)
      } else if (isConsumable(found)) {
        hcPromise = fetchHcDetail(found.id, found.hcKind || 'catalog')
      } else {
        firstDetail = fetchItemDetail(found.id)
        specsPromise = loadItemSpecs(found.id)
      }
    }
    data = await catalogPromise
    catalogWarnings.value = Boolean(data.warnings.length)
    byNameMap.value = data.byName
    byIdMap.value = data.byId
    found = drugId ? data.byId.get(drugId) : data.byId.get(id)
    if (!found || (drugId && !isDrug(found))) {
      error.value = t('detail.notFound')
      return
    }
    // 预览那一条和目录里的不是同一个对象（一条来自服务端单条，一条来自整包解出来），
    // 所以要换成目录里那条。名称要是跟着变了，按名字问的药典那一趟就白问了，重发一次。
    if (item.value !== found) item.value = found
    if (isDrug(found)) {
      if (!pharmaPromise || pharmaName !== found.name) {
        pharmaName = found.name
        pharmaPromise = mpPharmacopoeia([pharmaName]).catch(() => null)
      }
    } else {
      if (isConsumable(found)) {
        if (!hcPromise) hcPromise = fetchHcDetail(found.id, found.hcKind || 'catalog')
      } else {
        if (!firstDetail) firstDetail = fetchItemDetail(found.id)
        // 技术规范只挂在服务项目上，耗材那套分片里没有规范链，
        // 在这里发出去没人 await，纯属白发一趟。
        if (!specsPromise) specsPromise = loadItemSpecs(found.id)
      }
    }
    // 耗材的「分类相近」只连耗材，服务项目那条链上不会多出东西，所以三种条目
    // 都走这一份（目录关系 + 耗材分类），审核规则不进这里，它有自己的一块。
    hops.value = relatedOf(found, data.hopEdges, data.byId)
    // 药品只看名称、价格、限定支付范围和关联关系，这些目录里都是现成的。
    // 说明书改成点进去再看（pages/label），所以这里直接收工：
    // 不拉分片、也不去找「项目内涵」那一套（那是诊疗项目才有的）。
    // 药典出处是唯一多要的一块，问不到就空着，不挡页面。
    if (isDrug(found)) {
      try {
        pharma = await pharmaPromise
        pharmaHits.value = (pharma?.ok && pharma.byName[pharmaName]) || []
      } catch {
        pharmaHits.value = []
      }
      return
    }
    // 耗材走自己那套分片：规格、单价、版本沿革都在里面，没有「项目内涵」。
    if (isConsumable(found)) {
      hcDetail.value = await (hcPromise || fetchHcDetail(found.id, found.hcKind || 'catalog'))
      return
    }
    auditLinks.value = data.auditLinks
    parentItem = findParentItem(found, (code) => data.byCode.get(code), (name) => data.byName.get(name)) || null
    parent.value = parentItem
    detailTasks = []
    if (firstDetail) detailTasks.push(firstDetail)
    // 父项只有目录里才知道是谁，它那一份分片只能等这一步。
    if (parentItem) detailTasks.push(fetchItemDetail(parentItem.id))
    try {
      details = await Promise.all(detailTasks)
      detail.value = details[0]
      parentDetail.value = parentItem ? details[1] : null
    } catch (err) {
      // 只有内涵/调价历史这一块没拿到，上面的条目信息照常显示
      detailError.value = err instanceof Error ? err.message : t('detail.loadFail')
    }
    // 规范拿不到就不显示这个入口，不要摆一个点了没反应的角标。
    // loadItemSpecs 自己吞掉网络错误，返回空列表。
    itemSpecs = await specsPromise
    specCodes.value = itemSpecs.codes
    specRows.value = itemSpecs.specs
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('detail.loadFail')
  } finally {
    loading.value = false
  }
}

onLoad((query) => {
  applyChrome()
  enableShare()
  requestedDrug.value = routeValue(query?.drug)
  requestedId.value = routeValue(query?.id)
  void loadDetail()
})

/**
 * 分享标题带上现行价格：光一个项目名，对面不知道值不值得点开。
 * 药品不印价格（同一通用名下不同厂牌价差大，目录价是支付标准不是零售价），
 * 尚未执行的条目现在也没有可报的价，这两种都退回纯名字。
 */
const shareTitle = computed(() => {
  const cur = item.value
  if (!cur) return t('home.share')
  if (drug.value) return `${cur.name} · ${t('app.catalog')}`
  // 耗材的价是采购价（挂网价/企业报价/参考价），带上口径别让人当成医保支付标准。
  if (consumable.value) {
    if (!cur.hcPrice || !cur.hcPriceLabel) return `${cur.name} · ${t('app.catalog')}`
    return `${cur.name} ${cur.hcPrice}（${t(`hc.price.${cur.hcPriceLabel}`)}） · ${t('app.catalog')}`
  }
  const now = currentPriceOf(cur, hospitalLevel.value)
  const price = drawerPrice(now)
  if (!now || price === t('price.none')) return `${cur.name} · ${t('app.catalog')}`
  return `${cur.name} ${price}${cur.unit ? `/${cur.unit}` : ''} · ${t('app.catalog')}`
})

onShareAppMessage(() => ({
  title: shareTitle.value,
  path: item.value ? detailUrl(item.value) : '/pages/index/index',
}))

onShareTimeline(() => {
  const cur = item.value
  // id 和 drug 不能混：药品的 id 塞进 id= 会当成诊疗项目去找，落空成「未找到该项目」。
  const key = cur && isDrug(cur) ? 'drug' : 'id'
  return {
    title: shareTitle.value,
    query: cur ? shareQuery({ [key]: cur.id }) : '',
  }
})
</script>

<template>
  <view class="yb-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <HomePill />
    <ContentNotice />
    <!-- 条目信息（名称、价格、关联网络）在目录里就是现成的，先画出来；
         内涵和调价历史要另拉一个分片，由 GuideBlock 和下面的历史块各自显示载入中。
         所以这里只挡「还没有条目」，不挡「详情分片还没到」——否则点一条要白等一个来回。 -->
    <view v-if="!item && loading" class="muted pad">
      {{ t('detail.loading') }}
      <LoadingBar :percent="catalogBar" />
    </view>
    <view v-else-if="!item && error" class="muted pad">{{ error }}<button class="yb-btn is-ghost" @click="loadDetail">{{ t('audit.retry') }}</button></view>
    <view v-else-if="item && (drug || guide || consumable)" class="drawer-block yb-in">
      <view v-if="detailError || catalogWarnings" class="home-notice">{{ detailError ? t('detail.loadFail') : t('audit.partialCatalog') }}<button class="yb-btn is-ghost" :disabled="loading" @click="loadDetail">{{ t('audit.retry') }}</button></view>
      <view class="drawer-head">
        <view class="name" :class="[nameFit, { 'is-stopped': !drug && stopped }]"><text>{{ ct(item.name) }}</text><text v-if="isLimitedDrug(item)" class="limit-badge">{{ t('common.limitedShort') }}</text></view>
        <template v-if="drug">
          <view v-if="item.paid === false" class="banner banner-stop">
            <text class="t">{{ item.kind === 'excluded' ? t('result.fundExcluded') : t('result.commercial') }}</text>
            <text class="s">{{ t('detail.fundNoPay') }}</text>
          </view>
          <view v-if="item.special" class="banner banner-pending">
            <text class="t">{{ t('result.special') }}</text>
            <text class="s">{{ t('detail.specialManaged') }}</text>
          </view>
        </template>
        <template v-else-if="consumable">
          <view v-if="stopped" class="banner banner-stop">
            <text class="t">{{ t('hc.status.stopped') }}</text>
            <text class="s">{{ ct(item.remark) || t('detail.stoppedFallback') }}</text>
          </view>
          <view v-if="pending" class="banner banner-pending">
            <text class="t">{{ t('hc.status.pending') }}</text>
            <text class="s">{{ ct(item.remark) }}</text>
          </view>
          <!-- 耗材的价格不是「现行/未执行」那套：挂网价、企业报价、其他省份参考价
               都是采购价，报出来必须带口径。 -->
          <view v-if="item.hcPrice" class="hc-head-price">
            <text class="hc-price-label">{{ hcPriceLabel ? t(`hc.price.${hcPriceLabel}`) : '' }}</text>
            <text class="hc-price-value">{{ item.hcPrice }}</text>
          </view>
          <view v-if="item.hcPrice && item.hcPrice.indexOf('~') >= 0" class="current-price is-next">{{ t('hc.price.range') }}</view>
          <view v-else-if="!item.hcPrice && item.hcKind === 'product'" class="current-price">{{ t('hc.card.noPrice') }}</view>
          <view v-else-if="!item.hcPrice && item.hcKind === 'lot'" class="current-price">{{ t('hc.card.noLotPrice') }}</view>
          <view v-if="item.hcPrice && hcPriceLabel" class="muted">{{ t(`hc.price.warn.${hcPriceLabel}`) }}</view>
          <view v-if="hcPriceLabel && hcDetail" class="muted">{{ t('hc.price.filled', { total: hcFilled.total, filled: hcFilled.filled, label: t(`hc.price.${hcPriceLabel}`) }) }}</view>
          <view v-if="hcMixedLabels" class="muted">{{ t('hc.price.mixed') }}</view>
        </template>
        <template v-else>
          <view v-if="stopped" class="banner banner-stop">
            <text class="t">{{ t('detail.stoppedTitle') }}</text>
            <text class="s">{{ ct(item.stopAt) || t('detail.stoppedFallback') }}</text>
          </view>
          <view v-if="pending" class="banner banner-pending">
            <text class="t">{{ t('detail.pendingTitle') }}</text>
            <text class="s">{{ t('detail.pendingBody', { date: ct(item.executeAt) }) }}</text>
          </view>
          <view v-if="upcoming" class="banner banner-now">
            <text class="t">{{ t('detail.chargeNow') }}</text>
            <text class="s">{{ t('detail.upcomingBody', { merge: mergeAtNote(item, ct) }) }}</text>
          </view>
          <view v-if="item.merged && !pending" class="banner banner-merge">
            <text class="t">{{ t('detail.mergedTitle') }}</text>
            <text class="s">{{ t('detail.mergedBody') }}</text>
          </view>
          <view v-if="pending">
            <view class="price-blocked">{{ t('detail.nowBlocked') }}</view>
            <view class="current-price is-next">{{ t('detail.futurePrice', { date: ct(item.executeAt), price: drawerPrice(livePrice, note), level: levelLabel(hospitalLevel) }) }}</view>
          </view>
          <view v-else class="current-price" :class="{ 'is-dead': stopped }">
            {{ stopped ? t('detail.beforeStopPrice') : t('detail.livePrice') }}：{{ drawerPrice(stopped ? priceByLevel(item, hospitalLevel) : livePrice, note) }}（{{ levelLabel(hospitalLevel) }}）
          </view>
        </template>
      </view>

      <!-- 说明书不在这里整片展开：分片 31~142 KB、正文中位数 528 字，而全目录只有
           58% 的药品配到了说明书。点进去单独一页看，这一页就干净了。 -->
      <view v-if="drug" class="label-entry" hover-class="is-press" :hover-stay-time="80" @click="openLabel">
        <view class="label-entry-main">
          <view class="label-entry-title">{{ t('label.title') }}</view>
          <view class="label-entry-sub">{{ t('detail.labelSub') }}</view>
        </view>
        <text class="label-entry-arrow">›</text>
      </view>

      <!-- 药典出处：同一品种可能在不同部都收了（如氯化钠既是化学药又是药用辅料），逐条列。 -->
      <view v-if="drug && pharmaHits.length" class="usage-block">
        <view class="usage-head">
          <text class="usage-title">{{ t('drug.pharmacopoeia') }}</text>
        </view>
        <view v-for="(hit, i) in pharmaHits" :key="i" class="usage-body">{{ pharmacopoeiaText(hit) }}</view>
      </view>

      <!-- 相关症状（知识图谱经疾病推断）。category/curated 标出来，exact/synonym 不加标签。 -->
      <view v-if="kgSymptoms" class="usage-block kg-block">
        <view class="usage-head">
          <text class="usage-title">相关症状</text>
          <text v-if="kgTierTag" class="kg-tag">{{ kgTierTag }}</text>
        </view>
        <view class="kg-chips">
          <text v-for="word in kgSymptoms.symptoms" :key="word" class="kg-chip" hover-class="is-press" :hover-stay-time="80" @click="openSymptom(word)">{{ word }}</text>
        </view>
        <view class="muted kg-note">仅供参考，不作诊断依据</view>
      </view>

      <!-- 类别级「使用说明」：目录原文入口上方先给出来。这一段是整章通用说明（有的章
           没有），文字长，先折起几行，点一下展开看全。 -->
      <view v-if="!drug && !consumable && usageNote" class="usage-block">
        <view class="usage-head">
          <text class="usage-title">{{ t('guide.usage') }}</text>
          <text v-if="usageLong" class="usage-more" hover-class="is-press" :hover-stay-time="80" @click="usageOpen = !usageOpen">{{ usageOpen ? t('guide.collapse') : t('guide.expand') }}</text>
        </view>
        <view class="usage-body" :class="{ 'is-clamp': usageLong && !usageOpen }">{{ ct(usageNote) }}</view>
      </view>

      <!-- 计价说明是这条项目自己的，和使用说明（整章通用）分开。目录里这条是原文，
           有的是整段话、有的只是一个数字，照原文显示，不加工。 -->
      <view v-if="!drug && !consumable && note" class="usage-block">
        <view class="usage-head">
          <text class="usage-title">{{ t('guide.priceNote') }}</text>
        </view>
        <view class="usage-body">{{ ct(note) }}</view>
      </view>

      <view v-if="!drug && !consumable" class="label-entry" hover-class="is-press" :hover-stay-time="80" @click="openGuide">
        <view class="label-entry-main">
          <view class="label-entry-title">{{ t('guide.source') }}</view>
          <view class="label-entry-sub">{{ specCodes.length ? t('guide.openSpecSub', { count: specCodes.length }) : t('guide.openSub') }}</view>
        </view>
        <text class="label-entry-arrow">›</text>
      </view>

      <view v-if="specCodes.length === 1" class="label-entry" hover-class="is-press" :hover-stay-time="80" @click="openSpec(specCodes[0])">
        <view class="label-entry-main">
          <view class="label-entry-title">{{ t('spec.head') }}</view>
          <view class="label-entry-sub">{{ t('spec.openOne') }}</view>
        </view>
        <text class="label-entry-arrow">›</text>
      </view>

      <view v-else-if="specRows.length" class="usage-block">
        <view class="usage-head">
          <text class="usage-title">{{ t('spec.head') }}</text>
        </view>
        <view class="usage-body">{{ t('spec.openMany', { count: specRows.length }) }}</view>
        <view v-for="row in specRows" :key="row.code" class="detail-spec" hover-class="is-press" :hover-stay-time="80" @click="openSpec(row.code)">
          <view class="detail-spec-main">
            <text class="detail-spec-name">{{ row.name }}</text>
            <text class="detail-spec-meta">{{ row.code }} · {{ t('spec.pageLabel', { page: row.page }) }}</text>
          </view>
          <text class="detail-spec-arrow">›</text>
        </view>
      </view>

      <view v-if="!drug && !consumable && stopped && item.successors.length" class="alert alert-danger">
        <view class="t">{{ t('detail.useMerged') }}</view>
        <view v-for="s in item.successors" :key="s.id" class="merge-row">
          <text class="jump" hover-class="is-press" :hover-stay-time="80" @click="openItem(s.id)">{{ ct(s.name) }}</text>
          <text class="alert-code">（{{ s.code }}）</text>
        </view>
      </view>

      <view v-if="!drug && !consumable && upcoming && item.successors.length" class="alert alert-info">
        <view class="t">{{ t('detail.mergeFromDate', { date: laterDateText(item.stopAt) }) }}</view>
        <view v-for="s in item.successors" :key="s.id" class="merge-row">
          <text class="jump" hover-class="is-press" :hover-stay-time="80" @click="openItem(s.id)">{{ ct(s.name) }}</text>
          <text class="alert-code">（{{ s.code }}{{ successorNote(s.id, item.stopAt) }}）</text>
        </view>
      </view>

      <view v-if="!drug && !consumable && pending && nowUse.length" class="alert alert-ok">
        <view class="t">{{ t('detail.useOriginalNow') }}</view>
        <view v-for="name in nowUse" :key="name" class="merge-row">
          <text v-if="findByName(name)" class="jump" hover-class="is-press" :hover-stay-time="80" @click="openByName(name)">{{ ct(name) }}</text>
          <text v-else>{{ ct(name) }}</text>
          <text v-if="findByName(name)" class="alert-code">{{ nowUseNote(name) }}</text>
        </view>
      </view>

      <view v-if="!drug && !consumable && item.mergeFrom.length" class="surface">
        <view class="muted">
          {{ pending ? t('detail.originalPending', { count: item.mergeFrom.length }) : t('detail.originalMerged', { count: item.mergeFrom.length }) }}
        </view>
        <view class="merge-names">{{ mergeNames.map(ct).join(' / ') }}</view>
        <view v-if="item.mergeFrom.length > 8 && !mergeOpen" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="mergeOpen = true">
          {{ t('detail.expandAll', { count: item.mergeFrom.length }) }}
        </view>
      </view>

      <view v-if="item.remark" class="surface">
        <view class="muted">{{ t('detail.remark') }}</view>
        <view>{{ ct(item.remark) }}</view>
      </view>

      <view v-if="!drug && !consumable && detail?.composition" class="surface">
        <view class="muted">{{ t('detail.priceComposition') }}</view>
        <view>{{ ct(detail.composition) }}</view>
      </view>
      <view v-if="!drug && !consumable && detail?.consumables" class="surface">
        <view class="muted">{{ t('detail.consumables') }}</view>
        <view>{{ ct(detail.consumables) }}</view>
      </view>
      <view v-if="!drug && !consumable && detail?.excluded" class="surface">
        <view class="muted">{{ t('detail.excluded') }}</view>
        <view>{{ ct(detail.excluded) }}</view>
      </view>

      <HopList :hops="hops" :as-drug="drug" @jump="openItem" />

      <view v-if="drug" class="surface">
        <view class="desc-row"><text class="k">{{ t('detail.catalog') }}</text><text class="v">{{ item.kind ? drugKindText(item.kind) : '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.payClass') }}</text><text class="v">{{ payLabel(item.payClass) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.category') }}</text><text class="v">{{ [item.classCode, ct(item.className)].filter(Boolean).join(' ') || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.forms') }}</text><text class="v">{{ (item.forms || []).map(ct).join(' / ') || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.brand') }}</text><text class="v">{{ ct(item.brand) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.indication') }}</text><text class="v">{{ ct(item.indication) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.protocol') }}</text><text class="v">{{ ct(item.protocol) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.executeAt') }}</text><text class="v">{{ ct(item.executeAt) || '/' }}</text></view>
      </view>

      <view v-else-if="!consumable" class="surface">
        <view class="desc-row"><text class="k">{{ t('detail.itemCode') }}</text><text class="v">{{ item.code || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.unit') }}</text><text class="v">{{ ct(item.unit) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.payType') }}</text><text class="v">{{ payLabel(item.payType) || '/' }}</text></view>
        <view class="desc-row">
          <text class="k">{{ pending ? t('detail.currentLevel', { level: levelLabel('L3') }) : t('detail.levelPrice', { level: levelLabel('L3') }) }}</text>
          <text class="v">{{ pending ? t('detail.notExecuted') : drawerPrice(item.priceL3, note) }}</text>
        </view>
        <view class="desc-row">
          <text class="k">{{ pending ? t('detail.currentLevel', { level: levelLabel('L2') }) : t('detail.levelPrice', { level: levelLabel('L2') }) }}</text>
          <text class="v">{{ pending ? t('detail.notExecuted') : drawerPrice(item.priceL2, note) }}</text>
        </view>
        <view class="desc-row">
          <text class="k">{{ pending ? t('detail.currentLevel', { level: levelLabel('L1') }) : t('detail.levelPrice', { level: levelLabel('L1') }) }}</text>
          <text class="v">{{ pending ? t('detail.notExecuted') : drawerPrice(item.priceL1, note) }}</text>
        </view>
        <view v-if="pending" class="desc-row">
          <text class="k">{{ ct(item.executeAt) }}{{ levelLabel(hospitalLevel) }}</text>
          <text class="v">{{ drawerPrice(livePrice, note) }}</text>
        </view>
        <view class="desc-row">
          <text class="k">{{ t('detail.category') }}</text>
          <text class="v">{{ [categoryLabel(item.cat1), ct(detail?.cat2), ct(detail?.cat3)].filter(Boolean).join(' / ') || '/' }}</text>
        </view>
        <view class="desc-row"><text class="k">{{ t('detail.executeAt') }}</text><text class="v">{{ ct(item.executeAt) || '/' }}</text></view>
        <view class="desc-row"><text class="k">{{ t('detail.stopAt') }}</text><text class="v">{{ ct(item.stopAt) || '/' }}</text></view>
      </view>

      <!-- 耗材的三个数据面。目录条目讲「这个编码在各版目录里是什么」（来源、分类、
           版本沿革、材质规格），挂网产品讲「这个注册证下有哪些规格、各是什么价」
           （规格与价格、企业、耗材编码），带量采购讲「哪个联盟、中选哪些规格」。
           规格、编码动辄几十上百条，默认只铺前几条，其余折在「展开其余 N 条」里。 -->
      <view v-if="consumable" class="surface">
        <view class="desc-row"><text class="k">{{ t('hc.detail.source') }}</text><text class="v">{{ ct(item.source) }}</text></view>
        <view class="desc-row"><text class="k">{{ t('search.hcKind') }}</text><text class="v">{{ item.hcKind ? hcKindText(item.hcKind) : '' }}</text></view>
        <view v-if="item.hcPath" class="desc-row"><text class="k">{{ t('hc.detail.path') }}</text><text class="v">{{ ct(item.hcPath) }}</text></view>
        <view v-if="item.hcKind === 'catalog' && item.code" class="desc-row"><text class="k">{{ t('hc.detail.code') }}</text><text class="v">{{ item.code }}</text></view>
        <view v-if="item.hcCert" class="desc-row"><text class="k">{{ t('hc.detail.cert') }}</text><text class="v">{{ item.hcCert }}</text></view>
        <view v-if="item.payClass" class="desc-row"><text class="k">{{ t('detail.payClass') }}</text><text class="v">{{ payLabel(item.payClass) }}</text></view>
        <view v-if="hcDetail?.lotBatch" class="desc-row"><text class="k">{{ t('hc.detail.lotBatch') }}</text><text class="v">{{ ct(hcDetail.lotBatch) }}</text></view>
        <view v-if="hcAreas.length" class="desc-row"><text class="k">{{ t('hc.detail.area') }}</text><text class="v">{{ hcAreas.map(ct).join(' / ') }}</text></view>
        <view v-if="item.hcPublicOk" class="hc-ok">{{ t('hc.detail.publicOk') }}</view>
      </view>

      <view v-if="consumable && hcVersionRows.length" class="surface">
        <view class="section-label">{{ t('hc.detail.versions') }}</view>
        <view v-for="(row, i) in hcVersionRows" :key="`${row.version}-${i}`" class="hc-row">
          <view class="hc-row-top">
            <text class="hc-row-main">{{ ct(row.version) }}</text>
            <text v-if="row.payClass" class="hc-row-tag">{{ payLabel(row.payClass) }}</text>
          </view>
          <text v-if="row.source" class="hc-row-side">{{ ct(row.source) }}</text>
          <text v-if="row.note" class="hc-row-side">{{ ct(row.note) }}</text>
        </view>
      </view>

      <view v-if="consumable && hcSpecRows.length" class="surface">
        <view class="section-label">{{ t('hc.detail.specs', { count: hcSpecRows.length }) }}</view>
        <view v-for="(row, i) in hcShown(hcSpecRows, 'specs', 10)" :key="`${row.spec}-${i}`" class="hc-row">
          <text class="hc-row-main">{{ ct(row.spec) }}</text>
          <text v-if="row.material" class="hc-row-side">{{ t('hc.detail.material') }}：{{ ct(row.material) }}</text>
        </view>
        <view v-if="hcMore(hcSpecRows, 'specs', 10)" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="hcToggle('specs')">{{ hcMore(hcSpecRows, 'specs', 10) }}</view>
      </view>

      <view v-if="consumable && hcVariantRows.length" class="surface">
        <view class="section-label">{{ t('hc.detail.variants', { count: hcVariantRows.length }) }}</view>
        <view v-for="(row, i) in hcShown(hcVariantRows, 'variants', 8)" :key="`${row.code}-${i}`" class="hc-row">
          <view class="hc-row-top">
            <text class="hc-row-main">{{ [ct(row.spec), ct(row.model)].filter(Boolean).join(' / ') || ct(row.name) || ct(item.name) }}</text>
            <text v-if="row.price" class="hc-row-price">{{ row.price }}</text>
          </view>
          <text v-if="row.name && row.name !== item.name && row.name !== row.spec" class="hc-row-side">{{ ct(row.name) }}</text>
          <text v-if="row.priceLabel && row.priceLabel !== item.hcPriceLabel" class="hc-row-side">{{ t(`hc.price.${row.priceLabel}`) }}</text>
          <text class="hc-row-side">{{ hcVariantMeta(row) }}</text>
          <text v-if="row.provinces.length" class="hc-row-side">{{ t('hc.detail.provinces', { list: row.provinces.join('、') }) }}</text>
          <text v-if="row.table" class="hc-row-side">{{ row.table }}</text>
        </view>
        <view v-if="hcMore(hcVariantRows, 'variants', 8)" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="hcToggle('variants')">{{ hcMore(hcVariantRows, 'variants', 8) }}</view>
        <view class="muted">{{ t('hc.detail.warn') }}</view>
      </view>

      <view v-if="consumable && hcLotSpecRows.length" class="surface">
        <view class="section-label">{{ t('hc.detail.lotSpecs', { count: hcLotSpecRows.length }) }}</view>
        <view class="hc-chips">
          <text v-for="(spec, i) in hcShown(hcLotSpecRows, 'lotSpecs', 12)" :key="`${spec}-${i}`" class="hc-chip">{{ spec }}</text>
        </view>
        <view v-if="hcMore(hcLotSpecRows, 'lotSpecs', 12)" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="hcToggle('lotSpecs')">{{ hcMore(hcLotSpecRows, 'lotSpecs', 12) }}</view>
      </view>

      <view v-if="consumable && (hcMakers.length || hcSellers.length)" class="surface">
        <view class="section-label">{{ t('hc.detail.firms') }}</view>
        <view v-if="hcMakers.length" class="desc-row"><text class="k">{{ t('hc.detail.makers') }}</text><text class="v">{{ hcMakers.map(ct).join(' / ') }}</text></view>
        <view v-if="hcSellers.length" class="desc-row"><text class="k">{{ t('hc.detail.sellers') }}</text><text class="v">{{ hcSellers.map(ct).join(' / ') }}</text></view>
      </view>

      <view v-if="consumable && hcCodeRows.length" class="surface">
        <view class="section-label">{{ t('hc.detail.codes', { count: hcCodeRows.length }) }}</view>
        <view class="hc-chips">
          <text v-for="(code, i) in hcShown(hcCodeRows, 'codes', 12)" :key="`${code}-${i}`" class="hc-chip is-code" hover-class="is-press" :hover-stay-time="80" @click="copyText(code)">{{ code }}</text>
        </view>
        <view v-if="hcMore(hcCodeRows, 'codes', 12)" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="hcToggle('codes')">{{ hcMore(hcCodeRows, 'codes', 12) }}</view>
      </view>

      <view v-if="!drug && !consumable" class="surface">
        <view class="section-label">{{ t('detail.priceHistory') }}</view>
        <view v-if="detailError" class="muted">{{ t('detail.historyFail') }}</view>
        <view v-else-if="!detail" class="muted">{{ t('detail.historyLoading') }}<LoadingBar inline /></view>
        <view v-else-if="!detail.history.length" class="muted">{{ t('detail.historyEmpty') }}</view>
        <view v-else class="history-list">
          <view v-for="(row, i) in historyRows.shown" :key="`${row.event}-${row.at}-${i}`" class="history-item" :class="`is-${row.kind}`">
            <view class="history-dot" />
            <view class="history-top">
              <text class="ht">{{ ct(historyTitle(row)) }}</text>
              <text class="at">{{ ct(row.at) || t('common.current') }}</text>
            </view>
            <view class="history-prices">
              {{ t('detail.historyPrices', { l3: priceText(row.priceL3, note), l2: priceText(row.priceL2, note), l1: priceText(row.priceL1, note), pay: row.payType ? ` · ${payLabel(row.payType)}` : '' }) }}
            </view>
          </view>
        </view>
        <view v-if="historyRows.extra" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="histOpen = true">{{ t('detail.expandHistory', { count: historyRows.extra }) }}</view>
      </view>

      <!-- 医保智能审核规则：官方规则明细，只有收费项目会被命中。最多的一条是
           「腹腔镜辅助操作」，有 210 条，所以按规则分组、每组只留前几条。 -->
      <view v-if="!drug && !consumable && auditGroups.length" class="surface">
        <view class="section-label">{{ t('audit.title') }}<text class="audit-count">{{ t('audit.count', { count: auditCount }) }}</text></view>
        <view class="muted">{{ t('audit.note') }}</view>
        <view v-for="group in auditShownGroups" :key="group.rule" class="audit-group">
          <view class="audit-rule">
            <text class="audit-rule-name">{{ auditRuleText(group.rule) }}</text>
            <text class="audit-rule-hit">{{ t('audit.hit') }}</text>
          </view>
          <view v-for="(row, i) in auditRows(group)" :key="`${row.otherId}-${i}`" class="audit-row">
            <text v-if="auditName(row.otherId)" class="jump" hover-class="is-press" :hover-stay-time="80" @click="openItem(row.otherId)">{{ ct(auditName(row.otherId)) }}</text>
            <text v-else class="audit-other">{{ t('audit.other') }}</text>
            <text v-if="row.condition" class="audit-cond">{{ row.condition }}</text>
            <text v-if="row.note" class="audit-note">{{ row.note }}</text>
          </view>
          <view v-if="auditRowRest(group)" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="auditOpen = true">{{ t('hc.detail.more', { count: auditRowRest(group) }) }}</view>
        </view>
        <view v-if="auditRestGroups" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="auditOpen = true">{{ t('audit.more', { count: auditRestGroups }) }}</view>
        <view v-else-if="auditOpen" class="history-more" hover-class="is-press" :hover-stay-time="80" @click="auditOpen = false">{{ t('hc.detail.less') }}</view>
        <view v-if="auditOneSided" class="muted">{{ t('audit.oneSided', { count: auditOneSided }) }}</view>
      </view>

      <view class="yb-btn is-ghost" hover-class="is-press" :hover-stay-time="80" @click="openGraph">{{ t('detail.graph') }}</view>
      <view class="yb-btn is-ghost" hover-class="is-press" :hover-stay-time="80" @click="copyCode">{{ drug ? t('detail.copyName') : t('detail.copyCode') }}</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.drawer-block {
  display: flex;
  flex-direction: column;
  gap: 32rpx;
}
.merge-row {
  margin-top: 8rpx;
  font-size: 28rpx;
  line-height: 1.5;
}
.merge-names {
  margin-top: 12rpx;
  color: var(--yb-text-2);
  font-size: 26rpx;
  line-height: 1.6;
}
.limit-badge {
  display: inline-flex;
  align-items: center;
  min-height: 38rpx;
  margin-left: 12rpx;
  padding: 0 10rpx;
  border-radius: 9rpx;
  background: #fff0d2;
  color: #b45309;
  font-size: 22rpx;
  font-weight: 800;
  line-height: 38rpx;
  vertical-align: middle;
}
.label-entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-top: 16rpx;
  padding: 22rpx 22rpx;
  border: 1rpx solid var(--yb-border);
  border-radius: 16rpx;
  background: var(--yb-surface);
}
/* 类别级使用说明：整章通用的那一段，长，默认折 5 行。 */
.usage-block {
  margin-top: 16rpx;
  padding: 20rpx 22rpx;
  border: 1rpx solid var(--yb-border);
  border-radius: 16rpx;
  background: var(--yb-level-track);
}
.usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}
.usage-title {
  color: var(--yb-text-2);
  font-size: 26rpx;
  font-weight: 600;
}
.usage-more {
  flex-shrink: 0;
  color: var(--yb-primary);
  font-size: 24rpx;
}
.usage-body {
  margin-top: 10rpx;
  color: var(--yb-text-2);
  font-size: 25rpx;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.usage-body.is-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 一条收费项目对应多条技术规范时，规范就列在本页，点一条进一条，不绕道关联网络。 */
.detail-spec {
  display: flex;
  align-items: center;
  gap: 12rpx;
  min-height: 84rpx;
  border-bottom: 1rpx solid var(--yb-border);
}
.detail-spec:last-of-type { border-bottom: 0; }
.detail-spec-main { min-width: 0; flex: 1; }
.detail-spec-name {
  display: block;
  overflow: hidden;
  color: var(--yb-text);
  font-size: 26rpx;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.detail-spec-meta { display: block; margin-top: 4rpx; color: var(--yb-text-3); font-size: 21rpx; }
.detail-spec-arrow { flex: none; color: var(--yb-text-3); font-size: 34rpx; }
.label-entry-main {
  min-width: 0;
  flex: 1;
}
.label-entry-title {
  color: var(--yb-text);
  font-size: 28rpx;
  font-weight: 600;
}
.label-entry-sub {
  margin-top: 6rpx;
  color: var(--yb-text-3);
  font-size: 22rpx;
  line-height: 1.5;
}
.label-entry-arrow {
  flex: none;
  color: var(--yb-text-3);
  font-size: 38rpx;
}
/* 耗材的价格块：口径写在数字前面，字号比数字小，别让人把采购价当成支付标准 */
.hc-head-price {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
  margin-top: 8rpx;
}
.hc-price-label {
  color: var(--yb-text-3);
  font-size: 24rpx;
}
.hc-price-value {
  color: var(--yb-text);
  font-size: 40rpx;
  font-weight: 700;
}
/* 同时列入公立机构目录是加法信息，用一条窄提示，不占一整行 */
.hc-ok {
  margin-top: 12rpx;
  color: #0369a1;
  font-size: 24rpx;
  line-height: 1.5;
}
.hc-row {
  padding: 14rpx 0;
  border-top: 1rpx solid var(--yb-border);
}
.hc-row-top {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
}
.hc-row-main {
  min-width: 0;
  flex: 1;
  color: var(--yb-text);
  font-size: 27rpx;
  font-weight: 600;
  line-height: 1.5;
  word-break: break-all;
}
.hc-row-price {
  flex: none;
  color: var(--yb-text);
  font-size: 30rpx;
  font-weight: 700;
}
/* 版本沿革里的支付类别标签，跟数字一起挤在标题行右侧 */
.hc-row-tag {
  flex: none;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  background: var(--yb-bg);
  color: var(--yb-text-2);
  font-size: 21rpx;
}
.hc-row-side {
  display: block;
  margin-top: 4rpx;
  color: var(--yb-text-3);
  font-size: 23rpx;
  line-height: 1.5;
  word-break: break-all;
}
.hc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
  margin-top: 12rpx;
}
.hc-chip {
  padding: 6rpx 14rpx;
  border: 1rpx solid var(--yb-border);
  border-radius: 10rpx;
  color: var(--yb-text-2);
  font-size: 23rpx;
  line-height: 1.5;
  word-break: break-all;
}
.hc-chip.is-code {
  font-family: monospace;
}
.audit-count {
  margin-left: 12rpx;
  color: var(--yb-text-3);
  font-size: 23rpx;
  font-weight: 400;
}
.audit-group {
  margin-top: 20rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid var(--yb-border);
}
.audit-rule {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
}
.audit-rule-name {
  min-width: 0;
  flex: 1;
  color: var(--yb-text);
  font-size: 27rpx;
  font-weight: 600;
}
.audit-rule-hit {
  flex: none;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  background: #e0f2fe;
  color: #0369a1;
  font-size: 21rpx;
}
.audit-row {
  margin-top: 10rpx;
  font-size: 26rpx;
  line-height: 1.6;
}
.audit-other {
  color: var(--yb-text-2);
}
.audit-cond {
  margin-left: 12rpx;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  background: var(--yb-bg);
  color: var(--yb-text-2);
  font-size: 22rpx;
}
.audit-note {
  display: block;
  margin-top: 4rpx;
  color: var(--yb-text-3);
  font-size: 23rpx;
}
.kg-chips { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 12rpx; }
.kg-chip { padding: 6rpx 18rpx; border-radius: 999rpx; background: var(--yb-soft, #eef3fa); font-size: 26rpx; }
.kg-tag { margin-left: 12rpx; padding: 2rpx 12rpx; border-radius: 8rpx; font-size: 22rpx; color: #b26a00; background: #fff4e0; }
.kg-note { margin-top: 12rpx; font-size: 22rpx; }
</style>
