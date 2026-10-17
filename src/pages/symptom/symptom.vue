<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { mpKgSymptomLabs, type KgSymptomLab } from '../../lib/api'

const query = ref('')
const items = ref<KgSymptomLab[]>([])
const matched = ref<string[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const searched = ref(false)
const TAG: Record<string, string> = { category: '同类推断', curated: '人工整理' }
let seq = 0

function run() {
  const q = query.value.trim()
  if (!q) return
  const mine = ++seq
  loading.value = true
  error.value = ''
  mpKgSymptomLabs(q, 50)
    .then((res) => {
      if (mine !== seq) return
      items.value = res.items || []
      matched.value = res.symptoms || []
      total.value = res.total || 0
      searched.value = true
    })
    .catch((err) => {
      if (mine === seq) error.value = err instanceof Error ? err.message : '查询失败'
    })
    .finally(() => {
      if (mine === seq) loading.value = false
    })
}

function open(row: KgSymptomLab) {
  uni.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(row.itemId)}` })
}

onLoad((opts) => {
  const q = opts && opts.q ? decodeURIComponent(String(opts.q)) : ''
  if (q) {
    query.value = q
    run()
  }
})
</script>

<template>
  <view class="page">
    <view class="search-row">
      <input v-model="query" class="search-input" placeholder="输入症状，如 黄疸、头晕" confirm-type="search" @confirm="run" />
      <view class="yb-btn" hover-class="is-press" :hover-stay-time="80" @click="run">查询</view>
    </view>
    <view class="notice">仅供参考，不作诊断依据。结果由公开医学知识图谱经疾病关联推断，不构成医保目录或支付政策解释。</view>
    <view v-if="loading" class="muted">查询中…</view>
    <view v-else-if="error" class="muted">{{ error }}</view>
    <view v-else-if="searched && !items.length" class="muted">没有找到与该症状相关的检验项目</view>
    <view v-else-if="items.length">
      <view class="muted">匹配症状：{{ matched.slice(0, 6).join('、') }}　共 {{ total }} 项</view>
      <view v-for="row in items" :key="row.itemId" class="row" hover-class="is-press" :hover-stay-time="80" @click="open(row)">
        <view class="row-main">
          <text class="row-name">{{ row.name }}</text>
          <text v-if="TAG[row.tier]" class="tag">{{ TAG[row.tier] }}</text>
        </view>
        <text class="row-sub">{{ row.code }} · {{ row.symptom }}</text>
      </view>
    </view>
  </view>
</template>

<style>
.page { padding: 24rpx; }
.search-row { display: flex; gap: 16rpx; align-items: center; }
.search-input { flex: 1; height: 72rpx; padding: 0 20rpx; border-radius: 12rpx; background: #f2f5f9; }
.notice { margin: 20rpx 0; font-size: 24rpx; color: #8a6d3b; }
.muted { color: #888; font-size: 24rpx; margin: 12rpx 0; }
.row { padding: 20rpx 0; border-bottom: 1rpx solid #eee; }
.row-main { display: flex; align-items: center; gap: 12rpx; }
.row-name { font-size: 30rpx; }
.row-sub { font-size: 24rpx; color: #888; }
.tag { padding: 2rpx 12rpx; border-radius: 8rpx; font-size: 22rpx; color: #b26a00; background: #fff4e0; }
</style>
