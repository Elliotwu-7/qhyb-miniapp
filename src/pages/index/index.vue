<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { onHide, onLoad, onReachBottom, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import ResultCard from '../../components/ResultCard.vue'
import ContentNotice from '../../components/ContentNotice.vue'
import LoadingBar from '../../components/LoadingBar.vue'
import SearchTermsNotice from '../../components/SearchTermsNotice.vue'
import { loadSearchTerms } from '../../lib/search-terms'
import { useContentTranslation } from '../../lib/content'
import { copyFeedbackWeChat } from '../../lib/contact'
import { failMessage } from '../../lib/fail'
import { clearHistory, loadHistory, pushHistory, removeHistory, type HistoryEntry } from '../../lib/history'
import { categoryLabel, drugKindText, hcKindText, localeClass, t } from '../../lib/i18n'
import { buildHopIndex, prefetchDetail } from '../../lib/data'
import { levelLabel } from '../../lib/price'
import { resolveCurrentHits, searchDirectory, type SearchScope, type DrugFilter, type ConsumableFilter } from '../../lib/search'
import { enableShare, shareQuery } from '../../lib/share'
import { isCurrentlyChargeable } from '../../lib/status'
import { mpCatalogSearch, mpNhcSpec, mpPharmacopoeia, type CatalogSearchCounts, type NhcSpecHit, type PharmacopoeiaHit } from '../../lib/api'
import { specAsSearchItem } from '../../lib/nhcSpec'
import { consumeQuery, hospitalLevel, registered, restoreSession, sessionBusy } from '../../lib/session'
import { catalogReady, metaReady } from '../../lib/store'
import { catalogBar } from '../../lib/progress'
import { routeValue } from '../../lib/route'
import { applyChrome, themeMode } from '../../lib/theme'
import { DRUG_KIND_LABEL, isConsumable, isDrug, isSpec, type DrugKind, type CatalogEdge, type CatalogMeta, type SearchItem } from '../../lib/types'

const q = ref('')
const tibetanQuery = computed(() => /[\u0f00-\u0fff]/.test(q.value))
onShow(() => { void loadSearchTerms() })
const { ct } = useContentTranslation(true)
const committed = ref('')
const focused = ref(false)
const status = ref('current')
const scope = ref<SearchScope>('all')
const drugFilter = ref<DrugFilter>('all')
const consumableFilter = ref<ConsumableFilter>('all')
const cat1 = ref('全部')
const filterOpen = ref(false)
const draftStatus = ref('current')
const draftDrugFilter = ref<DrugFilter>('all')
const draftConsumableFilter = ref<ConsumableFilter>('all')
const draftCategory = ref('全部')
const browsing = ref(false)
const items = shallowRef<SearchItem[]>([])
const drugs = shallowRef<SearchItem[]>([])
const consumables = shallowRef<SearchItem[]>([])
const edges = shallowRef<CatalogEdge[]>([])
/** 卡片上的「相关耗材」走这份：目录关系 + 耗材分类相近，不含审核规则。 */
const hopEdges = shallowRef<CatalogEdge[]>([])
const byName = shallowRef(new Map<string, SearchItem>())
const byId = shallowRef(new Map<string, SearchItem>())
const history = ref<HistoryEntry[]>(loadHistory())
const meta = ref<CatalogMeta>({ stats: { total: 0, version: '', title: '' }, units: [], payTypes: [], payClasses: [], categories: [] })
const loading = ref(true)
const error = ref('')
const warnings = ref<string[]>([])
const catalogBusy = ref(false)
const searching = ref(false)
let searchVersion = 0
const pageSize = 40
const shown = ref(pageSize)

const onHome = computed(
  () => scope.value === 'all' && !browsing.value,
)

const hotItems = computed(() => meta.value.common || [])
const scopes: SearchScope[] = ['all', 'service', 'drug', 'consumable', 'spec']
const scopeKeys = { all: 'common.all', service: 'common.medicalService', drug: 'common.drug', consumable: 'common.consumable', spec: 'common.spec' }
const drugFilters: DrugFilter[] = ['all', 'classA', 'classB', 'limited', 'outside']
const hcFilters: ConsumableFilter[] = ['all', 'catalog', 'product', 'lot']
const hcFilterLabel = (filter: ConsumableFilter) => (filter === 'all' ? t('hc.filter.all') : hcKindText(filter))
const categories = computed(() => scope.value === 'drug'
  ? (Object.keys(DRUG_KIND_LABEL) as DrugKind[])
    .filter((kind) => drugs.value.some((item) => item.kind === kind))
    .map((kind) => ({ value: DRUG_KIND_LABEL[kind], label: drugKindText(kind) }))
  : meta.value.categories.map((value) => ({ value, label: categoryLabel(value) })))
const serviceFilters = computed(() => [
  { value: 'current', label: committed.value ? t('common.all') : t('home.statusCurrent') },
  ...(committed.value ? [{ value: 'active', label: t('status.active') }] : []),
  { value: 'pending', label: t('home.statusPending') },
  { value: 'stopped', label: t('home.statusStopped') },
  { value: 'merged', label: t('home.statusMerged') },
  { value: 'upcoming', label: t('home.statusUpcoming') },
])
/** 耗材只有现行、公示未生效、已废止三档：没有合并、也没有停用日期那一说。 */
const consumableFilters = computed(() => [
  { value: 'current', label: t('home.statusCurrent') },
  { value: 'pending', label: t('hc.status.pending') },
  { value: 'stopped', label: t('hc.status.stopped') },
])
const filterCount = computed(() => {
  // 规范档没有目录筛选可给（规范库那边只认关键词），套用兜底那条会把
  // 「全部」分类和状态算成两个筛选条件，工具栏却根本没渲染出来。
  if (scope.value === 'spec') return 0
  if (scope.value === 'drug') return Number(cat1.value !== '全部') + Number(drugFilter.value !== 'all')
  if (scope.value === 'consumable') return Number(consumableFilter.value !== 'all') + Number(status.value !== 'current')
  return Number(cat1.value !== '全部') + Number(status.value !== 'current')
})
/** 现行状态那一栏的标签：耗材三档、收费项目五档，各取自己那张筛选项表。 */
function statusLabelOf(scopeValue: string, statusValue: string) {
  const rows = scopeValue === 'consumable' ? consumableFilters.value : serviceFilters.value
  return rows.find((s) => s.value === statusValue)?.label || t('status.active')
}
const filterSummary = computed(() => {
  const labels: string[] = []
  if (scope.value === 'spec') return t('search.noFilters')
  if (scope.value !== 'consumable' && cat1.value !== '全部') labels.push(categories.value.find((c) => c.value === cat1.value)?.label || '')
  if (scope.value === 'drug' && drugFilter.value !== 'all') labels.push(t('search.drugFilter.' + drugFilter.value))
  if (scope.value === 'consumable' && consumableFilter.value !== 'all') labels.push(hcFilterLabel(consumableFilter.value))
  // 不在这层开 const：块级声明降级后会顶掉同名模块级绑定（见 README）。
  if (scope.value !== 'all' && scope.value !== 'spec' && status.value !== 'current') labels.push(statusLabelOf(scope.value, status.value))
  return labels.join(' · ') || t('search.noFilters')
})

/**
 * 目录还没下到手机上时，检索结果先问服务端拿一页。本地目录一到，hits 接管，
 * 两边是同一套打分，所以交接时顺序不会变。
 * 不带关键词的浏览（翻整本目录）不走这里：那一次要的是全量，还是等本地目录。
 */
const remoteRows = ref<SearchItem[]>([])
const remoteTotal = ref(0)
const remoteCounts = ref<CatalogSearchCounts>({ service: 0, drug: 0, consumable: 0 })
const remotePending = ref(false)
let remoteVersion = 0
/** remoteRows 是哪一次检索的结果，翻页必须拿它再要，不能用后来改掉的筛选。 */
let remoteKey = ''
/**
 * 同一组条件（词 + 范围 + 筛选）的服务端结果只向服务端要一次。目录这一轮会话不会变，
 * 而打字、删回去、点历史词都会对同一组条件再要一遍。按条件记下已经拿到的页，
 * 翻页时把新的一页接进去；换了条件、或这一轮被作废才重新要。
 */
const remoteCache = new Map<string, { total: number; counts: CatalogSearchCounts; items: SearchItem[] }>()

function remoteParams() {
  return {
    q: committed.value,
    scope: scope.value === 'spec' ? 'all' : scope.value,
    category: cat1.value === '全部' ? '' : cat1.value,
    status: status.value === 'current' ? '' : status.value,
    drug: drugFilter.value,
    hc: consumableFilter.value,
  }
}

async function refreshRemote() {
  const version = ++remoteVersion
  const params = remoteParams()
  const key = JSON.stringify(params)
  remoteKey = key
  if (items.value.length || !params.q || scope.value === 'spec') {
    remotePending.value = false
    return
  }
  // 这组条件这一轮已经要过了：直接用记下的页，省掉一次往返。记下的是请求当时的
  // 原样，和再要一次拿到的是同一份；本地目录一到，hits 会整份替换掉它。
  const cached = remoteCache.get(key)
  if (cached) {
    remoteRows.value = cached.items
    remoteTotal.value = cached.total
    remoteCounts.value = cached.counts
    remotePending.value = false
    return
  }
  remotePending.value = true
  let data: Awaited<ReturnType<typeof mpCatalogSearch>> | null = null
  try {
    data = await mpCatalogSearch({ ...params, offset: 0, limit: pageSize })
  } catch {
    if (version === remoteVersion) remotePending.value = false
    return
  }
  // 这一页在飞的时候换了词或筛选，丢掉它，别把上一次的结果画到新条件上。
  if (version !== remoteVersion) return
  remoteRows.value = data.items || []
  remoteTotal.value = data.total || 0
  remoteCounts.value = data.counts || remoteCounts.value
  remotePending.value = false
  remoteCache.set(key, { total: remoteTotal.value, counts: remoteCounts.value, items: remoteRows.value })
}

/** 目录还在下载时的「加载更多」：带 offset 再要一页，接到已有结果后面。 */
async function loadMoreRemote() {
  if (items.value.length || !committed.value || scope.value === 'spec' || remoteRows.value.length >= remoteTotal.value) return
  const version = remoteVersion
  const key = remoteKey
  const offset = remoteRows.value.length
  let data: Awaited<ReturnType<typeof mpCatalogSearch>> | null = null
  try {
    data = await mpCatalogSearch({ ...remoteParams(), offset, limit: pageSize })
  } catch {
    return
  }
  if (version !== remoteVersion || key !== remoteKey) return
  const more = data.items || []
  // 按 id 去重：服务端还没跟上 offset 时会把第一页再发一遍，直接接上去就成了重复条目。
  const seen = new Set(remoteRows.value.map((row) => row.id))
  const fresh = more.filter((row) => row.id && !seen.has(row.id))
  if (fresh.length) {
    remoteRows.value = remoteRows.value.concat(fresh)
    remoteTotal.value = data.total || remoteTotal.value
  } else {
    remoteTotal.value = remoteRows.value.length
  }
  // 翻页拿到的是这组条件更完整的一版，下回打到同一组条件就用它，不用再从第一页要起。
  remoteCache.set(key, { total: remoteTotal.value, counts: remoteCounts.value, items: remoteRows.value })
}

const nhcHits = ref<NhcSpecHit[]>([])
const nhcTotal = ref(0)
/** nhcHits 是哪一次关键词的结果，翻页时必须拿它去要下一页，不能用后来改掉的 q。 */
let nhcQuery = ''
let nhcVersion = 0
/**
 * 同一个词的规范结果只向服务端要一次。规范检索要扫整本规范库，而结果跟着字走：
 * 打字、删回去、点历史词都会对同一个词再要一遍。规范库这一轮会话不会变，
 * 所以按词记下第一页；换了词、或这一轮被作废（返回首页）才重新要。
 */
const nhcCache = new Map<string, { total: number; items: NhcSpecHit[] }>()
/** 规范命中卡的入场只在换关键词时播一次。它们是网络回来才出现的，
 *  不挂这一拍的话是整块突然冒出来；翻页追加不算换词，不重播。 */
const specFresh = ref(false)
let specFreshTimer = 0

function replaySpec() {
  specFresh.value = false
  clearTimeout(specFreshTimer)
  specFreshTimer = setTimeout(() => {
    specFresh.value = true
  }, 30) as unknown as number
}

/**
 * 这一页结果里的药品在《中国药典》里的出处，按药品名索引。
 * 药典库在服务端，不整本拉下来：只问当前这一页里还没问过的药品名，
 * 一次最多 40 个（接口上限），翻页才再要一批。
 */
const pharmaByName = ref<Record<string, PharmacopoeiaHit[]>>({})
let pharmaVersion = 0

async function refreshPharmacopoeia(rows: SearchItem[]) {
  const version = ++pharmaVersion
  const names: string[] = []
  const seen = new Set<string>()
  rows.forEach((row) => {
    if (!isDrug(row) || !row.name || seen.has(row.name) || pharmaByName.value[row.name]) return
    seen.add(row.name)
    names.push(row.name)
  })
  if (!names.length) return
  let data: Awaited<ReturnType<typeof mpPharmacopoeia>> | null = null
  try {
    data = await mpPharmacopoeia(names.slice(0, 40))
  } catch {
    return
  }
  // 这一批在飞的时候翻了页，丢掉它，别把上一页的结果写到新一页上。
  if (version !== pharmaVersion || !data.ok) return
  pharmaByName.value = { ...pharmaByName.value, ...(data.byName || {}) }
}

async function refreshNhc(query: string) {
  const version = ++nhcVersion
  const text = query.trim()
  // 声明摊在函数体一层：块里的 const 被压缩器改成短名后，微信降级 ES5 时
  // 提升成 var，可能顶掉参数（见 README）。
  let data: Awaited<ReturnType<typeof mpNhcSpec>> | null = null
  nhcQuery = text
  if (text.length < 2) {
    nhcHits.value = []
    nhcTotal.value = 0
    return
  }
  // 这个词这一轮已经要过了：直接用记下的第一页，省掉一次整库扫描。
  // 记下的是请求当时的原样，和再要一次拿到的是同一份。
  const cached = nhcCache.get(text)
  if (cached) {
    nhcHits.value = cached.items
    nhcTotal.value = cached.total
    if (cached.items.length) replaySpec()
    return
  }
  try {
    data = await mpNhcSpec(text)
    if (version === nhcVersion) {
      nhcHits.value = data.items || []
      nhcTotal.value = data.total || 0
      nhcCache.set(text, { total: nhcTotal.value, items: nhcHits.value })
      if (nhcHits.value.length) replaySpec()
    }
  } catch {
    if (version === nhcVersion) {
      nhcHits.value = []
      nhcTotal.value = 0
    }
  }
}

/**
 * 规范档的「加载更多」。规范库在线上，一次只给一页，所以要带 offset 再要一页；
 * 目录档是本地全量，翻页只是把已经拿到手的结果多显示几条（见 loadMore）。
 * 之前这里没有翻页，命中一百多条的词也只看得见前 30 条，条数还照着 30 显示。
 */
async function loadMoreNhc() {
  if (nhcQuery.length < 2 || nhcHits.value.length >= nhcTotal.value) return
  const version = nhcVersion
  const offset = nhcHits.value.length
  let data: Awaited<ReturnType<typeof mpNhcSpec>> | null = null
  try {
    data = await mpNhcSpec(nhcQuery, offset)
  } catch {
    return
  }
  // 这一页在飞的时候换了关键词，就丢掉它，别把上一个词的结果接到新词后面。
  if (version !== nhcVersion) return
  const more = data.items || []
  // 按编号去重：服务端还没跟上 offset 时会把第一页再发一遍，直接接上去就成了重复条目。
  const seen = new Set(nhcHits.value.map((row) => row.code))
  const fresh = more.filter((row) => row.code && !seen.has(row.code))
  if (fresh.length) {
    nhcHits.value = nhcHits.value.concat(fresh)
    nhcTotal.value = data.total || nhcTotal.value
  } else {
    // 没有新东西了（服务端已经到底，或者它这一版还不认 offset）：把总数收成实际拿到的
    // 条数，免得「加载更多」一直挂着却点不出东西来。
    nhcTotal.value = nhcHits.value.length
  }
  // 翻页拿到的是这个词更完整的一版，下回打到同一个词就用它，不用再从第一页要起。
  nhcCache.set(nhcQuery, { total: nhcTotal.value, items: nhcHits.value })
}

const hits = computed(() => {
  if (onHome.value) return []
  return searchDirectory(items.value, drugs.value, {
    query: committed.value,
    scope: scope.value,
    category: cat1.value === '全部' ? '' : cat1.value,
    status: status.value === 'current' ? '' : status.value,
    drugFilter: drugFilter.value,
    consumables: consumables.value,
    consumableFilter: consumableFilter.value,
  }, byName.value)
})

/** 本地目录还没到、手上又有关键词时，用服务端那一页顶上，免得干等整本目录下完。
 *  目录一到，remoteWanted 变 false，hits 接管，两边是同一套打分，顺序不会变。 */
const remoteActive = computed(() => !items.value.length && Boolean(committed.value) && scope.value !== 'spec' && (remoteRows.value.length > 0 || remotePending.value))
const pageRows = computed(() => (remoteActive.value ? remoteRows.value : hits.value.slice(0, shown.value)))
/**
 * 技术规范这一档：命中的是规范本身（线上规范库），不是本地目录里的收费项目。
 * 所以它并进 listRows 单独成列，但绝不并进 hits —— hits 是目录检索的结果，
 * 混进规范会让「全部」档的条数和顺序跟着变。
 */
const specActive = computed(() => scope.value === 'spec')
const specRows = computed(() => nhcHits.value.map(specAsSearchItem))
/**
 * 规范档一次只要一页（线上库按 offset 给），拿到多少就列多少，不再用 shown 切；
 * 目录档还是本地全量，shown 只管显示多少条。
 */
const listRows = computed(() => (specActive.value ? specRows.value : pageRows.value))
// 结果页变了（新检索、翻页）就去补这一页药品的药典出处。规范档没有药品，跳过。
watch(pageRows, (rows) => {
  if (specActive.value) return
  void refreshPharmacopoeia(rows)
})
const listHasMore = computed(() => {
  if (specActive.value) return nhcHits.value.length < nhcTotal.value
  if (remoteActive.value) return remoteRows.value.length < remoteTotal.value
  return shown.value < hits.value.length
})
/** 结果入场动画只在换关键词时播一次。列表一直挂着动画的话，每敲一个字
 *  整列都从头淡入，边打字边看结果反而晃。shown 回到第一页才算一次新结果，
 *  点「加载更多」把 shown 加大不算。 */
const listFresh = ref(false)
let listFreshTimer = 0
watch([committed, scope, status, cat1, drugFilter, consumableFilter], () => {
  if (shown.value !== pageSize) return
  listFresh.value = false
  clearTimeout(listFreshTimer)
  listFreshTimer = setTimeout(() => {
    listFresh.value = true
  }, 30) as unknown as number
  // 预览改关键词走 applyPreview；筛选和分栏在这里变，服务端那一页要跟着重要。
  // 目录已经在本地了就不用：hits 自己会重算。
  if (!items.value.length) void refreshRemote()
})
const drugCount = computed(() => (remoteActive.value ? remoteCounts.value.drug : hits.value.filter(isDrug).length))
const consumableCount = computed(() => (remoteActive.value ? remoteCounts.value.consumable : hits.value.filter(isConsumable).length))
const serviceCount = computed(() => (remoteActive.value ? remoteCounts.value.service : hits.value.filter((item) => !isDrug(item) && !isConsumable(item) && !isSpec(item)).length))
const soonStop = computed(() => meta.value.stats.upcomingStop || 0)
const soonExec = computed(() => meta.value.stats.upcomingExecute || 0)
const liveCount = computed(() => {
  const found = items.value.filter((it) => isCurrentlyChargeable(it))
  return resolveCurrentHits(items.value, found, '', '').length
})
/** 首页那行统计里的耗材数：和点「医用耗材」栏不输关键词时看到的条数一致（现行那些）。 */
const liveHcCount = computed(() => consumables.value.filter((it) => isCurrentlyChargeable(it)).length)

const heroMeta = computed(() => {
  if (error.value) return error.value
  if (!meta.value.stats.version) return loading.value ? t('home.loading') : ''
  const ver = meta.value.stats.version
  // meta 比目录先到；目录没到就别印数字，否则会拿 meta 里的旧计数，
  // 和浏览列表（resolveCurrentHits）对不上。
  if (!items.value.length) return loading.value ? t('home.loading') : t('home.updatedLoading', { version: ver })
  return t('home.updated', { version: ver, count: liveCount.value, drugs: drugs.value.length, hc: liveHcCount.value })
})

const homeNotice = computed(() => {
  const changes: string[] = []
  if (soonStop.value) changes.push(t('home.stopSoon', { count: soonStop.value }))
  if (soonExec.value) changes.push(t('home.executeSoon', { count: soonExec.value }))
  return changes.length ? t('home.timeNotice', { changes: changes.join(' · ') }) : ''
})

function ensureCatalog(force = false) {
  if (catalogBusy.value || (!force && items.value.length && !warnings.value.length)) return
  catalogBusy.value = true
  loading.value = true
  error.value = ''
  void catalogReady()
    .then((data) => {
      items.value = data.items
      drugs.value = data.drugs
      consumables.value = data.consumables
      edges.value = data.edges
      hopEdges.value = data.hopEdges
      byName.value = data.byName
      byId.value = data.byId
      meta.value = data.meta
      warnings.value = data.warnings
    })
    .catch((err) => {
      error.value = failMessage(err, t('home.loadFail'))
    })
    .finally(() => {
      loading.value = false
      catalogBusy.value = false
    })
}

async function commitSearch(text: string) {
  const next = text.trim()
  const version = ++searchVersion
  if (!next) {
    searching.value = false
    q.value = ''
    committed.value = ''
    browsing.value = true
    shown.value = pageSize
    ensureCatalog()
    return
  }
  searching.value = true
  q.value = next
  committed.value = next
  browsing.value = true
  shown.value = pageSize
  history.value = pushHistory(next)
  ensureCatalog()
  void refreshRemote()
  void refreshNhc(next)
  searching.value = false
  if (registered.value) {
    void consumeQuery(next).catch((err) => {
      if (version === searchVersion) uni.showToast({ title: failMessage(err, t('home.searchFail')), icon: 'none' })
    })
  }
}

function goLogin() {
  uni.navigateTo({ url: '/pages/register/register' })
}

/**
 * 用户主动发起一次查询的唯一入口：查询按钮、热词、历史词都走这里。
 * 之前只有查询按钮挡登录，点热词/历史词就直接出结果了——那几条也是查询。
 * 例外只有转发链接进来的 ?q=（见 applySharedQuery）：那条路是别人分享的成果，
 * 挡掉等于分享链接打不开。
 */
async function requestSearch(text: string) {
  if (!registered.value && !sessionBusy.value) await restoreSession().catch(() => undefined)
  if (!registered.value) {
    uni.showToast({ title: t('home.loginRequired'), icon: 'none' })
    goLogin()
    return
  }
  commitSearch(text)
}

async function onConfirm() {
  await requestSearch(q.value)
}

/**
 * 从转发链接进来时用（?q=鼻炎片）。
 * 和 commitSearch 的区别是**不把显示卡在记账上**：consumeQuery 要走服务端，网络不好
 * 或者配额用尽时它会抛，而 commitSearch 是先 await 再显示 —— 那样一条分享出去的链接
 * 会因为一次记不上账而打不开。这里先把结果画出来，记账尽力而为。
 */
function applySharedQuery(text: string) {
  const next = text.trim()
  if (!next) return
  q.value = next
  committed.value = next
  browsing.value = true
  shown.value = pageSize
  history.value = pushHistory(next)
  ensureCatalog()
  void refreshRemote()
  // 转发链接也是产品自己的入口，规范这一节照样要出：查的是规范库，不占查询次数。
  void refreshNhc(next)
  if (registered.value) void consumeQuery(next).catch(() => undefined)
}

function openWeChat() {
  copyFeedbackWeChat(t('contact.copied'), t('common.feedback'))
}

/** 搜索结果页回首页：把五栏、筛选、关键词、规范那一段都放回默认，首页 hero 才会回来。 */
function backHome() {
  searchVersion += 1
  searching.value = false
  q.value = ''
  committed.value = ''
  scope.value = 'all'
  status.value = 'current'
  cat1.value = '全部'
  drugFilter.value = 'all'
  consumableFilter.value = 'all'
  browsing.value = false
  shown.value = pageSize
  nhcVersion += 1
  nhcHits.value = []
  nhcTotal.value = 0
  nhcCache.clear()
  ensureCatalog()
}

function onClear() {
  searchVersion += 1
  searching.value = false
  q.value = ''
  committed.value = ''
  shown.value = pageSize
  if (scope.value === 'all') browsing.value = false
  // 还没到点的预览作废，免得清掉之后又被它填回来。
  clearTimeout(previewTimer)
}

function browseCatalog() {
  searchVersion += 1
  searching.value = false
  q.value = ''
  committed.value = ''
  status.value = 'current'
  scope.value = 'all'
  drugFilter.value = 'all'
  consumableFilter.value = 'all'
  cat1.value = '全部'
  browsing.value = true
  shown.value = pageSize
  ensureCatalog()
}

function setScope(next: SearchScope) {
  if (scope.value === next && !onHome.value) return
  scope.value = next
  status.value = 'current'
  cat1.value = '全部'
  drugFilter.value = 'all'
  consumableFilter.value = 'all'
  browsing.value = true
  shown.value = pageSize
  ensureCatalog()
  // 规范不走本地目录，命中的是线上规范库那一段。切到这一档时若手上没有结果
  // （首页点进来、或刚点过返回首页把 nhc 清了），拿当前关键词补一次；
  // 关键词不足两字时 refreshNhc 自己会清空早返回，不会白发请求。
  if (next === 'spec' && !nhcHits.value.length) void refreshNhc(committed.value)
}

function openFilters() {
  draftStatus.value = status.value
  draftDrugFilter.value = drugFilter.value
  draftConsumableFilter.value = consumableFilter.value
  draftCategory.value = cat1.value
  uni.hideKeyboard()
  uni.hideTabBar({ animation: false, fail: () => undefined })
  filterOpen.value = true
}

function closeFilters() {
  if (!filterOpen.value) return
  filterOpen.value = false
  uni.showTabBar({ animation: false, fail: () => undefined })
}

function resetDraftFilters() {
  draftStatus.value = 'current'
  draftDrugFilter.value = 'all'
  draftConsumableFilter.value = 'all'
  draftCategory.value = '全部'
}

function applyFilters() {
  status.value = draftStatus.value
  drugFilter.value = draftDrugFilter.value
  consumableFilter.value = draftConsumableFilter.value
  cat1.value = draftCategory.value
  shown.value = pageSize
  closeFilters()
}

function detailUrl(item: SearchItem) {
  const key = isDrug(item) ? 'drug' : 'id'
  return `/pages/detail/detail?${key}=${encodeURIComponent(item.id)}`
}

function openDetail(item: SearchItem) {
  uni.navigateTo({ url: detailUrl(item) })
}

function openGraph() {
  uni.navigateTo({ url: '/pages/graph/graph' })
}

/** 参考资料汇编：全国／上海市／山东省的目录原文，和本地目录分开的一份数据。 */
function openRef() {
  uni.navigateTo({ url: '/pages/ref/ref' })
}

/** 技术规范检索命中的是规范本身，不是收费项目，所以进规范页而不是详情页。 */
function openSpec(code: string) {
  uni.navigateTo({ url: `/pages/spec/spec?code=${encodeURIComponent(code)}` })
}

/** 规范卡和目录卡在同一个列表里渲染，进哪个页面按条目的性质分发。 */
function openCard(item: SearchItem) {
  if (isSpec(item)) openSpec(item.code)
  else openDetail(item)
}

// 按 id 预先算好 hop 并存起来。直接在模板里调 relatedOf 每次渲染都会返回新数组，
// 微信小程序会把整个结果列表当成变了、每敲一个字就重发一遍 —— 输入卡顿的根源。
// 摊平只扫一遍 edges；逐个条目调 relatedOf 的话是 17851 × 492 ≈ 878 万次比较，
// 正好卡在第一次出结果那一刻。
const EMPTY_HOPS: Array<{ item: SearchItem; rel: string }> = []
/** 固定的空数组：写 `|| []` 每次渲染都是新引用，小程序会认为数据变了整列重发。 */
const NO_PHARMA: PharmacopoeiaHit[] = []
const hopsIndex = computed(() => buildHopIndex(hopEdges.value, byId.value))

function hopsOf(item: SearchItem) {
  return hopsIndex.value.get(item.id) || EMPTY_HOPS
}

function jumpTo(id: string) {
  const hit = byId.value.get(id)
  if (hit) uni.navigateTo({ url: detailUrl(hit) })
  else uni.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
}

function loadMore() {
  if (specActive.value) {
    void loadMoreNhc()
    return
  }
  if (remoteActive.value) {
    void loadMoreRemote()
    return
  }
  if (listHasMore.value) shown.value += pageSize
}

/** 滚到底自己翻页。以前只有底部那个按钮，结果多的时候要一直点。
 *  规范档走线上分页，目录档只是把本地结果多显示一页，都不扣查询次数。 */
onReachBottom(() => {
  if (browsing.value && listHasMore.value) loadMore()
})

function wipeHistory() {
  history.value = clearHistory()
}

function dropHistory(text: string) {
  history.value = removeHistory(text)
}

function localizedHint(text: string) {
  if (text === '已合并') return t('status.merged')
  if (text === '在用') return t('status.active')
  if (text === '已停用') return t('status.stopped')
  return text
}

function onInput(e: { detail: { value: string } }) {
  searchVersion += 1
  searching.value = false
  q.value = e.detail.value
  // 已登录的用户，结果跟着字走，不必再等点查询按钮：目录检索全在本地，
  // 倒排索引本来就是为这一下准备的。
  // 查询次数只在点按钮、热词、历史词时扣（commitSearch），这里绝不能扣 ——
  // 否则每敲一个字都烧掉一次配额。没登录的人也不在这里出结果：
  // 查询要先登录，那道门在 requestSearch 里，预览不能绕过它。
  schedulePreview()
}

/** 连着打字只算最后一次。80 毫秒和图谱搜索框同一个拍子，敲得快的时候不会每字都重排一遍。 */
let previewTimer = 0

function schedulePreview() {
  clearTimeout(previewTimer)
  const version = searchVersion
  previewTimer = setTimeout(() => {
    if (version !== searchVersion) return
    applyPreview()
  }, 80) as unknown as number
}

function applyPreview() {
  if (!registered.value) return
  const next = q.value.trim()
  if (committed.value === next && (next || browsing.value)) return
  committed.value = next
  browsing.value = Boolean(next) || scope.value !== 'all'
  shown.value = pageSize
  if (next) {
    void refreshRemote()
    void refreshNhc(next)
  }
}

onShow(() => {
  applyChrome()
})
onHide(closeFilters)

onLoad((query) => {
  applyChrome()
  enableShare()
  // 分享链接带 ?q= 进来：先把查询填上再等目录，别让用户对着空首页等。
  applySharedQuery(routeValue(query?.q))
  void metaReady().then((data) => { meta.value = data }).catch(() => undefined)
  ensureCatalog()
})

const shareTitle = computed(() =>
  committed.value ? `${t('app.catalog')}: ${committed.value}` : t('home.share'),
)

onShareAppMessage(() => ({
  title: shareTitle.value,
  // 首页是 tabBar 页，路径就是 /pages/index/index；带 q 让对面直接看到同一批结果。
  path: `/pages/index/index${committed.value ? `?q=${encodeURIComponent(committed.value)}` : ''}`,
}))

onShareTimeline(() => ({
  title: shareTitle.value,
  query: shareQuery({ q: committed.value }),
}))
</script>

<template>
  <page-meta :page-style="filterOpen ? 'overflow: hidden;' : ''" />
  <view class="yb-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <view v-if="!registered && !sessionBusy" class="home-notice">
      {{ t('home.loginRequired') }}
      <button class="yb-btn is-ghost" @click="goLogin">{{ t('me.freeLogin') }}</button>
    </view>
    <!-- 搜索状态下的顶栏：返回首页钉在最上面最左侧。以前这颗按钮在搜索框和范围栏下面，
         而且完全没有任何样式 —— 字面就是个裸的「‹ 返回首页」。 -->
    <view v-if="!onHome" class="top-bar">
      <view class="back-home" hover-class="is-press" :hover-stay-time="80" @click="backHome">
        <view class="back-chevron" />
        <text class="back-text">{{ t('home.backHome') }}</text>
      </view>
      <text class="back-where">{{ scope === 'all' ? t('home.browse') : t(scopeKeys[scope]) }}</text>
    </view>

    <view v-if="onHome" class="hero-copy yb-in">
      <image class="hero-logo" src="/static/logo.png" mode="aspectFit" />
      <view class="hero-text">
        <view class="hero-kicker">{{ t('home.kicker') }}</view>
        <view class="hero-title">{{ t('home.title') }}</view>
      </view>
    </view>

    <view class="search-box" :class="{ 'is-on': focused }">
      <view class="search-icon">⌕</view>
      <input
        class="search-input"
        :class="{ 'is-tibetan': tibetanQuery }"
        :maxlength="80"
        :value="q"
        confirm-type="search"
        hold-keyboard
        adjust-position
        :cursor-spacing="24"
        :placeholder="onHome ? t('home.searchPlaceholder') : t('home.searchMore')"
        placeholder-class="search-placeholder"
        @input="onInput"
        @confirm="onConfirm"
        @focus="focused = true"
        @blur="focused = false"
      />
      <view class="search-clear" :class="{ 'is-hidden': !q }" hover-class="is-press" :hover-stay-time="80" @click="onClear">×</view>
      <button class="search-submit" :loading="searching" @click="onConfirm">{{ t('tab.search') }}</button>
    </view>

    <SearchTermsNotice :query="q" />
    <view class="scope-tabs">
      <view v-for="option in scopes" :key="option" class="scope-tab"
        :class="{ 'is-on': scope === option }" hover-class="is-press" :hover-stay-time="80"
        @click="setScope(option)">{{ t(scopeKeys[option]) }}</view>
    </view>

    <view v-if="onHome" class="yb-in yb-in-2">
      <view v-if="homeNotice" class="home-notice">{{ homeNotice }}</view>
      <view v-if="error" class="home-notice">{{ error }}<button class="yb-btn is-ghost" @click="ensureCatalog(true)">{{ t('audit.retry') }}</button></view>
      <view v-else-if="warnings.length" class="home-notice">{{ t('audit.partialCatalog') }}<button class="yb-btn is-ghost" :disabled="catalogBusy" @click="ensureCatalog(true)">{{ t('audit.retry') }}</button></view>
      <view class="home-suggest">
        <view v-if="history.length" class="home-block">
          <view class="home-block-head">
            <text class="h">{{ t('home.history') }}</text>
            <text class="history-more" hover-class="is-press" :hover-stay-time="80" @click="wipeHistory">{{ t('home.clear') }}</text>
          </view>
          <view class="chips chips-left">
            <view v-for="row in history" :key="row.q" class="chip chip-history" hover-class="is-press" :hover-stay-time="80">
              <text class="chip-text" @click="requestSearch(row.q)">{{ ct(row.q) }}</text>
              <text class="chip-x" hover-class="is-press" :hover-stay-time="80" @click="dropHistory(row.q)">×</text>
            </view>
          </view>
        </view>
        <view v-if="hotItems.length" class="home-block">
          <view class="home-block-head">
            <text class="h">{{ t('home.common') }}</text>
          </view>
          <view class="chips chips-left">
            <view v-for="row in hotItems" :key="row.q" class="chip" hover-class="is-press" :hover-stay-time="80" @click="requestSearch(row.q)">
              {{ ct(row.q) }}<text v-if="row.hint" class="chip-hint">{{ localizedHint(row.hint) }}</text>
            </view>
          </view>
        </view>
        <view class="home-block">
          <view class="home-block-head">
            <text class="h">{{ t('home.entries') }}</text>
          </view>
          <view class="entry-row">
            <view class="entry" hover-class="is-press" :hover-stay-time="80" @click="browseCatalog">
              <text class="entry-title">{{ t('home.browse') }}</text>
              <text class="entry-arrow">›</text>
            </view>
            <view class="entry" hover-class="is-press" :hover-stay-time="80" @click="openGraph">
              <text class="entry-title">{{ t('home.graph') }}</text>
              <text class="entry-arrow">›</text>
            </view>
            <view class="entry" hover-class="is-press" :hover-stay-time="80" @click="openRef">
              <text class="entry-title">{{ t('ref.nav') }}</text>
              <text class="entry-sub">{{ t('ref.eyebrow') }}</text>
              <text class="entry-arrow">›</text>
            </view>
          </view>
        </view>
      </view>
      <view v-if="heroMeta" class="hero-meta">{{ heroMeta }}</view>
      <LoadingBar v-if="loading && !error" :percent="catalogBar" />
      <view class="site-foot">
        <view>{{ t('common.disclaimerShort') }}</view>
        <view>{{ t('common.powered') }}</view>
        <!-- 文案里自带微信号（contact.action 三个语言都带），复制失败时也还能照着输 -->
        <view class="site-link" hover-class="is-press" :hover-stay-time="80" @click="openWeChat">{{ t('contact.action') }}</view>
      </view>
    </view>

    <view v-else>
      <ContentNotice />
      <view v-if="warnings.length && !error" class="home-notice">{{ t('audit.partialCatalog') }}<button class="yb-btn is-ghost" :disabled="catalogBusy" @click="ensureCatalog(true)">{{ t('audit.retry') }}</button></view>
      <view v-if="scope === 'all' || scope === 'service'" class="level-hint muted">{{ t('home.priceHint', { level: levelLabel(hospitalLevel) }) }}</view>
      <view v-if="scope !== 'all' && scope !== 'spec'" class="filter-toolbar">
        <text class="filter-summary">{{ filterSummary }}</text>
        <button class="filter-trigger" :class="{ 'is-on': filterCount }" hover-class="is-press" @click="openFilters">
          {{ t('search.filters') }}<text v-if="filterCount" class="filter-count">{{ filterCount }}</text><text class="filter-arrow">⌄</text>
        </button>
      </view>
      <view v-if="loading && !remoteRows.length" class="muted pad">
        {{ t('home.loadingCatalog') }}
        <LoadingBar :percent="catalogBar" />
      </view>
      <view v-else-if="error && !remoteRows.length" class="muted pad">{{ error }}<button class="yb-btn is-ghost" @click="ensureCatalog(true)">{{ t('audit.retry') }}</button></view>
      <view v-else-if="specActive ? !specRows.length : (pageRows.length === 0 && !nhcHits.length)" class="muted pad">{{ specActive ? (committed ? t('spec.searchEmpty') : t('spec.search')) : committed ? t('home.notFound', { query: committed }) : t('common.none') }}<button v-if="!specActive && filterCount" class="yb-btn is-ghost" @click="openFilters">{{ t('audit.adjustFilters') }}</button></view>
      <view v-else>
        <view v-if="specActive" class="result-summary yb-in">{{ t('search.specCount', { count: nhcTotal }) }}</view>
        <view v-else class="result-summary yb-in">{{ t('search.resultCount', { count: remoteActive ? remoteTotal : hits.length, services: serviceCount, drugs: drugCount, consumables: consumableCount }) }}</view>
        <!-- 规范那一句「不作为价格、报销依据」整档说一次就够，不必每张卡重复 -->
        <view v-if="specActive" class="muted spec-note">{{ t('spec.note') }}</view>
        <view class="result-list" :class="{ 'is-fresh': listFresh }">
          <view v-for="item in listRows" :key="item.id" class="result-row">
            <ResultCard
              :item="item"
              :level="hospitalLevel"
              :hops="hopsOf(item)"
              :pharmacopoeia="pharmaByName[item.name] || NO_PHARMA"
              @open="openCard(item)"
              @warm="prefetchDetail(item)"
              @jump="jumpTo"
            />
          </view>
        </view>
<view v-if="listHasMore" class="yb-btn is-ghost" hover-class="is-press" :hover-stay-time="80" @click="loadMore">{{ t('home.loadMore') }}</view>
      </view>
      <!-- 规范档自己就是那个列表，这段独立小节只在别的档里兜底，免得同一批规范出现两遍 -->
      <view v-if="nhcHits.length && !specActive" class="surface">
        <view class="section-label">{{ t('spec.title') }} · {{ nhcTotal }}</view>
        <view class="muted">{{ t('spec.note') }}</view>
        <view v-for="row in nhcHits" :key="row.code" class="guide-row is-tap" :class="{ 'is-fresh': specFresh }" hover-class="is-press" :hover-stay-time="80" @click="openSpec(row.code)">
          <view class="dt">{{ row.name }}</view>
          <view class="dd">{{ row.code }} · {{ t('spec.pageLabel', { page: row.page }) }}</view>
          <text class="guide-row-arrow">›</text>
        </view>
        <view v-if="nhcHits.length < nhcTotal" class="yb-btn is-ghost" hover-class="is-press" :hover-stay-time="80" @click="loadMoreNhc">{{ t('home.loadMore') }}</view>
      </view>
    </view>

    <view v-if="filterOpen" class="filter-layer">
      <view class="filter-backdrop" @click="closeFilters" @touchmove.stop.prevent />
      <view class="filter-sheet" @touchmove.stop>
        <view class="filter-sheet-head">
          <view class="filter-sheet-title">{{ t('search.filters') }} · {{ t(scopeKeys[scope]) }}</view>
          <button class="filter-close" hover-class="is-press" @click="closeFilters">{{ t('search.cancel') }}</button>
        </view>
        <scroll-view scroll-y :show-scrollbar="false" class="filter-options">
          <view v-if="scope === 'consumable'" class="filter-section">
            <view class="filter-section-title">{{ t('search.hcKind') }}</view>
            <view class="filter-grid hc-filters">
              <button v-for="filter in hcFilters" :key="filter" class="filter-option" :class="{ 'is-on': draftConsumableFilter === filter }"
                hover-class="is-press" @click="draftConsumableFilter = filter">{{ hcFilterLabel(filter) }}</button>
            </view>
          </view>
          <view v-if="scope !== 'spec'" class="filter-section">
            <view class="filter-section-title">{{ scope === 'drug' ? t('search.coverage') : t('search.status') }}</view>
            <view v-if="scope === 'drug'" class="filter-grid drug-filters">
              <button v-for="filter in drugFilters" :key="filter" class="filter-option" :class="{ 'is-on': draftDrugFilter === filter }"
                hover-class="is-press" @click="draftDrugFilter = filter">{{ t('search.drugFilter.' + filter) }}</button>
            </view>
            <view v-else-if="scope === 'consumable'" class="filter-grid hc-status-filters">
              <button v-for="filter in consumableFilters" :key="filter.value" class="filter-option" :class="{ 'is-on': draftStatus === filter.value }"
                hover-class="is-press" @click="draftStatus = filter.value">{{ filter.label }}</button>
            </view>
            <view v-else class="filter-grid service-filters">
              <button v-for="filter in serviceFilters" :key="filter.value" class="filter-option" :class="{ 'is-on': draftStatus === filter.value }"
                hover-class="is-press" @click="draftStatus = filter.value">{{ filter.label }}</button>
            </view>
          </view>
          <view v-if="scope !== 'consumable' && scope !== 'spec'" class="filter-section">
            <view class="filter-section-title">{{ t('search.category') }}</view>
            <view class="filter-grid category-filters">
              <button class="filter-option" :class="{ 'is-on': draftCategory === '全部' }" hover-class="is-press" @click="draftCategory = '全部'">{{ t('common.all') }}</button>
              <button v-for="c in categories" :key="c.value" class="filter-option" :class="{ 'is-on': draftCategory === c.value }"
                hover-class="is-press" @click="draftCategory = c.value">{{ c.label }}</button>
            </view>
          </view>
        </scroll-view>
        <view class="filter-sheet-actions">
          <button class="filter-reset" hover-class="is-press" @click="resetDraftFilters">{{ t('search.reset') }}</button>
          <button class="filter-apply" hover-class="is-press" @click="applyFilters">{{ t('search.apply') }}</button>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.scope-tabs {
  display: flex;
  gap: 8rpx;
  padding: 8rpx;
  margin: 20rpx 0;
  border-radius: 24rpx;
  background: var(--yb-level-track);
}
.scope-tab {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 76rpx;
  padding: 18rpx 8rpx;
  box-sizing: border-box;
  border-radius: 18rpx;
  font-size: 27rpx;
  line-height: 1.5;
  text-align: center;
  color: var(--yb-text-2);
  overflow-wrap: anywhere;
}
.scope-tab.is-on {
  color: var(--yb-primary);
  background: var(--yb-surface);
  font-weight: 700;
  box-shadow: 0 2rpx 8rpx rgba(26, 29, 38, 0.08);
}
/* 藏文/英文标签更长，会折成两行；行高压到 1.6 并靠 flex 居中，四格才一样齐。 */
.lang-bo .scope-tab { line-height: 1.6; }
.lang-en .scope-tab { font-size: 25rpx; }
/* 首页三个去处：和上面的搜索历史胶囊分开，各自整行可点，长标题也能放下。
   参考资料那行多一句适用范围，所以三行高度不齐是故意的。 */
.entry-row { display: flex; flex-direction: column; gap: 12rpx; margin-top: 20rpx; }
.entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  min-height: 96rpx;
  padding: 20rpx 28rpx;
  box-sizing: border-box;
  border: 1rpx solid var(--yb-chip-border);
  border-radius: 24rpx;
  background: var(--yb-surface);
  transition: transform 0.14s ease;
}
.entry.is-press { transform: scale(0.98); }
.entry-title { flex: 1; min-width: 0; color: var(--yb-text); font-size: 28rpx; font-weight: 650; line-height: 1.5; }
.entry-sub { flex: none; max-width: 46%; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.4; text-align: right; }
.entry-arrow { flex: none; color: var(--yb-text-3); font-size: 36rpx; line-height: 1; }
.lang-bo .entry { min-height: 112rpx; }
.lang-bo .entry-title { line-height: 1.75; }
.lang-en .entry-sub { max-width: 58%; }
.filter-toolbar {
  display: flex;
  align-items: center;
  gap: 20rpx;
  margin: 20rpx 0;
}
.filter-summary { flex: 1; min-width: 0; font-size: 24rpx; color: var(--yb-text-3); overflow-wrap: anywhere; }
.filter-trigger {
  display: flex;
  align-items: center;
  gap: 10rpx;
  flex-shrink: 0;
  margin: 0;
  padding: 16rpx 24rpx;
  border-radius: 18rpx;
  font-size: 26rpx;
  line-height: 1.5;
  color: var(--yb-text);
  background: var(--yb-surface);
  border: 1rpx solid var(--yb-border);
}
.filter-trigger.is-on { color: var(--yb-primary); border-color: var(--yb-chip-on-border); }
.filter-count { font-weight: 700; }
.filter-arrow { margin-left: 4rpx; }
.filter-layer { position: fixed; inset: 0; z-index: 1000; }
.filter-backdrop { position: absolute; inset: 0; background: rgba(13, 23, 42, 0.42); }
.filter-sheet {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  height: 80vh;
  border-radius: 32rpx 32rpx 0 0;
  background: var(--yb-surface);
  color: var(--yb-text);
  overflow: hidden;
}
.filter-sheet-head { display: flex; align-items: center; gap: 20rpx; padding: 30rpx 32rpx 24rpx; border-bottom: 1rpx solid var(--yb-border); }
.filter-sheet-title { flex: 1; min-width: 0; font-size: 32rpx; font-weight: 700; overflow-wrap: anywhere; }
.filter-close { flex-shrink: 0; margin: 0; padding: 12rpx 0 12rpx 16rpx; background: transparent; color: var(--yb-text-2); font-size: 26rpx; line-height: 1.5; }
.filter-options { flex: 1; height: 0; min-height: 0; }
.filter-section { padding: 28rpx 32rpx 12rpx; }
.filter-section:last-child { padding-bottom: 32rpx; }
.filter-section-title { margin-bottom: 18rpx; color: var(--yb-text-2); font-size: 26rpx; font-weight: 600; }
.filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16rpx; }
.filter-option {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 88rpx;
  margin: 0;
  padding: 18rpx 16rpx;
  border: 2rpx solid transparent;
  border-radius: 16rpx;
  background: var(--yb-bg);
  color: var(--yb-text-2);
  font-size: 26rpx;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.filter-option.is-on { border-color: var(--yb-primary); color: var(--yb-primary); background: var(--yb-primary-soft); font-weight: 600; }
.filter-sheet-actions {
  display: flex;
  gap: 20rpx;
  padding: 24rpx 32rpx;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid var(--yb-border);
}
.filter-reset, .filter-apply { margin: 0; padding: 22rpx 16rpx; min-width: 0; border-radius: 20rpx; font-size: 28rpx; line-height: 1.5; }
.filter-reset { flex: 1; background: var(--yb-bg); color: var(--yb-text-2); }
.filter-apply { flex: 2; background: var(--yb-primary); color: var(--yb-btn-fg); }
.filter-layer button::after, .filter-trigger::after { border: 0; }
.lang-bo .filter-option, .lang-bo .filter-sheet-title, .lang-bo .filter-summary { line-height: 1.9; }
.level-hint {
  margin: 20rpx 0 0;
  font-size: 24rpx;
}
.chip-hint {
  margin-left: 12rpx;
  color: var(--yb-text-3);
  font-size: 22rpx;
}
.search-icon {
  font-size: 36rpx;
  line-height: 1;
}
.search-submit { flex: none; margin: 0; padding: 14rpx 18rpx; border-radius: 20rpx; background: var(--yb-primary); color: var(--yb-btn-fg); font-size: 25rpx; line-height: 1.5; }
.search-submit::after { border: 0; }
.search-input.is-tibetan { font-family: 'QhybTibetan', 'Microsoft Himalaya', serif; font-size: 30rpx; }
.lang-bo .search-submit { line-height: 1.9; }
/* 规范命中是可以点开原文的，所以给它一个卡片的样子，而不是一段说明文字。 */
.guide-row.is-tap { display: flex; align-items: center; gap: 12rpx; margin: 0 0 12rpx; padding: 18rpx 20rpx; border: 1rpx solid var(--yb-border); border-radius: 18rpx; background: var(--yb-bg); }
/* 网络回来才出现的这几张卡，跟着结果一起长出来。is-fresh 只在换关键词时重新加上，
   翻页追加的不播。关键帧写在页面里：页面样式是隔离的，全局的 yb-in 在这里取不到。 */
@keyframes yb-spec-in {
  from { opacity: 0; transform: translateY(16rpx); }
  to { opacity: 1; transform: translateY(0); }
}
.guide-row.is-tap.is-fresh { animation: yb-spec-in 0.3s cubic-bezier(0.22, 0.8, 0.3, 1) both; }
.guide-row.is-tap.is-fresh:nth-child(3) { animation-delay: 0.04s; }
.guide-row.is-tap.is-fresh:nth-child(4) { animation-delay: 0.08s; }
.guide-row.is-tap.is-fresh:nth-child(5) { animation-delay: 0.12s; }
.guide-row.is-tap.is-fresh:nth-child(6) { animation-delay: 0.16s; }
.guide-row.is-tap.is-fresh:nth-child(7) { animation-delay: 0.2s; }
.guide-row.is-tap.is-fresh:nth-child(n + 8) { animation: none; }
.guide-row.is-tap:last-child { margin-bottom: 0; }
.guide-row.is-tap .dt { min-width: 0; flex: 1; margin: 0; color: var(--yb-text); font-size: 27rpx; font-weight: 400; }
.guide-row.is-tap .dd { flex: none; margin: 0; color: var(--yb-text-3); font-size: 21rpx; white-space: nowrap; }
.guide-row-arrow { flex: none; color: var(--yb-text-3); font-size: 34rpx; }
/* 规范档的摘要下面那一句免责：比摘要再淡一档，别抢了条数。 */
.spec-note { margin: 0 0 20rpx; font-size: 23rpx; }
</style>
