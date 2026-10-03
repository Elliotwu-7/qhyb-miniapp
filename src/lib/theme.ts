import { computed, ref } from 'vue'
import { applyLocaleChrome } from './i18n'

export type ThemeMode = 'light' | 'dark'

export const THEME_KEY = 'qhyb.theme'
export const THEME_LIGHT = '#F5F8FC'
export const THEME_DARK = '#0f141c'

function systemDark() {
  try {
    return uni.getSystemInfoSync().theme === 'dark'
  } catch {
    return false
  }
}

const systemIsDark = ref(systemDark())

export const themeMode = computed<ThemeMode>(() => (systemIsDark.value ? 'dark' : 'light'))

const TAB_ROUTES = new Set(['pages/index/index', 'pages/me/me'])

function currentRoute() {
  // 声明在 try 外面：块里的 const 降级成 ES5 时会提升成 var，见 README
  let stack: Array<{ route?: string }> = []
  let cur: { route?: string } | undefined
  try {
    stack = getCurrentPages() as Array<{ route?: string }>
    cur = stack[stack.length - 1]
    return cur?.route || ''
  } catch {
    return ''
  }
}

function callChrome(fn: () => void) {
  try {
    fn()
  } catch {
    /* 该平台没有这个 API；主题是装饰性的，不能打断页面初始化 */
  }
}

export function applyChrome(mode = themeMode.value) {
  const dark = mode === 'dark'
  const bg = dark ? THEME_DARK : THEME_LIGHT
  const front = dark ? '#ffffff' : '#000000'
  callChrome(() =>
    uni.setNavigationBarColor({
      frontColor: front,
      backgroundColor: bg,
      animation: { duration: 0, timingFunc: 'linear' },
      fail() {},
    }),
  )
  callChrome(() =>
    uni.setBackgroundColor({
      backgroundColor: bg,
      backgroundColorTop: bg,
      backgroundColorBottom: bg,
      fail() {},
    }),
  )
  applyLocaleChrome()
  const route = currentRoute()
  if (!route || !TAB_ROUTES.has(route)) return
  callChrome(() =>
    uni.setTabBarStyle({
      color: dark ? '#8b95a8' : '#6b7280',
      selectedColor: dark ? '#7aa0ff' : '#2660ff',
      backgroundColor: dark ? '#1a2030' : '#ffffff',
      borderStyle: dark ? 'white' : 'black',
      fail() {},
    }),
  )
}

export function bootTheme() {
  try {
    uni.removeStorageSync(THEME_KEY)
  } catch {
    /* ignore leftover manual pref */
  }
  systemIsDark.value = systemDark()
  applyChrome()
  try {
    uni.onThemeChange((res) => {
      systemIsDark.value = res.theme === 'dark'
      applyChrome()
    })
  } catch {
    /* ignore */
  }
}
