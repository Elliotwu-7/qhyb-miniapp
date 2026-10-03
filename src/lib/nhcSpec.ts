import { mpNhcSpecItems, mpNhcSpecLinks, type NhcSpecRow } from './api'
import type { SearchItem } from './types'

export type NhcSpecItem = {
  code: string
  name: string
  page: number
  english: string
  connotation: string
  detail: string
  fullText: string
}

/** 收费项目 → 技术规范。codes 可能不止一条：一个定价项目可以合并多条规范。 */
export type ItemSpecs = {
  codes: string[]
  specs: NhcSpecItem[]
}

export type SpecDetail = {
  spec: NhcSpecItem
  /** 由这条规范形成的收费项目编号；名称用目录里的同一条数据解析，不重复存。 */
  items: string[]
  total: number
}

const EMPTY = {
  title: '全国医疗服务项目技术规范（2023年版）',
  publisher: '国家卫生健康委、国家中医药局、国家疾控局',
  note: '技术规范检索结果，不作为本目录价格、报销或临床操作依据。',
  /** 官方 PDF 原文。小程序打不开外部网页（业务域名里没有 nhc.gov.cn），
   *  所以这里只给链接、由用户复制后在浏览器里打开。 */
  url: 'https://www.nhc.gov.cn/caiwusi/c100043/202309/b22604883d9a4ca58e82bc61b57cd4fd/files/1743471174207_63273.pdf',
}

/** 规范节点的 id 前缀。规范不是收费项目，所以不能混进目录 id 里。 */
export const SPEC_PREFIX = 'nhc:'

export function specNodeId(code: string) {
  return `${SPEC_PREFIX}${code}`
}

export function isSpecNode(id: string) {
  return id.startsWith(SPEC_PREFIX)
}

export function specCodeOf(id: string) {
  return isSpecNode(id) ? id.slice(SPEC_PREFIX.length) : ''
}

export function specAsSearchItem(spec: Pick<NhcSpecItem, 'code' | 'name' | 'page'>): SearchItem {
  return {
    id: specNodeId(spec.code),
    code: spec.code,
    name: spec.name,
    aliases: [],
    pi: '',
    py: '',
    aliasPi: '',
    aliasPy: '',
    status: 'active',
    merged: false,
    unit: `第 ${spec.page} 页`,
    cat1: '技术规范',
    payClass: '',
    payType: '',
    priceL3: '',
    priceL2: '',
    priceL1: '',
    stopAt: '',
    executeAt: '',
    mergeFrom: [],
    successors: [],
    source: 'nhc-spec',
    spec: true,
    page: Number(spec.page || 0),
  }
}

function toSpec(row: NhcSpecRow): NhcSpecItem {
  return {
    code: String(row.code || ''),
    name: String(row.name || ''),
    page: Number(row.page || 0),
    english: String(row.english || ''),
    connotation: String(row.connotation || ''),
    detail: String(row.detail || row.excerpt || ''),
    fullText: String(row.fullText || ''),
  }
}

// 只缓存成功的查询：网络失败不能被当成「这个项目没有规范」。
const itemCache = new Map<string, ItemSpecs>()

export async function loadItemSpecs(itemId: string): Promise<ItemSpecs> {
  const hit = itemCache.get(itemId)
  if (hit) return hit
  let data: Awaited<ReturnType<typeof mpNhcSpecLinks>> | null = null
  try {
    data = await mpNhcSpecLinks([itemId])
  } catch {
    return { codes: [], specs: [] }
  }
  const codes = (data.byItem || {})[itemId] || []
  const byCode = new Map<string, NhcSpecItem>()
  ;(data.items || []).forEach((row) => {
    const spec = toSpec(row)
    if (spec.code) byCode.set(spec.code, spec)
  })
  const specs: NhcSpecItem[] = []
  codes.forEach((code) => {
    const spec = byCode.get(code)
    if (spec) specs.push(spec)
  })
  const out = { codes, specs }
  itemCache.set(itemId, out)
  return out
}

/** 规范本身：正文加由它形成的收费项目。 */
export async function loadSpec(code: string): Promise<SpecDetail | null> {
  let data: Awaited<ReturnType<typeof mpNhcSpecItems>> | null = null
  try {
    data = await mpNhcSpecItems(code)
  } catch {
    return null
  }
  if (!data.ok || !data.spec) return null
  return { spec: toSpec(data.spec), items: data.items || [], total: Number(data.total || 0) }
}

export function nhcSpecDocument() {
  return EMPTY
}
