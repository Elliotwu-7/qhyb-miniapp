import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/lib/privacy.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 } }).outputText
function setup(options = {}) {
  const state = { listener: null, registrations: 0, opens: 0, toasts: [], answers: [] }
  const wx = {
    onNeedPrivacyAuthorization(callback) {
      state.registrations++
      if (options.registrationFails && state.registrations === 1) throw Error('SDK failure')
      state.listener = callback
    },
    openPrivacyContract(o) { state.opens++; if (options.openFails) o.fail() },
  }
  if (options.noNativeAPI) delete wx.onNeedPrivacyAuthorization
  const uni = { showToast(o) { state.toasts.push(o) }, showModal() { throw Error('Modal must never authorize') } }
  const module = { exports: {} }
  vm.runInNewContext(code, { wx, uni, module, exports: module.exports, require(name) {
    if (name === './i18n') return { t: key => key }
    return require(name)
  } })
  const api = module.exports
  api.watchPrivacy()
  const request = () => state.listener(answer => state.answers.push(JSON.parse(JSON.stringify(answer))))
  return { state, api, request }
}
let count = 0
function check(name, fn) { fn(); count++; console.log('PASS ' + name) }
check('native function callback remains pending until explicit agreement with button ID', () => {
  const { state, api, request } = setup()
  api.setPrivacyPromptActive(true); request()
  assert.equal(api.privacyVisible.value, true); assert.equal(state.answers.length, 0)
  api.agreePrivacy()
  assert.deepEqual(state.answers, [{ event: 'agree', buttonId: 'qhyb-privacy-agree' }])
  assert.equal(api.privacyVisible.value, false)
  api.agreePrivacy(); assert.equal(state.answers.length, 1); assert.equal(state.registrations, 1)
})
check('decline cannot become consent through a late event', () => {
  const { state, api, request } = setup()
  api.setPrivacyPromptActive(true); request(); api.declinePrivacy(); api.agreePrivacy()
  assert.deepEqual(state.answers, [{ event: 'disagree' }])
})
check('viewing the contract leaves the choice pending', () => {
  const { state, api, request } = setup()
  api.setPrivacyPromptActive(true); request(); api.openPrivacyContract()
  assert.equal(state.opens, 1); assert.equal(state.answers.length, 0); assert.equal(api.privacyVisible.value, true)
})
check('contract failure reports the problem without authorization', () => {
  const { state, api, request } = setup({ openFails: true })
  api.setPrivacyPromptActive(true); request(); api.openPrivacyContract()
  assert.equal(state.toasts.length, 1); assert.equal(state.answers.length, 0)
  api.setPrivacyPromptActive(false); assert.deepEqual(state.answers, [{ event: 'disagree' }])
})
check('concurrent callbacks all settle even if one request has ended', () => {
  const { state, api, request } = setup()
  api.setPrivacyPromptActive(true)
  state.listener(() => { throw Error('request ended') }); request(); request()
  api.setPrivacyPromptActive(false)
  assert.deepEqual(state.answers, [{ event: 'disagree' }, { event: 'disagree' }])
  api.setPrivacyPromptActive(true); request(); api.agreePrivacy()
  assert.equal(state.answers.at(-1).event, 'agree')
})
check('no visible host means rejection, never invisible consent', () => {
  const { state, api, request } = setup()
  request(); assert.deepEqual(state.answers, [{ event: 'disagree' }])
  assert.equal(api.privacyVisible.value, false)
})
check('failed listener registration retries when the page becomes available', () => {
  const { state, api, request } = setup({ registrationFails: true })
  assert.equal(state.listener, null)
  api.setPrivacyPromptActive(true); request(); api.declinePrivacy()
  assert.equal(state.registrations, 2); assert.deepEqual(state.answers, [{ event: 'disagree' }])
})
check('older SDKs never synthesize consent or crash', () => {
  const { state, api } = setup({ noNativeAPI: true })
  api.setPrivacyPromptActive(true); api.agreePrivacy(); api.setPrivacyPromptActive(false)
  assert.equal(state.answers.length, 0)
})
console.log(`${count} privacy behavior checks passed`)
