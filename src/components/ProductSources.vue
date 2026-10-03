<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { fetchLabelProduct, type DrugLabel } from '../lib/data'
import { productRows, type LabelProduct } from '../lib/labelSourceTypes'
import { localeClass, t } from '../lib/i18n'
import { useContentTranslation } from '../lib/content'
const props = defineProps<{ label: DrugLabel }>()
const { ct } = useContentTranslation()
const query=ref('');const page=ref(0);const selected=ref('')
const product=ref<LabelProduct | null>(null);const pending=ref(false);const failed=ref(false)
let serial=0
const info=computed(() => props.label.info!)
const matches=computed(() => info.value.products.filter((p) => `${p.name} ${p.company} ${p.approval} ${p.strength}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const visible=computed(() => matches.value.slice(page.value*40,(page.value+1)*40))
const options=computed(() => [t('source.choose'),...visible.value.map((p) => `${p.name} · ${p.company || t('source.unknown')} · ${p.approval || t('source.unknown')} · ${p.strength || t('source.unknown')}`)])
const selectedRef=computed(() => info.value.products.find((p) => p.id===selected.value))
const pickerValue=computed(() => Math.max(0,visible.value.findIndex((p) => p.id===selected.value)+1))
const rows=computed(() => product.value ? productRows(product.value).map(([title,body]) => ({ title,body })) : [])
async function choose(id: string) {
  const run=++serial
  let data: LabelProduct
  selected.value=id;product.value=null;failed.value=false;pending.value=Boolean(id)
  if (!id) return
  try { data=await fetchLabelProduct(id);if (run===serial) product.value=data }
  catch { if (run===serial) failed.value=true }
  finally { if (run===serial) pending.value=false }
}
function changeProduct(event: { detail: { value: string | number } }) { void choose(visible.value[Number(event.detail.value)-1]?.id || '') }
function changePage(delta: number) { page.value+=delta;void choose('') }
function copy(url: string) { uni.setClipboardData({data:url}) }
watch(query,() => {page.value=0;void choose('')})
watch(() => props.label,() => {query.value='';page.value=0;void choose('')})
onUnmounted(() => {serial+=1})
</script>
<template>
  <view class="product-sources" :class="localeClass">
    <view class="source-title">{{ t('source.title') }}</view>
    <view class="source-muted">{{ t('source.count',{products:info.products.length,cde:info.cde.length}) }}</view>
    <template v-if="info.products.length">
      <view class="source-note">{{ t('source.note') }}</view>
      <input v-model="query" class="source-input" :placeholder="t('source.find')" />
      <view class="source-muted">{{ t('source.identifiers') }}</view>
      <picker :range="options" :value="pickerValue" @change="changeProduct"><view class="source-picker">{{ selectedRef ? options[pickerValue] : t('source.choose') }} ▾</view></picker>
      <view class="source-pages"><button class="yb-btn is-ghost" :disabled="page===0" @click="changePage(-1)">{{ t('source.previous') }}</button><text>{{ t('source.page',{page:page+1,count:matches.length}) }}</text><button class="yb-btn is-ghost" :disabled="(page+1)*40>=matches.length" @click="changePage(1)">{{ t('source.next') }}</button></view>
      <view v-if="selectedRef?.match==='different_name'" class="source-note">{{ t('source.different') }}</view>
      <view v-if="pending" class="source-note">{{ t('source.loading') }}</view>
      <view v-if="failed" class="source-note">{{ t('source.failed') }}<button class="yb-btn is-ghost" @click="choose(selected)">{{ t('audit.retry') }}</button></view>
      <view v-if="product && selectedRef" class="source-product">
        <view class="source-title">{{ ct(selectedRef.name) }}</view>
        <view class="source-text">{{ selectedRef.company || t('source.unknown') }}
{{ selectedRef.approval || t('source.unknown') }} · {{ selectedRef.strength || t('source.unknown') }}</view>
        <button class="yb-btn is-ghost" @click="copy(product.origin.url)">{{ t('source.copy') }}</button>
        <view class="source-muted">{{ t('source.fetched',{date:product.origin.fetchedAt.slice(0,10)}) }}</view>
        <view v-for="row in rows" :key="row.title" class="source-field"><view class="source-field-title">{{ ct(row.title) }}</view><view class="source-text">{{ ct(row.body) }}</view></view>
      </view>
    </template>
    <view v-if="info.cde.length" class="source-approvals">
      <view class="source-title">{{ t('source.cde') }}</view><view class="source-note">{{ t('source.cdeNote') }}</view>
      <view v-for="record in info.cde" :key="`${record.row}:${record.section}`" class="source-product">
        <view class="source-title">{{ ct(record.name) }}</view><view>{{ record.holder || t('source.unknown') }}</view><view>{{ record.date || t('source.unknown') }} · {{ ct(record.state) || t('source.unknown') }}</view>
        <view class="source-text">{{ ct(record.instruction) }}</view><button class="yb-btn is-ghost" @click="copy(record.url)">{{ t('source.copy') }}</button><view class="source-muted">{{ t('source.fetched',{date:record.fetchedAt.slice(0,10)}) }}</view>
      </view>
    </view>
  </view>
</template>
<style scoped>
.product-sources{padding:24rpx;border:1rpx solid var(--yb-border);border-radius:20rpx;background:var(--yb-surface);font-size:26rpx;line-height:1.8;overflow-wrap:anywhere}.source-title{font-size:30rpx;font-weight:650;margin:12rpx 0}.source-muted{font-size:23rpx;color:var(--yb-text-3);margin:12rpx 0}.source-note{margin:18rpx 0;padding:16rpx;border-left:5rpx solid #bd8837;background:#bd883710}.source-input{padding:18rpx;border:1rpx solid var(--yb-border);border-radius:12rpx;min-height:52rpx}.source-picker{padding:20rpx;border:1rpx solid var(--yb-border);border-radius:12rpx;white-space:normal}.source-pages{display:flex;align-items:center;gap:12rpx;margin:16rpx 0;font-size:22rpx;flex-wrap:wrap}.source-pages button{font-size:22rpx;margin:0;flex:none}.source-product{border-top:1rpx solid var(--yb-border);margin-top:24rpx;padding-top:18rpx}.source-text{white-space:pre-wrap;line-height:1.9;margin:14rpx 0}.source-field-title{font-weight:600;color:var(--yb-text-3)}.source-field{margin-top:24rpx}.lang-bo{font-family:'QhybTibetan','Noto Serif Tibetan',sans-serif;font-size:30rpx;line-height:2}.lang-bo .source-muted{font-size:26rpx;line-height:1.9}.lang-bo .source-text{line-height:2}
</style>
