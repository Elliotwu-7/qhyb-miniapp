import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserTest, sleep } from '../../QYB/yibao-query/scripts/browser_harness.mjs'
import { installLoginStub, SESSION } from './h5env.mjs'

const broken = new Set(['search'])
let count = 0
const check = (name, ok) => { assert.ok(ok, name); count += 1; console.log(`PASS ${name}`) }
await browserTest({ root: 'G:/qhyb-miniapp/dist/build/h5', width: 430, height: 950 }, async (b) => {
  // 目录数据用仓库里的 public/data 副本顶替线上。副本里没有 release.json（它是发布产物，
  // 不在仓库里），这里现造一个合法版本号；真实请求都挂在 /catalog/<版本>/ 下，
  // 副本没有那一层，剥掉前缀取尾巴。少了这两步，每个包都会 404，
  // 每个断言都会失败，看上去像产品坏了。
  const VERSION = 'v20260923000000-123456789abc'
  const LOCAL = 'G:/QYB/yibao-query/public/data'
  // 首页同时挂着好几条 .home-notice：登录提示（它的按钮是「免费登录」）、
  // 即将停用/即将执行提醒（没有按钮）、加载失败。要挑的是「带重试按钮、又不是登录那条」的第一个。
  const retryAt = (scope = '') => `([...document.querySelectorAll('${scope}.home-notice')].filter((n) => n.querySelector('.yb-btn') && !n.innerText.includes('免费登录'))[0] || {}).querySelector?.('.yb-btn')`
  const retryReady = (scope = '') => `!!(${retryAt(scope)})`
  const retryClick = (scope = '') => `${retryAt(scope)}.click()`
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const path = new URL(request.url).pathname
    const group = path.includes('/labels/') ? 'labels' : path.includes('/d/') || path.includes('/details.') ? 'details' : path.split('/').at(-1).split('.')[0]
    const json = [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }]
    const cors = [...json, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'GET,POST,OPTIONS' }, { name: 'access-control-max-age', value: '600' }]
    const fulfill = (body, headers) => b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(body).toString('base64') })
    try {
      // 未登录会被首页和详情页的登录闸挡住，这个检查跑的是正常登录用户的状态，
      // 所以给 /api 顶一个已登录的会话（同 h5env 的 sessionHandler），
      // 跨域预检也要自己答，否则请求会一直挂着。
      if (request.method === 'OPTIONS') { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }); return }
      if (path.startsWith('/api/')) { await fulfill(JSON.stringify(SESSION), json); return }
      if (broken.has(group)) { await b.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' }); return }
      if (path === '/data/release.json') { await fulfill(JSON.stringify({ id: VERSION, base: `/catalog/${VERSION}` }), json); return }
      const body = await readFile(join(LOCAL, path.replace(/^\/catalog\/[^/]+/, '/data').slice('/data/'.length)))
      await fulfill(body, path.endsWith('.gz') ? [{ name: 'content-type', value: 'application/octet-stream' }, { name: 'access-control-allow-origin', value: '*' }] : json)
    } catch { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {}) }
  })
  // 目录包在 /catalog/<版本>/ 下，版本清单在 /data/ 下，会话在 /api/ 下 —— 三条都要拦。
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://qhyb.lynkco.site/data/*', requestStage: 'Request' }, { urlPattern: 'https://qhyb.lynkco.site/catalog/*', requestStage: 'Request' }, { urlPattern: 'https://qhyb.lynkco.site/api/*', requestStage: 'Request' }] })
  await installLoginStub({ send: b.send })
  let visit = 0
  const navigate = async (path) => { await b.send('Page.navigate', { url: `${b.origin}/?audit=${++visit}#${path}` }); await sleep(200) }
  await navigate('/pages/index/index')
  await b.waitFor(`${retryReady()}`)
  check('首页断网有重新加载入口', true)
  broken.delete('search'); await b.eval(`${retryClick()}`)
  // 只要求统计行真的算出来了（目录可用），不钉具体数字：
  // 目录每更新一次，在用项目数就变，钉死了这条断言会跟着失败。
  await b.waitFor(`/[在用] [0-9]+ 项/.test(document.querySelector('.hero-meta')?.innerText || '')`)
  check('恢复网络后无需重启即可进入目录', true)

  broken.add('drugs')
  await navigate('/pages/index/index?q=' + encodeURIComponent('鼻炎片'))
  await b.waitFor(`[...document.querySelectorAll('.home-notice')].some((n) => n.innerText.includes('结果可能不完整'))`)
  check('药品包失败时明确提示结果不完整', true)
  broken.delete('drugs'); await b.eval(`${retryClick()}`)
  await b.waitFor(`document.querySelectorAll('.result-card.is-drug').length === 4`)
  check('重试补齐药品结果', true)

  broken.add('labels')
  await navigate('/pages/label/label?drug=xiyao-13')
  await b.waitFor(`!!document.querySelector('.label-hint .yb-btn')`)
  check('说明书下载失败不显示成没有说明书', !(await b.eval(`!!document.querySelector('.label-sheet')`)))
  broken.delete('labels'); await b.eval(`document.querySelector('.label-hint .yb-btn').click()`)
  await b.waitFor(`document.querySelector('.label-sheet')?.innerText.includes('适应症')`)
  check('说明书重试成功显示正文', true)

  broken.add('details')
  await navigate('/pages/detail/detail?id=' + encodeURIComponent('reform:013106000020000'))
  await b.waitFor(`${retryReady('.drawer-block ')}`)
  check('详情网络失败仍保留项目名称和价格', await b.eval(`document.querySelector('.drawer-head')?.innerText.includes('一氧化氮')`))
  broken.delete('details'); await b.eval(`${retryClick('.drawer-block ')}`)
  // 详情页不再直接嵌原文（GuideBlock 现在只在 pages/guide/guide 里），
  // 这里改成看“目录原文”入口恢复、并且点得进去看得到正文。
  await b.waitFor(`!document.querySelector('.drawer-block .home-notice') && !![...document.querySelectorAll('.label-entry-title')].find((n) => n.innerText.includes('目录原文'))`)
  await b.eval(`[...document.querySelectorAll('.label-entry')].find((n) => n.innerText.includes('目录原文')).click()`)
  await b.waitFor(`(document.querySelector('.guide-sheet')?.innerText || '').length > 20`)
  check('详情原文可以原地重试', true)

  await navigate('/pages/index/index?q=100%25')
  await b.waitFor(`!!document.querySelector('.search-submit') && !document.querySelector('.hero-copy')`)
  check('含百分号的分享查询不会白屏', true)
  check('全过程无未捕获异常', b.errors.length === 0)
})
console.log(`${count}/${count} passed`)
