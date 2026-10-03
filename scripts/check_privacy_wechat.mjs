// Render the real compiled component in WeChat; do not grant real consent.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
let ws
let next = 0, pageId, navigated = false, saved = false
const pending = new Map(), checks = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
/**
 * 一发一收。
 *
 * 返回的 promise 上多挂一个空 catch：自动化桥偶尔会在一发已经超时（下面那 20 秒）之后
 * 才把回应送到，那时调用方早走了，reject 就成了未处理的 rejection —— Node 默认把它当
 * 异常抛出，进程直接崩。挂个空 catch 只是让那条 reject 有人接，正常的 await 那条链
 * 该抛还是抛。
 */
const rpc = (method, params = {}) => {
  const promise = new Promise((resolve, reject) => {
    const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout: ' + method)) }, 20000)
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
  promise.catch(() => {})
  return promise
}
/**
 * 连上自动化端口，连不上就重试。
 *
 * 刚 `cli.bat auto` 起来的实例端口要几秒才 listen。这段时间里连它，undici 会先发一个
 * error（我们 reject 掉、被 catch 住），随后再发一个 —— 那时 `{ once: true }` 的监听已经
 * 用掉了，第二个 error 就成了未处理的 'error' 事件，直接把进程打崩。崩溃输出是一坨
 * Symbol、看不出原因，和「产品坏了」长得一样。所以这里常挂一个空的 error 监听，
 * 并且自己重试到连上为止。 */
const connect = async (budgetMs = 90000) => {
  const until = Date.now() + budgetMs
  for (;;) {
    const socket = new WebSocket('ws://127.0.0.1:' + (process.env.QHYB_AUTOMATION_PORT || '9432'))
    socket.addEventListener('error', () => {})  // 后到的 error 不能变成未处理事件
    socket.addEventListener('message', ({ data }) => {
      // 桥偶尔会送一帧不是 JSON 的东西（二进制帧在 undici 里是 Blob，JSON.parse 直接抛）。
      // 这个回调里抛异常是未捕获异常，进程会崩，而崩出来只有一坨 Symbol —— 看不出原因。
      // 认不出的帧跳过就好，真正的回应会按 id 再来。
      if (typeof data !== 'string') return
      let message
      try { message = JSON.parse(data) } catch { return }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id); clearTimeout(entry.timer)
      message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result)
    })
    const ok = await new Promise((resolve) => {
      socket.addEventListener('open', () => resolve(true), { once: true })
      socket.addEventListener('error', () => resolve(false), { once: true })
      socket.addEventListener('close', () => resolve(false), { once: true })
    })
    if (ok) { ws = socket; return }
    try { socket.close() } catch { /* 没连上，关不掉就算了 */ }
    if (Date.now() >= until) throw Error('自动化端口连不上（先 cli.bat auto --auto-port 9432，见 README）')
    await delay(1500)
  }
}
const call = async functionDeclaration => (await rpc('App.callFunction', { functionDeclaration, args: [] })).result
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name) }
/** 连上之后逻辑层还没热身完，头一两次调用会被桥自己回 "timeout waiting for automator
 *  response"（不是我们那 20 秒的超时）。空转几圈等它能答上一句再开验。 */
const warmUp = async (budgetMs = 60000) => {
  const until = Date.now() + budgetMs
  for (;;) {
    try { await rpc('App.getCurrentPage'); return } catch { /* 还没热身好，再等一轮 */ }
    if (Date.now() >= until) return
    await delay(1500)
  }
}
try {
  await connect()
  await warmUp()
  check('simulator is running the new privacy module', await call('function(){return require("lib/privacy.js").PRIVACY_BUTTON_ID === "qhyb-privacy-agree"}'))
  await call('function(){var s=require("lib/session.js"),l=require("lib/i18n.js");getApp().__privacyTest={profile:s.profile.value,busy:s.sessionBusy.value,locale:l.locale.value};s.profile.value=null;s.sessionBusy.value=true;l.locale.value="zh"}')
  saved = true
  await rpc('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/pages/register/register' }] })
  navigated = true; await delay(650)
  pageId = (await rpc('App.getCurrentPage')).pageId
  await call('function(){require("lib/privacy.js").privacyVisible.value=true}')
  await delay(350)
  // This SDK's selector bridge does not expose the custom component. Inspect
  // its real WXML wiring and capture the native rendering for visual review.
  const wxml = await readFile(new URL('../dist/build/mp-weixin/components/PrivacyPrompt.wxml', import.meta.url), 'utf8')
  const button = wxml.match(/<button[^>]*class="privacy-agree[^>]*>/)?.[0] || ''
  check('compiled native consent button has the correct event and no ordinary tap handler', button.includes('open-type="agreePrivacyAuthorization"') && button.includes('bindagreeprivacyauthorization=') && !button.includes('bindtap='))
  await writeFile('G:/QYB/tmp/privacy-wechat-ui.png', Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
  await call('function(){require("lib/privacy.js").declinePrivacy()}'); await delay(200)
  check('compiled decline controller resets visibility', await call('function(){return !require("lib/privacy.js").privacyVisible.value}'))
  await writeFile('G:/QYB/tmp/privacy-wechat-result.json', JSON.stringify({ checks, screenshot: 'privacy-wechat-ui.png', nativeConsentFlowVerified: false, realAccountAuthorized: false, realRegistrationSubmitted: false, storageCleared: false }, null, 2))
} finally {
  if (navigated) await rpc('App.callWxMethod', { method: 'navigateBack', args: [{}] }).catch(() => {})
  if (saved) await call('function(){var p=getApp().__privacyTest,s=require("lib/session.js"),l=require("lib/i18n.js");require("lib/privacy.js").setPrivacyPromptActive(false);if(p){s.profile.value=p.profile;s.sessionBusy.value=p.busy;l.locale.value=p.locale;delete getApp().__privacyTest}}').catch(() => {})
  try { ws.close() } catch { /* 没连上就没有要关的 */ }
  pending.forEach(entry => clearTimeout(entry.timer))
}
