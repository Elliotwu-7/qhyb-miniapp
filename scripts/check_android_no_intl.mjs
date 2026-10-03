// 小程序的「安卓逻辑层没有 Intl」守卫。
//
// 微信小程序的两端跑的不是同一个 JS 引擎：iOS 逻辑层是 JavaScriptCore，自带 Intl；
// 安卓逻辑层是精简版 V8，没有 Intl。所以 `new Intl.DateTimeFormat(...)` 这类代码
// 在 iOS 上静悄悄，在安卓上直接抛 —— 而且如果它写在模块顶层（实测 lib/status.ts
// 就是这么写的），import 到它的页面整页白屏，只剩微信原生的 tabBar。
//
// 检测办法是把 dist 里每个模块分别在「有 Intl」和「没有 Intl」两个沙箱里加载一遍，
// 取差集：只有「有 Intl 能过、没 Intl 抛错」的模块才算数。这样别的加载失败
// （缺 wx、缺数据…）不会误报。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { join, relative } from 'node:path'

const DIST = 'G:\\qhyb-miniapp\\dist\\build\\mp-weixin'
// 框架预构建产物，不是本仓库源码，不在此守卫生效范围内。
const SKIP = new Set(['common/vendor.js', 'common/vendor.js.map'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// 沙箱里凡是没列出来的东西都不存在 —— 这正是「安卓逻辑层」的建模方式。
function makeSandbox(globalThisIsIntl) {
  const callable = function () {}
  const stub = new Proxy(callable, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    construct: () => stub,
  })
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: () => stub,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date,
    Map,
    Set,
    WeakMap,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    JSON,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Symbol,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    setTimeout,
    clearTimeout,
  }
  // 只有这一项在两次加载之间不同。
  sandbox.Intl = globalThisIsIntl ? Intl : undefined
  sandbox.globalThis = sandbox
  sandbox.wx = stub
  sandbox.App = () => {}
  sandbox.Page = () => {}
  sandbox.Component = () => {}
  sandbox.Behavior = () => {}
  sandbox.getApp = () => stub
  sandbox.getCurrentPages = () => []
  return sandbox
}

function loadAll(withIntl) {
  const result = new Map()
  for (const file of walk(DIST)) {
    const rel = relative(DIST, file).split('\\').join('/')
    if (SKIP.has(rel)) continue
    try {
      runInContext(readFileSync(file, 'utf8'), createContext(makeSandbox(withIntl)), { filename: file })
      result.set(rel, null)
    } catch (err) {
      result.set(rel, `${err.constructor.name}: ${err.message}`)
    }
  }
  return result
}

const withIntl = loadAll(true)
const noIntl = loadAll(false)

const broken = []
for (const [rel, err] of noIntl) {
  if (!err) continue
  if (withIntl.get(rel)) continue // 有 Intl 也加载不了，说明是别的原因，不算
  broken.push({ rel, err })
}

console.log(`扫了 ${withIntl.size} 个模块；去掉 Intl 后新炸的：${broken.length} 个`)
if (!broken.length) {
  console.log('CLEAN - 没有模块依赖安卓逻辑层缺失的 Intl')
  process.exit(0)
}
console.log('\n这些模块在安卓上会整页白屏：')
for (const b of broken) console.log(`  ${b.rel}\n    ${b.err}`)
process.exit(1)
