<script setup lang="ts">
import { computed } from 'vue'
import { integrateLines, type GuideSheet } from '../lib/guide'
import { compactUsageRows } from '../lib/usage'
import { t } from '../lib/i18n'
import { useContentTranslation } from '../lib/content'
const { ct } = useContentTranslation()
import type { SearchItem } from '../lib/types'
const props = withDefaults(
  defineProps<{
    item: SearchItem
    guide: GuideSheet
    loading?: boolean
    compact?: boolean
    block?: boolean
  }>(),
  { loading: false, compact: false, block: false },
)

const mergeLines = computed(() => integrateLines(props.item, props.guide, ct))
const usageNote = computed(() => (props.item.usageNote || '').trim())
const usageRows = computed(() =>
  props.compact ? compactUsageRows(props.guide.usageRows) : props.guide.usageRows,
)
const conLabel = computed(() =>
  props.guide.inheritedFrom ? t('guide.connotationInherited', { name: ct(props.guide.inheritedFrom) }) : t('guide.connotation'),
)
const sheetClass = computed(() => {
  const bits = ['guide-sheet']
  if (props.compact) bits.push('is-compact')
  if (props.block) bits.push('is-block')
  if (props.loading) bits.push('is-loading')
  else if (props.guide.missing) bits.push('is-missing')
  return bits.join(' ')
})
</script>

<template>
  <view :class="sheetClass">
    <!-- 这里的每一行（项目内涵、计价说明、整合项目）都摘自医保目录原文，
         和药品那份「说明书」（适应症、用法用量、禁忌，见 pages/label）是两回事。
         原来的小标题写的是「说明书」，一个诊疗项目根本没有说明书，点开药品的
         「说明书」入口看到的又是别的内容，两个同名不同物的东西摆在一起必然看混。 -->
    <view class="h">{{ t('guide.source') }}</view>
    <view v-if="loading" class="p">{{ t('guide.loading') }}</view>
    <view v-else-if="guide.missing && !usageNote" class="p">{{ t('guide.missing') }}</view>
    <view v-else>
      <view v-if="guide.connotation" class="guide-row">
        <view class="dt">{{ conLabel }}</view>
        <view class="dd">{{ ct(guide.connotation) }}</view>
      </view>
      <view v-if="usageNote" class="guide-row">
        <view class="dt">{{ t('guide.usage') }}</view>
        <view class="dd">{{ ct(usageNote) }}</view>
      </view>
      <view v-if="guide.priceNote" class="guide-row">
        <view class="dt">{{ t('guide.priceNote') }}</view>
        <view class="dd">{{ ct(guide.priceNote) }}</view>
      </view>
      <view v-if="mergeLines.length" class="guide-row">
        <view class="dt">{{ t('guide.integrated') }}</view>
        <view v-for="line in mergeLines" :key="line" class="dd">{{ line }}</view>
      </view>
    </view>
    <view v-for="row in usageRows" :key="row.title + row.body.slice(0, 24)" class="guide-row">
      <view class="dt">{{ ct(row.title) }}</view>
      <view class="dd">{{ ct(row.body) }}</view>
    </view>
  </view>
</template>
