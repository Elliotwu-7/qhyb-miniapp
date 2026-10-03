<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import { avatarSrc } from '../../lib/api'
import { copyFeedbackWeChat } from '../../lib/contact'
import { failMessage } from '../../lib/fail'
import { ensureTibetanFont } from '../../lib/font'
import { locale, localeClass, setLocale, t, type AppLocale } from '../../lib/i18n'
import { enableShare } from '../../lib/share'
import {
  cancelAccount,
  claimAdReward,
  doCheckin,
  hospitalLevel,
  logoutAccount,
  profile,
  quota,
  registered,
  sessionBusy,
  sessionError,
  setHospitalLevel,
} from '../../lib/session'
import { formatMemberSince, memberFromCheckin, nextHint, type MemberInfo } from '../../lib/member'
import { levelLabel } from '../../lib/price'
import { applyChrome, themeMode } from '../../lib/theme'
import type { HospitalLevel } from '../../lib/types'

const levels: HospitalLevel[] = ['L3', 'L2', 'L1']

function openWeChat() {
  copyFeedbackWeChat(t('contact.copied'), t('common.feedback'))
}
const adBusy = ref(false)
const checkinBusy = ref(false)
// 广告实例只建一次：每次点击都新建会在微信里堆出多个监听。
// 广告位 id 随用户资料异步到达，所以第一次点「看广告」时才建。
let rewardedAd: UniNamespace.RewardedVideoAdContext | null = null
let rewardedUnit = ''

const languages: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'bo', label: 'བོད་ཡིག' },
  { value: 'en', label: 'English' },
]

function localizedTier(tier: string) {
  if (tier === 'gold') return t('member.gold')
  if (tier === 'silver') return t('member.silver')
  return t('member.basic')
}

const member = computed<MemberInfo>(() => {
  const raw = profile.value?.member || memberFromCheckin(profile.value?.checkinTotal || 0, profile.value?.checkinStreak || 0)
  return {
    ...raw,
    label: localizedTier(raw.tier),
    next: raw.next ? { ...raw.next, label: localizedTier(raw.next.tier) } : null,
  }
})

const cardClass = computed(() => `is-${member.value.tier}`)
const sinceText = computed(() => formatMemberSince(member.value.since))
const progressPct = computed(() => Math.round(member.value.progress * 100))
const hint = computed(() => nextHint(member.value))
const remaining = computed(() => quota.value?.remaining ?? 0)
// 只有服务端确实配了广告位才出「看广告」按钮；奖励次数也取服务端配置，不写死默认值
const adUnit = computed(() => profile.value?.ads?.rewarded?.unitId || '')
const adBonus = computed(() => Number(quota.value?.adBonus) || 0)
const showAdButton = computed(() => Boolean(adUnit.value) && adBonus.value > 0)
const avatarUrl = computed(() => avatarSrc(profile.value?.avatar) || '/static/avatar-default.png')
const displayName = computed(() => profile.value?.nickname || member.value.label)

function goLogin() {
  uni.navigateTo({ url: '/pages/register/register' })
}

function goAbout() {
  uni.navigateTo({ url: '/pages/about/about' })
}

function onLanguage(next: AppLocale) {
  setLocale(next, 'pages/me/me')
}

async function onCheckin() {
  if (checkinBusy.value || sessionBusy.value || profile.value?.checkedInToday) return
  checkinBusy.value = true
  // next 声明在 try 外面：块里的 const 降级成 ES5 会提升成 var，见 README
  let next: Awaited<ReturnType<typeof doCheckin>> | null = null
  try {
    next = await doCheckin()
    uni.showToast({ title: next.already ? t('me.checked') : t('me.checkSuccess', { count: next.granted || 0 }), icon: 'success' })
  } catch (err) {
    uni.showToast({ title: failMessage(err, t('me.checkFail')), icon: 'none' })
  } finally {
    checkinBusy.value = false
  }
}

async function onLevel(next: HospitalLevel) {
  await setHospitalLevel(next)
}

async function onLogout() {
  await logoutAccount()
  uni.showToast({ title: t('me.loggedOut'), icon: 'none' })
}

async function onCancel() {
  const { confirm } = await uni.showModal({
    title: t('me.cancelTitle'),
    content: t('me.cancelBody'),
    confirmText: t('me.cancelConfirm'),
    confirmColor: '#c45c26',
  })
  if (!confirm) return
  try {
    await cancelAccount()
    uni.showToast({ title: t('me.cancelled'), icon: 'none' })
  } catch (err) {
    uni.showToast({ title: failMessage(err, t('me.cancelFail')), icon: 'none' })
  }
}

function showRewarded(): Promise<void> {
  const unitId = adUnit.value
  if (!unitId) return Promise.reject(new Error(t('me.adMissing')))
  if (!rewardedAd || rewardedUnit !== unitId) {
    rewardedAd = uni.createRewardedVideoAd({ adUnitId: unitId })
    rewardedUnit = unitId
  }
  const ad = rewardedAd
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  const finish = (ok: boolean, message: string) => {
    if (settled) return
    settled = true
    ad.offClose(onClose)
    ad.offError(onError)
    if (ok) resolve()
    else reject(new Error(message))
  }
  const onClose = (res: { isEnded?: boolean }) => {
    finish(Boolean(res?.isEnded), t('me.adMustFinish'))
  }
  const onError = (err: { errMsg?: string }) => {
    finish(false, err?.errMsg || t('me.adLoadFail'))
  }
  ad.onClose(onClose)
  ad.onError(onError)
  // 先直接展示缓存好的广告；没缓存时再拉取一次重试。
  ad.show().catch(() => {
    ad.load()
      .then(() => ad.show())
      .catch((err: { errMsg?: string }) => {
        finish(false, err?.errMsg || t('me.adPlayFail'))
      })
  })
  return promise
}

async function onWatchAd() {
  if (adBusy.value) return
  if (!adUnit.value) return
  adBusy.value = true
  // next 声明在 try 外面：块里的 const 降级成 ES5 会提升成 var，见 README
  let next: Awaited<ReturnType<typeof claimAdReward>> | null = null
  try {
    await showRewarded()
    next = await claimAdReward()
    uni.showToast({ title: t('me.adAdded', { count: next.granted || next.quota?.adBonus || 0 }), icon: 'success' })
  } catch (err) {
    uni.showToast({ title: failMessage(err, t('me.adFail')), icon: 'none' })
  } finally {
    adBusy.value = false
  }
}

// 只在 onLoad 里开一次：onShow 每次切回这个 tab 都会再触发一遍，
// 重复调 showShareMenu 没有意义。
onLoad(() => {
  enableShare()
  ensureTibetanFont()
})

onShow(() => {
  applyChrome()
})

// 「我的」是 tabBar 页，没有可分享的具体内容，转发出去的就是小程序本身。
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
    <view v-if="!registered" class="member-card yb-in is-guest">
      <view class="member-head">
        <image class="member-logo" src="/static/avatar-default.png" mode="aspectFill" />
        <view class="member-meta">
          <view class="member-name">{{ t('me.guest') }}</view>
          <view class="member-sub">{{ t('me.guestSub') }}</view>
        </view>
      </view>
      <view
        class="yb-btn"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="goLogin"
      >{{ t('me.freeLogin') }}</view>
    </view>

    <view v-if="registered" class="member-card yb-in" :class="cardClass">
      <view class="member-head">
        <image class="member-logo" :src="avatarUrl" mode="aspectFill" />
        <view class="member-meta">
          <view class="member-name">{{ displayName }}</view>
          <view class="member-sub">{{ member.label }}<text v-if="sinceText"> · {{ sinceText }}</text></view>
        </view>
      </view>
      <view class="member-stats">
        <view class="stat">
          <view class="n">{{ remaining }}</view>
          <view class="k">{{ t('me.remaining') }}</view>
        </view>
        <view class="stat">
          <view class="n">{{ profile?.checkinStreak || 0 }}</view>
          <view class="k">{{ t('me.streak') }}</view>
        </view>
        <view class="stat">
          <view class="n">{{ profile?.checkinTotal || 0 }}</view>
          <view class="k">{{ t('me.days') }}</view>
        </view>
      </view>
      <view class="member-bar">
        <view class="fill" :style="{ width: progressPct + '%' }" />
      </view>
      <view class="member-hint">{{ hint }}<text v-if="quota"> · {{ t('me.todayQuota', { used: quota.dailyUsed, limit: quota.dailyLimit }) }}<text v-if="showAdButton"> · {{ t('me.adExtra', { count: quota.extra }) }}</text></text></view>
    </view>

    <view v-if="sessionError" class="warn">{{ sessionError }}</view>

    <view v-if="registered" class="surface yb-in yb-in-2">
      <view
        class="yb-btn"
        :class="{ 'is-off': sessionBusy || checkinBusy || Boolean(profile?.checkedInToday) }"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="onCheckin"
      >{{ profile?.checkedInToday ? t('me.checked') : t('me.checkNow') }}</view>
      <view
        v-if="showAdButton"
        class="yb-btn is-ghost"
        :class="{ 'is-off': adBusy }"
        hover-class="is-press"
        :hover-stay-time="80"
        @click="onWatchAd"
      >{{ t('me.watchAd', { count: adBonus }) }}</view>
    </view>

    <view class="surface yb-in yb-in-3">
      <view class="section-label">{{ t('me.priceLevel') }}</view>
      <view class="muted">{{ t('me.priceLevelNote') }}</view>
      <view class="level-switch">
        <view
          v-for="lv in levels"
          :key="lv"
          class="opt"
          :class="{ 'is-on': hospitalLevel === lv }"
          hover-class="is-press"
          :hover-stay-time="80"
          @click="onLevel(lv)"
        >{{ levelLabel(lv) }}</view>
      </view>
      <view class="row">{{ t('me.currentLevel', { level: levelLabel(hospitalLevel) }) }}</view>
    </view>

    <view class="surface language-card yb-in yb-in-3">
      <view class="section-label">{{ t('language.title') }}</view>
      <view class="muted">{{ t('language.note') }}</view>
      <view class="language-switch">
        <view
          v-for="lang in languages"
          :key="lang.value"
          class="language-opt"
          :class="{ 'is-on': locale === lang.value, 'is-tibetan': lang.value === 'bo' }"
          hover-class="is-press"
          :hover-stay-time="80"
          @click="onLanguage(lang.value)"
        >{{ lang.label }}</view>
      </view>
    </view>

    <view class="account-row">
      <view class="link" hover-class="is-press" :hover-stay-time="80" @click="goAbout">{{ t('me.about') }}</view>
      <view v-if="registered" class="link" hover-class="is-press" :hover-stay-time="80" @click="onLogout">{{ t('me.logout') }}</view>
      <view v-if="registered" class="link danger" hover-class="is-press" :hover-stay-time="80" @click="onCancel">{{ t('me.cancel') }}</view>
    </view>

    <view class="site-foot">
      <view>{{ t('common.disclaimerShort') }}</view>
      <view>{{ t('common.powered') }}</view>
      <view class="site-link" @click="openWeChat">{{ t('common.feedback') }}</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.row {
  margin: 8rpx 0 0;
  font-size: 28rpx;
}
.warn {
  color: var(--yb-soon-fg);
  margin: 0 0 24rpx;
}
.member-card .yb-btn {
  margin-top: 28rpx;
}
.yb-btn + .yb-btn {
  margin-top: 16rpx;
}
.yb-btn.is-ghost {
  background: transparent;
  color: var(--yb-text);
  border: 1rpx solid var(--yb-border);
}
.level-switch {
  margin: 20rpx 0 8rpx;
}
.muted {
  margin-bottom: 4rpx;
}
.account-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18rpx 28rpx;
  justify-content: space-between;
  margin: 8rpx 8rpx 0;
}
.language-switch {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 12rpx;
  margin-top: 20rpx;
}
.language-opt {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 76rpx;
  padding: 12rpx 10rpx;
  border: 1rpx solid var(--yb-border);
  border-radius: 16rpx;
  color: var(--yb-text-2);
  font-size: 25rpx;
  line-height: 1.35;
  text-align: center;
}
.language-opt.is-on {
  border-color: var(--yb-chip-on-border);
  background: var(--yb-primary-soft);
  color: var(--yb-primary);
  font-weight: 700;
}
/* 藏文行高比中文高，1.9 时整行看着往下坠、和中文格不齐；压到 1.6 并把高度给足，
   既不切字（下加元音仍有余量），三格在任何语言下也同高同心。 */
.lang-bo .language-opt { min-height: 76rpx; line-height: 1.6; }
.language-opt.is-tibetan { font-family: 'QhybTibetan', 'Noto Serif Tibetan', 'Microsoft Himalaya', sans-serif; line-height: 1.6; }
.link {
  color: var(--yb-text-2);
  font-size: 24rpx;
}
.link.danger {
  color: var(--yb-soon-fg);
}
</style>
