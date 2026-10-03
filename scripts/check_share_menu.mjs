import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/share.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText

function load(uni) {
  const context = vm.createContext({ uni, exports: {} })
  vm.runInContext(compiled, context)
  return context.exports
}

async function scenario(name, outcomes, expected) {
  const calls = []
  const callbacks = []
  const api = load({
    showShareMenu(options) {
      const outcome = outcomes[calls.length]
      calls.push(Array.from(options.menus))
      assert.equal(options.withShareTicket, false)
      // uni uses callback mode only when a callback is supplied. Missing fail
      // is the original cause of the unhandled rejection on permission denial.
      assert.equal(typeof options.fail, 'function')
      if (outcome === 'throw') throw new Error('showShareMenu:fail no permission')
      if (outcome === 'deny') {
        callbacks.push(Promise.resolve().then(() => options.fail({
          errMsg: 'showShareMenu:fail no permission',
        })))
      }
    },
  })
  assert.doesNotThrow(() => api.enableShare())
  // The fallback may enqueue another asynchronous denial.
  for (let i = 0; i < callbacks.length; i++) await callbacks[i]
  assert.deepEqual(calls, expected)
  console.log(`PASS ${name}`)
}

const full = ['shareAppMessage', 'shareTimeline']
const friends = ['shareAppMessage']
await scenario('有权限时保留好友和朋友圈菜单', ['ok'], [full])
await scenario('完整菜单被拒绝时回退好友转发', ['deny', 'ok'], [full, friends])
await scenario('两次异步拒绝均被处理且不再重试', ['deny', 'deny'], [full, friends])
await scenario('同步抛错也不会中断页面', ['throw', 'throw'], [full, friends])
assert.doesNotThrow(() => load({}).enableShare())
console.log('PASS 缺少分享 API 的环境可正常浏览')
