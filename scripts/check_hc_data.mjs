// 耗材数据包的自检：数目对不对、价格口径词表有没有跑偏、关系两端能不能落到条目上、
// 32 个明细分片是不是把 4748 条全装下了。
//
// 默认打线上（那才是小程序真正拿到的包，顺带验发布有没有漏一处）；`--local` 直接读
// yibao-query 的 public/data，发数据之前先本地过一遍。
import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SITE = 'https://qhyb.lynkco.site'
const LOCAL_ROOT = 'G:\\QYB\\yibao-query\\public\\data'
const LOCAL = process.argv.includes('--local')

const HC_KINDS = { catalog: 1087, product: 3326, lot: 335 }
const HC_RELS = { neihan: 15505, audit: 2648, hcclass: 99 }
const PRICE_LABELS = ['挂网价', '企业报价', '其他省份参考价']

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function hcBase() {
  if (LOCAL) return LOCAL_ROOT
  const rel = await (await fetch(`${SITE}/data/release.json?t=${Date.now()}`, { cache: 'no-store' })).json()
  return (/^https?:/.test(rel.base) ? rel.base : SITE + rel.base).replace(/\/$/, '')
}

/** 一律先要 .gz：线上两个包都发了 .gz，页面也是优先拿它。 */
async function grab(name) {
  if (LOCAL) {
    const plain = join(LOCAL_ROOT, name)
    if (existsSync(`${plain}.gz`)) return JSON.parse(gunzipSync(readFileSync(`${plain}.gz`)).toString('utf8'))
    if (existsSync(plain)) return JSON.parse(readFileSync(plain, 'utf8'))
    throw new Error(`本地缺文件 ${name}`)
  }
  const url = `${HC_BASE}/${name}`
  const gz = await fetch(`${url}.gz?t=${Date.now()}`, { cache: 'no-store' })
  if (gz.ok) return JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString('utf8'))
  const plain = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })
  if (!plain.ok) throw new Error(`${name} 取不到（${plain.status}）`)
  return JSON.parse(await plain.text())
}

/** 小程序侧同一份 djb2 / 分片键，别在这里另写一套。 */
function detailShard(id, n = 32) {
  let h = 5381
  let i = 0
  while (i < id.length) {
    h = (Math.imul(h, 33) + id.charCodeAt(i)) >>> 0
    i += 1
  }
  return (h % n).toString(16).padStart(2, '0')
}

function rowsOf(pack) {
  return pack.r.map((row) => Object.fromEntries(pack.f.map((n, i) => [n, row[i]])))
}

let HC_BASE = ''
async function main() {
  HC_BASE = await hcBase()
  console.log(`耗材数据源 ${HC_BASE}${LOCAL ? '（本地）' : ''}`)

  const items = await grab('hc-items.json')
  const rows = rowsOf(items)
  const byKind = {}
  rows.forEach((row) => { byKind[row.kind] = (byKind[row.kind] || 0) + 1 })
  check('三类条目数', JSON.stringify(byKind) === JSON.stringify(HC_KINDS), JSON.stringify(byKind))
  check('包内 meta.counts 与条目一致', JSON.stringify(items.meta?.counts) === JSON.stringify(HC_KINDS), JSON.stringify(items.meta?.counts))

  const ids = rows.map((row) => row.id)
  const idSet = new Set(ids)
  const prefixOf = { catalog: 'hc:', product: 'hcp:', lot: 'hcl:' }
  const wrongPrefix = rows.filter((row) => !row.id.startsWith(prefixOf[row.kind])).length
  check('id 唯一且前缀对得上 kind', idSet.size === ids.length && wrongPrefix === 0, `唯一 ${idSet.size}/${ids.length}，前缀不符 ${wrongPrefix}`)

  // 挂网产品按注册证聚合：条目上的编码就是注册证号，所以详情页只印一次。
  const products = rows.filter((row) => row.kind === 'product')
  const codeIsCert = products.every((row) => row.code && row.code === row.cert)
  check('挂网产品：编码即注册证号', codeIsCert, products.find((row) => row.code !== row.cert)?.id || '')
  check('带量采购不带单体编码', rows.filter((row) => row.kind === 'lot' && row.code).length === 0)
  check('医保耗材目录都有编码', rows.filter((row) => row.kind === 'catalog' && !/^[A-Z0-9]+$/.test(row.code || '')).length === 0)

  const priced = rows.filter((row) => row.price)
  const oddLabel = priced.filter((row) => !PRICE_LABELS.includes(String(row.priceNote || '').split('：')[0]))
  check('有价格必有三种口径之一', oddLabel.length === 0 && priced.length === products.length, `${priced.length} 条有价，口径不符 ${oddLabel.length}`)
  const filled = rows.filter((row) => /（共 \d+ 个规格，其中 \d+ 个填了这项）$/.test(String(row.priceNote || '')))
  const overfilled = filled.filter((row) => {
    const m = String(row.priceNote).match(/共 (\d+) 个规格，其中 (\d+) 个填了这项/)
    return Number(m[2]) > Number(m[1])
  })
  check('「其中 M 个填了这项」不超过规格总数', overfilled.length === 0, `${filled.length} 条带后缀，越界 ${overfilled.length}`)

  const links = await grab('hc-links.json')
  const byRel = {}
  links.links.forEach((row) => { byRel[row.rel] = (byRel[row.rel] || 0) + 1 })
  check('三类关系条数', JSON.stringify(byRel) === JSON.stringify(HC_RELS), JSON.stringify(byRel))
  check('包内 meta.counts 与关系一致', JSON.stringify(links.meta?.counts) === JSON.stringify(HC_RELS), JSON.stringify(links.meta?.counts))
  const neihanHasB = links.links.filter((row) => row.rel === 'neihan' && row.b).length
  const hcclassNoB = links.links.filter((row) => row.rel === 'hcclass' && !row.b).length
  check('内涵耗材只有 a、耗材分类关系两端齐全', neihanHasB === 0 && hcclassNoB === 0, `neihan 带 b ${neihanHasB}，hcclass 缺 b ${hcclassNoB}`)

  // 两端都要能点得进去：master 端在收费项目包里，hc/hcp 端在耗材包里。
  const search = await grab('search.json')
  const searchIds = new Set(rowsOf(search).map((row) => row.id))
  let dangling = 0
  links.links.forEach((row) => {
    if (row.rel === 'neihan') return
    Array.from([row.a, row.b]).forEach((end) => {
      if (!end) return
      const known = end.startsWith('master:') ? searchIds.has(end) : idSet.has(end)
      if (!known) dangling += 1
    })
  })
  check('关系两端都能落到条目上', dangling === 0, `悬空 ${dangling}`)

  // 32 个分片把 4748 条全装下，且形状按 kind 分得清。
  const shards = Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(2, '0'))
  const packs = await Promise.all(shards.map(async (shard) => {
    try {
      return [shard, await grab(`hc/${shard}.json`)]
    } catch {
      return [shard, null]
    }
  }))
  const missing = []
  let specShape = 0
  let variantRows = 0
  let lotSpecShape = 0
  let priceSuffixOk = 0
  rows.forEach((row) => {
    const pack = packs.find(([shard]) => shard === detailShard(row.id))?.[1]
    const detail = pack?.[row.id]
    if (!detail) {
      missing.push(row.id)
      return
    }
    if (row.kind === 'catalog') {
      const history = Array.isArray(detail.history) ? detail.history : []
      // 目录条目靠「路径 + 版本沿革」立住：两样都空就说明这个分片没解出东西来。
      if ((detail.path || detail.versions?.length) && history.every((h) => typeof h.version === 'string')) specShape += 1
    } else if (row.kind === 'product') {
      const variants = Array.isArray(detail.variants) ? detail.variants : []
      variantRows += variants.length
      // 「其中 M 个填了这项」的 M 要和分片里真填了这项的规格数对得上。
      const m = String(row.priceNote || '').match(/共 \d+ 个规格，其中 (\d+) 个填了这项/)
      if (m) {
        const label = String(row.priceNote).split('：')[0]
        const hit = variants.filter((v) => v.price && v.priceLabel === label).length
        if (hit === Number(m[1])) priceSuffixOk += 1
      }
    } else if (Array.isArray(detail.specs) && detail.specs.every((s) => typeof s === 'string')) lotSpecShape += 1
  })
  check('32 个明细分片装下全部条目', missing.length === 0, `缺 ${missing.length}${missing.length ? ` 例：${missing[0]}` : ''}`)
  check('明细按 kind 分形状', specShape === HC_KINDS.catalog && lotSpecShape === HC_KINDS.lot, `目录 ${specShape}/${HC_KINDS.catalog}，带量 ${lotSpecShape}/${HC_KINDS.lot}`)
  const withSuffix = rows.filter((row) => /其中 \d+ 个填了这项/.test(String(row.priceNote || ''))).length
  check('「其中 M 个」与分片实填规格数一致', priceSuffixOk === withSuffix, `${priceSuffixOk}/${withSuffix}`)
  console.log(`挂网产品共 ${variantRows} 行规格（平均 ${(variantRows / HC_KINDS.product).toFixed(1)} 行/证）`)
}

main()
  .catch((err) => {
    console.error('ERROR', err.message)
    results.push({ name: 'harness', ok: false, detail: err.message })
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
