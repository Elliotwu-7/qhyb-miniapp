// 微信模拟器里验「返回首页」和「反馈微信」——用户手机上看到的就是这份产物。
//
// 分成两层，因为模拟器的自动化桥没有 DOM：
//   静态层：读 dist/build/mp-weixin 的 WXML／WXSS／lib/contact.js，验「顶栏在搜索框前面」
//           （也就是最上面）、胶囊样式真的进了 wxss、复制成功和失败两条路都在。
//   模拟器层：真页面里点，验状态翻转和两条复制路径。
//
// 剪贴板这一条的来龙去脉（2026-09-25 查出来的）：wx.setClipboardData 属于微信隐私接口，
// 用户没同意隐私协议时直接失败 —— 实测报 `errno 104 privacy permission is not authorized`。
// 原来的代码只接了 success，所以那一整条路是静默的，用户看到的就是「反馈微信无效」。
// 模拟器里的隐私状态改不动（同意必须来自原生 agreePrivacyAuthorization 按钮），所以
// 这里分两次验：先把剪贴板打桩成成功走一遍，再放开真实调用，验失败时确实把号弹出来。
// 端口 9431（同 check_wechat_search／check_wechat_terms，起法见 README）。
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

let checks = 0
const check = (label, ok = true) => { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }
const mp = (rel) => readFile(new URL(`../dist/build/mp-weixin/${rel}`, import.meta.url), 'utf8')

const ws = new WebSocket(`ws://127.0.0.1:${process.env.QHYB_AUTOMATION_PORT || '9431'}`)
// open 的监听要立刻挂上：下面静态层那几次 readFile 是真的异步，等读完再挂的话
// open 事件可能已经发过了，之后就永远等不到（看起来像端口没起）。
const opened = new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
const pending = new Map()
let nextId = 0
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = String(++nextId)
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 20000)
  pending.set(id, { resolve, reject, timer })
  ws.send(JSON.stringify({ id, method, params }))
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 在小程序逻辑层里跑一段函数体，返回它的返回值（callFunction 收的是整个 function 声明）。 */
const run = async (body) => (await rpc('App.callFunction', { functionDeclaration: `function(){${body}}`, args: [] })).result

let pageId
const elements = async (selector) => (await rpc('Page.getElements', { pageId, selector })).elements
// 冷启动的模拟器实例（比如刚起在另一个端口上）要十几秒才把目录读完、首页才画全，
// 所以等 15 秒；等不到就抛一句人话，别让调用方拿到空数组后崩在 elementId 上。
const once = async (selector, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const found = await elements(selector)
    if (found.length) return found
    await sleep(250)
  }
  assert.fail(`等了 ${Math.round(tries * 0.25)} 秒也没等到 ${selector}`)
}
const textOf = async (elementId) => {
  const result = await rpc('Element.getDOMProperties', { pageId, elementId, names: ['innerText'] })
  return result.properties?.innerText ?? result.properties?.[0] ?? ''
}
const tap = async (selector) => {
  const found = await elements(selector)
  assert.ok(found.length, `找不到 ${selector}`)
  await rpc('Element.tap', { pageId, elementId: found[0].elementId })
  await sleep(800)
}
const screenshot = async (name) => writeFile(`G:/QYB/tmp/${name}`, Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
/** 弹窗是原生浮层，不进页面元素树，所以拿 showToast／showModal 的调用记录当证据。
 *  小程序实例在两次运行之间是活的，`wx` 上的包装会叠（见 spyInstall 的 __qhybSpy 标记），
 *  所以记录先去重再断言 —— 一次调用记几条不影响结论。 */
const spyCalls = () => run(`var s=getApp().__spy||[], u=[]; s.forEach(function(x){ if(u.indexOf(x)<0) u.push(x) }); return JSON.stringify(u)`)
const spyInstall = () => run(`var g=getApp(); g.__spy=g.__spy||[];
  if(!wx.showToast.__qhybSpy){ ["showToast","showModal"].forEach(function(k){
    var real=wx[k]; var w=function(o){ g.__spy.push(k+":"+JSON.stringify(o)); return real&&real.call(wx,o) }; w.__qhybSpy=1; wx[k]=w }) }
  return "spy"`)

try {
  // ---- 静态层：编译产物 ----
  const wxml = await mp('pages/index/index.wxml')
  const wxss = await mp('app.wxss')
  const contact = await mp('lib/contact.js')
  const pillJs = await mp('components/HomePill.js')
  const navJs = await mp('lib/nav.js')
  const bar = wxml.indexOf('class="top-bar')
  // 搜索框的 class 是动态绑定（:class 的 is-on），编译出来是 class="{{['search-box', …]}}"，所以只认标识符。
  const box = wxml.indexOf('search-box')
  check(`顶栏排在搜索框前面（${bar} < ${box}）`, bar > 0 && box > 0 && bar < box)
  const pill = wxml.slice(bar, wxml.indexOf('back-where', bar))
  check('顶栏里先是返回首页胶囊（箭头 + 文案），再是当前栏目', pill.includes('back-home') && pill.includes('back-chevron') && pill.indexOf('back-home') < pill.indexOf('back-chevron'))
  check('胶囊样式进了 wxss（高 64rpx、圆角 999rpx、有过渡）', /\.back-home\{[^}]*min-height:64rpx/.test(wxss) && /\.back-home\{[^}]*border-radius:999rpx/.test(wxss) && /\.back-home\{[^}]*transition:/.test(wxss))
  check('箭头是两条边框转 45° 画的', /\.back-chevron\{[^}]*transform:rotate\(45deg\)/.test(wxss))
  check('长名字的字号档进了 wxss（最小档 25rpx、放宽到三行）', /\.result-name\.fit-3\{font-size:25rpx;-webkit-line-clamp:3\}/.test(wxss))
  check('复制成功与失败两条路都在（失败不再静默）', contact.includes('showModal') && contact.includes('showToast') && contact.includes('setClipboardData'))
  // 单页栈的出路：分享卡/扫码进来的页面，页面栈里只有这一页，微信原生返回箭头会**退出小程序**。
  // 平台上又没有「让原生导航栏画一个返回首页」的 API（3.17.3 的 wx 上只有 hideHomeButton），
  // 所以只能在页面里自己画一颗胶囊。产物里三件事都要在：
  //   lib/nav.js 先看栈 —— 还有上一页才 navigateBack，只有这一页才 switchTab 走首页 tab
  //   HomePill.js 把点击接到 goHome，并且只有 soloStack() 为真才渲染
  //   返回的是 index（查询 tab），不是 me（我的 tab）
  check('产物里有 lib/nav.js（先看栈再决定退还是回首页）', navJs.includes('switchTab') && navJs.includes('navigateBack') && navJs.includes('getCurrentPages'))
  check('返回落在首页 tab，不是「我的」tab', navJs.includes('/pages/index/index') && !navJs.includes('/pages/me/me'))
  check('HomePill 的点击接到 goHome', pillJs.includes('goHome') && pillJs.indexOf('goHome') > 0)
  check('HomePill 由 soloStack() 决定显不显示', pillJs.includes('soloStack'))
  // 有可能成为单页栈入口的页面都要注册这个组件，否则那颗胶囊根本不渲染。
  // 这四页都会把自己分享出去（detail/graph/spec/label），register 是扫码和「去登录」进来的，
  // 分享卡和扫码打开的页面栈里就只有它自己。首页不注册（它有自己内联的顶栏和「返回首页」
  // 状态复位），about 分享的是首页、guide 没有分享入口，所以这两页不需要。这一条前后呼应。
  for (const page of ['detail', 'graph', 'spec', 'label', 'register']) {
    const json = await mp(`pages/${page}/${page}.json`)
    check(`${page} 页注册了 home-pill`, json.includes('home-pill'))
  }
  check('首页没有注册 home-pill（它用自己内联的顶栏）', !(await mp('pages/index/index.json')).includes('home-pill'))

  // ---- 模拟器层 ----
  await opened
  await run('var l=require("lib/i18n.js"); l.setLocale("zh"); return l.locale.value')

  await rpc('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/pages/index/index' }] })
  await sleep(1600)
  pageId = (await rpc('App.getCurrentPage')).pageId
  const link = await once('.site-link')
  check('首页没有返回首页顶栏', (await elements('.top-bar')).length === 0)
  const linkText = (await textOf(link[0].elementId)).trim()
  check(`页脚的反馈入口自带微信号（${linkText}）`, linkText.includes('lynkcolove'))
  await rpc('App.callWxMethod', { method: 'pageScrollTo', args: [{ scrollTop: 99999, duration: 0 }] })
  await sleep(600)
  await screenshot('miniapp-back-home.png')

  // 这台机器的真实剪贴板状态记一笔（不是断言）：没同意隐私协议时 setClipboardData 会
  // 直接失败，报的就是 errno 104 —— 原来只有 success 分支，所以那一整条路是静默的。
  const realClip = await run(`if(wx.setClipboardData.__qhybStub) return "上一轮留了桩，没验";
    return new Promise(function(res){ wx.setClipboardData({ data: "qhyb-probe", success: function(){ res("真实剪贴板可用") }, fail: function(e){ res("真实剪贴板失败：" + (e&&e.errno) + " " + (e&&e.errMsg)) } }) })`)
  console.log(`（${realClip}）`)

  // 剪贴板可用时：只提示「已复制」，不弹号。
  // 这里把 wx.setClipboardData 打桩成成功／失败两种结果，而不是依赖这台机器的隐私状态 ——
  // 真实失败长什么样是另外单独验的（见下面那段探针：errno 104）。桩上打标记，免得
  // 上一轮留下的桩被当成真的（小程序实例在两次运行之间是活的）。
  await spyInstall()
  await run('wx.setClipboardData=function(o){ o&&o.success&&o.success({}) }; wx.setClipboardData.__qhybStub=1; getApp().__spy=[]; return 1')
  await tap('.site-link')
  const ok = await spyCalls()
  check(`剪贴板可用时提示已复制、不弹号（${ok}）`, ok.includes('showToast') && ok.includes('微信号已复制') && !ok.includes('showModal'))

  await run('wx.setClipboardData=function(o){ o&&o.fail&&o.fail({errMsg:"setClipboardData:fail privacy permission is not authorized",errno:104}) }; wx.setClipboardData.__qhybStub=1; getApp().__spy=[]; return 1')
  await tap('.site-link')
  const failed = await spyCalls()
  check(`剪贴板被拦住时把微信号直接弹出来（${failed}）`, failed.includes('showModal') && failed.includes('lynkcolove'))

  // 搜索页：顶栏在，返回首页在最上面（结构上排在搜索框前面），箭头和文案都在。
  await rpc('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/pages/index/index?q=' + encodeURIComponent('阿莫西林') }] })
  await sleep(1600)
  pageId = (await rpc('App.getCurrentPage')).pageId
  // 等「有结果」的信号是 .result-summary（index.vue 自己的节点），不是 .result-card：
  // 卡片属于 ResultCard 组件，自动化桥在有些实例上看不进组件里（2026-09-25 实测：页面
  // 截图上两张卡清清楚楚，getElements('.result-card') 和产品自己的 selectAll 都回 0），
  // 拿它当等待条件会把「等不到」误报成「没结果」。卡片本身靠截图看。
  await once('.result-summary')
  const summary = (await textOf((await once('.result-summary'))[0].elementId)).trim()
  check(`搜索页出结果了（${summary}）`, summary.length > 0)
  check('搜索页出现顶栏', (await elements('.top-bar')).length === 1)
  const pillEl = await once('.back-home')
  check(`返回首页胶囊和箭头都在，写着「${(await textOf(pillEl[0].elementId)).trim()}」`, pillEl.length === 1 && (await elements('.back-chevron')).length === 1 && (await textOf(pillEl[0].elementId)).trim().length > 0)
  const where = await once('.back-where')
  check(`右边写着当前栏目「${(await textOf(where[0].elementId)).trim()}」`, (await textOf(where[0].elementId)).trim().length > 0)
  check('旧的返回条已经不在页面里', (await elements('.back-row')).length === 0)
  await screenshot('miniapp-top-bar.png')

  await tap('.back-home')
  const home = {
    hero: (await once('.hero-copy')).length === 1,
    bar: (await elements('.top-bar')).length,
    // 首页不该再有结果摘要（它只在结果那一支里），比数卡片可靠，理由同上。
    summary: (await elements('.result-summary')).length,
    input: (await elements('.search-input')).length,
  }
  check(`点返回首页后回到首页（hero ${home.hero}、顶栏 ${home.bar} 个、结果区 ${home.summary} 个）`, home.hero && home.bar === 0 && home.summary === 0)
  check('首页的搜索框还在', home.input === 1)
  // 自动化桥读不到 input 的 value（names 只回 innerText，对 input 是空的），所以「旧词有没有
  // 清掉」这一条验不了；回页顶再拍一张，人工看图确认搜索框。
  await rpc('App.callWxMethod', { method: 'pageScrollTo', args: [{ scrollTop: 0, duration: 0 }] })
  await sleep(600)
  await screenshot('miniapp-back-home-top.png')

  // ---- 单页栈：分享卡／扫码进来的形状，胶囊必须自己长出来 ----
  // 桥看不见自定义组件内部（Page.getElements('.back-home') 在组件里回 0，2026-09-25 在
  // .result-card 上先踩过一次），所以量盒子要问组件实例自己：createSelectorQuery().in(实例)。
  // 比数元素个数可靠，而且量到的就是用户眼睛看到的那个矩形。
  const measurePill = async () => JSON.parse(await run(`var ps = getCurrentPages(); var last = ps[ps.length-1]; var v = last && last.$vm;
    var hp = (v && v.$children || []).filter(function(c){ return c.$options && (c.$options.__name || c.$options.name) === "HomePill" })[0];
    if (!hp) return Promise.resolve(JSON.stringify({ page: last.route, depth: ps.length, component: false, box: null }));
    return new Promise(function(res){
      wx.createSelectorQuery().in(hp).select(".back-home").boundingClientRect(function(r){
        res(JSON.stringify({ page: last.route, depth: ps.length, component: true,
          box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null }))
      }).exec()
    })`))

  // 真实存在的项目 id（目录里 22600 条，见 check_spec.mjs 的同一条）。
  await rpc('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/pages/detail/detail?id=' + encodeURIComponent('reform:012301030010000') }] })
  await sleep(2500)
  const soloDetail = await measurePill()
  check(`单页栈的项目详情上有返回首页胶囊（${soloDetail.depth} 页、${JSON.stringify(soloDetail.box)}）`,
    soloDetail.depth === 1 && soloDetail.component && soloDetail.box && soloDetail.box.w > 0 && soloDetail.box.h > 0)
  await screenshot('miniapp-solo-detail.png')

  // 再点它一下：桥点不到组件里的节点，所以这里直接跑 @click 绑的那个函数（lib/nav.js 的 goHome），
  // 验的仍然是「按下去之后栈变成什么样」——单页栈上必须落到首页 tab，而不是退出小程序。
  await run('var nav = require("lib/nav.js"); nav.goHome(); return 1')
  await sleep(2000)
  check('单页栈上按返回首页落到首页 tab', (await run('return JSON.stringify(getCurrentPages().map(function(p){return p.route}))')) === '["pages/index/index"]')

  // 有上一页时不该长胶囊：这条防的是「把胶囊变成常驻顶栏」，那会把搜索结果页的顶栏挤花。
  await rpc('App.callWxMethod', { method: 'switchTab', args: [{ url: '/pages/index/index' }] })
  await sleep(1500)
  await rpc('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/pages/spec/spec?code=HHL6U303' }] })
  await sleep(3000)
  const deepSpec = await measurePill()
  check(`有上一页时胶囊不出现（${deepSpec.page} 在 ${deepSpec.depth} 页栈上、${JSON.stringify(deepSpec.box)}）`,
    deepSpec.depth === 2 && deepSpec.component && deepSpec.box === null)

  console.log(`${checks}/${checks} passed`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  ws.close()
  for (const entry of pending.values()) clearTimeout(entry.timer)
}
