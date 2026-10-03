import { ref } from 'vue'

type Term = { source: string; language: 'en' | 'bo'; term: string; reviewed: boolean; normalized?: string }
type Pack = { ok: boolean; version: string; entries: Term[]; managed: Array<[string, string]> }
const terms = new Map<string, Term[]>()
const managed = new Set<string>()
export const searchTermRevision = ref(0)
export const searchTermsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
let pending: Promise<void> | null = null
let loadedAt = 0

export function normalizeSearchText(text: string): string {
  const folded = typeof text.normalize === 'function' ? text.normalize('NFKC') : text
  // Keep Tibetan letters and vowel marks; ignore tsheg, shad and spacing.
  return folded.replace(/[^\u4e00-\u9fffA-Za-z0-9\u0f20-\u0f29\u0f40-\u0f6c\u0f71-\u0f84\u0f86-\u0fbc]+/g, '').toLowerCase()
}

function key(source: string, language: string) { return `${language}\0${source}` }
function put(entry: Term) {
  const rows = terms.get(entry.source) || []
  if (rows.some((row) => row.language === entry.language && row.term === entry.term)) return
  rows.push({ ...entry, normalized: normalizeSearchText(entry.term) })
  terms.set(entry.source, rows)
}

export function registerReferenceTerm(source: string, language: 'en' | 'bo', term: string) {
  if (source.length > 200 || !term || managed.has(key(source, language))) return
  const before = terms.get(source)?.length || 0
  put({ source, language, term, reviewed: false })
  if ((terms.get(source)?.length || 0) !== before) searchTermRevision.value += 1
}

export function applySearchTerms(pack: Pack) {
  if (!pack || pack.ok !== true || typeof pack.version !== 'string' || !Array.isArray(pack.entries) || !Array.isArray(pack.managed)
    || pack.entries.some((row) => !row || typeof row.source !== 'string' || typeof row.term !== 'string' || !['en', 'bo'].includes(row.language) || typeof row.reviewed !== 'boolean')
    || pack.managed.some((row) => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !['en', 'bo'].includes(row[1]))) throw new Error('Invalid search terms')
  // Replace the snapshot so withdrawn aliases cannot survive in the cache.
  terms.clear(); managed.clear()
  pack.managed.forEach(([source, language]) => managed.add(key(source, language)))
  pack.entries.forEach(put)
  searchTermRevision.value += 1
}

export function translatedNameMatch(source: string, normalizedQuery: string): 'exact' | 'part' | null {
  searchTermRevision.value
  if (!normalizedQuery) return null
  const rows = terms.get(source) || []
  if (rows.some((row) => row.normalized === normalizedQuery)) return 'exact'
  return rows.some((row) => row.normalized?.includes(normalizedQuery)) ? 'part' : null
}

export function reviewedName(source: string, language: string): string | undefined {
  searchTermRevision.value
  return terms.get(source)?.find((row) => row.language === language && row.reviewed)?.term
}

export function loadSearchTerms(force = false): Promise<void> {
  if (pending) return pending
  if (!force && loadedAt && Date.now() - loadedAt < 60000) return Promise.resolve()
  searchTermsState.value = 'loading'
  pending = new Promise<void>((resolve, reject) => {
    uni.request({
      url: 'https://qhyb.lynkco.site/api/search/terms', method: 'GET', timeout: 12000,
      enableHttp2: false, enableQuic: false, useHighPerformanceMode: false,
      success(res) {
        try {
          if (res.statusCode !== 200) throw new Error('Search terms unavailable')
          applySearchTerms(res.data as Pack)
          loadedAt = Date.now(); searchTermsState.value = 'ready'; resolve()
        } catch (error) { reject(error) }
      },
      fail: reject,
    })
  }).catch(() => { searchTermsState.value = 'error' }).finally(() => { pending = null })
  return pending
}
