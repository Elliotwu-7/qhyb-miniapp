import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url), cache = new Map(), calls = []
let current = 'v20260923000000-123456789abc'
const first = current
let fail = false
function load(name) {
  if (name === './i18n') return { t: key => key }
  if (!name.startsWith('./')) return require(name)
  if (cache.has(name)) return cache.get(name)
  const module = { exports: {} }
  const js = ts.transpileModule(readFileSync(new URL('../src/lib/'+name.slice(2)+'.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
  vm.runInNewContext(js,{module,exports:module.exports,require:load,Date,Map,Set,uni:{request(o){
    calls.push(o.url)
    if (o.url.includes('/release.json')) { o.success({statusCode:200,data:{id:current,base:'/catalog/'+current}}); return }
    if (fail || o.url.endsWith('.gz')) { o.fail({errMsg:'isolated network failure'}); return }
    const data = o.url.includes('/labels/') ? {r:{'xiyao-1':{t:'A',name:'fixture',ind:'source'}}} : o.url.includes('/meta.') ? {stats:{total:1}} : {'p1':{connotation:'source'}}
    o.success({statusCode:200,data})
  }}})
  cache.set(name,module.exports);return module.exports
}
const data = load('./data')
await Promise.all([data.loadMeta(),data.fetchItemDetail('p1'),data.fetchDrugLabels(['xiyao-1'])])
assert.equal(calls.filter(x=>x.includes('/release.json')).length,1)
current = 'v20260923000001-abcdef123456'
fail = true; await assert.rejects(data.fetchItemDetail('p2')); fail=false
await data.fetchItemDetail('p2')
await data.fetchDrugLabels(['xiyao-2'])
assert.ok(calls.filter(x=>!x.includes('/release.json')).every(x=>x.startsWith('https://qhyb.lynkco.site/catalog/'+first+'/')))
assert.equal(calls.filter(x=>x.includes('/release.json')).length,1)
console.log('PASS meta、详情、说明书共用一次版本发现；发布后重试及整包回退仍读取原版本')
