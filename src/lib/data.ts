import { markRaw } from 'vue'
import { unpackProduct, unpackSources, type LabelProduct, type LabelSources } from './labelSourceTypes'
import { ungzip } from 'pako'
import { failErrorAt } from './fail'
import { t } from './i18n'
import { prepareSearchItems } from './search'
import { resetCatalogProgress, stepCatalogProgress } from './progress'
import { DRUG_KIND_LABEL, isDrug, type AuditGroup, type AuditRow, type CatalogEdge, type CatalogMeta, type ConsumableKind, type DrugItem, type DrugKind, type HcDetail, type HcLink, type HcSpecRow, type HcVariant, type HcVersionRow, type ItemDetail, type PriceEvent, type SearchItem, type Successor } from './types'

export const DATA_BASE = 'https://qhyb.lynkco.site/data'

export function djb2(text: string): number {
  let h = 5381
  // 用 while + 顶层声明的下标，不用 `for (let i...)`：见 README 的 ES5 降级说明
  let i = 0
  while (i < text.length) {
    h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0
    i += 1
  }
  return h
}

export function detailShard(id: string, n = 32): string {
  return (djb2(id) % n).toString(16).padStart(2, '0')
}

const wxNet = {
  enableHttp2: false,
  enableQuic: false,
  useHighPerformanceMode: false,
  enableCache: true,
} as const

export function requestRawJson<T>(url: string, cache = true): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  uni.request({
    url,
    method: 'GET',
    ...wxNet,
    enableCache: cache,
    success: (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`${url} ${res.statusCode}`))
        return
      }
      if (!res.data || typeof res.data !== 'object') {
        reject(new Error(t('audit.invalidData')))
        return
      }
      resolve(res.data as T)
    },
    fail: (err) => reject(failErrorAt(err, t('error.request', { target: url }))),
  })
  return promise
}

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  return null
}

type SearchPack = { f: string[]; r: unknown[][] }

function requestRawGzipJson<T>(url: string): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  uni.request({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    dataType: 'arraybuffer',
    header: { 'Accept-Encoding': 'identity' },
    ...wxNet,
    success: (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`${url} ${res.statusCode}`))
        return
      }
      // 提到 try 外面：留在块里的话，压缩后这个局部名会和模块级的 fail 引用撞名，
      // 微信开发者工具降级到 ES5 时把它提升成函数作用域的 var，catch 里的引用就没了。
      const bytes = asBytes(res.data)
      if (!bytes) {
        reject(new Error(t('error.binary', { target: url })))
        return
      }
      try {
        resolve(JSON.parse(ungzip(bytes, { toText: true })) as T)
      } catch (err) {
        reject(failErrorAt(err, t('error.unzip', { target: url })))
      }
    },
    fail: (err) => reject(failErrorAt(err, t('error.request', { target: url }))),
  })
  return promise
}

// Coalesced once for meta, search, drugs, graph, details and labels.
// Failed discovery can retry; failures in a pinned version never fall back to live data.
let releasePromise: Promise<string> | null = null

export function catalogBase(): Promise<string> {
  if (!releasePromise) {
    releasePromise = requestRawJson<{ id?: string; base?: string }>(`${DATA_BASE}/release.json?t=${Date.now()}`, false).then((release) => {
      if (!release.id || !/^v\d{14}-[0-9a-f]{12}$/.test(release.id) || release.base !== `/catalog/${release.id}`) throw new Error(t('audit.invalidData'))
      return `https://qhyb.lynkco.site${release.base}`
    }).catch((err) => { releasePromise = null; throw err })
  }
  return releasePromise
}

function pinnedUrl(url: string): Promise<string> {
  return catalogBase().then((base) => base + url.slice(DATA_BASE.length))
}

function requestJson<T>(url: string): Promise<T> {
  return pinnedUrl(url).then((pinned) => requestRawJson<T>(pinned))
}

function requestGzipJson<T>(url: string): Promise<T> {
  return pinnedUrl(url).then((pinned) => requestRawGzipJson<T>(pinned))
}

// 目录文件在线上是 immutable 缓存的，同一个版本里内容不会变，所以拉到一份就留着。
// 这一层缓存主要是给「缺包重来」用的：store 在缺任何一个包时会丢掉整份目录，
// 下一次查询重新 loadCatalog——没有这层缓存，那一次要把 733KB 的 search.json.gz
// 和所有包整个再拉一遍。失败的不缓存，重来的意义就是重拉缺的那个。
const packCache = new Map<string, unknown>()

function cachedPack<T>(key: string, load: () => Promise<T>, ok: (value: T) => boolean): Promise<T | null> {
  const hit = packCache.get(key)
  if (hit) return Promise.resolve(hit as T)
  return load().then((value) => {
    if (!ok(value)) return null
    packCache.set(key, value)
    return value
  }).catch(() => null)
}

function requestSearchPack() {
  return cachedPack(
    'search',
    () => requestGzipJson<SearchPack>(`${DATA_BASE}/search.json.gz`)
      .catch(() => requestJson<SearchPack>(`${DATA_BASE}/search.json`)),
    (pack) => isFieldPack(pack),
  )
}

export function unpackSearch(pack: SearchPack): SearchItem[] {
  const fields = pack.f
  return pack.r.map((row) => {
    const raw: Record<string, unknown> = {}
    fields.forEach((key, i) => {
      raw[key] = row[i]
    })
    const sucRaw = (raw.successors as unknown[] | null) || []
    const successors: Successor[] = sucRaw.map((entry) => {
      if (Array.isArray(entry)) {
        return { id: String(entry[0] || ''), code: String(entry[1] || ''), name: String(entry[2] || ''), mergeNote: '' }
      }
      return entry as Successor
    })
    return {
      id: String(raw.id || ''),
      code: String(raw.code || ''),
      name: String(raw.name || ''),
      aliases: (raw.aliases as string[]) || [],
      pi: String(raw.pi || ''),
      py: String(raw.py || ''),
      aliasPi: String(raw.aliasPi || ''),
      aliasPy: String(raw.aliasPy || ''),
      status: raw.status ? 'active' : 'stopped',
      merged: Boolean(raw.merged),
      unit: String(raw.unit || ''),
      cat1: String(raw.cat1 || ''),
      payClass: String(raw.payClass || ''),
      payType: String(raw.payType || ''),
      priceL3: String(raw.priceL3 || ''),
      priceL2: String(raw.priceL2 || ''),
      priceL1: String(raw.priceL1 || ''),
      stopAt: String(raw.stopAt || ''),
      executeAt: String(raw.executeAt || ''),
      mergeFrom: (raw.mergeFrom as string[]) || [],
      successors,
      source: String(raw.source || ''),
      remark: String(raw.remark || ''),
      contentText: String(raw.cx || ''),
    }
  })
}

export function unpackDetail(raw: Record<string, unknown> | undefined): ItemDetail {
  const history: PriceEvent[] = Array.isArray(raw?.h)
    ? (raw.h as unknown[]).map((row) => {
        const h = Array.isArray(row) ? row : []
        return {
          at: String(h[0] || ''),
          event: String(h[1] || ''),
          priceL3: String(h[2] || ''),
          priceL2: String(h[3] || ''),
          priceL1: String(h[4] || ''),
          ref: String(h[5] || ''),
          payType: String(h[6] || ''),
        }
      })
    : []
  return {
    connotation: String(raw?.connotation || ''),
    composition: String(raw?.composition || ''),
    consumables: String(raw?.consumables || ''),
    excluded: String(raw?.excluded || ''),
    priceNote: String(raw?.priceNote || ''),
    mergeNote: String(raw?.mergeNote || ''),
    cat2: String(raw?.cat2 || ''),
    cat3: String(raw?.cat3 || ''),
    history,
  }
}

let metaPromise: Promise<CatalogMeta> | null = null

export function loadMeta() {
  if (!metaPromise) {
    // meta 和 usage 以前直接拉原始 .json，线上这两个也都有 .gz（3KB / 21KB），
    // 白下 150KB。和其它包一样先试 .gz，拿不到再退回原文。
    metaPromise = requestGzipJson<CatalogMeta>(`${DATA_BASE}/meta.json.gz`)
      .catch(() => requestJson<CatalogMeta>(`${DATA_BASE}/meta.json`))
      .catch((err) => {
        metaPromise = null
        throw err
      })
  }
  return metaPromise
}

type FieldPack = { f: string[]; r: unknown[][] }

function rowRecord(fields: string[], row: unknown[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  fields.forEach((key, i) => {
    raw[key] = row[i]
  })
  return raw
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry))
}

export function unpackDrugs(pack: FieldPack): DrugItem[] {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    return {
      id: String(raw.id || ''),
      kind: String(raw.kind || '') as DrugKind,
      no: String(raw.no || ''),
      name: String(raw.name || ''),
      aliases: (raw.aliases as string[]) || [],
      forms: (raw.forms as string[]) || [],
      payClass: String(raw.payClass || ''),
      classCode: String(raw.classCode || ''),
      className: String(raw.className || ''),
      remark: String(raw.remark || ''),
      protocol: String(raw.protocol || ''),
      special: Boolean(raw.special),
      paid: raw.paid !== false,
      brand: String(raw.brand || ''),
      indication: String(raw.indication || ''),
      pi: String(raw.pi || ''),
      py: String(raw.py || ''),
      executeAt: String(raw.executeAt || ''),
    }
  })
}

export function unpackEdges(pack: FieldPack): CatalogEdge[] {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    const rel = String(raw.rel || 'text')
    return {
      drugId: String(raw.drugId || ''),
      serviceId: String(raw.serviceId || ''),
      rel: (['name', 'consumable', 'indication', 'class'].includes(rel) ? rel : 'text') as CatalogEdge['rel'],
      src: String(raw.src || 'inferred'),
    }
  })
}

export function drugAsSearchItem(drug: DrugItem): SearchItem {
  return {
    id: drug.id,
    code: drug.classCode,
    name: drug.name,
    aliases: drug.aliases,
    pi: drug.pi,
    py: drug.py,
    aliasPi: '',
    aliasPy: '',
    status: 'active',
    merged: false,
    unit: (drug.forms || []).join('、'),
    cat1: DRUG_KIND_LABEL[drug.kind] || '药品',
    payClass: drug.payClass,
    payType: drug.payClass,
    priceL3: '',
    priceL2: '',
    priceL1: '',
    stopAt: '',
    executeAt: drug.executeAt,
    mergeFrom: [],
    successors: [],
    source: 'drugs',
    kind: drug.kind,
    forms: drug.forms,
    remark: drug.remark,
    protocol: drug.protocol,
    special: drug.special,
    paid: drug.paid,
    brand: drug.brand,
    indication: drug.indication,
    classCode: drug.classCode,
    className: drug.className,
  }
}

function isFieldPack(data: unknown): data is FieldPack {
  return Boolean(data && typeof data === 'object' && Array.isArray((data as FieldPack).f) && Array.isArray((data as FieldPack).r))
}

// ---- 药品说明书（分片，和 details 同一套 djb2 键）----
// 展示时要注意 tier：A 同名、B 只差剂型、C 只差盐基。B/C 本质上是不同品种，
// 界面必须标出来源，不能让用户以为是这一条自己的说明书。

export type DrugLabel = {
  info?: LabelSources
  tier: 'A' | 'B' | 'C'
  source: string
  indication: string
  adverse: string
  contraindication: string
  warning: string
  pregnancy: string
  pediatric: string
  geriatric: string
  dosage: string
  interaction: string
  disease: string
  composition: string
  toxicology: string
}

/**
 * 说明书里值得展开给用户看的字段，数组顺序就是展示顺序。
 * 组件（components/DrugLabel.vue）和说明书页都用这一份 —— 两边各自维护一份的话，
 * 「有没有内容可显示」的判断迟早和实际渲染的行对不上。
 */
export const LABEL_ROWS: Array<[string, keyof DrugLabel]> = [
  ['适应症', 'indication'],
  ['不良反应', 'adverse'],
  ['禁忌', 'contraindication'],
  ['注意事项', 'warning'],
  ['孕妇及哺乳期妇女用药', 'pregnancy'],
  ['儿童用药', 'pediatric'],
  ['老人用药', 'geriatric'],
  ['用法用量', 'dosage'],
  ['药物相互作用', 'interaction'],
]

// 分片包里的短键名，和上面的展示字段是两回事，别混。
const LABEL_KEYS: Array<[string, keyof DrugLabel]> = [  ['ind', 'indication'],
  ['adr', 'adverse'],
  ['con', 'contraindication'],
  ['warn', 'warning'],
  ['preg', 'pregnancy'],
  ['ped', 'pediatric'],
  ['geri', 'geriatric'],
  ['dose', 'dosage'],
  ['inter', 'interaction'],
  ['dis', 'disease'],
  ['comp', 'composition'],
  ['tox', 'toxicology'],
]

function emptyLabel(): DrugLabel {
  return {
    tier: 'A',
    source: '',
    indication: '',
    adverse: '',
    contraindication: '',
    warning: '',
    pregnancy: '',
    pediatric: '',
    geriatric: '',
    dosage: '',
    interaction: '',
    disease: '',
    composition: '',
    toxicology: '',
  }
}

export function unpackLabel(raw: unknown): DrugLabel | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const out = emptyLabel()
  out.info = unpackSources(row)
  out.tier = (['A', 'B', 'C'].includes(String(row.t)) ? String(row.t) : 'A') as DrugLabel['tier']
  out.source = String(row.name || '')
  LABEL_KEYS.forEach(([key, field]) => {
    out[field] = String(row[key] || '') as never
  })
  return out
}

const labelShards: Record<string, Record<string, unknown>> = {}
const labelRequests = new Map<string, Promise<void>>()

function loadLabelShard(shard: string): Promise<void> {
  if (labelShards[shard]) return Promise.resolve()
  const pending = labelRequests.get(shard)
  if (pending) return pending
  const url = `${DATA_BASE}/labels/${shard}.json.gz`
  const request = requestGzipJson<{ r?: Record<string, unknown> }>(url)
    .catch(() => requestJson<{ r?: Record<string, unknown> }>(`${DATA_BASE}/labels/${shard}.json`))
    .then((pack) => {
      if (!pack || !pack.r || typeof pack.r !== 'object') throw new Error(t('audit.invalidData'))
      labelShards[shard] = (pack && pack.r) || {}
    })
    .finally(() => labelRequests.delete(shard))
  labelRequests.set(shard, request)
  return request
}

/** 失败向页面报告，不把网络故障缓存成“没有说明书”。 */
export async function fetchDrugLabels(ids: string[]): Promise<Record<string, DrugLabel>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  const shards = Array.from(new Set(unique.map((id) => detailShard(id))))
  await Promise.all(shards.map(loadLabelShard))
  const out: Record<string, DrugLabel> = {}
  unique.forEach((id) => {
    const label = unpackLabel(labelShards[detailShard(id)]?.[id])
    if (label) out[id] = label
  })
  return out
}

const productCache = new Map<string, Record<string, unknown>>()
const productPending = new Map<string, Promise<Record<string, unknown>>>()
export async function fetchLabelProduct(id: string): Promise<LabelProduct> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error(t('audit.invalidData'))
  const shard = detailShard(id, 256)
  if (productCache.has(shard)) return unpackProduct(productCache.get(shard)![id], id)
  let request = productPending.get(shard)
  if (!request) {
    request = requestGzipJson<{ schema?: number; r?: Record<string, unknown> }>(`${DATA_BASE}/label-products/${shard}.json.gz`)
      .catch(() => requestJson<{ schema?: number; r?: Record<string, unknown> }>(`${DATA_BASE}/label-products/${shard}.json`))
      .then((pack) => {
        if (pack?.schema !== 2 || !pack.r || typeof pack.r !== 'object' || Array.isArray(pack.r)) throw new Error(t('audit.invalidData'))
        productCache.set(shard, pack.r)
        if (productCache.size > 8) productCache.delete(productCache.keys().next().value!)
        return pack.r
      }).finally(() => productPending.delete(shard))
    productPending.set(shard, request)
  }
  const rows = await request
  return unpackProduct(rows[id], id)
}

function requestOptionalPack(name: string) {
  return cachedPack(
    name,
    () => requestGzipJson<FieldPack>(`${DATA_BASE}/${name}.json.gz`)
      .catch(() => requestJson<FieldPack>(`${DATA_BASE}/${name}.json`)),
    (pack) => isFieldPack(pack),
  )
}

/**
 * hc-links 不是字段包：它是 { links, meta }，行里字段名齐全，没有 f/r 那一层。
 * 所以不能走 requestOptionalPack——isFieldPack 会把它判成坏包丢掉，症状是整层耗材
 * 关系（审核规则、耗材分类相近）静默消失，只在首页留一句「部分目录未加载完成」。
 */
function requestHcLinkPack() {
  type Pack = { links?: unknown }
  return cachedPack(
    'hc-links',
    () => requestGzipJson<Pack>(`${DATA_BASE}/hc-links.json.gz`)
      .catch(() => requestJson<Pack>(`${DATA_BASE}/hc-links.json`)),
    (pack) => Array.isArray(pack?.links),
  )
}

/** 类别「使用说明」。缺了只是少一段说明，不该拖着首页等，所以失败也算成功（返回空）。 */
let usagePromise: Promise<Record<string, string> | null> | null = null

function requestUsage() {
  if (!usagePromise) {
    usagePromise = requestGzipJson<Record<string, string>>(`${DATA_BASE}/usage.json.gz`)
      .catch(() => requestJson<Record<string, string>>(`${DATA_BASE}/usage.json`))
      .catch(() => { usagePromise = null; return null })
  }
  return usagePromise
}

// ---- 医用耗材（《青海省医保医用耗材及医疗服务项目目录汇编（2017 年至 2026 年）》）----
// 三类共用一个包：catalog 是医保耗材目录编码，product 是挂网产品（按注册证聚合，
// 规格和单价在详情分片里），lot 是带量采购中选结果。耗材和服务项目、药品走同一套
// 搜索、详情和图谱，所以解出来也是 SearchItem，用 hcKind 区分。

/** 价格口径就这三种，取值直接来自数据里的 priceNote 前缀，别在界面上另起词。 */
const HC_PRICE_LABELS = ['挂网价', '企业报价', '其他省份参考价']

/** priceNote 是「标签：说明」，后面可能还跟着「（共 N 个规格，其中 M 个填了这项）」。 */
export function hcPriceLabelOf(note: string): string {
  const label = String(note || '').split('：')[0]
  return HC_PRICE_LABELS.includes(label) ? label : ''
}

export function unpackHcItems(pack: FieldPack): SearchItem[] {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    const kind = String(raw.kind || 'catalog')
    const status = String(raw.status || 'active')
    const note = String(raw.priceNote || '')
    return {
      id: String(raw.id || ''),
      code: String(raw.code || ''),
      name: String(raw.name || ''),
      aliases: (raw.aliases as string[]) || [],
      pi: String(raw.pi || ''),
      py: String(raw.py || ''),
      aliasPi: String(raw.aliasPi || ''),
      aliasPy: String(raw.aliasPy || ''),
      // 耗材多一个 pending：2026 年 6 月公示拟调整的那 8 条，列出来了但还没生效。
      status: (status === 'stopped' || status === 'pending' ? status : 'active') as SearchItem['status'],
      merged: false,
      unit: String(raw.unit || ''),
      cat1: String(raw.cat1 || ''),
      payClass: String(raw.payClass || ''),
      payType: '',
      priceL3: '',
      priceL2: '',
      priceL1: '',
      stopAt: '',
      executeAt: '',
      mergeFrom: [],
      successors: [],
      source: String(raw.source || ''),
      remark: String(raw.remark || ''),
      hcKind: (kind === 'product' || kind === 'lot' ? kind : 'catalog') as ConsumableKind,
      hcCert: String(raw.cert || ''),
      hcMaker: String(raw.maker || ''),
      hcSeller: String(raw.seller || ''),
      hcSpecCount: raw.specCount == null ? 0 : Number(raw.specCount),
      hcPrice: String(raw.price || ''),
      hcPriceLabel: hcPriceLabelOf(note),
      hcPriceNote: note,
      hcBatches: (raw.batches as string[]) || [],
      hcNoticedAt: String(raw.noticedAt || ''),
      hcPublicOk: Boolean(raw.publicOk),
      hcVersions: (raw.versions as string[]) || [],
      hcPath: String(raw.path || ''),
      hcCat2: String(raw.cat2 || ''),
    }
  })
}

/**
 * hc-links 的三类关系：neihan 是内涵一次性耗材（只有 a，b 为空）、audit 是医保智能
 * 审核规则、hcclass 是耗材分类相近。前两类是官方对照，第三类是推断。
 */
export function unpackHcLinks(pack: { links?: unknown }): HcLink[] {
  const rows = Array.isArray(pack?.links) ? (pack.links as unknown[]) : []
  return rows.map((row) => {
    const raw = (row || {}) as Record<string, unknown>
    const rel = String(raw.rel || '')
    return {
      a: String(raw.a || ''),
      b: String(raw.b || ''),
      rel: (rel === 'audit' || rel === 'hcclass' ? rel : 'neihan') as HcLink['rel'],
      note: String(raw.note || ''),
      detail: String(raw.detail || ''),
    }
  })
}

/**
 * 两端的耗材关系才画成边；b 为空的是挂在 a 上的说明（内涵耗材名、或现行目录里
 * 查不到编码的对方），不是一条边。列进 CatalogEdge 是为了复用关联网络那一套，
 * drugId/serviceId 在这里只是「两端」的意思，不代表真有一头是药品。
 */
export function hcEdgeOf(link: HcLink): CatalogEdge | null {
  if (!link.b || !link.a) return null
  return { drugId: link.a, serviceId: link.b, rel: link.rel, src: 'hc' }
}

export function unpackHcDetail(raw: Record<string, unknown> | undefined, kind: ConsumableKind): HcDetail {
  const specsIn = Array.isArray(raw?.specs) ? (raw?.specs as unknown[]) : []
  const specs: HcSpecRow[] = []
  const lotSpecs: string[] = []
  // 同名不同形：目录的 specs 是 {material, spec} 行，带量采购的是纯字符串。
  if (kind === 'catalog') {
    specsIn.forEach((row) => {
      const spec = (row || {}) as Record<string, unknown>
      specs.push({ material: String(spec.material || ''), spec: String(spec.spec || '') })
    })
  } else {
    specsIn.forEach((row) => lotSpecs.push(String(row)))
  }
  const variantsIn = Array.isArray(raw?.variants) ? (raw?.variants as unknown[]) : []
  const variants: HcVariant[] = variantsIn.map((row) => {
    const v = (row || {}) as Record<string, unknown>
    return {
      name: String(v.name || ''),
      spec: String(v.spec || ''),
      model: String(v.model || ''),
      unit: String(v.unit || ''),
      batch: String(v.batch || ''),
      noticedAt: String(v.noticedAt || ''),
      code: String(v.code || ''),
      material: String(v.material || ''),
      table: String(v.table || ''),
      price: String(v.price || ''),
      priceLabel: String(v.priceLabel || ''),
      provinces: stringList(v.provinces),
    }
  })
  const historyIn = Array.isArray(raw?.history) ? (raw?.history as unknown[]) : []
  const history: HcVersionRow[] = historyIn.map((row) => {
    const h = (row || {}) as Record<string, unknown>
    return {
      version: String(h.version || ''),
      payClass: String(h.payClass || ''),
      source: String(h.source || ''),
      note: String(h.note || ''),
    }
  })
  return {
    hcKind: kind,
    path: String(raw?.path || ''),
    versions: stringList(raw?.versions),
    history,
    publicOk: Boolean(raw?.publicOk),
    specs,
    lotSpecs,
    // 带量的 batch 是联盟名（「人工晶体（陕西牵头省际联盟）」），不是批号。
    lotBatch: String(raw?.batch || ''),
    area: stringList(raw?.area),
    variants,
    priceLabel: String(raw?.priceLabel || ''),
    priceNote: String(raw?.priceNote || ''),
    makers: stringList(raw?.makers),
    sellers: stringList(raw?.sellers),
    batches: stringList(raw?.batches),
    codes: stringList(raw?.codes),
  }
}

/**
 * 结果卡片的关联只放目录关系和耗材分类相近。
 * 医保智能审核规则是「一条规则挂一串项目」（实测单点最多 209 条），铺在卡片上会把
 * 卡片撑爆，它该出现在关联网络和项目详情页里，那里有规则名和涉及项目。
 */
export function hopEdgesOf(edges: CatalogEdge[], hcEdges: CatalogEdge[]): CatalogEdge[] {
  const out = edges.slice()
  hcEdges.forEach((edge) => {
    if (edge.rel === 'hcclass') out.push(edge)
  })
  return out
}

/**
 * 一个项目命中的医保智能审核规则，按规则名分组。
 *
 * 规则名固定九个，就写在 note 和 detail 的前缀上（「重复收费」「限定性别（限女）」）。
 * 双边记录两端都在现行目录里，列出对面那一条；单边记录的对方编码现行目录里没有
 * （2007 条里绝大多数），只能把原文列出来，别假装它是一条能点的关系。
 * 单点最多命中 210 条（腹腔镜辅助操作），调用方要自己截断。
 */
export function auditGroupsOf(id: string, links: HcLink[]): AuditGroup[] {
  const groups: AuditGroup[] = []
  // 用 forEach 而不是 for...of：见 README 的 ES5 降级说明
  links.forEach((link) => {
    if (link.rel !== 'audit') return
    if (link.a !== id && link.b !== id) return
    const rule = link.detail.replace('医保智能审核规则：', '') || link.note
    const parts = link.note.split('；')
    const paren = parts[0].match(/（([^）]*)）/)
    const row: AuditRow = {
      otherId: link.b ? (link.a === id ? link.b : link.a) : '',
      condition: paren ? paren[1] : '',
      note: parts.length > 1 ? parts.slice(1).join('；') : '',
    }
    const slot = groups.find((group) => group.rule === rule)
    if (slot) slot.rows.push(row)
    else groups.push({ rule, rows: [row] })
  })
  return groups
}

export function hopVisible(item: SearchItem) {
  if (!isDrug(item)) return true
  if (item.paid === false) return false
  return Array.from(item.name || '').length >= 3
}

export function relatedOf(
  item: SearchItem,
  edges: CatalogEdge[],
  byId: Map<string, SearchItem>,
): Array<{ item: SearchItem; rel: string }> {
  const out: Array<{ item: SearchItem; rel: string }> = []
  // 用 forEach 而不是 for...of：微信开发者工具把 for...of 降级成函数作用域的
  // var，循环变量一旦被压缩成和模块级绑定同名，就会把同函数内更早的引用顶成
  // undefined（曾因此在 relatedOf 里崩 isDrug）。回调参数在嵌套函数作用域里，不受影响。
  if (isDrug(item) && !hopVisible(item)) return out
  // 两个方向都要看：耗材分类、审核规则这两类边的两端都不是药品，
  // 只按 drugId 找的话，站在另一端的那条会一条都看不见。
  edges.forEach((edge) => {
    let other = ''
    if (edge.drugId === item.id) other = edge.serviceId
    else if (edge.serviceId === item.id) other = edge.drugId
    if (!other) return
    const hit = byId.get(other)
    if (!hit || !hopVisible(hit)) return
    out.push({ item: hit, rel: edge.rel })
  })
  return out
}


/**
 * 一次扫完 edges，摊成 id → hop 列表。
 *
 * relatedOf 每调一次都要线性扫一遍全部 edges，列表页给每个条目都算一次就是
 * 17851 × 492 ≈ 878 万次比较，而且正好卡在第一次出结果的那一刻，几百毫秒的
 * 白屏。edges 本身只有几百条，扫一遍、正反两个方向各记一笔就够。
 * 结果与逐条 relatedOf 逐项一致（含顺序，因为都按 edges 的顺序 push）。
 */
export function buildHopIndex(
  edges: CatalogEdge[],
  byId: Map<string, SearchItem>,
): Map<string, Array<{ item: SearchItem; rel: string }>> {
  type Hop = { item: SearchItem; rel: string }
  const map = new Map<string, Hop[]>()
  // 用 forEach 而不是 for...of：见 README 的 ES5 降级说明
  edges.forEach((edge) => {
    const drug = byId.get(edge.drugId)
    const svc = byId.get(edge.serviceId)
    if (!drug || !svc) return
    if (!hopVisible(drug)) return
    const forDrug = map.get(drug.id)
    if (forDrug) forDrug.push({ item: svc, rel: edge.rel })
    else map.set(drug.id, [{ item: svc, rel: edge.rel }])
    const forSvc = map.get(svc.id)
    if (forSvc) forSvc.push({ item: drug, rel: edge.rel })
    else map.set(svc.id, [{ item: drug, rel: edge.rel }])
  })
  return map
}

/**
 * 给一个包挂上进度回调。成功失败都算「这一格结束了」——失败的那个由 warnings 交代，
 * 进度条卡在 90% 不动比走满更像死机。
 */
function withProgress<T>(key: string, task: Promise<T>): Promise<T> {
  return task.then(
    (value) => {
      stepCatalogProgress(key)
      return value
    },
    (err) => {
      stepCatalogProgress(key)
      throw err
    },
  )
}

export async function loadCatalog() {
  resetCatalogProgress()
  const [pack, meta, usage, drugPack, edgePack, hcPack, hcLinkPack] = await Promise.all([
    withProgress('search', requestSearchPack()),
    withProgress('meta', loadMeta()),
    withProgress('usage', requestUsage()),
    withProgress('drugs', requestOptionalPack('drugs')),
    withProgress('edges', requestOptionalPack('edges')),
    withProgress('hc-items', requestOptionalPack('hc-items')),
    withProgress('hc-links', requestHcLinkPack()),
  ])
  // 其它包缺了都能降级（少一段说明、少一层关系），检索包缺了就是没有目录可查——
  // 直接报错走重试，别拿 null 去解包。
  if (!pack) throw new Error(t('audit.invalidData'))
  // 规范本身不进目录检索：它有自己的「技术规范」档，直接问线上规范库（见 index 的
  // specActive）。以前这里硬塞一条「全国医疗服务项目技术规范」进全部结果，搜「规范」
  // 会先撞上规范自己。
  const items = markRaw(
    prepareSearchItems(
      unpackSearch(pack).map((item) => {
        const note = usage?.[item.cat1]
        return { ...item, usageNote: typeof note === 'string' ? note : '' }
      }),
    ),
  )
  let drugs: SearchItem[] = []
  let edges: CatalogEdge[] = []
  try {
    if (drugPack) drugs = markRaw(prepareSearchItems(unpackDrugs(drugPack).map(drugAsSearchItem)))
  } catch {
    drugs = []
  }
  try {
    if (edgePack) edges = markRaw(unpackEdges(edgePack))
  } catch {
    edges = []
  }
  let consumables: SearchItem[] = []
  let hcEdges: CatalogEdge[] = []
  let auditLinks: HcLink[] = []
  try {
    if (hcPack) consumables = markRaw(prepareSearchItems(unpackHcItems(hcPack)))
  } catch {
    consumables = []
  }
  // 声明摊在函数体一层、不进 if/try 块：块里的 const 被压缩器改成短名后，微信降级
  // ES5 时提升成 var，正好顶掉上面 Promise.all 解构出来的同名变量（见 README）。
  let hcLinks: HcLink[] = []
  const hcEdgeRows: CatalogEdge[] = []
  const hcAuditRows: HcLink[] = []
  try {
    hcLinks = hcLinkPack ? unpackHcLinks(hcLinkPack) : []
  } catch {
    hcLinks = []
  }
  // 内涵一次性耗材那 15505 行不进内存：实测它是详情分片里 consumables 原文的
  // 子集（3790 条全部都有，没有一条是新的），界面上已经有那一段了。
  hcLinks.forEach((link) => {
    if (link.rel === 'audit') hcAuditRows.push(link)
    const edge = hcEdgeOf(link)
    if (edge) hcEdgeRows.push(edge)
  })
  hcEdges = markRaw(hcEdgeRows)
  auditLinks = markRaw(hcAuditRows)
  const warnings: string[] = []
  if (!usage) warnings.push('usage')
  if (!drugPack || !drugs.length) warnings.push('drugs')
  if (!edgePack) warnings.push('edges')
  if (!hcPack || !consumables.length || !hcLinkPack) warnings.push('hc')
  return { items, drugs, consumables, edges, hcEdges, auditLinks, meta, warnings }
}

const shardCache: Record<string, Record<string, unknown>> = {}

function loadDetailShard(shard: string): Promise<Record<string, unknown>> {
  if (shardCache[shard]) return Promise.resolve(shardCache[shard])
  // 先拉 .gz：整块 d/xx.json 线上是 237KB，gzip 之后只有 51KB，真机上点一条
  // 结果要干等一大截主要就是这个。labels 分片一直是这么拉的。
  return requestGzipJson<Record<string, unknown>>(`${DATA_BASE}/d/${shard}.json.gz`)
    .catch(() => requestJson<Record<string, unknown>>(`${DATA_BASE}/d/${shard}.json`))
    .then((pack) => {
      shardCache[shard] = pack || {}
      return shardCache[shard]
    })
}

export async function fetchItemDetail(id: string): Promise<ItemDetail> {
  const key = detailShard(id)
  if (!shardCache[key]) {
    await loadDetailShard(key).catch(async () => {
      shardCache.__all = shardCache.__all || (await requestJson<Record<string, unknown>>(`${DATA_BASE}/details.json`))
    })
  }
  const pack = shardCache[key] || shardCache.__all || {}
  const row = pack[id]
  return unpackDetail(row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined)
}

const hcShardCache: Record<string, Record<string, unknown>> = {}

function loadHcShard(shard: string): Promise<Record<string, unknown>> {
  if (hcShardCache[shard]) return Promise.resolve(hcShardCache[shard])
  // 和服务项目一样先拉 .gz：一个 hc 分片 27KB 左右，整目录 861KB。
  return requestGzipJson<Record<string, unknown>>(`${DATA_BASE}/hc/${shard}.json.gz`)
    .catch(() => requestJson<Record<string, unknown>>(`${DATA_BASE}/hc/${shard}.json`))
    .then((pack) => {
      hcShardCache[shard] = pack || {}
      return hcShardCache[shard]
    })
}

/**
 * 手指按上结果卡的那一刻就把详情分片拉下来。分片键是 id 的纯函数，不用等进了详情页
 * 才知道要哪一片；loadDetailShard / loadHcShard 自己有缓存，也自己吞掉失败，所以
 * 这里只负责把请求提前发出去。药品没有分片，规范详情走服务端，都不预取。
 */
export function prefetchDetail(item: Pick<SearchItem, 'id' | 'hcKind' | 'kind' | 'spec'>): void {
  if (!item.id || item.spec || item.kind) return
  const shard = detailShard(item.id)
  if (item.hcKind) {
    loadHcShard(shard).catch(() => undefined)
    return
  }
  loadDetailShard(shard).catch(() => undefined)
}
export async function fetchHcDetail(id: string, kind: ConsumableKind): Promise<HcDetail> {
  const pack = await loadHcShard(detailShard(id)).catch(() => ({}) as Record<string, unknown>)
  const row = pack[id]
  return unpackHcDetail(row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined, kind)
}
