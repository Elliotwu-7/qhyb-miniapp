import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url), cache = new Map(), requests = [], toasts = []
let failed = true, backs = 0, tabSwitches = []
// 页面栈：返回到底去哪，全看这一页上面还有没有页。默认按「从「我的」点进来」摆两页。
const stack = [{ route: 'pages/me/me' }, { route: 'pages/register/register' }]
const uni = {
  setStorageSync() {}, removeStorageSync() {},
  request(o) {
    requests.push(o)
    o.success(failed ? { statusCode: 503, data: { error: '内容审核暂时不可用，请稍后重试', retryable: true } }
      : { statusCode: 200, data: { ok: true, openid: 'test', registered: true, hospitalLevel: 'L3', nickname: o.data.nickname } })
  },
  // 两个导航 API 分开记：合成一个计数器就分不出「退回去」和「回首页」了，
  // 而这正是这个 bug 的形态（原来两处都写死 switchTab 到「我的」）。
  showToast(o) { toasts.push(o) }, navigateBack() { backs++ }, switchTab(o) { tabSwitches.push(o && o.url) }, reLaunch() {},
  getFileSystemManager() { return { readFile(o) { o.success({ data: 'aW1hZ2U=' }) } } },
}
function load(name) {
  if (name === './i18n') return { t: key => key }
  if (!name.startsWith('./')) return require(name)
  if (cache.has(name)) return cache.get(name)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/' + name.slice(2) + '.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: load, uni, getCurrentPages: () => stack, Date, Map, Set, Error, Promise })
  cache.set(name, module.exports); return module.exports
}
const session = load('./session')
session.applyProfile({ openid: 'test', registered: false, hospitalLevel: 'L3' }, 'existing-session')
let source = readFileSync(new URL('../src/pages/register/register.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
source += '\nexport { onRegister, leaveIfRegistered, nickname, avatar, submitting }'
const module = { exports: {} }
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
vm.runInNewContext(js, { module, exports: module.exports, uni, getCurrentPages: () => stack, Promise, Error, require(name) {
  if (name === 'vue') return require('vue')
  if (name === '@dcloudio/uni-app') return { onShow() {}, onHide() {}, onUnload() {} }
  if (name.endsWith('/PrivacyPrompt.vue')) return {}
  if (name.endsWith('/HomePill.vue')) return {}
  if (name.endsWith('/theme')) return { applyChrome() {}, themeMode: 'light' }
  if (name.endsWith('/privacy')) return { openPrivacyContract() {}, setPrivacyPromptActive() {} }
  return load('./' + name.split('/').pop())
} })
const form = module.exports
form.nickname.value = '测试昵称'; form.avatar.value = 'wxfile://avatar.jpg'
await form.onRegister()
assert.equal(form.submitting.value, false); assert.equal(session.sessionBusy.value, false)
assert.equal(session.registered.value, false); assert.equal(form.nickname.value, '测试昵称'); assert.equal(form.avatar.value, 'wxfile://avatar.jpg')
assert.equal(backs, 0); assert.deepEqual(tabSwitches, []); assert.ok(toasts.at(-1).title.includes('稍后重试'), JSON.stringify(toasts))
assert.equal(requests.length, 1); assert.equal(requests[0].header.Authorization, 'Bearer existing-session')
console.log('PASS 503 preserves form, avatar and session, shows retry message and releases both submit locks')
failed = false
await form.onRegister()
assert.equal(session.registered.value, true); assert.equal(session.sessionError.value, '')
// 栈里上面还有「我的」，注册完就退回上一页，不该跳 tab。
assert.equal(backs, 1); assert.deepEqual(tabSwitches, [])
assert.equal(requests.length, 2); assert.equal(requests[1].data.avatar, 'data:image/jpeg;base64,aW1hZ2U=')
console.log('PASS retry uses selected avatar bytes and the same session, then returns to the previous page')
// 分享卡/扫码直接进注册页：栈里只有这一页。这时 navigateBack 什么都不做（实测不触发 fail），
// 原生返回箭头会退出小程序，所以必须自己去首页 tab —— 而且不能是「我的」。
stack.splice(0, 1)
backs = 0; tabSwitches = []
form.leaveIfRegistered()
assert.equal(backs, 0); assert.deepEqual(tabSwitches, ['/pages/index/index'])
console.log('PASS solo stack goes to the home tab, not back and not the profile tab')
