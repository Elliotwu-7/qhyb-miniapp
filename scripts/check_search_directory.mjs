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
  const source = readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: load, Date, Map, Set })
  modules.set(name, module.exports)
  return module.exports
}
const { prepareSearchItems, orderDirectoryHits, searchDirectory, searchCatalog } = load('./search')
const { isDrug } = load('./types')
const { isEffectivelyStopped, isUpcomingExecute } = load('./status')
const { unpackSearch, unpackDrugs, drugAsSearchItem } = load('./data')
const now = new Date('2026-09-23T04:00:00Z')
const make = (id, fields = {}) => ({
  id, name: '测试项目', code: id, aliases: [], pi: '', py: '', aliasPi: '', aliasPy: '',
  status: 'active', merged: false, cat1: '检验', stopAt: '', executeAt: '',
  mergeFrom: [], successors: [], ...fields,
})
const fixtures = prepareSearchItems([
  make('dead', { name: '测试', status: 'stopped' }),
  make('today', { stopAt: '2026.9.23停用' }),
  make('future', { executeAt: '2026.9.24起' }),
  make('drug', { kind: 'xiyao', cat1: '西药', payClass: '乙类', remark: '限指定范围', paid: true }),
  make('soon', { stopAt: '2026.9.24停用' }),
  make('live'),
  make('outside', { kind: 'excluded', cat1: '不得支付饮片', paid: false }),
  make('startsToday', { executeAt: '2026.9.23起' }),
], now)
const ids = (items) => Array.from(items, (item) => item.id)
let count = 0
function check(name, run) { run(); count += 1; console.log(`PASS ${name}`) }
check('有效日期分组：在用 → 药品 → 待执行 → 失效，组内顺序保留', () => {
  assert.deepEqual(ids(orderDirectoryHits(fixtures)), ['soon', 'live', 'startsToday', 'drug', 'outside', 'future', 'dead', 'today'])
})
const services = fixtures.filter((item) => !isDrug(item))
const drugs = fixtures.filter(isDrug)
const search = (options) => searchDirectory(services, drugs, { query: '', scope: 'all', ...options })
check('空关键词同样可浏览药品，非基金支付不等于失效', () => {
  assert.deepEqual(ids(search({ scope: 'drug' })), ['drug', 'outside'])
  assert.equal(search({}).filter(isDrug).length, 2)
  assert.equal(searchDirectory([], drugs, { scope: 'all', query: '' }).length, 2)
})
check('药品类别和限制支付组合筛选，保留原始数据判定', () => {
  assert.deepEqual(ids(search({ scope: 'drug', category: '西药', drugFilter: 'limited' })), ['drug'])
  assert.equal(search({ scope: 'drug', drugFilter: 'classA' }).length, 0)
  assert.deepEqual(ids(search({ scope: 'drug', drugFilter: 'classB' })), ['drug'])
  assert.deepEqual(ids(search({ scope: 'drug', drugFilter: 'outside' })), ['outside'])
})
check('诊疗状态筛选不混入药品，不把今日停用项目算在用', () => {
  assert.deepEqual(ids(search({ scope: 'service', status: 'stopped' })), ['dead', 'today'])
  assert.deepEqual(ids(search({ scope: 'service', status: 'pending' })), ['future'])
  assert.deepEqual(ids(search({ scope: 'service', status: 'active', query: '测试' })), ['soon', 'live', 'startsToday'])
})
check('状态不从诊疗泄漏到药品，药品筛选不泄漏到全部', () => {
  assert.equal(search({ scope: 'drug', status: 'stopped' }).length, 2)
  assert.equal(search({ scope: 'all', drugFilter: 'classA', category: '西药' }).filter(isDrug).length, 2)
})
check('失效精确命中也排在在用与药品后，分页不会先展示失效项', () => {
  const results = search({ query: '测试' })
  assert.equal(results[0].id, 'soon')
  assert.ok(results.findIndex((item) => item.id === 'drug') < results.findIndex((item) => item.id === 'dead'))
  assert.deepEqual(ids(results.slice(0, 4)), ['soon', 'live', 'startsToday', 'drug'])
})
check('待执行项目映射现行原项目后仍遵守类别与状态', () => {
  const predecessors = prepareSearchItems([
    make('orig', { name: '透析原项目', cat1: '旧分类' }),
    make('pending', { name: '透析新项目', cat1: '新分类', executeAt: '2099.1.1起', mergeFrom: ['透析原项目'] }),
  ], now)
  assert.deepEqual(ids(searchDirectory(predecessors, [], { scope: 'service', query: '透析新项目' })), ['orig'])
  assert.equal(searchDirectory(predecessors, [], { scope: 'service', query: '透析新项目', category: '新分类' }).length, 0)
  assert.equal(searchDirectory(predecessors, [], { scope: 'service', query: '透析新项目', status: 'stopped' }).length, 0)
})

const dataRoot = process.env.CATALOG_ROOT || 'G:/QYB/yibao-query/public/data'
const readPack = (name) => JSON.parse(readFileSync(`${dataRoot}/${name}.json`, 'utf8'))
const realServices = prepareSearchItems(unpackSearch(readPack('search')), now)
const realDrugs = prepareSearchItems(unpackDrugs(readPack('drugs')).map(drugAsSearchItem), now)
check('真实目录全部 4406 条药品可直接浏览，八类均可筛选', () => {
  const all = searchDirectory(realServices, realDrugs, { scope: 'drug', query: '' })
  assert.equal(all.length, realDrugs.length)
  assert.equal(new Set(all.map((item) => item.kind)).size, 8)
  for (const category of new Set(realDrugs.map((item) => item.cat1))) {
    const found = searchDirectory(realServices, realDrugs, { scope: 'drug', query: '', category })
    assert.ok(found.length > 0)
    assert.equal(found.length, realDrugs.filter((item) => item.cat1 === category).length)
  }
})
check('真实混合搜索有序，药品相关性排序不变', () => {
  const group = (item) => isDrug(item) ? 1 : isEffectivelyStopped(item, now) ? 3 : isUpcomingExecute(item, now) ? 2 : 0
  for (const query of ['氧', '肝素', '胰岛素', '麻醉', '鼻炎片', 'xytx']) {
    const found = searchDirectory(realServices, realDrugs, { scope: 'all', query })
    assert.ok(found.every((item, i) => !i || group(found[i - 1]) <= group(item)), query)
    assert.deepEqual(ids(found.filter(isDrug)), ids(searchCatalog(realDrugs, query)), query)
    console.log(`  ${query}: ${found.filter((x) => group(x) === 0).length} active / ${found.filter(isDrug).length} drugs / ${found.filter((x) => group(x) === 3).length} stopped`)
  }
})
console.log(`\n${count}/${count} passed`)
