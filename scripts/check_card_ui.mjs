// 结果卡片和赞/踩/反馈条的界面契约。
//
// 用户报过四条：卡片只有标题能点、胶囊上方有一根横线、胶囊贴着卡片底边、胶囊和卡片背景
// 分不出来也没有任何动画。这四条都是纯样式/事件绑定，H5 和 mp-weixin 两份产物都会犯，
// 但只有小程序里才看得见 —— 所以这里量几何、量和事件的绑定，不靠人眼看截图。
//
// 尺寸换算：视口 375px 宽，750rpx = 375px，即 1rpx = 0.5px。正文的左右留白是 28rpx = 14px，
// 胶囊的底边留白是 26rpx = 13px。
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserTest, sleep } from '../../QYB/yibao-query/scripts/browser_harness.mjs'
import { installLoginStub, SESSION } from './h5env.mjs'

let checks = 0
const check = (label, ok = true) => { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }
const VERSION = 'v20260923000000-123456789abc'
const LOCAL = 'G:/QYB/yibao-query/public/data'
// 站内常见药，本地副本里一定有；用中文查，免得依赖词库接口。
const QUERY = '阿莫西林'

await browserTest({ root: 'G:/qhyb-miniapp/dist/build/h5', width: 375, height: 900 }, async (b) => {
  const json = (requestId, data) => b.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
    body: Buffer.from(JSON.stringify(data)).toString('base64'),
  })
  const cors = [
    { name: 'content-type', value: 'application/json' },
    { name: 'access-control-allow-origin', value: '*' },
    { name: 'access-control-allow-headers', value: '*' },
    { name: 'access-control-allow-methods', value: 'GET,POST,OPTIONS' },
    { name: 'access-control-max-age', value: '600' },
  ]
  let votes = 0
  let sent = 0
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const path = new URL(request.url).pathname
    try {
      if (request.method === 'OPTIONS') { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }); return }
      // 点赞要走真接口才算数：本地失败了组件会把计数回滚，就验不到「点上有反应」。
      // 服务端路由是 /api/vote 和 /api/feedback（没有 /mp 前缀，见 server/app.py）。
      if (path === '/api/vote') { votes++; await b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: cors, body: Buffer.from(JSON.stringify({ ok: true, up: 7, down: 0, mine: 'up' })).toString('base64') }); return }
      if (path === '/api/feedback') { sent++; await b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: cors, body: Buffer.from(JSON.stringify({ ok: true, id: 'fixture-feedback' })).toString('base64') }); return }
      if (path.startsWith('/api/')) { await json(requestId, SESSION); return }
      if (path === '/data/release.json') { await json(requestId, { id: VERSION, base: `/catalog/${VERSION}` }); return }
      // 版本清单是发布产物，仓库副本里没有（同 check_audit_ui.mjs）。
      const body = await readFile(join(LOCAL, path.replace(/^\/catalog\/[^/]+/, '/data').slice('/data/'.length)))
      await b.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: path.endsWith('.gz') ? 'application/octet-stream' : 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
        body: body.toString('base64'),
      })
    } catch { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {}) }
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://qhyb.lynkco.site/*', requestStage: 'Request' }] })
  await installLoginStub({ send: b.send })

  let visit = 0
  const search = () => b.send('Page.navigate', { url: `${b.origin}/?card=${++visit}#/pages/index/index?q=${encodeURIComponent(QUERY)}` })
  const ready = `!!document.querySelector('.result-card .react-bar')`
  await search()
  await b.waitFor(ready)

  // 几何：三颗胶囊都得从卡片边缘缩进来，别压在左右下三条边上。
  const box = await b.eval(`(() => {
    const card = document.querySelector('.result-card')
    const bar = document.querySelector('.result-card .react-bar')
    const pills = [...bar.querySelectorAll('.react-btn')].map((n) => n.getBoundingClientRect())
    const c = card.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    return {
      pills: pills.length,
      left: Math.round(Math.min(...pills.map((p) => p.left - c.left)) * 10) / 10,
      right: Math.round(Math.min(...pills.map((p) => c.right - p.right)) * 10) / 10,
      bottom: Math.round(Math.min(...pills.map((p) => c.bottom - p.bottom)) * 10) / 10,
      pillH: Math.round(pills[0].height),
      lineTop: getComputedStyle(bar).borderTopWidth,
      pillBg: getComputedStyle(bar.querySelector('.react-btn')).backgroundColor,
      cardBg: getComputedStyle(card).backgroundColor,
      pillBorder: getComputedStyle(bar.querySelector('.react-btn')).borderTopWidth,
      transition: getComputedStyle(bar.querySelector('.react-btn')).transitionDuration,
      overflow: Math.round(document.documentElement.scrollWidth - innerWidth),
    }
  })()`)
  check(`卡片里三颗胶囊都在（${box.pills} 颗）`, box.pills === 3)
  check(`胶囊左缩进 ${box.left}px ≥ 12px（28rpx）`, box.left >= 12)
  check(`胶囊右缩进 ${box.right}px ≥ 12px（28rpx）`, box.right >= 12)
  check(`胶囊离卡片底边 ${box.bottom}px ≥ 11px（26rpx）`, box.bottom >= 11)
  check(`胶囊有 62rpx 的可点高度（${box.pillH}px）`, box.pillH >= 30)
  check('胶囊上方没有横线', box.lineTop === '0px')
  check(`胶囊底色 ${box.pillBg} 与卡片底色 ${box.cardBg} 不同`, box.pillBg !== box.cardBg && box.pillBg !== 'rgba(0, 0, 0, 0)')
  check(`胶囊有描边 ${box.pillBorder}`, box.pillBorder !== '0px')
  check(`胶囊有过渡时长 ${box.transition}`, box.transition !== '0s')
  check(`375px 下卡片区不横向溢出（${box.overflow}px）`, box.overflow <= 1)

  // 整卡可点：先点一个明确没有自己事件的空白处（标题右侧的留白），再直接点卡片根节点。
  // 后者是关键 —— 事件绑在根上才算「点卡片就能进」，只绑在正文块上时这一下不会有反应。
  const spot = await b.eval(`(() => {
    const card = document.querySelector('.result-card')
    const r = card.getBoundingClientRect()
    const main = card.querySelector('.result-main').getBoundingClientRect()
    return { x: Math.round(r.right - 5), y: Math.round(main.top + main.height / 2), hit: (document.elementFromPoint(r.right - 5, main.top + main.height / 2) || {}).className }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  }
  await b.waitFor(`location.hash.includes('/pages/detail/detail')`)
  check(`点卡片右侧留白（命中 ${spot.hit}）能进详情`, true)

  await search()
  await b.waitFor(ready)
  await b.eval(`document.querySelector('.result-card').click()`)
  await b.waitFor(`location.hash.includes('/pages/detail/detail')`)
  check('点卡片根节点能进详情', true)

  await search()
  await b.waitFor(ready)
  await b.eval(`[...document.querySelectorAll('.result-card .react-btn')][0].click()`)
  await b.waitFor(`!!document.querySelector('.result-card .react-btn.is-on .react-count')`)
  // 底色和图标都带 180~340ms 的过渡/动画，刚打完这一下量到的是过渡起点那一帧的旧值。
  await sleep(400)
  const voted = await b.eval(`(() => {
    const on = document.querySelector('.result-card .react-btn.is-on')
    return { hash: location.hash, count: on.querySelector('.react-count').innerText, name: getComputedStyle(on.querySelector('.react-icon')).animationName, bg: getComputedStyle(on).backgroundColor }
  })()`)
  check(`点赞落到了接口（${votes} 次请求）`, votes === 1)
  check(`点赞后计数为 ${voted.count}`, voted.count === '7')
  check(`选中态换了底色（${voted.bg}）`, voted.bg !== box.pillBg)
  check(`选中时图标播动画（${voted.name}）`, voted.name !== 'none')
  check('点胶囊没有连带进详情', !voted.hash.includes('/pages/detail/detail'))

  await b.eval(`[...document.querySelectorAll('.result-card .react-btn')][2].click()`)
  await b.waitFor(`!!document.querySelector('.result-card .react-box')`)
  await sleep(400)
  const panel = await b.eval(`(() => {
    const box = document.querySelector('.result-card .react-box')
    const card = document.querySelector('.result-card')
    const r = box.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    return { left: Math.round((r.left - c.left) * 10) / 10, bottom: Math.round((c.bottom - r.bottom) * 10) / 10, name: getComputedStyle(box).animationName }
  })()`)
  check(`反馈面板左缩进 ${panel.left}px，不贴边`, panel.left >= 12)
  check(`反馈面板离卡片底边 ${panel.bottom}px，不贴边`, panel.bottom >= 11)
  check(`反馈面板展开有动画（${panel.name}）`, panel.name !== 'none')

  // 反馈要真的提交得出去：写下两句、点提交，面板收起、接口收到。
  await b.eval(`(() => {
    const field = document.querySelector('.result-card .react-text textarea') || document.querySelector('.result-card .react-text')
    field.value = '价格和目录对不上，请人工核一下'
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await b.waitFor(`!document.querySelector('.result-card .react-send').className.includes('is-off')`)
  check('写够两个字后提交按钮可用', true)
  await b.eval(`document.querySelector('.result-card .react-send').click()`)
  await b.waitFor(`!document.querySelector('.result-card .react-box')`, 15000)
  check(`提交后接口收到反馈（${sent} 次请求）`, sent === 1)
  check('提交成功后收起面板', true)

  // 截图趁还在搜索结果页（第一张卡是刚点过赞的状态），等下跳去详情页就取不到卡片了。
  const card = await b.eval(`(() => {
    const c = document.querySelector('.result-card')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  const shot = await b.send('Page.captureScreenshot', { clip: { ...card, scale: 2 } })
  await writeFile(new URL('../card-reactions.png', import.meta.url), Buffer.from(shot.data, 'base64'))

  // 整卡可点带来的风险：同一张卡里两个 @click（卡片开自己、hop 开对方），万一 hop 的
  // stop 没生效，两次跳转会互相盖掉，落到错的项目上。卡托普利是 check_h5 里已知挂得上 hop 的查询。
  await b.send('Page.navigate', { url: `${b.origin}/?hop=${++visit}#/pages/index/index?q=${encodeURIComponent('卡托普利')}` })
  await b.waitFor(`!!document.querySelector('.result-card .hop-list .jump')`)
  const hop = await b.eval(`(() => {
    const card = [...document.querySelectorAll('.result-card')].find((c) => c.querySelector('.hop-list .jump'))
    const own = card.querySelector('.result-name').innerText.replace(/\\s+/g, ' ').trim()
    const jump = card.querySelector('.hop-list .jump')
    return { own, text: jump.innerText.replace(/\\s+/g, ' ').trim() }
  })()`)
  await b.eval(`(() => {
    const card = [...document.querySelectorAll('.result-card')].find((c) => c.querySelector('.hop-list .jump'))
    card.querySelector('.hop-list .jump').click()
  })()`)
  await b.waitFor(`(document.querySelector('.drawer-head .name') || {}).innerText`)
  const landed = await b.eval(`document.querySelector('.drawer-head .name').innerText.replace(/\\s+/g, ' ').trim()`)
  // 用全等而不是 includes：hop 的目标名往往就是卡片自己名字加个后缀（「卡托普利」→「卡托普利试验」），
  // 子串比较会把「点卡片自己」也判成通过。
  check(`点卡片「${hop.own}」里的 hop「${hop.text}」，进的是 hop 自己（落到了「${landed}」）`, landed === hop.text && landed !== hop.own)

  check('无未捕获页面异常', b.errors.length === 0)
  await sleep(200)
})
console.log(`${checks}/${checks} passed`)
