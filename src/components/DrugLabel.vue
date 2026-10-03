<script setup lang="ts">
import { computed } from 'vue'
import ProductSources from './ProductSources.vue'
import { LABEL_ROWS, type DrugLabel } from '../lib/data'
import { localeClass, t } from '../lib/i18n'
import { useContentTranslation } from '../lib/content'
const { ct } = useContentTranslation()

const props = defineProps<{
  label: DrugLabel | null | undefined
  compact?: boolean
}>()

const rows = computed(() => {
  const label = props.label
  if (!label) return []
  return LABEL_ROWS.filter(([, field]) => label[field]).map(([, field]) => ({ field, title: t(`label.${field}`), body: ct(String(label[field] || '')) }))
})

const tierText = computed(() => {
  const tier = props.label?.tier
  if (tier === 'A') return t('label.sameName')
  if (tier === 'B') return t('label.sameDrug')
  return t('label.sameIngredient')
})
</script>

<template>
  <ProductSources v-if="label?.info" :label="label" />
  <view v-else-if="label && rows.length" class="label-sheet" :class="[{ 'is-compact': compact }, localeClass]">
    <view class="label-head">
      <text class="label-title">{{ t('label.title') }}</text>
      <text class="label-src">{{ tierText }} · {{ ct(label.source) }}</text>
    </view>
    <view v-for="row in rows" :key="row.field" class="label-row">
      <view class="label-k">{{ row.title }}</view>
      <view class="label-v">{{ row.body }}</view>
    </view>
    <view v-if="label.disease" class="label-row">
      <view class="label-k">{{ t('label.disease') }}</view>
      <view class="label-v is-muted">{{ ct(label.disease) }}</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.label-sheet {
  border: 1px solid var(--yb-border, #e6e8eb);
  border-radius: 16rpx;
  padding: 20rpx 22rpx;
  margin-top: 16rpx;
  background: var(--yb-surface, #ffffff);
}

.label-sheet.is-compact {
  padding: 16rpx 18rpx;
  margin-top: 12rpx;
}

.label-head {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
  flex-wrap: wrap;
  margin-bottom: 12rpx;
}

.label-title {
  font-size: 28rpx;
  font-weight: 600;
}

.label-src {
  font-size: 22rpx;
  opacity: 0.65;
}

.label-row {
  margin-bottom: 14rpx;
}

.label-row:last-child {
  margin-bottom: 0;
}

.label-k {
  font-size: 22rpx;
  opacity: 0.65;
  margin-bottom: 4rpx;
}

.label-v {
  font-size: 26rpx;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.label-sheet.is-compact .label-v {
  font-size: 24rpx;
  line-height: 1.6;
}

.label-v.is-muted {
  opacity: 0.7;
}

.lang-bo { font-family: 'QhybTibetan', 'Noto Serif Tibetan', 'Microsoft Himalaya', sans-serif; }
.lang-bo .label-v { font-size: 30rpx; line-height: 2; overflow-wrap: break-word; }
.lang-bo .label-k, .lang-bo .label-src { font-size: 26rpx; line-height: 1.9; }
.lang-bo .label-title { font-size: 30rpx; line-height: 1.9; }
.lang-bo .label-row { margin-bottom: 24rpx; }
</style>
