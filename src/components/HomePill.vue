<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../lib/i18n'
import { goHome, soloStack } from '../lib/nav'

/**
 * 「返回首页」胶囊：只在页面栈里只有这一页时出现。
 *
 * 这种页面是分享卡或扫码直接进来的 —— 微信原生的返回箭头在单页栈上会**退出小程序**，
 * 平台上又没有「让原生导航栏画一个返回首页按钮」的 API（模拟器里查过，基础库 3.17.3
 * 的 wx 上只有 hideHomeButton，没有 showHomeButton）。所以只能自己在页面里给一条出路。
 *
 * 判断写在 computed 里：第一次渲染时求值，那会儿当前页已经在栈上了。栈深超过 1 就说明
 * 上面还有一页，原生箭头能把人送回去，这里不再重复。
 */
const solo = computed(() => soloStack())
</script>

<template>
  <view v-if="solo" class="top-bar">
    <view class="back-home" hover-class="is-press" :hover-stay-time="80" @click="goHome">
      <view class="back-chevron" />
      <text class="back-text">{{ t('home.backHome') }}</text>
    </view>
  </view>
</template>
