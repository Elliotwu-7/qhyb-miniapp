import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

const locale = vue.ref('en')
const requests = []
const timers = []
const module = { exports: {} }
const context = vm.createContext({
  module, exports: module.exports,
  setTimeout: (fn) => { timers.push(fn); return timers.length },
  uni: { request: (options) => requests.push(options) },
  require(name) {
    if (name === 'vue') return { ...vue, inject: () => null, provide: () => {} }
    if (name === './i18n') return { locale, t: (key) => key }
    if (name === './search-terms') return { reviewedName: () => undefined, registerReferenceTerm: () => {} }
    throw new Error(name)
  },
})
vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/lib/content.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText, context)
const scope = module.exports.useContentTranslation(true)
const drain = async () => {
  await vue.nextTick()
  let count = 0
  while (timers.length) {
    assert.ok(++count < 100, 'queue must settle')
    timers.shift()()
  }
  await vue.nextTick()
}
const reply = async (request, translations) => {
  request.success({ statusCode: 200, data: { ok: true, language: request.data.language, translations } })
  await drain()
}

assert.equal(scope.ct('法莫替丁'), '…')
scope.ct('法莫替丁')
await drain()
assert.equal(requests.length, 1)
assert.equal(requests[0].data.texts.length, 1)
console.log('PASS 同一正文重复显示只发一次翻译请求')

locale.value = 'bo'
await drain()
scope.ct('法莫替丁')
await drain()
assert.equal(requests.length, 2)
await reply(requests[0], ['Famotidine'])
assert.equal(scope.ct('法莫替丁'), '…')
await reply(requests[1], ['ཧྥ་མོ་ཐི་ཏིང་།'])
assert.equal(scope.ct('法莫替丁'), 'ཧྥ་མོ་ཐི་ཏིང་།')
console.log('PASS 切换语言后的旧响应不会覆盖新语言正文')

scope.original.value = true
assert.equal(scope.ct('法莫替丁'), '法莫替丁')
scope.original.value = false
assert.equal(scope.ct('法莫替丁'), 'ཧྥ་མོ་ཐི་ཏིང་།')
assert.equal(requests.length, 2)
console.log('PASS 查看原文再返回译文不重复请求')

scope.ct('儿童禁用')
await drain()
requests[2].fail({ errMsg: 'request:fail timeout' })
await drain()
assert.equal(scope.ct('儿童禁用'), 'content.unavailable')
assert.equal(scope.failed.value, true)
scope.retry()
await drain()
await reply(requests[3], ['བྱིས་པས་སྤྱོད་མི་ཆོག'])
assert.equal(scope.failed.value, false)
assert.equal(scope.ct('儿童禁用'), 'བྱིས་པས་སྤྱོད་མི་ཆོག')
console.log('PASS 网络失败有明确状态且可重试恢复')

scope.original.value = true
locale.value = 'en'
await drain()
assert.equal(scope.original.value, false)
assert.equal(scope.ct('法莫替丁'), 'Famotidine')
assert.equal(scope.ct('20 mg'), '20 mg')
locale.value = 'zh'
assert.equal(scope.ct('未缓存的中文原文'), '未缓存的中文原文')
console.log('PASS 语言重选回到译文，数字单位和中文模式保持原值')
