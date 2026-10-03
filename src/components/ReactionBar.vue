<script setup lang="ts">
import { ref, watch } from 'vue'
import { mpFeedback, mpVote } from '../lib/api'
import { t } from '../lib/i18n'
import type { SearchItem } from '../lib/types'

const props = defineProps<{ item: SearchItem }>()
const CLIENT_KEY = 'qhyb.client'
const mine = ref<'' | 'up' | 'down'>('')
const up = ref(0)
const down = ref(0)
const open = ref(false)
const text = ref('')
const sending = ref(false)
const note = ref('')

function clientId() {
  const saved = uni.getStorageSync(CLIENT_KEY)
  if (typeof saved === 'string' && saved) return saved
  const next = `c${Date.now()}${Math.random().toString(16).slice(2)}`
  uni.setStorageSync(CLIENT_KEY, next)
  return next
}

watch(() => props.item.id, () => {
  mine.value = ''
  up.value = 0
  down.value = 0
  open.value = false
  text.value = ''
  note.value = ''
})

async function vote(action: 'up' | 'down') {
  const next = mine.value === action ? '' : action
  const previous = { mine: mine.value, up: up.value, down: down.value }
  // 声明摊在函数体一层：块里的 const 被压缩器改成短名后，微信降级 ES5 时
  // 提升成 var，可能顶掉参数（见 README）。
  let data: Awaited<ReturnType<typeof mpVote>> | null = null
  up.value += action === 'up' ? (next ? 1 : -1) : mine.value === 'up' ? -1 : 0
  down.value += action === 'down' ? (next ? 1 : -1) : mine.value === 'down' ? -1 : 0
  mine.value = next
  try {
    data = await mpVote({ id: props.item.id, action: next, client: clientId() })
    up.value = data.up
    down.value = data.down
    mine.value = data.mine || ''
  } catch {
    mine.value = previous.mine
    up.value = previous.up
    down.value = previous.down
  }
}

async function send() {
  const body = text.value.trim()
  if (body.length < 2 || sending.value) return
  sending.value = true
  note.value = ''
  try {
    await mpFeedback({
      id: props.item.id,
      code: props.item.code || '',
      name: props.item.name,
      text: body,
      client: clientId(),
      snapshot: {
        priceL3: props.item.priceL3 || '',
        priceL2: props.item.priceL2 || '',
        priceL1: props.item.priceL1 || '',
        payType: props.item.payType || '',
        status: props.item.status || '',
        executeAt: props.item.executeAt || '',
        stopAt: props.item.stopAt || '',
      },
    })
    text.value = ''
    open.value = false
    uni.showToast({ title: t('react.sent'), icon: 'none' })
  } catch {
    note.value = t('react.fail')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <!-- 点下面的胶囊别把整张卡片一起按下去：hover-stop-propagation 挡掉祖先的点击态。 -->
  <view class="react-bar" :hover-stop-propagation="true" @click.stop>
    <view class="react-btn" :class="{ 'is-on': mine === 'up' }" hover-class="is-press" :hover-stay-time="80" @click="vote('up')">
      <text class="react-icon">👍</text><text class="react-label">{{ t('react.up') }}</text><text v-if="up" class="react-count">{{ up }}</text>
    </view>
    <view class="react-btn" :class="{ 'is-on': mine === 'down' }" hover-class="is-press" :hover-stay-time="80" @click="vote('down')">
      <text class="react-icon">👎</text><text class="react-label">{{ t('react.down') }}</text><text v-if="down" class="react-count">{{ down }}</text>
    </view>
    <view class="react-btn is-flag" :class="{ 'is-on': open }" hover-class="is-press" :hover-stay-time="80" @click="open = !open">
      <text class="react-icon">💬</text><text class="react-label">{{ t('react.flag') }}</text>
    </view>
  </view>
  <view v-if="open" class="react-box" :hover-stop-propagation="true" @click.stop>
    <textarea v-model="text" class="react-text" maxlength="400" :placeholder="t('react.placeholder')" />
    <view class="react-line">
      <text v-if="note" class="react-note">{{ note }}</text>
      <view class="react-hint">{{ t('react.hint') }}</view>
      <view class="react-send" :class="{ 'is-off': sending || text.trim().length < 2 }" hover-class="is-press" :hover-stay-time="80" @click="send">{{ sending ? t('react.sending') : t('react.send') }}</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
/* 三个胶囊是卡片里唯一的小控件，得跟白卡片分得开：浅底 + 描边，别再裸着贴在上面。
   左右 28rpx 跟 .result-main 的正文对齐，底部 26rpx 留出到卡片圆角的距离 —— 之前一点
   内外边距都没有，胶囊直接压在卡片左、右、下三条边上。 */
.react-bar {
  display: flex;
  align-items: center;
  gap: 14rpx;
  padding: 0 28rpx 26rpx;
}
.react-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  min-height: 62rpx;
  padding: 6rpx 22rpx;
  border: 1rpx solid var(--yb-chip-border);
  border-radius: 999rpx;
  background: var(--yb-clear-bg);
  color: var(--yb-text-3);
  font-size: 24rpx;
  line-height: 1.3;
  transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.14s ease;
}
.react-btn.is-press {
  transform: scale(0.92);
  opacity: 0.9;
}
/* 选中态整颗填成主色，远看也认得出点过没有 */
.react-btn.is-on {
  border-color: var(--yb-primary);
  background: var(--yb-primary);
  color: #fff;
  font-weight: 600;
}
/* 点上的那一下让图标弹一弹，反馈才看得见 */
.react-btn.is-on .react-icon {
  animation: react-pop 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.react-btn.is-flag.is-on .react-icon {
  animation: react-nudge 0.34s ease;
}
@keyframes react-pop {
  0% { transform: scale(1); }
  45% { transform: scale(1.42); }
  100% { transform: scale(1); }
}
@keyframes react-nudge {
  0% { transform: translateY(0); }
  40% { transform: translateY(-5rpx); }
  100% { transform: translateY(0); }
}
/* 反馈和点赞不是一回事，推到右边隔开，免得误点。 */
.react-btn.is-flag { margin-left: auto; }
.react-icon { font-size: 28rpx; line-height: 1; }
/* 计数只有点过才出现，节点新建就播一次入场，不用为了动画再加状态 */
.react-count {
  font-size: 22rpx;
  font-weight: 600;
  animation: react-count-in 0.26s ease both;
}
@keyframes react-count-in {
  0% { opacity: 0; transform: translateY(6rpx); }
  100% { opacity: 0.9; transform: translateY(0); }
}
.react-box {
  margin: 0 28rpx 26rpx;
  padding: 20rpx;
  border: 1rpx solid var(--yb-chip-border);
  border-radius: 20rpx;
  background: var(--yb-clear-bg);
  animation: react-box-in 0.22s ease both;
}
@keyframes react-box-in {
  0% { opacity: 0; transform: translateY(-8rpx); }
  100% { opacity: 1; transform: translateY(0); }
}
.react-text { width: 100%; min-height: 132rpx; padding: 18rpx; box-sizing: border-box; border: 1rpx solid var(--yb-border); border-radius: 14rpx; background: var(--yb-surface); font-size: 26rpx; line-height: 1.5; }
.react-line { display: flex; align-items: center; gap: 12rpx; margin-top: 12rpx; }
.react-note { color: var(--yb-soon-fg); font-size: 24rpx; }
.react-hint { flex: 1; min-width: 0; color: var(--yb-text-3); font-size: 22rpx; }
.react-send { min-height: 60rpx; padding: 10rpx 34rpx; border-radius: 999rpx; background: var(--yb-primary); color: #fff; font-size: 26rpx; line-height: 40rpx; transition: background-color 0.18s ease, color 0.18s ease, transform 0.14s ease; }
.react-send.is-off { background: var(--yb-level-track); color: var(--yb-text-3); }
.react-send.is-press { transform: scale(0.94); }
</style>
