<script setup lang="ts">
import { useContentTranslation } from '../lib/content'
import { locale, localeClass, t } from '../lib/i18n'
const { original, pending, failed, retry } = useContentTranslation()
</script>

<template>
  <view v-if="locale !== 'zh'" class="content-notice" :class="localeClass">
    <view class="content-note">{{ t('content.note') }}</view>
    <view v-if="pending" class="content-status">{{ t('content.loading') }}</view>
    <view v-if="failed" class="content-status">{{ t('content.failed') }}</view>
    <view class="content-actions">
      <view class="content-action" @click="original = !original">{{ original ? t('content.translated') : t('content.original') }}</view>
      <view v-if="failed" class="content-action" @click="retry">{{ t('content.retry') }}</view>
    </view>
  </view>
</template>

<style scoped>
.content-notice { margin: 16rpx 0; padding: 18rpx 22rpx; border-radius: 16rpx; background: var(--yb-primary-soft); color: var(--yb-text-2); font-size: 23rpx; line-height: 1.75; }
.content-actions { display: flex; flex-wrap: wrap; gap: 16rpx; margin-top: 10rpx; }
.content-action { color: var(--yb-primary); padding: 10rpx 0; min-height: 40rpx; font-weight: 600; }
.content-status { margin-top: 8rpx; color: var(--yb-text-3); }
.lang-bo { font-family: 'QhybTibetan', 'Noto Serif Tibetan', 'Microsoft Himalaya', sans-serif; font-size: 26rpx; line-height: 2; }
</style>
