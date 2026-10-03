// 线上是否真的在提供详情分片的 .gz。小程序 1.1.3 起 fetchItemDetail 先拉
// /data/d/xx.json.gz，缺一个分片就会悄悄退回 237KB 的 .json —— 功能不坏但白改。
// 所以发版后按真实 id 走一遍：算出分片号 → 下载 → 解压 → 确认这条 id 真在里面。
//
// 运行：node scripts/verify_gz_shards_live.mjs
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const DATA = 'G:/QYB/yibao-query/public/data'
const BASE = 'https://qhyb.lynkco.site/data'

function djb2(text) {
  let h = 5381
  let i = 0
  while (i < text.length) {
    h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0
    i += 1
  }
  return h
}
const detailShard = (id, n = 32) => (djb2(id) % n).toString(16).padStart(2, '0')

const pack = JSON.parse(readFileSync(`${DATA}/search.json`, 'utf8'))
const idAt = pack.f.indexOf('id')
const ids = pack.r.map((row) => String(row[idAt] || '')).filter(Boolean)
console.log(`本地 search.json ${ids.length} 条，分布在多少个分片`)

// 每个分片取一条 id 作代表，逐片验
const byShard = new Map()
ids.forEach((id) => {
  const s = detailShard(id)
  if (!byShard.has(s)) byShard.set(s, id)
})

const shards = Array.from(byShard.keys()).sort()
console.log(`需要验的分片 ${shards.length} 个\n`)

let ok = 0
let missing = []
let badContent = []
for (let i = 0; i < shards.length; i += 1) {
  const shard = shards[i]
  const id = byShard.get(shard)
  const url = `${BASE}/d/${shard}.json.gz`
  let res
  try {
    res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } })
  } catch (err) {
    missing.push(`${shard} (请求失败 ${err.message})`)
    continue
  }
  if (!res.ok) {
    missing.push(`${shard} (HTTP ${res.status})`)
    continue
  }
  const buf = Buffer.from(await res.arrayBuffer())
  let parsed
  try {
    parsed = JSON.parse(gunzipSync(buf).toString('utf8'))
  } catch (err) {
    badContent.push(`${shard} (解压/解析失败 ${err.message})`)
    continue
  }
  if (!parsed || typeof parsed !== 'object' || !(id in parsed)) {
    badContent.push(`${shard} (缺 id ${id})`)
    continue
  }
  ok += 1
  if (i < 3) console.log(`  样例 ${shard}.json.gz  ${buf.length} 字节 → 解出 ${Object.keys(parsed).length} 条，含 ${id}`)
}

console.log(`\n可用分片 ${ok}/${shards.length}`)
if (missing.length) console.log(`缺失/不可用：${missing.join('; ')}`)
if (badContent.length) console.log(`内容不对：${badContent.join('; ')}`)
process.exit(missing.length || badContent.length ? 1 : 0)
