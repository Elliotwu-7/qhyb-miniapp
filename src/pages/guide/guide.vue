<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import GuideBlock from '../../components/GuideBlock.vue'
import { useContentTranslation } from '../../lib/content'
import { fetchItemDetail } from '../../lib/data'
import { findParentItem, resolveGuide } from '../../lib/guide'
import { localeClass, t } from '../../lib/i18n'
import { loadItemSpecs, nhcSpecDocument, type NhcSpecItem } from '../../lib/nhcSpec'
import { routeValue } from '../../lib/route'
import { catalogReady } from '../../lib/store'
import { applyChrome, themeMode } from '../../lib/theme'
import { isDrug, type ItemDetail, type SearchItem } from '../../lib/types'

const item = ref<SearchItem | null>(null)
const detail = ref<ItemDetail | null>(null)
const parent = ref<SearchItem | null>(null)
const parentDetail = ref<ItemDetail | null>(null)
const specs = ref<NhcSpecItem[]>([])
const loading = ref(true)
const failed = ref(false)
const { ct } = useContentTranslation(true)

const guide = computed(() => (item.value ? resolveGuide(item.value, detail.value, parent.value, parentDetail.value) : null))

async function load(id: string) {
  loading.value = true
  failed.value = false
  // 结果变量声明在 try 外面：块里的 const 降级 ES5 时会提升成 var，
  // 撞上模块级绑定就把同函数里更早的引用顶成 undefined（见 README）。
  let data: Awaited<ReturnType<typeof catalogReady>> | null = null
  let found: SearchItem | undefined
  let ids: string[] = []
  let details: ItemDetail[] = []
  let linked: NhcSpecItem[] = []
  try {
    data = await catalogReady()
    found = data.byId.get(id)
    if (!found || isDrug(found)) {
      failed.value = true
      return
    }
    item.value = found
    parent.value = findParentItem(found, (code) => data.byCode.get(code), (name) => data.byName.get(name)) || null
    ids = [found.id, parent.value?.id].filter(Boolean) as string[]
    details = await Promise.all(ids.map((value) => fetchItemDetail(value)))
    detail.value = details[0]
    parentDetail.value = parent.value ? details[1] : null
    // 一个收费项目可能由多条规范合并形成，所以这里是列表而不是一条。
    linked = (await loadItemSpecs(found.id)).specs
    specs.value = linked
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

/** 规范原文单独一页：内涵、正文和由它形成的项目都在那边。 */
function openSpec(code: string) {
  uni.navigateTo({ url: `/pages/spec/spec?code=${encodeURIComponent(code)}` })
}

onLoad((query) => {
  applyChrome()
  const id = routeValue(query?.id)
  if (id) void load(id)
  else loading.value = false
})

onShow(() => applyChrome())
</script>

<template>
  <view class="yb-page guide-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <view class="guide-name">{{ item ? ct(item.name) : t('guide.source') }}</view>
    <view v-if="loading" class="muted pad">{{ t('guide.loading') }}</view>
    <view v-else-if="failed || !item || !guide" class="muted pad">{{ t('detail.loadFail') }}</view>
    <template v-else>
      <GuideBlock :item="item" :guide="guide" block />
      <view v-if="specs.length" class="surface">
        <view class="section-label">{{ nhcSpecDocument().title }}</view>
        <view v-for="row in specs" :key="row.code" class="guide-spec" hover-class="is-press" :hover-stay-time="80" @click="openSpec(row.code)">
          <view class="guide-spec-main">
            <text class="guide-spec-name">{{ row.name }}</text>
            <text class="guide-spec-meta">{{ row.code }} · {{ t('spec.pageLabel', { page: row.page }) }}</text>
          </view>
          <text class="guide-spec-arrow">›</text>
        </view>
        <view class="muted guide-spec-note">{{ t('spec.itemsNote') }}</view>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.guide-page { padding: 28rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); }
.guide-name { margin: 8rpx 8rpx 20rpx; color: var(--yb-text); font-size: 40rpx; font-weight: 760; line-height: 1.35; }
.guide-copy { margin-top: 16rpx; color: var(--yb-text); font-size: 28rpx; line-height: 1.7; white-space: pre-wrap; }
.guide-spec { display: flex; align-items: center; gap: 12rpx; min-height: 84rpx; border-bottom: 1rpx solid var(--yb-border); }
.guide-spec:last-of-type { border-bottom: 0; }
.guide-spec-main { min-width: 0; flex: 1; }
.guide-spec-name { display: block; overflow: hidden; color: var(--yb-text); font-size: 26rpx; white-space: nowrap; text-overflow: ellipsis; }
.guide-spec-meta { display: block; margin-top: 4rpx; color: var(--yb-text-3); font-size: 21rpx; }
.guide-spec-arrow { flex: none; color: var(--yb-text-3); font-size: 34rpx; }
.guide-spec-note { margin-top: 14rpx; font-size: 22rpx; line-height: 1.6; }
</style>
