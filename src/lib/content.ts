import { computed, inject, provide, ref, watch, type InjectionKey, type Ref, type ComputedRef } from 'vue'
import { locale, t, type AppLocale } from './i18n'
import { reviewedName, registerReferenceTerm } from './search-terms'

type ContentLocale = Exclude<AppLocale, 'zh'>
type Entry = { state: 'queued' | 'loading' | 'ready' | 'failed'; text: string }
const cache: Record<ContentLocale, Map<string, Entry>> = { en: new Map(), bo: new Map() }
const queues: Record<ContentLocale, Set<string>> = { en: new Set(), bo: new Set() }
export const contentRevision = ref(0)
let active = 0
let scheduled = false
const HAN = /[\u3400-\u9fff]/

function schedule() {
  if (scheduled) return
  scheduled = true
  setTimeout(() => { scheduled = false; flush() }, 30)
}

function enqueue(language: ContentLocale, text: string) {
  if (cache[language].has(text)) return
  cache[language].set(text, { state: 'queued', text: '' })
  queues[language].add(text)
  schedule()
}

function request(language: ContentLocale, texts: string[]): Promise<Array<string | null>> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: 'https://qhyb.lynkco.site/api/content/translate',
      method: 'POST',
      data: { language, texts },
      timeout: 120000,
      enableHttp2: false,
      enableQuic: false,
      useHighPerformanceMode: false,
      success(res) {
        const data = res.data as { ok?: boolean; language?: string; translations?: Array<string | null> }
        if (res.statusCode !== 200 || !data?.ok || data.language !== language || !Array.isArray(data.translations) || data.translations.length !== texts.length) {
          reject(new Error('Invalid content translation response'))
          return
        }
        resolve(data.translations)
      },
      fail: reject,
    })
  })
}

function flush() {
  if (active >= 2) return
  const language: ContentLocale | undefined = (['en', 'bo'] as const).find((lang) => queues[lang].size)
  if (!language) return
  const texts: string[] = []
  let length = 0
  queues[language].forEach((text) => {
    if (texts.length >= 24 || (texts.length > 0 && length + text.length > 3000)) return
    texts.push(text)
    length += text.length
  })
  texts.forEach((text) => {
    queues[language].delete(text)
    cache[language].set(text, { state: 'loading', text: '' })
  })
  active += 1
  contentRevision.value += 1
  const finish = (translations: Array<string | null>) => {
    texts.forEach((text, i) => {
      const value = translations[i]
      cache[language].set(text, typeof value === 'string' && value.trim() && !HAN.test(value)
        ? { state: 'ready', text: value }
        : { state: 'failed', text: '' })
      if (cache[language].get(text)?.state === 'ready') registerReferenceTerm(text, language, value!)
    })
    contentRevision.value += 1
    active -= 1
    schedule()
  }
  request(language, texts).then(finish, () => finish(texts.map(() => null)))
  // Start at most two requests; navigation and source-data requests stay responsive.
  schedule()
}

export type ContentScope = {
  ct: (value: string | null | undefined) => string
  ctSoft: (value: string | null | undefined) => string
  original: Ref<boolean>
  pending: ComputedRef<boolean>
  failed: ComputedRef<boolean>
  retry: () => void
}
const ContentKey: InjectionKey<ContentScope> = Symbol('content-language')

export function useContentTranslation(root = false): ContentScope {
  const inherited = inject(ContentKey, null)
  if (inherited && !root) return inherited
  const original = ref(false)
  const used = new Set<string>()
  const usedRevision = ref(0)
  let usageScheduled = false
  // soft=true 给「嵌在一句话里的名字」用：拿不到译文就退回原文，绝不把「译文暂不可用」
  // 塞进句子里（那会渲染成「请改用『译文暂不可用』」）。翻译失败本身由页面顶部的
  // ContentNotice 统一说明，句子这里只保证读得通。
  const ct = (value: string | null | undefined, soft = false) => {
    const text = String(value || '')
    const language = locale.value
    if (language === 'zh' || original.value || !HAN.test(text)) return text
    const reviewed = reviewedName(text, language)
    if (reviewed) return reviewed
    contentRevision.value
    if (!used.has(text)) {
      used.add(text)
      if (!usageScheduled) {
        usageScheduled = true
        setTimeout(() => { usageScheduled = false; usedRevision.value += 1 }, 0)
      }
    }
    enqueue(language, text)
    const entry = cache[language].get(text)
    if (entry?.state === 'ready') return entry.text
    if (entry?.state === 'failed') return soft ? text : t('content.unavailable')
    return soft ? text : '…'
  }
  const hasState = (state: Entry['state']) => {
    contentRevision.value
    usedRevision.value
    const language = locale.value
    if (language === 'zh' || original.value) return false
    return Array.from(used).some((text) => cache[language].get(text)?.state === state)
  }
  const scope: ContentScope = {
    ct, ctSoft: (value) => ct(value, true), original,
    pending: computed(() => hasState('queued') || hasState('loading')),
    failed: computed(() => hasState('failed')),
    retry() {
      const language = locale.value
      if (language === 'zh') return
      used.forEach((text) => {
        if (cache[language].get(text)?.state !== 'failed') return
        cache[language].delete(text)
        enqueue(language, text)
      })
      contentRevision.value += 1
    },
  }
  watch(locale, () => { original.value = false; used.clear() })
  if (root) provide(ContentKey, scope)
  return scope
}
