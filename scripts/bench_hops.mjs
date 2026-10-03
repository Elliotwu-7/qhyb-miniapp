// 量一下 hopsIndex 的真实代价。小程序里 relatedOf 每调一次就线性扫一遍全部 edges，
// hopsIndex 对 17851 个条目各调一次 —— 先在这里用真数据把数算出来，再决定怎么改。
//
// 运行：node scripts/bench_hops.mjs
import { readFileSync } from 'node:fs'

const DATA = 'G:/QYB/yibao-query/public/data'
const read = (name) => JSON.parse(readFileSync(`${DATA}/${name}`, 'utf8'))

function rows(pack) {
  return pack.r.map((row) => {
    const out = {}
    pack.f.forEach((key, i) => {
      out[key] = row[i]
    })
    return out
  })
}

// relatedOf / hopVisible 只碰这几个字段，按最小集还原即可
const items = rows(read('search.json')).map((r) => ({
  id: String(r.id || ''),
  name: String(r.name || ''),
}))
const drugs = rows(read('drugs.json')).map((r) => ({
  id: String(r.id || ''),
  name: String(r.name || ''),
  kind: String(r.kind || '') || undefined,
  paid: r.paid !== false,
}))
const edges = rows(read('edges.json')).map((r) => ({
  drugId: String(r.drugId || ''),
  serviceId: String(r.serviceId || ''),
  rel: String(r.rel || 'text'),
}))

const byId = new Map()
items.forEach((it) => byId.set(it.id, it))
drugs.forEach((it) => byId.set(it.id, it))

const isDrug = (item) => Boolean(item && item.kind)

function hopVisible(item) {
  if (!isDrug(item)) return true
  if (item.paid === false) return false
  return Array.from(item.name || '').length >= 3
}

// —— 现状：每个条目都从头扫一遍 edges ——
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

function buildHopsIndexCurrent(itemList, drugList, edgeList, index) {
  const map = new Map()
  itemList.forEach((it) => map.set(it.id, relatedOf(it, edgeList, index)))
  drugList.forEach((it) => map.set(it.id, relatedOf(it, edgeList, index)))
  return map
}

// —— 改法：只扫一遍 edges，正反两个方向各记一笔 ——
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

function time(label, fn) {
  const t0 = process.hrtime.bigint()
  const out = fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label.padEnd(28)} ${ms.toFixed(1).padStart(9)} ms`)
  return { out, ms }
}

console.log(`条目 service=${items.length} drug=${drugs.length} edge=${edges.length}`)
console.log(`现方案扫描次数 ≈ ${((items.length + drugs.length) * edges.length).toLocaleString()}`)
console.log('')

const cur = time('现状 buildHopsIndex', () => buildHopsIndexCurrent(items, drugs, edges, byId))
const fix = time('改后 buildHopIndex', () => buildHopIndex(edges, byId))
time('改后（重复 1000 次）', () => {
  let i = 0
  while (i < 1000) {
    buildHopIndex(edges, byId)
    i += 1
  }
})

// 正确性：改前改后每个 id 的 hop 列表必须逐项一致（顺序也要一致）
let checked = 0
let bad = 0
const allIds = new Set([...cur.out.keys(), ...fix.out.keys()])
allIds.forEach((id) => {
  const a = cur.out.get(id) || []
  const b = fix.out.get(id) || []
  checked += 1
  if (a.length !== b.length) {
    bad += 1
    return
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].item.id !== b[i].item.id || a[i].rel !== b[i].rel) {
      bad += 1
      return
    }
  }
})
console.log('')
console.log(`一致性：比对 ${checked} 个 id，不一致 ${bad} 个`)

// hop 数量分布 —— 决定首屏 40 条要渲染多少节点
const sizes = []
fix.out.forEach((list) => {
  if (list.length) sizes.push(list.length)
})
sizes.sort((a, b) => b - a)
console.log(`有 hop 的条目 ${sizes.length} 个，最多 ${sizes[0] || 0} 条，中位 ${sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0} 条`)
console.log(`加速比 ≈ ${(cur.ms / fix.ms).toFixed(0)}x`)
