<script setup lang="ts">
import { t } from '../lib/i18n'
import { PRIVACY_BUTTON_ID, agreePrivacy, declinePrivacy, openPrivacyContract, privacyVisible } from '../lib/privacy'
</script>

<template>
  <view v-if="privacyVisible" class="privacy-overlay" @click.self="declinePrivacy" @touchmove.stop.prevent>
    <view class="privacy-dialog" role="dialog" aria-modal="true" :aria-label="t('privacy.title')" @click.stop>
      <view class="privacy-title">{{ t('privacy.title') }}</view>
      <scroll-view scroll-y class="privacy-scroll">
        <view class="privacy-body">{{ t('privacy.body') }}</view>
        <button class="privacy-contract" @click="openPrivacyContract">{{ t('privacy.view') }}</button>
      </scroll-view>
      <view class="privacy-actions">
        <button class="privacy-decline" @click="declinePrivacy">{{ t('privacy.decline') }}</button>
        <button
          :id="PRIVACY_BUTTON_ID"
          class="privacy-agree"
          open-type="agreePrivacyAuthorization"
          @agreeprivacyauthorization="agreePrivacy"
          @error="declinePrivacy"
        >{{ t('privacy.agree') }}</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
.privacy-overlay { position: fixed; inset: 0; z-index: 1500; display: flex; align-items: center; justify-content: center; padding: 32rpx; background: rgba(0, 0, 0, .5); }
.privacy-dialog { width: 100%; max-width: 620rpx; max-height: 85vh; box-sizing: border-box; padding: 36rpx; border-radius: 24rpx; background: var(--yb-surface); color: var(--yb-text); }
.privacy-title { font-size: 34rpx; font-weight: 700; margin-bottom: 20rpx; }
.privacy-scroll { max-height: 50vh; }
.privacy-body { font-size: 28rpx; line-height: 1.75; color: var(--yb-text-2); }
.privacy-dialog button { font-size: 28rpx; line-height: 1.6; padding: 20rpx 16rpx; white-space: normal; margin: 0; }
.privacy-dialog button::after { border: 0; }
.privacy-contract { color: var(--yb-primary); background: transparent; text-align: left; width: 100%; }
.privacy-actions { display: flex; gap: 20rpx; margin-top: 20rpx; }
.privacy-actions button { flex: 1; }
.privacy-decline { background: var(--yb-bg); color: var(--yb-text-2); }
.privacy-agree { background: var(--yb-primary); color: #fff; }
</style>
