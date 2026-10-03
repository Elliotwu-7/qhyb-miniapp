<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import ContentNotice from '../../components/ContentNotice.vue'
import HomePill from '../../components/HomePill.vue'
import { mpRefItem, mpRefMeta, mpRefSearch, type RefItem, type RefMeta, type RefMetaDataset } from '../../lib/api'
import { localeClass, t } from '../../lib/i18n'
import { REF_PAGE_SIZE, REF_PART_LIMIT, REF_SCOPES, activeDataset, refDetailRows, refFieldLabel, refKindLabel, refScopeClass, refScopeCount, refScopeLabel } from '../../lib/refData'
import { routeValue } from '../../lib/route'
import { enableShare, shareQuery } from '../../lib/share'
import { applyChrome, themeMode } from '../../lib/theme'

const meta = ref<RefMeta | null>(null)
const metaFailed = ref(false)
const scope = ref(REF_SCOPES[0])
const ds = ref('')
const part = ref('')
const text = ref('')
const query = ref('')
const rows = ref<RefItem[]>([])
const total = ref(0)
const listLoading = ref(false)
const listFailed = ref(false)
/** 当前展开的那一条：明细要单独问接口，搜索包里没有长文本。 */
const openId = ref('')
const openItem = ref<RefItem | null>(null)
const openLoading = ref(false)
/** 取明细的请求序号：晚回来的旧请求不能盖掉新点开的那条。 */
let openRequest = 0
/** 取列表的请求序号：连点几个筛选条件时，先发的那条晚回来不能把新结果顶掉。 */
let listRequest = 0

const scopes = computed(() => (meta.value?.scopeOrder?.length ? meta.value.scopeOrder : REF_SCOPES))
const inScope = computed<RefMetaDataset[]>(() => {
  const list = meta.value?.datasets || []
  return list.filter((row) => !scope.value || row.scope === scope.value)
})
const dataset = computed(() => activeDataset(inScope.value, ds.value))
const parts = computed(() => {
  const map = dataset.value?.parts || {}
  return Object.keys(map).map((name) => ({ name, count: map[name] }))
})
const detailRows = computed(() => refDetailRows(openItem.value))
const hasMore = computed(() => rows.value.length < total.value)

/**
 * 链接直接指过来的那一条不一定落在当前这一页 —— 甚至不一定在当前筛选范围内。
 * 那样它就只有状态、没有卡片可展开。把它插到列表最前面，和网页版的右侧明细一样看得见。
 */
const listRows = computed(() => {
  const item = openItem.value
  if (!item) return rows.value
  let found = false
  rows.value.forEach((row) => {
    if (row.id === item.id) found = true
  })
  return found ? rows.value : [item].concat(rows.value)
})

/** 深链那一条还没取回来时，列表里没有它的卡片，得单独说一声「正在取明细」。 */
const pendingOutside = computed(() => {
  if (!openId.value || openItem.value || !openLoading.value) return false
  let found = false
  rows.value.forEach((row) => {
    if (row.id === openId.value) found = true
  })
  return !found
})

function loadMeta() {
  mpRefMeta()
    .then((data) => {
      if (data?.ok) meta.value = data
      else metaFailed.value = true
    })
    .catch(() => {
      metaFailed.value = true
    })
}

function loadList() {
  listLoading.value = true
  listFailed.value = false
  const version = ++listRequest
  mpRefSearch({ q: query.value, scope: scope.value, ds: ds.value, part: part.value, limit: REF_PAGE_SIZE, offset: 0 })
    .then((data) => {
      if (version !== listRequest) return
      rows.value = data?.items || []
      total.value = data?.total || 0
    })
    .catch(() => {
      if (version !== listRequest) return
      rows.value = []
      total.value = 0
      listFailed.value = true
    })
    .finally(() => {
      if (version === listRequest) listLoading.value = false
    })
}

function loadMore() {
  if (listLoading.value || !hasMore.value) return
  listLoading.value = true
  const version = listRequest
  mpRefSearch({ q: query.value, scope: scope.value, ds: ds.value, part: part.value, limit: REF_PAGE_SIZE, offset: rows.value.length })
    .then((data) => {
      // 期间换了筛选条件的话，这一页已经不是同一批结果了，丢掉。
      if (version !== listRequest) return
      rows.value = rows.value.concat(data?.items || [])
      total.value = data?.total || total.value
    })
    .catch(() => {
      /* 已经看到的那一屏留着，下一页失败不该把它清掉 */
    })
    .finally(() => {
      if (version === listRequest) listLoading.value = false
    })
}

function openRow(row: RefItem) {
  if (openId.value === row.id) {
    openId.value = ''
    openItem.value = null
    return
  }
  openId.value = row.id
  openItem.value = null
  openLoading.value = true
  const version = ++openRequest
  mpRefItem(row.id)
    .then((data) => {
      if (version !== openRequest) return
      openItem.value = data?.item || null
    })
    .catch(() => {
      if (version !== openRequest) return
      openItem.value = null
    })
    .finally(() => {
      if (version === openRequest) openLoading.value = false
    })
}

function pickScope(next: string) {
  if (next === scope.value) return
  scope.value = next
  ds.value = ''
  part.value = ''
  openId.value = ''
  openItem.value = null
  loadList()
}

function pickDataset(next: string) {
  ds.value = ds.value === next ? '' : next
  part.value = ''
  openId.value = ''
  openItem.value = null
  loadList()
}

function pickPart(next: string) {
  part.value = part.value === next ? '' : next
  openId.value = ''
  openItem.value = null
  loadList()
}

// 输入防抖：每敲一个字就发一次请求，手机上一次检索要几百毫秒，列表会一直闪。
let debounce = 0
watch(text, (value) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = 0
    query.value = value.trim()
    openId.value = ''
    openItem.value = null
    loadList()
  }, 300) as unknown as number
})

onLoad((params) => {
  applyChrome()
  enableShare()
  loadMeta()
  const seed = routeValue(params?.ref)
  if (seed) {
    openId.value = seed
    openLoading.value = true
    mpRefItem(seed)
      .then((data) => {
        openItem.value = data?.item || null
      })
      .catch(() => {
        openItem.value = null
      })
      .finally(() => {
        openLoading.value = false
      })
  }
  loadList()
})

onShow(() => applyChrome())

const shareTitle = computed(() => {
  if (openItem.value) return t('ref.shareItem', { name: openItem.value.name })
  return t('ref.share')
})

onShareAppMessage(() => ({
  title: shareTitle.value,
  path: `/pages/ref/ref${openId.value ? `?ref=${encodeURIComponent(openId.value)}` : ''}`,
}))

onShareTimeline(() => ({ title: shareTitle.value, query: shareQuery({ ref: openId.value }) }))
</script>

<template>
  <view class="yb-page ref-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <HomePill />
    <view class="ref-head">
      <view class="ref-eyebrow">{{ t('ref.eyebrow') }}</view>
      <view class="ref-title">{{ t('ref.title') }}</view>
      <view class="ref-sub">{{ t('ref.sub') }}</view>
    </view>

    <ContentNotice />

    <view v-if="metaFailed" class="ref-notice">{{ t('ref.metaFailed') }}</view>

    <!-- 适用范围是这一页的主轴：三份来源互不合并、不换算，也不互相替代 -->
    <view class="ref-scopes">
      <view
        v-for="name in scopes"
        :key="name"
        class="ref-scope-tab"
        :class="[refScopeClass(name), { 'is-on': scope === name }]"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="pickScope(name)"
      >
        <text class="ref-scope-name">{{ refScopeLabel(name) }}</text>
        <text class="ref-scope-count">{{ refScopeCount(meta, name) }}</text>
      </view>
    </view>

    <view class="ref-search">
      <text class="ref-search-icon">⌕</text>
      <input v-model="text" class="ref-search-input" type="text" :placeholder="t('ref.searchPlaceholder')" confirm-type="search" />
      <text v-if="text" class="ref-search-clear" hover-class="is-press" :hover-stay-time="80" @click="text = ''">×</text>
    </view>

    <view class="ref-count">{{ listLoading && !rows.length ? t('ref.loading') : t('ref.count', { count: total }) }}</view>

    <view v-if="inScope.length > 1" class="ref-chips ref-dataset-chips">
      <view class="ref-chip" :class="{ 'is-on': !ds }" hover-class="is-press" :hover-stay-time="80" @click="pickDataset('')">{{ t('ref.allDatasets') }}</view>
      <view
        v-for="row in inScope"
        :key="row.key"
        class="ref-chip"
        :class="{ 'is-on': ds === row.key }"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="pickDataset(row.key)"
      >
        {{ row.short }}<text class="ref-chip-count">{{ row.count }}</text>
      </view>
    </view>

    <view v-if="parts.length > 1 && parts.length <= REF_PART_LIMIT" class="ref-chips ref-part-chips">
      <view class="ref-chip" :class="{ 'is-on': !part }" hover-class="is-press" :hover-stay-time="80" @click="pickPart('')">{{ t('ref.allParts') }}</view>
      <view
        v-for="row in parts"
        :key="row.name"
        class="ref-chip"
        :class="{ 'is-on': part === row.name }"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="pickPart(row.name)"
      >
        {{ row.name }}<text class="ref-chip-count">{{ row.count }}</text>
      </view>
    </view>

    <view v-if="listFailed" class="ref-notice">{{ t('ref.listFailed') }}</view>
    <view v-else-if="!rows.length && !listLoading" class="ref-notice">{{ t('ref.empty') }}</view>
    <view v-if="pendingOutside" class="ref-notice">{{ t('ref.detailLoading') }}</view>

    <view v-for="row in listRows" :key="row.id" class="ref-card">
      <view class="ref-card-main" hover-class="is-press" :hover-stay-time="80" @click="openRow(row)">
        <view class="ref-card-tags">
          <text class="ref-badge" :class="refScopeClass(row.scope)">{{ refScopeLabel(row.scope) }}</text>
          <text class="ref-kind">{{ refKindLabel(row.kind) }}</text>
          <text v-if="row.part" class="ref-part">{{ row.part }}</text>
        </view>
        <view class="ref-name">{{ row.name }}</view>
        <view class="ref-card-meta">
          <text v-if="row.code">{{ t('ref.code') }} {{ row.code }}</text>
          <text v-if="row.form">{{ row.form }}</text>
          <text v-if="row.payClass">{{ row.payClass }}</text>
          <text v-if="row.price">{{ row.price }} {{ t('ref.yuan') }}</text>
        </view>
        <view v-if="row.alias" class="ref-alias">{{ row.alias }}</view>
      </view>

      <view v-if="openId === row.id" class="ref-detail">
        <view v-if="openLoading" class="muted">{{ t('ref.detailLoading') }}</view>
        <template v-else-if="openItem">
          <view class="ref-fields">
            <view class="ref-field"><text class="ref-field-key">{{ t('ref.dataset') }}</text><text class="ref-field-value">{{ openItem.ds }}</text></view>
            <view class="ref-field"><text class="ref-field-key">{{ t('ref.part') }}</text><text class="ref-field-value">{{ openItem.part || '—' }}</text></view>
            <view class="ref-field"><text class="ref-field-key">{{ t('ref.code') }}</text><text class="ref-field-value">{{ openItem.code || '—' }}</text></view>
            <view v-if="openItem.form" class="ref-field"><text class="ref-field-key">{{ t('ref.form') }}</text><text class="ref-field-value">{{ openItem.form }}</text></view>
            <view v-if="openItem.payClass" class="ref-field"><text class="ref-field-key">{{ t('ref.payClass') }}</text><text class="ref-field-value">{{ openItem.payClass }}</text></view>
            <view v-if="openItem.className" class="ref-field"><text class="ref-field-key">{{ t('ref.className') }}</text><text class="ref-field-value">{{ openItem.className }}</text></view>
            <view v-if="openItem.protocol" class="ref-field"><text class="ref-field-key">{{ t('ref.protocol') }}</text><text class="ref-field-value">{{ openItem.protocol }}</text></view>
            <view v-if="openItem.price" class="ref-field"><text class="ref-field-key">{{ t('ref.price') }}</text><text class="ref-field-value">{{ openItem.price }}{{ openItem.unit ? ` / ${openItem.unit}` : '' }}</text></view>
            <view class="ref-field"><text class="ref-field-key">{{ t('ref.status') }}</text><text class="ref-field-value">{{ openItem.status || '—' }}</text></view>
          </view>
          <view v-if="openItem.alias" class="ref-block">
            <view class="ref-block-title">{{ t('ref.alias') }}</view>
            <view class="ref-block-body">{{ openItem.alias }}</view>
          </view>
          <view v-if="openItem.remark" class="ref-block">
            <view class="ref-block-title">{{ t('ref.remark') }}</view>
            <view class="ref-block-body">{{ openItem.remark }}</view>
          </view>
          <view v-for="field in detailRows" :key="field.key" class="ref-block">
            <view class="ref-block-title">{{ refFieldLabel(field.key) }}</view>
            <view class="ref-block-body">{{ field.value }}</view>
          </view>
          <view class="ref-note">{{ t('ref.idNote') }} {{ openItem.id }}</view>
        </template>
        <view v-else class="muted">{{ t('ref.detailFail') }}</view>
      </view>
    </view>

    <view v-if="hasMore && rows.length" class="ref-more" hover-class="is-press" :hover-stay-time="80" @click="loadMore">
      {{ listLoading ? t('ref.loading') : t('home.loadMore') }}
    </view>

    <view class="surface">
      <view class="section-label">{{ t('ref.about') }}</view>
      <view class="ref-note">{{ t('ref.aboutBody') }}</view>
      <view v-if="meta && meta.withheldNote" class="ref-note">{{ meta.withheldNote }}</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.ref-page { padding: 28rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); }
.ref-head { padding: 8rpx 8rpx 20rpx; }
.ref-eyebrow { color: var(--yb-primary); font-size: 22rpx; font-weight: 700; letter-spacing: .12em; }
.ref-title { margin-top: 8rpx; font-size: 46rpx; font-weight: 760; letter-spacing: -.04em; }
.ref-sub { margin-top: 8rpx; color: var(--yb-text-3); font-size: 23rpx; line-height: 1.5; }
.ref-notice { margin: 0 8rpx 16rpx; padding: 20rpx 22rpx; border: 1rpx solid var(--yb-border); border-radius: 20rpx; background: var(--yb-surface); color: var(--yb-text-3); font-size: 23rpx; line-height: 1.6; }
.ref-scopes { display: flex; gap: 12rpx; margin-bottom: 16rpx; }
.ref-scope-tab { min-width: 0; flex: 1; padding: 18rpx 12rpx 16rpx; border: 1rpx solid var(--yb-border); border-radius: 20rpx; background: var(--yb-surface); text-align: center; }
.ref-scope-name { display: block; overflow: hidden; color: var(--yb-text-2); font-size: 26rpx; font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }
.ref-scope-count { display: block; margin-top: 6rpx; color: var(--yb-text-3); font-size: 21rpx; }
.ref-scope-tab.is-on { border-color: var(--yb-chip-on-border); background: var(--yb-primary-soft); }
.ref-scope-tab.is-on .ref-scope-name { color: var(--yb-primary); }
/* 三个范围各给一个底色，扫一眼就知道自己在看谁的数据 */
.ref-scope-tab.is-on.is-cn { background: #e8f0ff; border-color: #b9cdfa; }
.ref-scope-tab.is-on.is-cn .ref-scope-name { color: #1d4ed8; }
.ref-scope-tab.is-on.is-sh { background: #fdeee4; border-color: #f3c9a8; }
.ref-scope-tab.is-on.is-sh .ref-scope-name { color: #c2410c; }
.ref-scope-tab.is-on.is-sd { background: #e3f5ec; border-color: #a9dcc2; }
.ref-scope-tab.is-on.is-sd .ref-scope-name { color: #047857; }
.ref-search { display: flex; align-items: center; gap: 10rpx; margin-bottom: 12rpx; padding: 0 14rpx; min-height: 76rpx; border: 1rpx solid var(--yb-border); border-radius: 18rpx; background: var(--yb-surface); }
.ref-search-icon { flex: none; color: var(--yb-text-3); font-size: 34rpx; line-height: 1; }
.ref-search-input { min-width: 0; flex: 1; height: 72rpx; border: 0; background: transparent; color: var(--yb-text); font-size: 25rpx; }
.ref-search-clear { width: 42rpx; height: 42rpx; flex: none; border-radius: 50%; background: var(--yb-clear-bg); color: var(--yb-text-3); font-size: 30rpx; line-height: 38rpx; text-align: center; }
.ref-count { margin: 0 8rpx 12rpx; color: var(--yb-text-3); font-size: 22rpx; }
.ref-chips { display: flex; flex-wrap: wrap; gap: 10rpx; margin-bottom: 14rpx; }
.ref-chip { max-width: 100%; padding: 12rpx 18rpx; border: 1rpx solid var(--yb-border); border-radius: 999rpx; background: var(--yb-surface); color: var(--yb-text-2); font-size: 23rpx; }
.ref-chip.is-on { border-color: var(--yb-chip-on-border); background: var(--yb-primary-soft); color: var(--yb-primary); font-weight: 700; }
.ref-chip-count { margin-left: 8rpx; color: var(--yb-text-3); font-size: 20rpx; }
.ref-card { margin-bottom: 14rpx; border: 1rpx solid var(--yb-border); border-radius: 22rpx; background: var(--yb-surface); overflow: hidden; }
.ref-card-main { padding: 20rpx 22rpx; }
.ref-card-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 10rpx; }
.ref-badge { padding: 4rpx 12rpx; border-radius: 8rpx; font-size: 20rpx; font-weight: 700; }
.ref-badge.is-cn { background: #e8f0ff; color: #1d4ed8; }
.ref-badge.is-sh { background: #fdeee4; color: #c2410c; }
.ref-badge.is-sd { background: #e3f5ec; color: #047857; }
.theme-dark .ref-badge.is-cn { background: #1e2f52; color: #9dbcff; }
.theme-dark .ref-badge.is-sh { background: #3d2617; color: #f0a878; }
.theme-dark .ref-badge.is-sd { background: #14342a; color: #6fd2a6; }
.ref-kind { color: var(--yb-text-3); font-size: 20rpx; }
.ref-part { max-width: 45%; overflow: hidden; padding: 4rpx 10rpx; border-radius: 8rpx; background: var(--yb-bg); color: var(--yb-text-3); font-size: 20rpx; white-space: nowrap; text-overflow: ellipsis; }
.ref-name { margin-top: 10rpx; color: var(--yb-text); font-size: 29rpx; font-weight: 700; line-height: 1.4; }
.ref-card-meta { display: flex; flex-wrap: wrap; gap: 8rpx 16rpx; margin-top: 8rpx; color: var(--yb-text-3); font-size: 21rpx; }
.ref-alias { display: -webkit-box; overflow: hidden; margin-top: 8rpx; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.ref-detail { padding: 0 22rpx 20rpx; border-top: 1rpx solid var(--yb-border); }
.ref-fields { margin-top: 16rpx; }
.ref-field { display: flex; gap: 16rpx; padding: 10rpx 0; border-bottom: 1rpx solid var(--yb-border); }
.ref-field:last-child { border-bottom: 0; }
.ref-field-key { width: 150rpx; flex: none; color: var(--yb-text-3); font-size: 22rpx; }
.ref-field-value { min-width: 0; flex: 1; color: var(--yb-text); font-size: 24rpx; line-height: 1.5; word-break: break-all; }
.ref-block { margin-top: 16rpx; }
.ref-block-title { color: var(--yb-text-2); font-size: 23rpx; font-weight: 700; }
.ref-block-body { margin-top: 6rpx; color: var(--yb-text); font-size: 24rpx; line-height: 1.7; white-space: pre-wrap; }
.ref-note { margin-top: 14rpx; color: var(--yb-text-3); font-size: 21rpx; line-height: 1.6; word-break: break-all; }
.ref-more { margin: 4rpx 0 20rpx; padding: 22rpx 0; border: 1rpx solid var(--yb-border); border-radius: 18rpx; background: var(--yb-surface); color: var(--yb-primary); font-size: 24rpx; text-align: center; }
.lang-bo .ref-title { line-height: 1.5; letter-spacing: 0; }
.lang-bo .ref-sub, .lang-bo .ref-note, .lang-bo .ref-block-body { line-height: 1.9; }
.lang-en .ref-scope-name { font-size: 23rpx; }
</style>
