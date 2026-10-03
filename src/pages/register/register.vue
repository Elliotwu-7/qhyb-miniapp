<script setup lang="ts">
import { computed, ref } from 'vue'
import { onHide, onShow, onUnload } from '@dcloudio/uni-app'
import PrivacyPrompt from '../../components/PrivacyPrompt.vue'
import HomePill from '../../components/HomePill.vue'
import { failMessage } from '../../lib/fail'
import { localeClass, t } from '../../lib/i18n'
import {
  loggedIn,
  loginWithWeChat,
  registerAccount,
  registered,
  sessionBusy,
  sessionError,
} from '../../lib/session'
import { backOrHome } from '../../lib/nav'
import { openPrivacyContract, setPrivacyPromptActive } from '../../lib/privacy'
import { applyChrome, themeMode } from '../../lib/theme'

const DEFAULT_AVATAR = '/static/avatar-default.png'
const nickname = ref('')
const avatar = ref('')
const submitting = ref(false)

const canSubmit = computed(() => Boolean(nickname.value))
const preview = computed(() => avatar.value || DEFAULT_AVATAR)

function onChooseAvatar(e: { detail?: { avatarUrl?: string } }) {
  const url = e.detail?.avatarUrl || ''
  if (url) avatar.value = url
}

function onNickname(e: { detail?: { value?: string } }) {
  nickname.value = (e.detail?.value || '').trim()
}

async function fileToDataUrl(path: string): Promise<string> {
  if (!path) return ''
  const remote = path.startsWith('https://') && !path.includes('://tmp')
  if (remote) return path
  const { promise, resolve } = Promise.withResolvers<string>()
  uni.getFileSystemManager().readFile({
    filePath: path,
    encoding: 'base64',
    success: (res) => resolve(`data:image/jpeg;base64,${res.data}`),
    fail: () => resolve(''),
  })
  return promise
}

async function ensureLogin() {
  if (loggedIn.value || sessionBusy.value) return
  try {
    await loginWithWeChat()
  } catch {
    /* sessionError already set */
  }
}

async function onRegister() {
  if (submitting.value || sessionBusy.value) return
  if (!nickname.value) {
    uni.showToast({ title: t('login.needNickname'), icon: 'none' })
    return
  }
  // encoded 声明在 try 外面：留在块里的话，压缩后可能和模块级引用撞名，
  // 微信开发者工具降级 ES5 提升成 var，会把 catch 里的 failMessage 顶成 undefined。
  let encoded = ''
  submitting.value = true
  try {
    if (!loggedIn.value) await loginWithWeChat()
    encoded = avatar.value ? await fileToDataUrl(avatar.value) : ''
    await registerAccount({
      nickname: nickname.value,
      avatar: encoded,
    })
    uni.showToast({ title: t('login.success'), icon: 'success' })
    backOrHome()
  } catch (err) {
    uni.showToast({ title: failMessage(err, t('login.fail')), icon: 'none' })
  } finally {
    submitting.value = false
  }
}

/**
 * 已经登录过的人再点进来（比如从「我的」连点两次）就别停在登录表单上，
 * 直接退回去。有上一页就退回上一页；从分享/扫码直接进这一页时栈里只有这一页，
 * 那就回首页 —— 单页栈上不能靠 navigateBack 的 fail 兜底（实测它不 fail，只是
 * 什么都不做），也不能留着不管，留着就是让用户困在登录表单上。
 */
function leaveIfRegistered() {
  if (!registered.value) return
  backOrHome()
}

onShow(() => {
  setPrivacyPromptActive(true)
  applyChrome()
  leaveIfRegistered()
  void ensureLogin()
})
onHide(() => setPrivacyPromptActive(false))
onUnload(() => setPrivacyPromptActive(false))
</script>

<template>
  <view class="yb-page" :class="[{ 'theme-dark': themeMode === 'dark' }, localeClass]">
    <HomePill />
    <view class="login-hero yb-in">
      <button class="avatar-pick" open-type="chooseAvatar" @chooseavatar="onChooseAvatar">
        <image class="avatar-preview" :src="preview" mode="aspectFill" />
      </button>
      <view class="login-title">{{ t('login.title') }}</view>
      <view class="muted">{{ t('login.sub') }}</view>
    </view>

    <view v-if="sessionError" class="warn">{{ sessionError }}</view>

    <view class="login-form yb-in yb-in-2">
      <input
        class="nick-input"
        type="nickname"
        :placeholder="t('login.nickname')"
        :value="nickname"
        @blur="onNickname"
        @input="onNickname"
      />
      <view
        class="yb-btn"
        :class="{ 'is-off': sessionBusy || submitting || !canSubmit }"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="onRegister"
      >{{ t('login.button') }}</view>
      <view class="privacy-note">
        <text>{{ t('login.privacyPrefix') }}</text>
        <text class="privacy-link" @click="openPrivacyContract">{{ t('login.privacyGuide') }}</text>
      </view>
    </view>
    <PrivacyPrompt />
  </view>
</template>

<style lang="scss" scoped>
.login-hero {
  padding: 48rpx 0 32rpx;
  text-align: center;
}
.login-title {
  margin: 8rpx 0 8rpx;
  font-size: 44rpx;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.avatar-pick {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 176rpx;
  height: 176rpx;
  min-height: 0;
  margin: 0 auto 28rpx;
  padding: 0;
  overflow: hidden;
  border-radius: 50%;
  background: transparent;
  line-height: 0;
}
.avatar-pick::after {
  border: none;
}
.avatar-preview {
  width: 176rpx;
  height: 176rpx;
  border-radius: 50%;
  background: transparent;
}
.warn {
  color: var(--yb-soon-fg);
  margin: 0 0 24rpx;
  text-align: center;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}
.nick-input {
  height: 88rpx;
  padding: 0 32rpx;
  border-radius: 999rpx;
  background: var(--yb-surface);
  border: 1rpx solid var(--yb-border);
  color: var(--yb-text);
  font-size: 30rpx;
}
.privacy-note {
  margin-top: 8rpx;
  color: var(--yb-text-3);
  font-size: 22rpx;
  line-height: 1.6;
  text-align: center;
}
.privacy-link {
  color: var(--yb-primary);
}
</style>
