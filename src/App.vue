<script setup lang="ts">
import { onLaunch, onShow } from '@dcloudio/uni-app'
import { bootLocale } from './lib/i18n'
import { restoreSession } from './lib/session'
import { applyChrome, bootTheme } from './lib/theme'
import { watchPrivacy } from './lib/privacy'
import { loadSearchTerms } from './lib/search-terms'

onLaunch(() => {
  bootLocale()
  bootTheme()
  watchPrivacy()
  void restoreSession()
})

onShow(() => {
  applyChrome()
  void loadSearchTerms()
})
</script>

<template>
  <view />
</template>

<style lang="scss">
@import './styles/yb.scss';
</style>
