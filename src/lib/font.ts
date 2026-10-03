import { ref } from 'vue'

export const tibetanFontReady = ref(false)
let loading = false

/** Use one consistent Tibetan font; some system fallbacks draw stacked signs tiny. */
export function ensureTibetanFont() {
  if (loading || tibetanFontReady.value || typeof uni.loadFontFace !== 'function') return
  loading = true
  try {
    uni.loadFontFace({
      global: true,
      family: 'QhybTibetan',
      source: 'url("https://qhyb.lynkco.site/fonts/NotoSerifTibetan-Regular.ttf")',
      success: () => { tibetanFontReady.value = true; loading = false },
      fail: () => { loading = false },
    })
  } catch {
    loading = false
  }
}
