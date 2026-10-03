<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import { useContentTranslation } from '../../lib/content'
import HomePill from '../../components/HomePill.vue'
import { localeClass, t } from '../../lib/i18n'
import { loadSpec, nhcSpecDocument, specNodeId, type SpecDetail } from '../../lib/nhcSpec'
import { drawerPrice } from '../../lib/price'
import { routeValue } from '../../lib/route'
import { hospitalLevel } from '../../lib/session'
import { enableShare, shareQuery } from '../../lib/share'
import { catalogReady } from '../../lib/store'
import { applyChrome, themeMode } from '../../lib/theme'
import { isDrug, type SearchItem } from '../../lib/types'

const MAX_ITEMS = 20

const code = ref('')
const detail = ref<SpecDetail | null>(null)
const loading = ref(true)
const failed = ref(false)
const itemsOpen = ref(false)
const textOpen = ref(false)
const byId = ref<Map<string, SearchItem>>(new Map())
const { ct } = useContentTranslation(true)

const spec = computed(() => detail.value?.spec || null)
/** 目录里找不到的编号不显示：宁可少一行，也不要摆一个点不开的编号。 */
const priced = computed(() => {
  const rows: SearchItem[] = []
  ;(detail.value?.items || []).forEach((id) => {
    const item = byId.value.get(id)
    if (item) rows.push(item)
  })
  return rows
})
const visibleItems = computed(() => (itemsOpen.value ? priced.value : priced.value.slice(0, MAX_ITEMS)))
const hiddenItems = computed(() => Math.max(0, priced.value.length - MAX_ITEMS))
/** 正文和全文通常是同一段，只有确实更长时才值得再占一屏。 */
const longText = computed(() => {
  const row = spec.value
  if (!row) return ''
  const full = row.fullText.trim()
  return full.length > row.detail.trim().length + 40 ? full : ''
})

function priceOf(item: SearchItem) {
  const level = hospitalLevel.value
  const raw = level === 'L2' ? item.priceL2 : level === 'L1' ? item.priceL1 : item.priceL3
  return drawerPrice(raw, item.remark)
}

function openItem(id: string) {
  const item = byId.value.get(id)
  if (!item) return
  const key = isDrug(item) ? 'drug' : 'id'
  uni.navigateTo({ url: `/pages/detail/detail?${key}=${encodeURIComponent(id)}` })
}

/** 规范进关联网络：它是定价的上游，图里以它为中心铺开由它形成的项目。 */
function openGraph() {
  const id = specNodeId(code.value)
  uni.navigateTo({ url: `/pages/graph/graph?id=${encodeURIComponent(id)}` })
}

/** 官方 PDF 打不开就复制链接：小程序没有 nhc.gov.cn 的业务域名，web-view 是白屏。 */
function copyPdf() {
  uni.setClipboardData({
    data: nhcSpecDocument().url,
    success: () => uni.showToast({ title: t('spec.pdfCopied'), icon: 'none' }),
  })
}

async function load(value: string) {
  loading.value = true
  failed.value = false
  // 结果变量声明在 try 外面：块里的 const 降级 ES5 时会提升成 var，
  // 撞上模块级绑定就把同函数里更早的引用顶成 undefined（见 README）。
  let data: Awaited<ReturnType<typeof catalogReady>> | null = null
  const found = await loadSpec(value)
  detail.value = found
  failed.value = !found
  loading.value = false
  if (!found) return
  // 目录只是用来把编号换成名称和价格，取不到也要让规范正文先看得到。
  try {
    data = await catalogReady()
    byId.value = data.byId
  } catch {
    byId.value = new Map()
  }
}

onLoad((query) => {
  applyChrome()
  enableShare()
  code.value = routeValue(query?.code)
  if (code.value) void load(code.value)
  else {
    failed.value = true
    loading.value = false
  }
})

onShow(() => applyChrome())

const shareTitle = computed(() => {
  const row = spec.value
  return row ? t('graph.share', { name: row.name }) : t('spec.head')
})

onShareAppMessage(() => ({
  title: shareTitle.value,
  path: `/pages/spec/spec?code=${encodeURIComponent(code.value)}`,
}))

onShareTimeline(() => ({ title: shareTitle.value, query: shareQuery({ code: code.value }) }))
</script>

<template>
  <view class="yb-page spec-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <HomePill />
    <view v-if="loading" class="muted pad">{{ t('spec.loading') }}</view>
    <view v-else-if="failed || !spec" class="spec-missing">
      <view class="spec-missing-title">{{ t('spec.notFound') }}</view>
      <view class="muted">{{ t('spec.loadFail') }}</view>
    </view>
    <template v-else>
      <view class="spec-head">
        <view class="spec-eyebrow">{{ t('spec.eyebrow') }}</view>
        <view class="spec-title">{{ spec.name }}</view>
        <view class="spec-sub">{{ t('spec.code') }} {{ spec.code }} · {{ t('spec.pageLabel', { page: spec.page }) }}</view>
        <view v-if="spec.english" class="spec-english">{{ spec.english }}</view>
      </view>

      <view class="spec-actions">
        <view class="spec-action" hover-class="is-press" :hover-stay-time="80" @click="openGraph">{{ t('spec.inGraph') }}</view>
        <view class="spec-action is-ghost" hover-class="is-press" :hover-stay-time="80" @click="textOpen = !textOpen">
          {{ textOpen ? t('graph.collapse') : t('spec.head') }}
        </view>
      </view>

      <view v-if="spec.connotation" class="surface">
        <view class="section-label">{{ t('spec.connotation') }}</view>
        <view class="spec-copy">{{ spec.connotation }}</view>
      </view>

      <view v-if="spec.detail" class="surface">
        <view class="section-label">{{ t('spec.detail') }}</view>
        <view class="spec-copy">{{ spec.detail }}</view>
        <template v-if="longText && textOpen">
          <view class="spec-divider" />
          <view class="spec-copy">{{ longText }}</view>
        </template>
        <view v-else-if="longText" class="spec-more" hover-class="is-press" :hover-stay-time="80" @click="textOpen = true">
          {{ t('spec.moreText') }}
        </view>
      </view>

      <view class="surface">
        <view class="spec-items-head">
          <text class="section-label">{{ t('spec.items') }}</text>
          <text class="spec-items-count">{{ t('spec.itemsCount', { count: priced.length }) }}</text>
        </view>
        <view v-if="!priced.length" class="muted">{{ t('spec.itemsEmpty') }}</view>
        <template v-else>
          <view v-for="row in visibleItems" :key="row.id" class="spec-item" hover-class="is-press" :hover-stay-time="80" @click="openItem(row.id)">
            <view class="spec-item-main">
              <text class="spec-item-name">{{ ct(row.name) }}</text>
              <text class="spec-item-meta">{{ row.code || t('result.noCode') }} · {{ row.unit || t('detail.unit') }}</text>
            </view>
            <text class="spec-item-price">{{ priceOf(row) }}</text>
            <text class="spec-item-arrow">›</text>
          </view>
          <view v-if="hiddenItems && !itemsOpen" class="spec-more" hover-class="is-press" :hover-stay-time="80" @click="itemsOpen = true">
            {{ t('spec.moreItems', { count: hiddenItems }) }}
          </view>
          <view v-if="itemsOpen && hiddenItems" class="spec-more" hover-class="is-press" :hover-stay-time="80" @click="itemsOpen = false">
            {{ t('spec.collapse') }}
          </view>
        </template>
        <view class="spec-note">{{ t('spec.itemsNote') }}</view>
      </view>

      <view class="surface">
        <view class="section-label">{{ nhcSpecDocument().title }}</view>
        <view class="spec-note">{{ nhcSpecDocument().publisher }}</view>
        <view class="spec-note">{{ nhcSpecDocument().note }}</view>
        <view class="spec-note">{{ t('spec.pdfHint') }}</view>
        <view class="spec-action is-ghost spec-pdf" hover-class="is-press" :hover-stay-time="80" @click="copyPdf">{{ t('spec.pdfAction') }}</view>
      </view>

      <view class="spec-disclaimer">{{ t('spec.disclaimer') }}</view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.spec-page { padding: 28rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); }
.spec-head { padding: 8rpx 8rpx 20rpx; }
.spec-eyebrow { color: var(--yb-primary); font-size: 22rpx; font-weight: 700; letter-spacing: .12em; }
.spec-title { margin-top: 8rpx; color: var(--yb-text); font-size: 44rpx; font-weight: 760; line-height: 1.35; }
.spec-sub { margin-top: 10rpx; color: var(--yb-text-3); font-size: 23rpx; line-height: 1.5; }
.spec-english { margin-top: 6rpx; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.5; }
.spec-actions { display: flex; gap: 12rpx; margin: 0 0 20rpx; }
.spec-action { flex: 1; min-height: 76rpx; border-radius: 16rpx; background: var(--yb-btn); color: var(--yb-btn-fg); font-size: 25rpx; font-weight: 700; line-height: 76rpx; text-align: center; }
.spec-action.is-ghost { border: 1rpx solid var(--yb-chip-on-border); background: var(--yb-primary-soft); color: var(--yb-primary); font-weight: 400; }
.spec-copy { color: var(--yb-text); font-size: 28rpx; line-height: 1.75; white-space: pre-wrap; }
.spec-divider { height: 1rpx; margin: 20rpx 0; background: var(--yb-border); }
.spec-items-head { display: flex; align-items: baseline; justify-content: space-between; }
.spec-items-count { color: var(--yb-text-3); font-size: 22rpx; }
.spec-item { display: flex; align-items: center; gap: 12rpx; min-height: 88rpx; border-bottom: 1rpx solid var(--yb-border); }
.spec-item:last-of-type { border-bottom: 0; }
.spec-item-main { min-width: 0; flex: 1; }
.spec-item-name { display: block; overflow: hidden; color: var(--yb-text); font-size: 27rpx; white-space: nowrap; text-overflow: ellipsis; }
.spec-item-meta { display: block; margin-top: 4rpx; color: var(--yb-text-3); font-size: 21rpx; }
.spec-item-price { flex: none; color: var(--yb-primary); font-size: 27rpx; font-weight: 700; }
.spec-item-arrow { flex: none; color: var(--yb-text-3); font-size: 34rpx; }
.spec-more { padding: 16rpx 0 2rpx; color: var(--yb-primary); font-size: 23rpx; text-align: center; }
.spec-pdf { margin-top: 16rpx; }
.spec-note { margin-top: 14rpx; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.6; }
.spec-disclaimer { margin: 4rpx 8rpx 0; color: var(--yb-text-3); font-size: 21rpx; line-height: 1.6; }
.spec-missing { padding: 48rpx 8rpx; }
.spec-missing-title { margin-bottom: 8rpx; color: var(--yb-text); font-size: 32rpx; font-weight: 700; }
.lang-bo .spec-title { line-height: 1.6; }
.lang-bo .spec-copy, .lang-bo .spec-note, .lang-bo .spec-disclaimer { line-height: 1.9; }
</style>
