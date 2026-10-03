<script setup lang="ts">
import { computed } from 'vue'
import { useContentTranslation } from '../lib/content'
const { ct } = useContentTranslation()
import { edgeRelText, t } from '../lib/i18n'
import { isDrug, type SearchItem } from '../lib/types'

const props = defineProps<{
  hops: Array<{ item: SearchItem; rel: string }>
  asDrug?: boolean
  /** 标题和推断说明的键。默认按药品/项目的两套文案，耗材传 hop.relatedConsumables。 */
  headKey?: string
  noteKey?: string
}>()

const emit = defineEmits<{
  jump: [id: string]
}>()

const headText = computed(() => t(props.headKey || (props.asDrug ? 'hop.relatedServices' : 'hop.relatedDrugs')))
const noteText = computed(() => t(props.noteKey || 'hop.note'))

// 按关系类型分组：同名重合和按适应症推断的可信度不一样，混在一起看不出差别
const groups = computed(() => {
  const out: Array<{ rel: string; label: string; rows: SearchItem[] }> = []
  const index = new Map<string, number>()
  props.hops.forEach((hop) => {
    const at = index.get(hop.rel)
    if (at === undefined) {
      index.set(hop.rel, out.length)
      out.push({ rel: hop.rel, label: edgeRelText(hop.rel), rows: [hop.item] })
    } else {
      out[at].rows.push(hop.item)
    }
  })
  return out
})
</script>

<template>
  <view v-if="hops.length" class="hop-list">
    <view class="hop-head">
      <text class="muted">{{ headText }}</text>
      <text class="hop-count">{{ hops.length }}</text>
    </view>
    <view class="hop-note">{{ noteText }}</view>
    <view v-for="group in groups" :key="group.rel" class="hop-group">
      <view class="hop-rel">
        <text>{{ group.label }}</text>
        <text class="hop-rel-n">{{ group.rows.length }}</text>
      </view>
      <view v-for="row in group.rows" :key="row.id" class="merge-row">
        <text class="jump" hover-class="is-press" :hover-stay-time="80" @click.stop="emit('jump', row.id)">{{ ct(row.name) }}</text>
        <text v-if="!isDrug(row) && row.code" class="alert-code">（{{ row.code }}）</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.hop-head {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 8rpx;
}

.hop-count {
  font-size: 22rpx;
  color: var(--yb-icon-muted, #7b8494);
  background: var(--yb-clear-bg, #eef1f6);
  border-radius: 999rpx;
  padding: 2rpx 14rpx;
}

.hop-group {
  margin-top: 16rpx;
}

.hop-rel {
  display: flex;
  align-items: center;
  gap: 10rpx;
  font-size: 22rpx;
  color: var(--yb-icon-muted, #7b8494);
  margin-bottom: 4rpx;
}

.hop-rel-n {
  opacity: 0.7;
}

.merge-row {
  margin-top: 8rpx;
  font-size: 28rpx;
  line-height: 1.5;
}
</style>
