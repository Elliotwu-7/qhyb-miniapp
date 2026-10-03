<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import DrugLabel from '../../components/DrugLabel.vue'
import ContentNotice from '../../components/ContentNotice.vue'
import HomePill from '../../components/HomePill.vue'
import { useContentTranslation } from '../../lib/content'
import { fetchDrugLabels, LABEL_ROWS, type DrugLabel as DrugLabelData } from '../../lib/data'
import { drugKindText, localeClass, t } from '../../lib/i18n'
import { enableShare, shareQuery } from '../../lib/share'
import { catalogReady } from '../../lib/store'
import { routeValue } from '../../lib/route'
import { applyChrome, themeMode } from '../../lib/theme'
import { isDrug, isLimitedDrug, type SearchItem } from '../../lib/types'

// 说明书从详情页拆出来单独一页：点进去才拉。
// 详情页原来一进去就整片拉下来（分片 31~142 KB，正文中位数 528 字），
// 但全目录只有 58% 的药品有说明书 —— 四成情况下那些流量和版面是白花的。
const drugId = ref('')
const { ct } = useContentTranslation(true)
const item = ref<SearchItem | null>(null)
const label = ref<DrugLabelData | null>(null)
const loading = ref(true)
const failed = ref(false)

const rowCount = computed(() => {
  const data = label.value
  if (!data) return 0
  return LABEL_ROWS.filter(([, field]) => String(data[field] || '')).length
})

const hasLabel = computed(() => Boolean(label.value?.info) || Boolean(label.value) && rowCount.value > 0)

const kindText = computed(() => {
  const current = item.value
  if (!current || !isDrug(current)) return ''
  return drugKindText(current.kind)
})

/**
 * tier A 是同名说明书，不用解释；B/C 本质上是**另一个品种**的说明书，
 * 界面必须说清楚，否则用户会当成这一条自己的说明书来读。
 */
const tierNote = computed(() => {
  if (label.value?.info) return ''
  const tier = label.value?.tier
  if (tier === 'B') {
    return t('label.tierB')
  }
  if (tier === 'C') {
    return t('label.tierC')
  }
  return ''
})

async function loadLabel() {
  if (loading.value && labelRequestRunning) return
  const id = drugId.value
  if (!id) {
    loading.value = false
    return
  }
  loading.value = true
  failed.value = false
  labelRequestRunning = true
  // 药品名走目录（通常是缓存好的），说明书走分片，两条路互不拖累：
  // 目录挂了也照样能看说明书正文。
  void catalogReady()
    .then((data) => {
      item.value = data.byId.get(id) || null
    })
    .catch(() => undefined)
  fetchDrugLabels([id])
    .then((map) => {
      label.value = map[id] || null
    })
    .catch(() => {
      failed.value = true
    })
    .finally(() => {
      loading.value = false
      labelRequestRunning = false
    })
}
let labelRequestRunning = false

onLoad((query) => {
  applyChrome()
  enableShare()
  drugId.value = routeValue(query?.drug)
  void loadLabel()
})

onShow(() => {
  applyChrome()
})

onShareAppMessage(() => ({
  title: item.value ? `${ct(item.value.name)} ${t('label.title')} · ${t('app.catalog')}` : `${t('nav.label')} · ${t('app.catalog')}`,
  path: `/pages/label/label?drug=${encodeURIComponent(drugId.value)}`,
}))

onShareTimeline(() => ({
  title: item.value ? `${ct(item.value.name)} ${t('label.title')} · ${t('app.catalog')}` : `${t('nav.label')} · ${t('app.catalog')}`,
  query: shareQuery({ drug: drugId.value }),
}))
</script>

<template>
  <view class="yb-page label-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <HomePill />
    <!-- 不再单起一行「说明书」小标题：导航栏已经写着「药品说明书」，
         下面的卡片头还有一条，三处重复。 -->
    <view class="label-hero">
      <view class="label-hero-name">
        <text>{{ item ? ct(item.name) : t('nav.label') }}</text>
        <text v-if="isLimitedDrug(item)" class="limit-badge">{{ t('common.limitedShort') }}</text>
      </view>
      <view v-if="item && isDrug(item)" class="label-hero-tag">{{ kindText }}</view>
    </view>

    <ContentNotice />
    <view v-if="loading" class="label-hint">{{ t('label.loading') }}</view>
    <view v-else-if="failed" class="label-hint">{{ t('label.failed') }}<button class="yb-btn is-ghost" @click="loadLabel">{{ t('audit.retry') }}</button></view>
    <view v-else-if="!hasLabel" class="label-hint">{{ t('label.missing') }}</view>
    <template v-else>
      <view v-if="tierNote" class="label-tier">{{ tierNote }}</view>
      <DrugLabel :label="label" />
    </template>
  </view>
</template>

<style lang="scss" scoped>
.label-page { padding: 28rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); }
.label-hero { padding: 8rpx 8rpx 20rpx; }
.label-hero-name { display: flex; align-items: center; gap: 10rpx; margin-top: 8rpx; color: var(--yb-text); font-size: 42rpx; font-weight: 760; line-height: 1.3; letter-spacing: -.03em; }
.limit-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 34rpx; height: 34rpx; padding: 0 8rpx; border-radius: 8rpx; background: #fff0d2; color: #b45309; font-size: 20rpx; font-weight: 800; line-height: 34rpx; flex: none; }
.label-hero-tag { display: inline-block; margin-top: 12rpx; padding: 6rpx 14rpx; border-radius: 999rpx; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 21rpx; }
.label-hint { padding: 40rpx 24rpx; border: 1rpx solid var(--yb-border); border-radius: 24rpx; background: var(--yb-surface); color: var(--yb-text-3); font-size: 24rpx; line-height: 1.7; text-align: center; }
.label-tier { margin-top: 4rpx; padding: 18rpx 20rpx; border: 1rpx solid var(--yb-chip-on-border); border-radius: 16rpx; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 23rpx; line-height: 1.65; }
.lang-bo .label-hero-name { font-size: 38rpx; line-height: 1.8; letter-spacing: 0; }
.lang-bo .label-hero-tag, .lang-bo .label-tier { font-size: 26rpx; line-height: 1.9; }
</style>
