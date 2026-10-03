<script setup lang="ts">
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import { copyFeedbackWeChat } from '../../lib/contact'
import { openPrivacyContract } from '../../lib/privacy'
import { enableShare } from '../../lib/share'
import { localeClass, t } from '../../lib/i18n'
import { applyChrome, themeMode } from '../../lib/theme'

onLoad(() => {
  enableShare()
})

onShow(() => {
  applyChrome()
})

// 声明页本身没什么可带走的，转发就是把小程序递出去。
onShareAppMessage(() => ({
  title: t('home.share'),
  path: '/pages/index/index',
}))

onShareTimeline(() => ({
  title: t('home.share'),
}))
</script>

<template>
  <view class="yb-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <view class="surface yb-in">
      <view class="section-label">{{ t('about.function') }}</view>
      <view class="p">{{ t('about.function1') }}</view>
      <view class="p">{{ t('about.function2') }}</view>
    </view>

    <view class="surface yb-in yb-in-2">
      <view class="section-label">{{ t('about.privacy') }}</view>
      <view class="p">{{ t('about.privacy1') }}</view>
      <view class="p">{{ t('about.privacy2') }}</view>
      <view class="p">{{ t('about.privacy3') }}</view>
      <view class="p">{{ t('about.privacy4') }}</view>
      <view class="link" hover-class="is-press" :hover-stay-time="80" @click="openPrivacyContract">{{ t('about.openPrivacy') }}</view>
    </view>

    <view class="surface yb-in yb-in-3">
      <view class="section-label">{{ t('about.contact') }}</view>
      <view class="p">{{ t('about.contactBody') }}</view>
      <view class="link" hover-class="is-press" :hover-stay-time="80" @click="copyFeedbackWeChat(t('contact.copied'), t('common.feedback'))">
        {{ t('contact.action') }}
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.p {
  margin-top: 12rpx;
  color: var(--yb-text-2);
  font-size: 26rpx;
  line-height: 1.7;
}
.link {
  margin-top: 20rpx;
  color: var(--yb-primary);
  font-size: 26rpx;
}
</style>
