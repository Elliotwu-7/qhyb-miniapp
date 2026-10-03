<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** 0~1 的真实进度。不传就是不定态：亮条来回扫，用在拿不到总量的分片请求上。 */
  percent?: number
  /** 嵌在正文块里（调价历史那种），窄一点、靠左。 */
  inline?: boolean
}>()

const sweep = computed(() => typeof props.percent !== 'number')
const width = computed(() => `${Math.round(Math.min(1, Math.max(0, props.percent || 0)) * 100)}%`)
</script>

<template>
  <view class="load-bar" :class="{ 'is-inline': inline }">
    <view class="load-track">
      <view class="load-fill" :class="{ 'is-sweep': sweep }" :style="sweep ? '' : `width:${width}`" />
    </view>
  </view>
</template>
