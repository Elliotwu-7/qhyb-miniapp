import { catalogDate, isEffectivelyStopped, isFutureCatalogDate } from './status'
import { t } from './i18n'
import type { PriceEvent, SearchItem } from './types'

const MARKET_RE = /市场调节|自行定价/
const MILEAGE_RE = /按里程计|里程费用/
const BLOOD_RE = /参照血站|血液中心/
const PRIMARY_RE = /限基层|乡镇卫生院|社区卫生服务/
const BLANK = new Set(['', '—', '-', '–', '−', '/', 'none', 'null', 'None', '无'])

export type PriceKind = 'money' | 'market' | 'none' | 'note'
export type PriceShow = { kind: PriceKind; text: string }

export function isBlank(raw: string) {
  return BLANK.has((raw || '').trim())
}

export function showPrice(raw: string, note = ''): PriceShow {
  const v = (raw || '').trim()
  if (MARKET_RE.test(v) || (isBlank(v) && MARKET_RE.test(note))) {
    return { kind: 'market', text: t('price.market') }
  }
  if (v === '按里程计' || (isBlank(v) && MILEAGE_RE.test(note))) {
    return { kind: 'note', text: t('price.mileage') }
  }
  if (v === '参照血站价' || (isBlank(v) && BLOOD_RE.test(note))) {
    return { kind: 'note', text: t('price.blood') }
  }
  if (v === '限基层机构' || (isBlank(v) && PRIMARY_RE.test(note))) {
    return { kind: 'note', text: t('price.primary') }
  }
  if (isBlank(v)) return { kind: 'none', text: '/' }
  return { kind: 'money', text: v }
}

export function drawerPrice(raw: string, note = '') {
  const show = showPrice(raw, note)
  if (show.kind === 'money') return t('price.yuan', { value: show.text })
  if (show.kind === 'market' || show.kind === 'note') return show.text
  return t('price.none')
}

export function levelLabel(level: string) {
  if (level === 'L2') return t('price.level2')
  if (level === 'L1') return t('price.level1')
  return t('price.level3')
}

export function priceText(raw: string, note = '') {
  return showPrice(raw, note).text
}

export type HistoryKind = 'future' | 'now' | 'dead'
export type HistoryRow = PriceEvent & { kind: HistoryKind }

export function isStopEvent(event: string) {
  return event.includes('停用') || event.includes('不可再收费')
}

export function isOldEvent(event: string) {
  return event.startsWith('原') || event.includes('停用前') || event.includes('修订前')
}

export function historyStamp(at: string): number {
  const d = catalogDate(at)
  return d ? d.getTime() : 0
}

export function sortHistory<T extends { at: string; event: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = historyStamp(a.at)
    const db = historyStamp(b.at)
    if (db !== da) return db - da
    const ao = a.event.startsWith('原') ? 1 : 0
    const bo = b.event.startsWith('原') ? 1 : 0
    if (ao !== bo) return ao - bo
    const as = /停用/.test(a.event) ? 1 : 0
    const bs = /停用/.test(b.event) ? 1 : 0
    return as - bs
  })
}

export function historyTitle(row: PriceEvent) {
  if (row.event === '现行指导价' && isFutureCatalogDate(row.at)) return t('price.upcoming')
  if (row.event === '现行指导价') return t('result.livePrice')
  return row.event
}

function currentStamp(rows: PriceEvent[]): number {
  let max = 0
  // 用 forEach 而不是 for...of：见 README 的 ES5 降级说明
  rows.forEach((row) => {
    if (isFutureCatalogDate(row.at)) return
    if (row.event.startsWith('改用')) return
    if (isStopEvent(row.event) || isOldEvent(row.event)) return
    max = Math.max(max, historyStamp(row.at))
  })
  return max
}

export function historyKind(row: PriceEvent, nowMax: number, stopped: boolean): HistoryKind {
  if (isFutureCatalogDate(row.at)) return 'future'
  if (row.event.startsWith('改用')) return 'now'
  if (stopped || isStopEvent(row.event) || isOldEvent(row.event)) return 'dead'
  const t = historyStamp(row.at)
  if (t === nowMax) return 'now'
  return 'dead'
}

export function decorateHistory(
  history: PriceEvent[],
  item: SearchItem,
  findByName?: (name: string) => SearchItem | undefined,
): HistoryRow[] {
  const rows = history.map((row) => {
    let pay = row.payType || ''
    if (!pay && row.event.startsWith('原') && row.ref && findByName) {
      pay = findByName(row.ref)?.payType || ''
    }
    if (!pay && !row.event.startsWith('原')) pay = item.payType || ''
    return { ...row, payType: pay }
  })
  const sorted = sortHistory(rows)
  const nowMax = currentStamp(sorted)
  const stopped = isEffectivelyStopped(item)
  return sorted.map((row) => ({ ...row, kind: historyKind(row, nowMax, stopped) }))
}
