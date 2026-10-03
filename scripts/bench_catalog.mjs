// 搜索一次到底花在哪。把 search.ts / status.ts / data.ts 的热路径照抄一份，
// 用线上真数据跑一遍，量出各项耗时占比 —— 不靠猜。
//
// 运行：node scripts/bench_catalog.mjs
import { readFileSync } from 'node:fs'

const DATA = 'G:/QYB/yibao-query/public/data'
const readJson = (name) => JSON.parse(readFileSync(`${DATA}/${name}`, 'utf8'))

// ---------- status.ts ----------
const shanghaiFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' })
const todayByMinute = new Map()
const parsedDates = new Map()

function shanghaiToday(now = new Date()) {
  const bucket = Math.floor(now.getTime() / 60000)
  const hit = todayByMinute.get(bucket)
  if (hit) return hit
  const parts = shanghaiFmt.formatToParts(now)
  const num = (type) => Number(parts.find((p) => p.type === type)?.value)
  const today = new Date(num('year'), num('month') - 1, num('day'))
  todayByMinute.set(bucket, today)
  if (todayByMinute.size > 8) todayByMinute.delete(todayByMinute.keys().next().value)
  return today
}
function catalogDate(text) {
  if (parsedDates.has(text)) return parsedDates.get(text) ?? null
  const m = (text || '').match(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  parsedDates.set(text, d)
  return d
}
function isFutureCatalogDate(text, now = new Date()) {
  const d = catalogDate(text)
  if (!d) return false
  return d.getTime() > shanghaiToday(now).getTime()
}
function isEffectivelyStopped(item, now = new Date()) {
  if (item.status === 'stopped') return true
  const d = catalogDate(item.stopAt)
  if (!d) return false
  return d.getTime() <= shanghaiToday(now).getTime()
}
function isUpcoming(item, now = new Date()) {
  if (isEffectivelyStopped(item, now)) return false
  return isFutureCatalogDate(item.stopAt, now)
}
function isUpcomingExecute(item, now = new Date()) {
  if (isEffectivelyStopped(item, now)) return false
  return isFutureCatalogDate(item.executeAt, now)
}
function isCurrentlyChargeable(item, now = new Date()) {
  return !isEffectivelyStopped(item, now) && !isUpcomingExecute(item, now)
}
function currentUseHint(item) {
  const from = item.mergeFrom || []
  if (!from.length) return []
  const compact = item.name.replace(/[（）()·,，、/\-\s]/g, '')
  const tokens = []
  if (compact.length >= 2) tokens.push(compact.slice(0, 2))
  if (compact.length >= 3) tokens.push(compact.slice(0, 3))
  if (compact.length >= 4) tokens.push(compact.slice(0, 4))
  const generic = /^(常规|复杂|加收|扩展|普通|治疗|项目|门诊|手术)$/
  const bits = tokens.filter((t) => !generic.test(t))
  return from.filter((name) => bits.some((bit) => name.includes(bit)))
}

// ---------- search.ts ----------
function norm(s) {
  const folded = typeof s.normalize === 'function' ? s.normalize('NFKC') : s
  return folded.replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '').toLowerCase()
}
function isSubsequence(haystack, needle) {
  if (!needle || needle.length < 2) return false
  let i = 0
  return Array.from(haystack).some((ch) => {
    if (ch === needle[i]) i += 1
    return i === needle.length
  })
}
const asIndexed = (item) => ('nameN' in item ? item : null)
function aliasHit(item, qn) {
  const indexed = asIndexed(item)
  const aliases = indexed ? indexed.aliasesN : item.aliases.map(norm)
  if (aliases.includes(qn)) return 'exact'
  return aliases.some((an) => an.includes(qn)) ? 'part' : null
}
function prepareSearchItems(items, now = new Date()) {
  items.forEach((item) => {
    item.nameN = norm(item.name)
    item.aliasesN = item.aliases.map(norm)
    item.codeLower = (item.code || '').toLowerCase()
    item.piJoin = `${item.pi}${item.aliasPi}`.replace(/\s+/g, '')
    item.pyJoin = `${item.py}${item.aliasPy}`.replace(/\s+/g, '')
    item.stopped = isEffectivelyStopped(item, now)
    item.pending = isUpcomingExecute(item, now)
    item.upcoming = isUpcoming(item, now)
    item.chargeable = !item.stopped && !item.pending
  })
  return items
}
function buildNameIndex(items) {
  const byName = new Map()
  items.forEach((item) => {
    if (!byName.has(item.name)) byName.set(item.name, item)
  })
  return byName
}
function scoreItem(item, query) {
  const q = query.trim()
  const qn = norm(q)
  if (!qn) return 0
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  const alpha = /^[a-z0-9]+$/i.test(q)
  const alias = aliasHit(item, qn)
  const exactName = nameN === qn
  const pending = indexed ? indexed.pending : isUpcomingExecute(item)
  const stopped = indexed ? indexed.stopped : isEffectivelyStopped(item)
  const chargeable = indexed ? indexed.chargeable : isCurrentlyChargeable(item)
  const piJoin = indexed ? indexed.piJoin : `${item.pi}${item.aliasPi}`.replace(/\s+/g, '')
  const pyJoin = indexed ? indexed.pyJoin : `${item.py}${item.aliasPy}`.replace(/\s+/g, '')
  const mergedLive = item.merged && chargeable
  let score = 0
  if (alias === 'exact' && mergedLive) score = 5000
  else if (exactName && stopped) score = 4500
  else if (exactName) score = 4000
  else if (nameN.startsWith(qn) && mergedLive) score = 3600
  else if (nameN.startsWith(qn) && chargeable) score = 3200
  else if (alias === 'exact') score = 2800
  else if (nameN.includes(qn)) score = 2200
  else if (codeLower.includes(qn)) score = 2000
  else if (alias === 'part') score = 1600
  else if (alpha) {
    if (item.pi === qn || item.pi.startsWith(qn)) score = 1400
    else if (piJoin.includes(qn)) score = 1200
    else if (isSubsequence(item.pi, qn) || isSubsequence(piJoin, qn)) score = 900
    else if (pyJoin.includes(qn)) score = 700
  }
  if (score === 0) return 0
  if (chargeable) score += 80
  if (pending) score -= 420
  if (stopped && !exactName) score -= 80
  score -= Math.max(0, nameN.length - qn.length) * 1.5
  return score
}
function searchCatalog(items, query) {
  const q = query.trim()
  if (!q) return items
  const ranked = []
  items.forEach((item) => {
    const s = scoreItem(item, q)
    if (s > 0) ranked.push({ s, item })
  })
  ranked.sort((a, b) => b.s - a.s)
  return ranked.map((x) => x.item)
}
function queryHitsNameOrCode(item, query) {
  const q = query.trim()
  const qn = norm(q)
  if (!qn) return false
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  if (nameN === qn || nameN.includes(qn) || codeLower === qn) return true
  if (/^[a-z0-9]+$/i.test(q) && (item.pi === qn || item.pi.startsWith(qn))) return true
  return false
}
function queryIsExactNameOrCode(item, query) {
  const qn = norm(query)
  if (!qn) return false
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  return nameN === qn || codeLower === qn
}
function liveOriginals(item, byName) {
  const out = []
  const seen = new Set()
  currentUseHint(item).forEach((name) => {
    const orig = byName.get(name)
    if (!orig) return
    const chargeable = asIndexed(orig)?.chargeable ?? isCurrentlyChargeable(orig)
    if (!chargeable || seen.has(orig.id)) return
    seen.add(orig.id)
    out.push(orig)
  })
  return out
}
function resolveCurrentHits(catalog, found, query, statusFilter, byName) {
  const pendingOf = (item) => asIndexed(item)?.pending ?? isUpcomingExecute(item)
  if (statusFilter === 'pending') return found.filter((item) => pendingOf(item))
  const q = query.trim()
  const names = byName ?? buildNameIndex(catalog)
  const extras = []
  if (q) {
    catalog.forEach((item) => {
      if (!pendingOf(item) || !queryHitsNameOrCode(item, q)) return
      extras.push(...liveOriginals(item, names))
    })
  }
  const seen = new Set()
  const kept = []
  let origs = []
  found.forEach((item) => {
    if (item.kind) {
      if (seen.has(item.id)) return
      seen.add(item.id)
      kept.push(item)
      return
    }
    if (pendingOf(item)) {
      origs = liveOriginals(item, names)
      if (!(q && queryIsExactNameOrCode(item, q) && origs.length === 0)) return
    }
    if (seen.has(item.id)) return
    seen.add(item.id)
    kept.push(item)
  })
  const head = []
  extras.forEach((orig) => {
    if (seen.has(orig.id)) return
    seen.add(orig.id)
    head.push(orig)
  })
  return [...head, ...kept]
}
function matchesStatus(item, statusFilter, hasQuery) {
  const indexed = asIndexed(item)
  const chargeable = indexed ? indexed.chargeable : isCurrentlyChargeable(item)
  const stopped = indexed ? indexed.stopped : isEffectivelyStopped(item)
  const pending = indexed ? indexed.pending : isUpcomingExecute(item)
  const upcoming = indexed ? indexed.upcoming : isUpcoming(item)
  if (statusFilter === 'active') return chargeable
  if (statusFilter === 'stopped') return stopped
  if (statusFilter === 'merged') return item.merged
  if (statusFilter === 'upcoming') return upcoming
  if (statusFilter === 'pending') return pending
  if (!hasQuery) return chargeable
  return true
}

// ---------- data.ts ----------
const rowRecord = (fields, row) => {
  const raw = {}
  fields.forEach((key, i) => {
    raw[key] = row[i]
  })
  return raw
}
function unpackSearch(pack) {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    const sucRaw = raw.successors || []
    const successors = sucRaw.map((entry) => {
      if (Array.isArray(entry)) return { id: String(entry[0] || ''), code: String(entry[1] || ''), name: String(entry[2] || ''), mergeNote: '' }
      return entry
    })
    return {
      id: String(raw.id || ''), code: String(raw.code || ''), name: String(raw.name || ''),
      aliases: raw.aliases || [], pi: String(raw.pi || ''), py: String(raw.py || ''),
      aliasPi: String(raw.aliasPi || ''), aliasPy: String(raw.aliasPy || ''),
      status: raw.status ? 'active' : 'stopped', merged: Boolean(raw.merged),
      unit: String(raw.unit || ''), cat1: String(raw.cat1 || ''),
      payClass: String(raw.payClass || ''), payType: String(raw.payType || ''),
      priceL3: String(raw.priceL3 || ''), priceL2: String(raw.priceL2 || ''), priceL1: String(raw.priceL1 || ''),
      stopAt: String(raw.stopAt || ''), executeAt: String(raw.executeAt || ''),
      mergeFrom: raw.mergeFrom || [], successors,
      source: String(raw.source || ''), remark: String(raw.remark || ''),
    }
  })
}
function drugAsSearchItem(drug) {
  return {
    id: drug.id, code: drug.classCode, name: drug.name, aliases: drug.aliases,
    pi: drug.pi, py: drug.py, aliasPi: '', aliasPy: '', status: 'active', merged: false,
    unit: (drug.forms || []).join('、'), cat1: '药品', payClass: drug.payClass, payType: drug.payClass,
    priceL3: '', priceL2: '', priceL1: '', stopAt: '', executeAt: drug.executeAt,
    mergeFrom: [], successors: [], source: 'drugs', kind: drug.kind, forms: drug.forms,
    remark: drug.remark, protocol: drug.protocol, special: drug.special, paid: drug.paid,
    brand: drug.brand, indication: drug.indication, classCode: drug.classCode, className: drug.className,
  }
}
function unpackDrugs(pack) {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    return {
      id: String(raw.id || ''), kind: String(raw.kind || ''), no: String(raw.no || ''),
      name: String(raw.name || ''), aliases: raw.aliases || [], forms: raw.forms || [],
      payClass: String(raw.payClass || ''), classCode: String(raw.classCode || ''),
      className: String(raw.className || ''), remark: String(raw.remark || ''),
      protocol: String(raw.protocol || ''), special: Boolean(raw.special),
      paid: raw.paid !== false, brand: String(raw.brand || ''), indication: String(raw.indication || ''),
      pi: String(raw.pi || ''), py: String(raw.py || ''), executeAt: String(raw.executeAt || ''),
    }
  })
}
function unpackEdges(pack) {
  return pack.r.map((row) => {
    const raw = rowRecord(pack.f, row)
    const rel = String(raw.rel || 'text')
    return {
      drugId: String(raw.drugId || ''), serviceId: String(raw.serviceId || ''),
      rel: ['name', 'consumable', 'indication', 'class'].includes(rel) ? rel : 'text',
      src: String(raw.src || 'inferred'),
    }
  })
}

// ---------- hops ----------
const isDrug = (item) => Boolean(item && item.kind)
function hopVisible(item) {
  if (!isDrug(item)) return true
  if (item.paid === false) return false
  return Array.from(item.name || '').length >= 3
}
function relatedOf(item, edgeList, index) {
  const out = []
  if (isDrug(item)) {
    if (!hopVisible(item)) return out
    edgeList.forEach((edge) => {
      if (edge.drugId !== item.id) return
      const svc = index.get(edge.serviceId)
      if (svc) out.push({ item: svc, rel: edge.rel })
    })
    return out
  }
  edgeList.forEach((edge) => {
    if (edge.serviceId !== item.id) return
    const drug = index.get(edge.drugId)
    if (drug && hopVisible(drug)) out.push({ item: drug, rel: edge.rel })
  })
  return out
}
function buildHopIndex(edgeList, index) {
  const map = new Map()
  const push = (id, entry) => {
    const list = map.get(id)
    if (list) list.push(entry)
    else map.set(id, [entry])
  }
  edgeList.forEach((edge) => {
    const drug = index.get(edge.drugId)
    const svc = index.get(edge.serviceId)
    if (!drug || !svc) return
    if (!hopVisible(drug)) return
    push(drug.id, { item: svc, rel: edge.rel })
    push(svc.id, { item: drug, rel: edge.rel })
  })
  return map
}

// ---------- 跑 ----------
const t = (label, fn) => {
  const t0 = process.hrtime.bigint()
  const out = fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`)
  return out
}

const searchPack = t('JSON.parse search.json (5.0MB)', () => readJson('search.json'))
const drugPack = readJson('drugs.json')
const edgePack = readJson('edges.json')

const rawItems = t('unpackSearch (13445 行)', () => unpackSearch(searchPack))
const items = t('prepareSearchItems (13445 项)', () => prepareSearchItems(rawItems))
const drugs = t('prepareSearchItems (4406 药品)', () => prepareSearchItems(unpackDrugs(drugPack).map(drugAsSearchItem)))
const edges = unpackEdges(edgePack)

const byName = t('buildNameIndex', () => buildNameIndex(items))
const byId = new Map()
items.forEach((it) => byId.set(it.id, it))
drugs.forEach((it) => byId.set(it.id, it))

// index.vue 里 hits 的计算路径，逐段量
const catalog = items
console.log('')
const QUERY = '血液透析'
t('cat1 filter (全部 → 跳过)', () => 0)
const listed = t('matchesStatus filter', () => catalog.filter((it) => matchesStatus(it, '', true)))
const found = t(`searchCatalog (${QUERY})`, () => searchCatalog(listed, QUERY))
const services = t('resolveCurrentHits', () => resolveCurrentHits(catalog, found, QUERY, '', byName))
const drugHits = t('searchCatalog (drugs)', () => searchCatalog(drugs, QUERY))
console.log(`  → 命中 service=${services.length} drug=${drugHits.length}`)

console.log('')
t('hopsIndex 现状 (17851 × 492)', () => {
  const map = new Map()
  items.forEach((it) => map.set(it.id, relatedOf(it, edges, byId)))
  drugs.forEach((it) => map.set(it.id, relatedOf(it, edges, byId)))
  return map
})
t('buildHopIndex (只扫 492 边)', () => buildHopIndex(edges, byId))

console.log('')
t('liveCount (首页 heroMeta)', () => {
  const f = items.filter((it) => isCurrentlyChargeable(it))
  return resolveCurrentHits(items, f, '', '').length
})
