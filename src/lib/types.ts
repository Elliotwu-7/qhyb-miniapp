export type Successor = {
  id: string
  code: string
  name: string
  mergeNote: string
}

export type DrugKind =
  | 'xiyao'
  | 'zhongcheng'
  | 'tanpan'
  | 'jingjia'
  | 'yinpian'
  | 'excluded'
  | 'minzu'
  | 'shangbao'

export const DRUG_KIND_LABEL: Record<DrugKind, string> = {
  xiyao: '西药',
  zhongcheng: '中成药',
  tanpan: '谈判药品',
  jingjia: '竞价药品',
  yinpian: '中药饮片',
  excluded: '不得支付饮片',
  minzu: '增补民族药',
  shangbao: '商保创新药',
}

export const EDGE_REL_LABEL: Record<string, string> = {
  name: '名称重合',
  text: '项目文本',
  consumable: '耗材',
  indication: '适应症/限定范围',
  class: '同医保分类',
  spec: '技术规范',
  audit: '医保智能审核规则',
  hcclass: '耗材分类相近',
}

export type EdgeRel = 'name' | 'text' | 'consumable' | 'indication' | 'class' | 'spec' | 'audit' | 'hcclass'

export type CatalogEdge = {
  drugId: string
  serviceId: string
  rel: EdgeRel
  src: string
}

export type DrugItem = {
  id: string
  kind: DrugKind
  no: string
  name: string
  aliases: string[]
  forms: string[]
  payClass: string
  classCode: string
  className: string
  remark: string
  protocol: string
  special: boolean
  paid: boolean
  brand: string
  indication: string
  pi: string
  py: string
  executeAt: string
}

export type SearchItem = {
  id: string
  code: string
  name: string
  aliases: string[]
  pi: string
  py: string
  aliasPi: string
  aliasPy: string
  status: 'active' | 'stopped' | 'pending'
  merged: boolean
  unit: string
  cat1: string
  payClass: string
  payType: string
  priceL3: string
  priceL2: string
  priceL1: string
  stopAt: string
  executeAt: string
  mergeFrom: string[]
  successors: Successor[]
  source: string
  remark?: string
  /**
   * 项目内涵（构建期截断并折叠过），只用来做内容兜底匹配，不展示。
   * 展示走 details 包里的 connotation 原文。
   */
  contentText?: string
  usageNote?: string
  kind?: DrugKind
  forms?: string[]
  protocol?: string
  special?: boolean
  paid?: boolean
  brand?: string
  indication?: string
  classCode?: string
  className?: string
  /** 技术规范条目（不是收费项目，也没有价格）。 */
  spec?: boolean
  /** 技术规范条目在《技术规范（2023年版）》里的页码。 */
  page?: number
  /**
   * 医用耗材条目。耗材和收费项目一样走搜索、图谱、跳转，所以共用 SearchItem，
   * 用 hcKind 区分；下面带 hc 前缀的字段只有耗材才有，不和服务项目的那套混。
   */
  hcKind?: ConsumableKind
  hcCert?: string
  hcMaker?: string
  hcSeller?: string
  hcSpecCount?: number
  hcPrice?: string
  hcPriceLabel?: string
  hcPriceNote?: string
  hcBatches?: string[]
  hcNoticedAt?: string
  hcPublicOk?: boolean
  hcVersions?: string[]
  hcPath?: string
  hcCat2?: string
}

/** 耗材三类：医保耗材目录编码、挂网产品（按注册证聚合）、带量采购中选结果。 */
export type ConsumableKind = 'catalog' | 'product' | 'lot'

export const HC_KIND_LABEL: Record<ConsumableKind, string> = {
  catalog: '医保耗材目录',
  product: '挂网产品',
  lot: '带量采购',
}

export type HcItem = SearchItem & { hcKind: ConsumableKind }

/** 医保耗材目录明细里的「材质 / 规格型号」一行。 */
export type HcSpecRow = { material: string; spec: string }

/** 医保耗材目录明细里的版本沿革一行（同一编码在各版目录里的支付类别和出处）。 */
export type HcVersionRow = { version: string; payClass: string; source: string; note: string }

/**
 * 挂网产品明细里的一行规格。价格一定带 priceLabel：只有第 38 批之后的附件才有
 * 青海挂网价，6~37 批填的是企业在其他省份的参考价，43 批起与企业报价互补。
 */
export type HcVariant = {
  name: string
  spec: string
  model: string
  unit: string
  batch: string
  noticedAt: string
  code: string
  material: string
  /** 附件里的表名（如「不视为非中选产品表」），空的表示没写。 */
  table: string
  price: string
  priceLabel: string
  provinces: string[]
}

/**
 * 三类耗材的明细合在一个袋子里，按 kind 取用。
 * 注意 catalog 的 specs 是 {material, spec} 行，lot 的 specs 是纯字符串数组，
 * 同名不同形，所以后者单独放 lotSpecs，不共用一个字段。
 */
export type HcDetail = {
  hcKind: ConsumableKind | ''
  path: string
  versions: string[]
  history: HcVersionRow[]
  publicOk: boolean
  specs: HcSpecRow[]
  lotSpecs: string[]
  lotBatch: string
  area: string[]
  variants: HcVariant[]
  priceLabel: string
  priceNote: string
  makers: string[]
  sellers: string[]
  batches: string[]
  codes: string[]
}

export type HcRel = 'neihan' | 'audit' | 'hcclass'

/** hc-links.json 的一行。b 为空表示这条是挂在 a 上的说明，不是一条两端的边。 */
export type HcLink = { a: string; b: string; rel: HcRel; note: string; detail: string }

/**
 * 医保智能审核规则命中一个项目时列在详情页的一行。
 * 双边记录（a、b 都在现行目录里）给出对面那一条，可以点进去；
 * 单边记录给的是规则原文里那个查不到编码的项目名，或者条件（限女、每日限 1 次）。
 */
export type AuditRow = {
  /** 对面项目的 id；单边记录为空 */
  otherId: string
  /** 条件，如「限女」「每日限 1 次」，没有就为空 */
  condition: string
  /** 单边记录的原文（涉及项目「…」（编码，现行目录里没查到该编码）） */
  note: string
}

export type AuditGroup = { rule: string; rows: AuditRow[] }

export function isConsumable(item: Pick<SearchItem, 'hcKind'> | null | undefined): item is HcItem {
  return Boolean(item?.hcKind)
}

export function isDrug(item: Pick<SearchItem, 'kind'> | null | undefined): item is SearchItem & { kind: DrugKind } {
  return Boolean(item?.kind)
}

export function isSpec(item: Pick<SearchItem, 'spec'> | null | undefined): boolean {
  return Boolean(item?.spec)
}

export function isLimitedDrug(item: Pick<SearchItem, 'kind' | 'remark'> | null | undefined): boolean {
  return Boolean(isDrug(item) && String(item.remark || '').includes('限'))
}

export type PriceEvent = {
  at: string
  event: string
  priceL3: string
  priceL2: string
  priceL1: string
  ref: string
  payType: string
}

export type ItemDetail = {
  connotation: string
  composition: string
  consumables: string
  excluded: string
  priceNote: string
  mergeNote: string
  cat2: string
  cat3: string
  history: PriceEvent[]
}

export type CatalogMeta = {
  stats: {
    total: number
    version: string
    title: string
    active?: number
    stopped?: number
    upcomingStop?: number
    upcomingExecute?: number
  }
  common?: Array<{ q: string; hint: string }>
  units: string[]
  payTypes: string[]
  payClasses: string[]
  categories: string[]
}

export type HospitalLevel = 'L3' | 'L2' | 'L1'
