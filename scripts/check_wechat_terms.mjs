import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
const pack = await (await fetch('https://qhyb.lynkco.site/api/search/terms')).json()
assert.ok(pack.ok)
const samples = ['en', 'bo'].map((language) => pack.entries.find((row) => row.source === '法莫替丁' && row.language === language))
assert.ok(samples.every(Boolean), 'Real cached bilingual names should be indexed')
const ws = new WebSocket('ws://127.0.0.1:9431')
const pending = new Map()
let nextId = 0
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id); clearTimeout(entry.timer)
  message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = String(++nextId)
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 20000)
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  await rpc('App.callFunction', { functionDeclaration: 'function(){require("lib/i18n.js").setLocale("zh")}', args: [] })
  for (const sample of samples) {
    await rpc('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/pages/index/index?q=' + encodeURIComponent(sample.term) }] })
    await sleep(1000)
    const { pageId } = await rpc('App.getCurrentPage')
    let found = false
    for (let tries = 0; tries < 35; tries++) {
      // The card lives inside a custom component; Page selectors cannot cross its boundary.
      const rows = (await rpc('Page.getElements', { pageId, selector: '.result-summary' })).elements
      for (const row of rows) {
        const result = await rpc('Element.getDOMProperties', { pageId, elementId: row.elementId, names: ['innerText'] })
        const text = result.properties?.innerText ?? result.properties?.[0] ?? result.innerText ?? ''
        if (text.includes('诊疗 0') && text.includes('药品 1')) found = true
      }
      if (found) break
      await sleep(400)
    }
    assert.ok(found, `${sample.language} search should find the original catalog drug`)
    const index = await rpc('App.callFunction', { functionDeclaration: `function(){var s=require("lib/search-terms.js");return {status:s.searchTermsState.value,match:s.translatedNameMatch(${JSON.stringify(sample.source)},s.normalizeSearchText(${JSON.stringify(sample.term)}))}}`, args: [] })
    assert.equal(index.result.status, 'ready')
    assert.equal(index.result.match, 'exact')
    await sleep(500)
    await writeFile(new URL(`../devtools-search-${sample.language}.png`, import.meta.url), Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
    console.log(`PASS WeChat simulator: ${sample.language} name from live index finds the correct drug`)
  }
  await sleep(500)
  await writeFile(new URL('../devtools-search-tibetan.png', import.meta.url), Buffer.from((await rpc('App.captureScreenshot')).data, 'base64'))
} finally {
  ws.close(); for (const entry of pending.values()) clearTimeout(entry.timer)
}
