// 转发链接的**接收端**：别人点开分享出来的小程序卡片，会带着 q / id / drug 参数
// 直接进到某一页。H5 里微信那套转发菜单根本不出现，所以这里验不了「分享出去」，
// 但能验「分享进来」——而这一半才是用户真会遇到的：链接参数没接住、或者要登录
// 才肯显示，分享出去就是一条死链。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp\\dist\\build\\h5'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 8960
const CDP_PORT = 9410
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html') } catch { f = join(ROOT, 'index.html') }
    const b = await readFile(f)
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' })
    res.end(b)
  } catch (e) { res.writeHead(404).end(String(e)) }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const profile = mkdtempSync(join(tmpdir(), 'qyb-share-h5-'))
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' })

  let wsUrl
  for (let i = 0; i < 90 && !wsUrl; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!wsUrl) await sleep(250)
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  let id = 0
  const pending = new Map()
  const errors = []
  const labelCalls = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0])
    if (m.method === 'Network.requestWillBeSent' && /\/labels\/[^/?]+\.json(\.gz)?(\?|$)/.test(m.params.request.url)) labelCalls.push(m.params.request.url)
  })
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed')
    return r.result.value
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

  /**
   * 冷启动打开一个 hash 路由。URL 里那个 t= 不是给应用的（hash 路由会忽略它），
   * 只是让浏览器认为这是一次真正的导航 —— 否则只改 hash 属于同文档跳转，页面不重载。
   */
  let nav = 0
  const goto = async (hash, wait = 9000) => {
    nav += 1
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${nav}#${hash.replace(/^#/, '')}` })
    await sleep(wait)
  }

  /**
   * 等一个条件成立。这台机器到线上一次请求要 5~15 秒（跨洋），固定 sleep 全看运气，
   * 上一轮还过、下一轮就红的检查没人会信。
   */
  const waitFor = async (expr, timeout = 25000, step = 500) => {
    const until = Date.now() + timeout
    for (;;) {
      try { if (await run(expr)) return true } catch { /* 页面正在重载，下一轮再问 */ }
      if (Date.now() >= until) return false
      await sleep(step)
    }
  }

  // ① 搜索词分享：/pages/index/index?q=鼻炎片
  await goto(`/pages/index/index?q=${encodeURIComponent('鼻炎片')}`, 8000)
  await waitFor(`document.querySelectorAll('.result-card').length > 0`, 30000)
  const search = await run(`(() => {
    const box = document.querySelector('.search-input input')
    const cards = [...document.querySelectorAll('.result-card')]
    return {
      input: box ? box.value : '',
      cards: cards.length,
      first: cards[0] ? cards[0].innerText.replace(/\\s+/g, ' ').slice(0, 40) : '',
      home: document.body.innerText.includes('青海公开价格目录'),
    }
  })()`)
  console.log('搜索词落地:', JSON.stringify(search, null, 2))
  check('带 ?q= 进来搜索框已填好', search.input === '鼻炎片', search.input)
  check('带 ?q= 进来直接出结果', search.cards > 0, `${search.cards} 张卡 · ${search.first}`)
  check('不再停在首页引导页', !search.home)

  // ② 条目分享：先从结果里点进去，拿到应用自己生成的链接，再原样冷启动一次。
  // Page.navigate 到「只差 hash」的地址是同文档跳转，页面不会重载 —— 那测出来的还是
  // 刚才点进去的那一页。真正的分享链接是冷启动，所以每次都要换个 URL 上的 t= 打散缓存。
  await waitFor(`document.querySelector('.result-card .result-main')`, 20000)
  await run(`(() => {
    const main = document.querySelector('.result-card .result-main')
    if (main) main.click()
  })()`)
  await waitFor(`/^#\\/pages\\/detail\\/detail/.test(location.hash)`, 20000)
  const link = await run(`location.hash`)
  check('详情页链接是 drug= 形式', /^#\/pages\/detail\/detail\?drug=/.test(link), link)

  await goto(link, 6000)
  await waitFor(`document.querySelector('.drawer-head .name')`, 30000)
  const detail = await run(`(() => {
    const t = document.body.innerText.replace(/\\s+/g, ' ')
    return {
      notFound: t.includes('未找到该项目'),
      name: (document.querySelector('.drawer-head .name')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      entry: !!document.querySelector('.label-entry'),
      sheet: !!document.querySelector('.label-sheet'),
    }
  })()`)
  console.log('重开分享链接:', JSON.stringify(detail, null, 2))
  check('重开链接能落到药品详情', !detail.notFound && Boolean(detail.name), detail.name)
  check('详情页只有说明书入口', detail.entry && !detail.sheet)
  check('详情页没顺手拉说明书分片', labelCalls.length === 0, `${labelCalls.length} 次`)

  // ③ 说明书的链接：点入口进去，再用同一个 hash 重开
  await waitFor(`document.querySelector('.label-entry')`, 15000)
  await run(`(() => { const e = document.querySelector('.label-entry'); if (e) e.click() })()`)
  await waitFor(`/^#\\/pages\\/label\\/label/.test(location.hash)`, 20000)
  const labelHash = await run(`location.hash`)
  check('说明书链接是 label 页', /^#\/pages\/label\/label\?drug=/.test(labelHash), labelHash)

  await goto(labelHash, 6000)
  // 说明书页要等 labels 分片，慢的时候十来秒（本机到线上要跨洋），别按 9s 默认值等。
  await waitFor(`document.querySelector('.label-sheet') || document.querySelector('.product-sources')`, 40000)
  const label = await run(`(() => {
    // 两种正文：产品归档（.product-sources）和整理好的说明书（.label-sheet）。
    // 有归档的药品走前者，只认 sheet 会把「页面其实渲染好了」判成失败。
    const sheet = document.querySelector('.label-sheet') || document.querySelector('.product-sources')
    return {
      sheet: !!sheet,
      name: (document.querySelector('.label-hero-name')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      text: (sheet ? sheet.innerText : '').replace(/\\s+/g, ' ').slice(0, 80),
    }
  })()`)
  console.log('重开说明书链接:', JSON.stringify(label, null, 2))
  check('重开链接能落到说明书页', label.sheet, `${label.name} · ${label.text}`)

  // ④ 链接指向已经下架/改名的条目时不能是白屏。
  await goto(`#/pages/detail/detail?id=${encodeURIComponent('000000000000000000')}`, 8000)
  await waitFor(`!/(正在载入|载入中)/.test(document.body.innerText) && document.body.innerText.length > 10`, 30000)
  const stale = await run(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 60)`)
  console.log('失效链接:', JSON.stringify(stale))
  check('失效链接有提示不是白屏', /未找到该项目/.test(stale), stale)

  // ⑤ 图页分享链接：带 id 进来要直接以它为圆心
  await goto(`#/pages/graph/graph?id=${encodeURIComponent('zhongcheng-1101')}`, 8000)
  await waitFor(`(document.querySelector('.graph-selection-name')?.innerText || '').trim()`, 40000)
  const graph = await run(`(() => {
    const values = [...document.querySelectorAll('.graph-stat-value')].map((el) => Number(el.innerText || 0))
    return {
      canvas: !!document.querySelector('canvas'),
      center: (document.querySelector('.graph-selection-name')?.innerText || '').trim(),
      related: values[2] || 0,
    }
  })()`)
  console.log('图页分享链接:', JSON.stringify(graph))
  check('图页链接以分享的条目为中心', graph.center === '鼻炎片' && graph.related > 0, `${graph.center} · ${graph.related} 个关联`)

  // ⑥ 图页链接指向已经不在目录里的 id：退回度数最高的中心，不能是空画布
  await goto(`#/pages/graph/graph?id=${encodeURIComponent('已经下架的条目')}`, 8000)
  await waitFor(`(document.querySelector('.graph-selection-name')?.innerText || '').trim()`, 40000)
  const fallback = await run(`(() => {
    return {
      canvas: !!document.querySelector('canvas'),
      empty: !!document.querySelector('.graph-canvas-hint'),
      center: (document.querySelector('.graph-selection-name')?.innerText || '').trim(),
    }
  })()`)
  console.log('图页失效链接:', JSON.stringify(fallback))
  check('图页失效链接退回默认中心', fallback.canvas && !fallback.empty && Boolean(fallback.center), fallback.center)

  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160))

  edge.kill(); server.close()
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
