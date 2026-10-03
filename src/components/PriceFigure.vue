<script setup lang="ts">
import { computed } from 'vue'
import { levelLabel, showPrice } from '../lib/price'
import { t } from '../lib/i18n'
import type { HospitalLevel } from '../lib/types'

const props = defineProps<{
  value: string
  note?: string
  level: HospitalLevel
  mode: 'live' | 'future' | 'dead'
  label: string
}>()

const show = computed(() => showPrice(props.value, props.note || ''))
const empty = computed(() => show.value.kind !== 'money')
const wrap = computed(() => (props.mode === 'dead' ? 'price-dead' : props.mode === 'future' ? 'price-future' : 'price-live'))
</script>

<template>
  <view :class="wrap">
    <text class="label">{{ label }}</text>
    <text class="num" :class="{ 'is-empty': empty }">{{ show.text }}</text>
    <text class="lv">{{ t('common.levelSuffix', { level: levelLabel(level) }) }}</text>
  </view>
</template>
