import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserTest, sleep } from '../../QYB/yibao-query/scripts/browser_harness.mjs'
const pack = { ok: true, version: 'browser-fixture', managed: [], entries: [
  { source: '法莫替丁', language: 'en', term: 'Famotidine', reviewed: false },
  { source: '法莫替丁', language: 'bo', term: 'ཧྥ་མོ་ཐི་ཏིང་།', reviewed: false },
] }
let unavailable = false
let requests = 0
let checks = 0
const VERSION = 'v20260923000000-123456789abc'
const LOCAL = 'G:/QYB/yibao-query/public/data'
const check = (label, ok = true) => { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }
await browserTest({ root: 'G:/qhyb-miniapp/dist/build/h5', width: 375, height: 900 }, async (b) => {
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const path = new URL(request.url).pathname
    const json = (data, status = 200) => b.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(JSON.stringify(data)).toString('base64') })
    try {
      if (path === '/api/search/terms') { requests++; await json(unavailable ? { ok: false } : pack, unavailable ? 503 : 200); return }
      if (path.startsWith('/api/')) { await json({ ok: true }); return }
      if (path === '/data/release.json') { await json({ id: VERSION, base: `/catalog/${VERSION}` }); return }
      // 版本清单是发布产物，仓库里的 public/data 副本没有；现造一个合法版本号，再剥掉 /catalog/<版本>/ 前缀按尾巴找副本里的文件（同 check_audit_ui.mjs）。
      const body = await readFile(join(LOCAL, path.replace(/^\/catalog\/[^/]+/, '/data').slice('/data/'.length)))
      await b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: path.endsWith('.gz') ? 'application/octet-stream' : 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: body.toString('base64') })
    } catch { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {}) }
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://qhyb.lynkco.site/*', requestStage: 'Request' }] })
  let visit = 0
  const navigate = async (path) => b.send('Page.navigate', { url: `${b.origin}/?terms=${++visit}#${path}` })
  const search = (query) => navigate('/pages/index/index?q=' + encodeURIComponent(query))
  await search('Famotidine')
  await b.waitFor(`document.querySelector('.result-card')?.innerText.includes('法莫替丁')`)
  check('首页英文译名命中真实药品卡片')
  await search('ཧྥ མོ ཐི ཏིང')
  await b.waitFor(`document.querySelector('.result-card')?.innerText.includes('法莫替丁')`)
  check('首页藏文输入无需中文键盘即可命中')
  check('375px 搜索结果和词库提示不横向溢出', await b.eval(`document.documentElement.scrollWidth<=innerWidth+1`))
  await sleep(700)
  await writeFile(new URL('../search-terms-tibetan.png', import.meta.url), Buffer.from((await b.send('Page.captureScreenshot')).data, 'base64'))
  unavailable = true
  await search('Famotidine')
  await b.waitFor(`document.querySelector('.terms-notice')?.innerText.includes('加载失败')`)
  check('词库断网明确提示译名结果不完整')
  unavailable = false
  await b.eval(`document.querySelector('.terms-notice .yb-btn').click()`)
  await b.waitFor(`document.querySelector('.result-card')?.innerText.includes('法莫替丁')`)
  check('原地重试后自动更新当前搜索结果，不重复扣查询次数')
  await navigate('/pages/graph/graph')
  await b.waitFor(`!!document.querySelector('.graph-search-input input')`)
  await b.eval(`(() => { const e=document.querySelector('.graph-search-input input'); e.value='ཧྥ་མོ་ཐི་ཏིང་།'; e.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await b.waitFor(`document.querySelector('.graph-search-result')?.innerText.includes('法莫替丁')`)
  check('图谱搜索也支持藏文译名')
  check('无未捕获页面异常', b.errors.length === 0)
  assert.ok(requests >= 4)
})
console.log(`${checks}/${checks} passed`)
