import { failErrorAt } from './fail'
import { t } from './i18n'
import type { MemberInfo } from './member'
import type { SearchItem } from './types'

export type { MemberInfo, MemberTier } from './member'

export const API_BASE = 'https://qhyb.lynkco.site/api'

export type AdsConfig = {
  enabled: boolean
  rewarded: { unitId: string | null; reserved: boolean }
}

export type QuotaInfo = {
  dailyLimit: number
  dailyUsed: number
  dailyLeft: number
  extra: number
  remaining: number
  adBonus: number
}

export type MpProfile = {
  ok: boolean
  token?: string
  openid?: string
  hospitalLevel: 'L3' | 'L2' | 'L1'
  lastCheckinDate: string
  checkedInToday: boolean
  checkinStreak: number
  checkinTotal: number
  ads: AdsConfig
  member?: MemberInfo
  registered?: boolean
  nickname?: string
  avatar?: string
  phone?: string
  quota?: QuotaInfo
  already?: boolean
  reward?: string
  granted?: number
  source?: string
  error?: string
}

const wxNet = {
  enableHttp2: false,
  enableQuic: false,
  useHighPerformanceMode: false,
} as const

function request<T>(path: string, method: 'GET' | 'POST', body?: unknown, token?: string): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const header: Record<string, string> = { 'content-type': 'application/json' }
  if (token) {
    header.Authorization = `Bearer ${token}`
    header['x-mp-token'] = token
  }
  uni.request({
    url: `${API_BASE}${path}`,
    method,
    header,
    data: body as string | AnyObject | ArrayBuffer | undefined,
    ...wxNet,
    success: (res) => {
      // 声明提到回调顶层：放在 if 块里降级成 ES5 时会提升成 var，见 README
      const payload = (res.data || {}) as { error?: string; quota?: QuotaInfo }
      const err = new Error(payload.error || `${path} ${res.statusCode}`) as Error & { quota?: QuotaInfo; statusCode?: number }
      err.statusCode = res.statusCode
      if (res.statusCode && res.statusCode >= 400) {
        if (payload.quota) err.quota = payload.quota
        reject(err)
        return
      }
      resolve(res.data as T)
    },
    fail: (err) => reject(failErrorAt(err, t('error.request', { target: `${API_BASE}${path}` }))),
  })
  return promise
}

export function mpLogin(code: string) {
  return request<MpProfile>('/mp/login', 'POST', { code })
}

export function mpMe(token: string) {
  return request<MpProfile>('/mp/me', 'GET', undefined, token)
}

export function mpCheckin(token: string) {
  return request<MpProfile>('/mp/checkin', 'POST', {}, token)
}

export function mpSettings(token: string, hospitalLevel: 'L3' | 'L2' | 'L1') {
  return request<MpProfile>('/mp/settings', 'POST', { hospitalLevel }, token)
}

export function mpRegister(token: string, body: { nickname: string; avatar?: string; phoneCode?: string }) {
  return request<MpProfile>('/mp/register', 'POST', body, token)
}

export function mpLogout(token: string) {
  return request<{ ok: boolean }>('/mp/logout', 'POST', {}, token)
}

export function mpCancel(token: string) {
  return request<{ ok: boolean }>('/mp/cancel', 'POST', {}, token)
}

export type NhcSpecHit = { code: string; name: string; page: number }

export type NhcSpecRow = {
  code: string
  name: string
  page: number
  english?: string
  connotation?: string
  detail?: string
  fullText?: string
  excerpt?: string
  catalogIds?: string[]
}

/** 规范检索。total 是命中总数，items 只给一页；翻页靠 offset（见 index 的 loadMoreNhc）。 */
export function mpNhcSpec(query: string, offset = 0) {
  const q = encodeURIComponent(query.trim())
  const from = Math.max(0, Math.floor(offset) || 0)
  return request<{ ok: boolean; total: number; items: NhcSpecHit[]; note?: string }>(`/nhc-spec?q=${q}&offset=${from}`, 'GET')
}

/**
 * 目录检索。整份目录不再先下到手机上建索引：手机只拿这一页，打字预览和翻页都走这里。
 * 和规范检索一样是公开的 GET，不扣查询配额 —— 配额只在点查询、热词、历史词时扣。
 */
export type CatalogSearchCounts = { service: number; drug: number; consumable: number }

export type CatalogSearchPage = {
  ok: boolean
  version: string
  total: number
  counts: CatalogSearchCounts
  items: SearchItem[]
}

export function mpCatalogSearch(params: {
  q: string
  scope?: string
  category?: string
  status?: string
  drug?: string
  hc?: string
  offset?: number
  limit?: number
}) {
  const parts: string[] = []
  const add = (key: string, value: string) => {
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`)
  }
  add('q', params.q)
  add('scope', params.scope || '')
  add('category', params.category || '')
  add('status', params.status || '')
  add('drug', params.drug || '')
  add('hc', params.hc || '')
  parts.push(`offset=${Math.max(0, Math.floor(params.offset || 0) || 0)}`)
  parts.push(`limit=${params.limit || 40}`)
  return request<CatalogSearchPage>(`/catalog-search?${parts.join('&')}`, 'GET')
}

/**
 * 按 id 只要这一条。详情页在整份目录还没下完时用它先画出名称和价格，
 * 不用等搜索包、关系包和耗材包全部到齐。查不到时 item 是 null。
 */
export function mpCatalogItem(id: string) {
  return request<{ ok: boolean; item: SearchItem | null }>(`/catalog-search?id=${encodeURIComponent(id)}`, 'GET')
}

/** 收费项目对应的技术规范。byItem 给出全部规范编号，合并项不会被截成其中一条。 */
export function mpNhcSpecLinks(ids: string[]) {
  const list = encodeURIComponent(ids.join(','))
  return request<{ ok: boolean; items: NhcSpecRow[]; byItem: Record<string, string[]> }>(`/nhc-spec?ids=${list}`, 'GET')
}

/** 一条技术规范，以及由它形成的收费项目（只给编号，名称用本地目录解析）。 */
export function mpNhcSpecItems(code: string) {
  return request<{ ok: boolean; spec?: NhcSpecRow; items: string[]; total: number; error?: string }>(
    `/nhc-spec?code=${encodeURIComponent(code)}`,
    'GET',
  )
}

/** 药品在《中国药典》2025年版里的出处。药典库在服务端，这里按药品名批量问。 */
export type PharmacopoeiaHit = {
  name: string
  volume: string
  part: string
  bookPage: number | null
  pdfPage: number | null
}

export function mpPharmacopoeia(names: string[]) {
  const list = encodeURIComponent(names.join(','))
  return request<{ ok: boolean; byName: Record<string, PharmacopoeiaHit[]> }>(`/pharmacopoeia?names=${list}`, 'GET')
}

/**
 * 参考资料汇编（全国／上海市／山东省）。和技术规范同理：整包 59,359 条、光搜索包 18 MB，
 * 不进小程序包，只在服务端建索引，这里按需问。
 */
export type RefMetaDataset = {
  key: string
  title: string
  short: string
  scope: string
  kind: string
  issuer: string
  effectiveAt: string
  sourceFile: string
  note: string
  count: number
  parts: Record<string, number>
}

export type RefMeta = {
  ok: boolean
  total: number
  scopeOrder: string[]
  datasets: RefMetaDataset[]
  withheld: string[]
  withheldNote: string
}

export type RefItem = {
  id: string
  ds: string
  scope: string
  kind: string
  part: string
  code: string
  name: string
  form: string
  payClass: string
  classCode: string
  className: string
  remark: string
  protocol: string
  price: string
  unit: string
  status: string
  alias: string
  pi: string
  py: string
  /** 只有按 id 取单条时才带回来：搜索包里不发行这几栏长文本。 */
  detail?: Record<string, string>
}

export function mpRefMeta() {
  return request<RefMeta>('/ref-datasets', 'GET')
}

export function mpRefSearch(params: { q?: string; scope?: string; ds?: string; part?: string; limit?: number; offset?: number }) {
  const parts: string[] = []
  const add = (key: string, value: string) => {
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`)
  }
  add('q', params.q || '')
  add('scope', params.scope || '')
  add('ds', params.ds || '')
  add('part', params.part || '')
  parts.push(`limit=${params.limit || 20}`)
  parts.push(`offset=${params.offset || 0}`)
  return request<{ ok: boolean; total: number; items: RefItem[]; query: string }>(`/ref?${parts.join('&')}`, 'GET')
}

export function mpRefItem(id: string) {
  return request<{ ok: boolean; item: RefItem | null }>(`/ref?id=${encodeURIComponent(id)}`, 'GET')
}

export function mpVote(body: { id: string; action: '' | 'up' | 'down'; client: string }) {
  return request<{ ok: boolean; up: number; down: number; mine: '' | 'up' | 'down' }>('/vote', 'POST', body)
}

export function mpFeedback(body: { id: string; code: string; name: string; text: string; client: string; snapshot: Record<string, string> }) {
  return request<{ ok: boolean; id: string }>('/feedback', 'POST', body)
}

export function mpQuery(token: string, q: string) {
  return request<MpProfile>('/mp/query', 'POST', { q }, token)
}

export function mpAdReward(token: string) {
  return request<MpProfile>('/mp/ad-reward', 'POST', {}, token)
}

export function avatarSrc(path?: string) {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('wxfile://') || path.startsWith('http://tmp') || path.startsWith('/static/')) {
    return path
  }
  if (path.startsWith('/')) return `https://qhyb.lynkco.site${path}`
  return path
}
