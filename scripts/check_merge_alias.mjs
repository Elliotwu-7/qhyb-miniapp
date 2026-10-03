// 并入别的项目之后，老名字还要能搜到活下来的那一条。
// 「雷火灸」并入「悬空灸」但搜不到，就是这个不变量破了。目录来自 yibao-query 的候选快照，
// 与 check_search_terms.mjs 取的是同一份。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const modules = new Map()
function load(name) {
  if (name === './i18n') return { t: (key) => key }
  if (!name.startsWith('./')) return require(name)
  if (modules.has(name)) return modules.get(name)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: load, Date, Map, Set, uni: { request: () => {} } })
  modules.set(name, module.exports)
  return module.exports
}

const search = load('./search')
const data = load('./data')
// 目录默认取 yibao-query 的候选快照；传一个目录参数可以拿线上那份来跑（线上缺别名时这个检查会红）。
const dir = process.argv[2] || 'G:/QYB/yibao-query/public/data'
const read = (file) => JSON.parse(readFileSync(`${dir}/${file}.json`, 'utf8'))
console.log(`目录：${dir}`)
const services = search.prepareSearchItems(data.unpackSearch(read('search')))

// 用户报的那一条：雷火灸已并入悬空灸，搜「雷火灸」必须出悬空灸。
const hit = search.searchCatalog(services, '雷火灸')
assert.ok(
  hit.some((row) => row.name === '悬空灸'),
  `搜「雷火灸」没有出悬空灸，实际：${hit.slice(0, 5).map((r) => r.name).join('、') || '(无结果)'}`,
)
console.log(`PASS 搜「雷火灸」出「悬空灸」（第 ${hit.findIndex((r) => r.name === '悬空灸') + 1} 条）`)

// 推广成不变量：目录里每个别名，搜它都要能搜回拥有它的那一条。
// 重名/包含关系允许它不排第一，但不许一条都搜不到。
let checked = 0
const missed = []
for (const item of services) {
  for (const alias of item.aliases || []) {
    if (!alias) continue
    checked += 1
    const rows = search.searchCatalog(services, alias)
    if (!rows.some((row) => row.id === item.id)) missed.push(`${alias} -> ${item.name}(${item.id})`)
  }
}
assert.equal(missed.length, 0, `有 ${missed.length} 个别名搜不回原条目：\n  ${missed.slice(0, 20).join('\n  ')}`)
console.log(`PASS ${checked} 个别名全部能搜回所属条目`)
console.log(`${checked + 1} 项通过`)
