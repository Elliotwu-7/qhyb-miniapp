import { isConsumable, type HospitalLevel, type SearchItem } from './types'
import { t } from './i18n'

/**
 * 上海（中国标准时间）当天的本地零点。
 *
 * 这里原来用 `new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai' })` + formatToParts
 * 取年月日，在小程序里是致命的：微信 iOS 的逻辑层是 JavaScriptCore，自带 Intl；安卓逻辑层是
 * 精简版 V8，没有 Intl。而这句话在模块顶层，import 到它的页面直接整页白屏 ——
 * lib/search 引它，首页和「我的」都引 search，所以安卓上只剩微信原生的 tabBar，
 * 上面全空。iOS 一点事没有，正是因为 JSC 有 Intl。
 *
 * 中国标准时间 1991 年后就没有夏令时了，全年恒为 UTC+8，按固定偏移换算和查时区库
 * 结果完全一致，也就用不着 Intl。
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function shanghaiToday(now = new Date()): Date {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
}

const parsedDates = new Map<string, Date | null>()

export function catalogDate(text: string): Date | null {
  if (parsedDates.has(text)) return parsedDates.get(text) ?? null
  const m = (text || '').match(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  parsedDates.set(text, d)
  return d
}

export function isFutureCatalogDate(text: string, now = new Date()): boolean {
  const d = catalogDate(text)
  if (!d) return false
  return d.getTime() > shanghaiToday(now).getTime()
}

export function isEffectivelyStopped(item: SearchItem, now = new Date()): boolean {
  if (item.status === 'stopped') return true
  const d = catalogDate(item.stopAt)
  if (!d) return false
  return d.getTime() <= shanghaiToday(now).getTime()
}

export function isUpcoming(item: SearchItem, now = new Date()): boolean {
  if (isEffectivelyStopped(item, now)) return false
  return isFutureCatalogDate(item.stopAt, now)
}

export function isUpcomingExecute(item: SearchItem, now = new Date()): boolean {
  if (isEffectivelyStopped(item, now)) return false
  // 耗材目录里有一档「公示未生效」：编码已经公示，但还没到执行这一步。
  // 收费项目的 status 只有在用/停用两种，多这一条不会影响它们。
  if (item.status === 'pending') return true
  return isFutureCatalogDate(item.executeAt, now)
}

export function isCurrentlyChargeable(item: SearchItem, now = new Date()): boolean {
  return !isEffectivelyStopped(item, now) && !isUpcomingExecute(item, now)
}

export function currentUseHint(item: SearchItem): string[] {
  const from = item.mergeFrom || []
  if (!from.length) return []
  const compact = item.name.replace(/[（）()·,，、/\-\s]/g, '')
  const tokens: string[] = []
  if (compact.length >= 2) tokens.push(compact.slice(0, 2))
  if (compact.length >= 3) tokens.push(compact.slice(0, 3))
  if (compact.length >= 4) tokens.push(compact.slice(0, 4))
  const generic = /^(常规|复杂|加收|扩展|普通|治疗|项目|门诊|手术)$/
  const bits = tokens.filter((t) => !generic.test(t))
  return from.filter((name) => bits.some((bit) => name.includes(bit)))
}

export function priceByLevel(item: Pick<SearchItem, 'priceL3' | 'priceL2' | 'priceL1'>, level: HospitalLevel) {
  if (level === 'L2') return item.priceL2
  if (level === 'L1') return item.priceL1
  return item.priceL3
}

export function currentPriceOf(item: SearchItem, level: HospitalLevel, now = new Date()) {
  if (isUpcomingExecute(item, now)) return ''
  return priceByLevel(item, level)
}

export function nextPriceOf(item: SearchItem, level: HospitalLevel, now = new Date()) {
  if (!isUpcomingExecute(item, now)) return ''
  return priceByLevel(item, level)
}

export function displayPriceOf(item: SearchItem, level: HospitalLevel, now = new Date()) {
  if (isUpcomingExecute(item, now)) return nextPriceOf(item, level, now)
  const current = currentPriceOf(item, level, now)
  if (current) return current
  if (isEffectivelyStopped(item, now)) return priceByLevel(item, level)
  return ''
}

export function laterDateText(text: string) {
  const m = (text || '').match(/(\d{4}[.\-/年]\d{1,2}[.\-/月]\d{1,2})/)
  return m ? m[1].replace(/[年月]/g, '.').replace(/日/, '') : text
}

export function statusLabel(item: SearchItem) {
  // 耗材的词表和服务项目不一样：目录会整版废止，挂网和带量只有现行一种。
  if (isConsumable(item)) return t(`hc.status.${item.status || 'active'}`)
  if (isEffectivelyStopped(item)) return t('status.stopped')
  if (isUpcomingExecute(item)) return t('status.executes', { date: item.executeAt })
  if (isUpcoming(item)) return t('status.stops', { date: laterDateText(item.stopAt) })
  if (item.merged) return t('status.merged')
  return t('status.active')
}

export function statusType(item: SearchItem): 'danger' | 'warning' | 'primary' | 'success' | 'default' {
  if (isEffectivelyStopped(item)) return 'danger'
  if (isUpcomingExecute(item) || isUpcoming(item)) return 'warning'
  if (item.merged) return 'primary'
  return 'success'
}
