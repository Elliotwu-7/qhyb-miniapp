import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as vue from 'vue'
const require = createRequire(import.meta.url)
const flush = async () => { for (let i = 0; i < 25; i += 1) await Promise.resolve() }
let passed = 0
const check = (name) => { passed += 1; console.log(`PASS ${name}`) }

function loader(stubs = {}, globals = {}) {
  const cache = new Map()
  const load = (name) => {
    if (name in stubs) return stubs[name]
    if (name === './i18n') return { t: (key) => key }
    if (!name.startsWith('./')) return require(name)
    if (cache.has(name)) return cache.get(name)
    const module = { exports: {} }
    const code = ts.transpileModule(readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, require: load, Date, Map, Set, ...globals })
    cache.set(name, module.exports)
    return module.exports
  }
  return load
}
const calls = []
let failed = true
let missingDrugs = false
const itemId = 'xiyao-test'
const requests = { request(options) {
  calls.push(options.url)
  if (failed || options.url.endsWith('.gz') || (missingDrugs && options.url.includes('/drugs.'))) { options.fail({ errMsg: 'test offline' }); return }
  if (options.url.includes('/release.json')) { options.success({ statusCode: 200, data: { id: 'v20260923000000-123456789abc', base: '/catalog/v20260923000000-123456789abc' } }); return }
  let data = {}
  if (options.url.includes('/labels/')) data = { r: { [itemId]: { t: 'A', name: '测试药品', ind: '说明书正文' } } }
  else if (options.url.includes('/d/') || options.url.endsWith('/details.json')) data = { [itemId]: { connotation: '项目内涵', h: [] } }
  else if (options.url.endsWith('/search.json')) data = { f: ['id', 'name', 'status'], r: [['service-test', '测试项目', 1]] }
  else if (options.url.endsWith('/drugs.json')) data = { f: ['id', 'name', 'kind'], r: [[itemId, '测试药品', 'xiyao']] }
  else if (options.url.endsWith('/edges.json')) data = { f: ['drugId', 'serviceId', 'rel'], r: [] }
  else if (options.url.endsWith('/usage.json')) data = { '消化系统': '类别说明' }
  else if (options.url.endsWith('/hc-items.json')) data = { f: ['id', 'name', 'kind', 'status'], r: [['hc-test', '测试耗材', 'catalog', 'active']] }
  else if (options.url.endsWith('/hc-links.json')) data = { links: [] }
  else if (options.url.endsWith('/meta.json')) data = { stats: { total: 1 }, categories: [] }
  options.success({ statusCode: 200, data })
} }
const load = loader({}, { uni: requests })
const data = load('./data')
await assert.rejects(data.fetchDrugLabels([itemId]))
failed = false
const before = calls.length
const labels = await Promise.all([data.fetchDrugLabels([itemId]), data.fetchDrugLabels([itemId])])
assert.equal(labels[0][itemId].indication, '说明书正文')
assert.equal(calls.length - before, 3)
await data.fetchDrugLabels([itemId])
assert.equal(calls.length - before, 3)
check('说明书断网会报错，重试恢复，并发加载合并，成功才缓存')

failed = true
await assert.rejects(data.fetchItemDetail(itemId))
failed = false
assert.equal((await data.fetchItemDetail(itemId)).connotation, '项目内涵')
check('详情分片和整包均失败后仍可重新加载')

const store = load('./store')
missingDrugs = true
const partial = await store.catalogReady()
assert.equal(partial.drugs.length, 0)
assert.ok(partial.warnings.includes('drugs'))
missingDrugs = false
const complete = await store.catalogReady()
assert.equal(complete.drugs.length, 1)
assert.equal(complete.warnings.length, 0)
check('部分目录失败明确标记不完整，下次重试能补齐药品')

assert.equal(load('./route').routeValue('100%'), '100%')
assert.equal(load('./route').routeValue('%E6%B0%A7'), '氧')
assert.equal(load('./route').routeValue('%bad'), '%bad')
check('包含百分号或损坏编码的分享参数不会崩溃')

const writes = []
const storage = new Map()
const baseProfile = { openid: 'test', registered: true, hospitalLevel: 'L3' }
const session = loader({ './api': {
  mpSettings: (_, level) => new Promise((resolve) => writes.push({ level, resolve })),
} }, { uni: { setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: (k) => storage.delete(k) } })('./session')
session.applyProfile(baseProfile, 'test-token')
const first = session.setHospitalLevel('L2')
const second = session.setHospitalLevel('L1')
await flush()
assert.equal(writes.length, 1)
assert.equal(session.hospitalLevel.value, 'L1')
writes[0].resolve({ ...baseProfile, hospitalLevel: 'L2' }); await flush()
assert.equal(writes.length, 2)
assert.equal(writes[1].level, 'L1')
session.applyProfile(baseProfile)
assert.equal(session.hospitalLevel.value, 'L1')
writes[1].resolve({ ...baseProfile, hospitalLevel: 'L1' })
await Promise.all([first, second])
assert.equal(session.hospitalLevel.value, 'L1')
check('快速切换医院档位按顺序保存，旧回复和其他请求不覆盖最后选择')

const pendingQueries = []
const mockSession = { registered: vue.ref(true), hospitalLevel: vue.ref('L3'), consumeQuery: (q) => new Promise((resolve) => pendingQueries.push({ q, resolve })) }
const script = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
const module = { exports: {} }
const deps = {
  '@dcloudio/uni-app': { onLoad() {}, onHide() {}, onShow() {}, onShareAppMessage() {}, onShareTimeline() {} },
  '../../lib/session': mockSession,
  '../../lib/content': { useContentTranslation: () => ({ ct: (x) => x }) },
  '../../lib/history': { loadHistory: () => [], pushHistory: () => [] },
  '../../lib/store': { catalogReady: async () => ({ ...complete, meta: { stats: {}, categories: [] } }) },
  '../../lib/theme': { themeMode: vue.ref('light') },
}
vm.runInNewContext(ts.transpileModule(`${script}\nexport { commitSearch, onClear, q, committed, searching };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
  module, exports: module.exports, uni: { showToast() {} },
  require(name) { if (name in deps) return deps[name]; if (name.endsWith('.vue')) return {}; if (name.startsWith('../../lib/')) return load('./' + name.split('/').at(-1)); return require(name) },
})
const page = module.exports
const oldSearch = page.commitSearch('旧搜索')
const newSearch = page.commitSearch('新搜索')
pendingQueries[1].resolve(baseProfile); await newSearch
pendingQueries[0].resolve(baseProfile); await oldSearch
assert.equal(page.committed.value, '新搜索')
const clearedSearch = page.commitSearch('随后清空')
page.onClear()
pendingQueries[2].resolve(baseProfile); await clearedSearch
assert.equal(page.committed.value, '')
assert.equal(page.searching.value, false)
check('连续搜索只接受最新响应，清空后旧响应不会恢复结果')
console.log(`${passed}/${passed} passed`)
