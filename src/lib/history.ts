export type HistoryEntry = { q: string; at: number }

const HIST_KEY = 'qhyb.history.v1'
const MAX_HIST = 10

export function loadHistory(): HistoryEntry[] {
  // 声明在 try 外面：块里的 const 降级成 ES5 时会提升成 var，见 README
  let raw: unknown
  let parsed: unknown
  try {
    raw = uni.getStorageSync(HIST_KEY)
    parsed = typeof raw === 'string' ? (JSON.parse(raw) as HistoryEntry[]) : raw
    return Array.isArray(parsed) ? parsed.filter((row) => row && row.q) : []
  } catch {
    return []
  }
}

function save(next: HistoryEntry[]) {
  uni.setStorageSync(HIST_KEY, next)
  return next
}

export function pushHistory(q: string): HistoryEntry[] {
  const text = q.trim()
  if (text.length < 1) return loadHistory()
  return save([{ q: text, at: Date.now() }, ...loadHistory().filter((row) => row.q !== text)].slice(0, MAX_HIST))
}

export function removeHistory(q: string): HistoryEntry[] {
  return save(loadHistory().filter((row) => row.q !== q))
}

export function clearHistory(): HistoryEntry[] {
  try {
    uni.removeStorageSync(HIST_KEY)
  } catch {
    /* ignore */
  }
  return []
}
