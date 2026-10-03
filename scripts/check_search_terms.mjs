import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const modules = new Map()
const requests = []
function load(name) {
  if (name === './i18n') return { t: (key) => key }
  if (!name.startsWith('./')) return require(name)
  if (modules.has(name)) return modules.get(name)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: load, Date, Map, Set, uni: { request: (o) => requests.push(o) } })
  modules.set(name, module.exports)
  return module.exports
}
const terms = load('./search-terms')
const search = load('./search')
const data = load('./data')
const read = (file) => JSON.parse(readFileSync(`G:/QYB/yibao-query/public/data/${file}.json`, 'utf8'))
const services = search.prepareSearchItems(data.unpackSearch(read('search')))
const drugs = search.prepareSearchItems(data.unpackDrugs(read('drugs')).map(data.drugAsSearchItem))
const tibetan = 'ཧྥ་མོ་ཐི་ཏིང་།'
const pack = { ok: true, version: 'fixture', entries: [
  { source: '法莫替丁', language: 'en', term: 'Famotidine', reviewed: false },
  { source: '法莫替丁', language: 'bo', term: tibetan, reviewed: false },
], managed: [] }
let checks = 0
const check = (name) => { checks++; console.log(`PASS ${name}`) }
const find = (query, extra = {}) => search.searchDirectory(services, drugs, { query, scope: 'all', ...extra })
terms.applySearchTerms(pack)
assert.ok(find('Famotidine').some((row) => row.name === '法莫替丁'))
assert.deepEqual(Array.from(find('ＦＡＭＯＴＩＤＩＮＥ'), (r) => r.id), Array.from(find('Famotidine'), (r) => r.id))
assert.equal(find('Famotidine', { scope: 'service' }).length, 0)
check('真实目录英文译名、大小写、全角输入和药品/诊疗筛选一致')
assert.ok(find(tibetan).length)
assert.deepEqual(Array.from(find(tibetan), (r) => r.id), Array.from(find('ཧྥ མོ ཐི ཏིང'), (r) => r.id))
assert.notEqual(terms.normalizeSearchText('ཐི'), terms.normalizeSearchText('ཐུ'))
assert.equal(find('་།').length, 0)
check('藏文字母和元音保留，音节点/空格等价，纯标点不误命中')
assert.ok(search.orderDirectoryHits(search.searchCatalog([...services, ...drugs], tibetan)).some((r) => r.name === '法莫替丁'))
check('图谱与首页使用同一份译名索引')
terms.registerReferenceTerm('法莫替丁', 'en', 'Previously displayed name')
assert.ok(find('Previously displayed name').length)
check('刚显示过的机器参考译名可以立即检索')
terms.applySearchTerms({ ...pack, version: 'reviewed', managed: [['法莫替丁', 'en']], entries: [{ source: '法莫替丁', language: 'en', term: 'Reviewed fixture name', reviewed: true }] })
assert.equal(terms.reviewedName('法莫替丁', 'en'), 'Reviewed fixture name')
assert.equal(find('Famotidine').length, 0)
assert.ok(find('Reviewed fixture name').length)
terms.registerReferenceTerm('法莫替丁', 'en', 'Famotidine')
assert.equal(find('Famotidine').length, 0)
check('核对发布后显示与检索优先采用人工词条，旧机器译名不重新加入')
terms.applySearchTerms({ ...pack, version: 'withdrawn', entries: [], managed: [['法莫替丁', 'en'], ['法莫替丁', 'bo']] })
terms.registerReferenceTerm('法莫替丁', 'en', 'Famotidine')
assert.equal(find('Famotidine').length, 0)
assert.equal(find(tibetan).length, 0)
assert.ok(find('法莫替丁').length)
check('撤回移除旧译名，中文目录检索保持可用')
const first = terms.loadSearchTerms(true)
const second = terms.loadSearchTerms(true)
assert.equal(requests.length, 1)
requests[0].fail({ errMsg: 'ConnectionClosed' })
await Promise.all([first, second])
assert.equal(terms.searchTermsState.value, 'error')
const retry = terms.loadSearchTerms(true)
requests[1].success({ statusCode: 200, data: pack })
await retry
assert.equal(terms.searchTermsState.value, 'ready')
assert.ok(find('Famotidine').length)
check('词库请求合并，断网明确报错并可原地重试')
assert.throws(() => terms.applySearchTerms({ ...pack, entries: [null] }))
assert.ok(find('Famotidine').length)
check('异常响应不会清掉已加载的有效索引')
console.log(`${checks}/${checks} passed`)
