// Exercise the compiled page in the WeChat developer-tools simulator.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const ws = new WebSocket('ws://127.0.0.1:9431')
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
let pageId
const elements = async (selector) => (await rpc('Page.getElements', { pageId, selector })).elements
const textOf = async (elementId) => {
  const result = await rpc('Element.getDOMProperties', { pageId, elementId, names: ['innerText'] })
  return result.properties?.innerText ?? result.properties?.[0] ?? result.innerText ?? ''
}
const tap = (elementId) => rpc('Element.tap', { pageId, elementId })
const tapText = async (selector, text) => {
  for (const element of await elements(selector)) {
    if ((await textOf(element.elementId)).trim() !== text) continue
    await tap(element.elementId)
    await sleep(400)
    return
  }
  throw new Error(`Missing ${selector}: ${text}`)
}
try {
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  await rpc('App.callFunction', { functionDeclaration: 'function(){require("lib/i18n.js").setLocale("zh")}', args: [] })
  await rpc('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/pages/index/index?q=' + encodeURIComponent('肝素') }] })
  await sleep(1500)
  pageId = (await rpc('App.getCurrentPage')).pageId
  let summary = ''
  for (let tries = 0; tries < 30; tries += 1) {
    const found = await elements('.result-summary')
    if (found.length) summary = await textOf(found[0].elementId)
    if (summary.includes('药品 6')) break
    await sleep(500)
  }
  assert.ok(summary.includes('诊疗 3') && summary.includes('药品 6'), summary)
  assert.equal((await elements('.search-submit')).length, 1)
  console.log('PASS 微信模拟器显示混合目录和分类计数')
  await tapText('.scope-tab', '药品')
  await tap((await elements('.filter-trigger'))[0].elementId)
  await sleep(500)
  assert.equal((await elements('.filter-sheet')).length, 1)
  assert.equal((await elements('.category-filters .filter-option')).length, 9)
  console.log('PASS 微信原生页面弹出八类药品筛选面板')
  await tapText('.drug-filters .filter-option', '限制支付（限）')
  await writeFile(new URL('../devtools-search-filters.png', import.meta.url), Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
  await tapText('.filter-apply', '确定')
  assert.equal((await elements('.filter-sheet')).length, 0)
  summary = await textOf((await elements('.filter-summary'))[0].elementId)
  assert.ok(summary.includes('限制支付'), summary)
  console.log('PASS 微信模拟器确认筛选并关闭面板')
  await writeFile(new URL('../devtools-search-results.png', import.meta.url), Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  ws.close()
  for (const entry of pending.values()) clearTimeout(entry.timer)
}
