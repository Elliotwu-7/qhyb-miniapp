<script setup lang="ts">
import { computed, watch } from 'vue'
import { locale, t } from '../lib/i18n'
import { ensureTibetanFont } from '../lib/font'
import { loadSearchTerms, searchTermsState } from '../lib/search-terms'
const props = defineProps<{ query?: string }>()
const relevant = computed(() => locale.value !== 'zh' || /[A-Za-z\u0f00-\u0fff]/.test(props.query || ''))
watch(() => props.query, (value) => { if (/[\u0f00-\u0fff]/.test(value || '')) ensureTibetanFont() }, { immediate: true })
</script>
<template>
  <view v-if="relevant" class="terms-notice">
    <template v-if="searchTermsState === 'error'">{{ t('search.termsError') }}<button class="yb-btn is-ghost" @click="loadSearchTerms(true)">{{ t('audit.retry') }}</button></template>
    <text v-else-if="searchTermsState === 'loading'">{{ t('search.termsLoading') }}</text>
    <text v-else>{{ t('search.termsHint') }}</text>
  </view>
</template>
<style scoped>
.terms-notice { margin: 12rpx 0; padding: 14rpx 18rpx; border-radius: 14rpx; background: var(--yb-primary-soft); color: var(--yb-text-2); font-size: 23rpx; line-height: 1.8; overflow-wrap: anywhere; }
</style>
