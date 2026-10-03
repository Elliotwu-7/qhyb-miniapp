// 项目（非药品）详情的两条改动：
//   1. 分片走 .gz（线上 d/xx.json 是 237KB，gz 只有 51KB），不能回退成整包 details.json
//   2. 条目信息在目录里就是现成的，分片没到就应该先画出来，而不是整页白等
// 第 2 条用 CDP 把分片请求挂住来验：只要挂住时页面已经画出名称，就说明没在等网络。
//
// 运行：node scripts/check_detail.mjs
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp\\dist\\build\\h5'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 8970
const CDP_PORT = 9420
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
// 等一个条件成立，超时返回 false —— 上线等目录就别写死秒数（原因见下面 waitFor 调用处）
async function waitFor(fn, run, timeoutMs, everyMs = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await run(fn)) return Date.now() - t0
    await sleep(everyMs)
  }
  return -1
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const profile = mkdtempSync(join(tmpdir(), 'qyb-detail-h5-'))
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
  const shardCalls = []
  const wholePackCalls = []
  const paused = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0])
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url
      if (/\/d\/[^/]*\.json(\.gz)?(\?|$)/.test(u)) shardCalls.push(u)
      if (/details\.json(\?|$)/.test(u)) wholePackCalls.push(u)
    }
    if (m.method === 'Fetch.requestPaused') paused.push(m.params)
  })
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

  // 查询现在要先登录，而 H5 里没有微信，登录那条链在浏览器里走不通（详见 check_h5.mjs）。
  // 所以从产品自己的「转发链接」进来：这条入口不经过登录门，验的仍是真实目录和真实结果列表。
  const shared = encodeURIComponent('海马磁共振成像')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/pages/index/index?q=${shared}` })

  // 别写死等 16 秒。整条链是串行的：release.json 先落地，七包目录才敢发请求
  // （src/lib/data.ts 的 catalogBase() 把所有包 URL 都挂在这一个 promise 后面），
  // 然后最大的 search.json.gz（733KB）落地那一刻才画列表。2026-09-25 从这台机实测：
  // release.json 8.3s、search.json.gz 18.7s、列表 27.5s。写死 16 秒就是必挂。
  const waited = await waitFor(`Boolean(document.querySelector('.result-card'))`, run, 90000)
  check('目录载入后列表出现', waited >= 0, waited >= 0 ? `等了 ${(waited / 1000).toFixed(1)}s` : '90s 超时')
  if (waited < 0) { edge.kill(); server.close(); console.log('\n0/1 passed'); process.exit(1) }

  // 挂住详情分片，再点进去（分片目录跟着目录版本走，不写死 /data/）
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/d/*', requestStage: 'Request' }] })
  const opened = await run(`(() => {
    const card = document.querySelector('.result-card')
    if (!card) return ''
    const main = card.querySelector('.result-main')
    if (main) main.click()
    return (card.innerText || '').split('\\n')[0].slice(0, 40)
  })()`)
  check('列表里点得到项目', Boolean(opened), opened)
  await sleep(5000)

  const held = paused.filter((p) => /\/d\/.*\.gz(\?|$)/.test(p.request.url))
  check('分片请求被挂住（说明确实在拉 .gz）', held.length === 1, paused.map((p) => p.request.url.replace(/^https?:\/\/[^/]+/, '')).join(', ').slice(0, 120))

  const early = await run(`(() => {
    const t = document.body.innerText.replace(/\\s+/g, ' ')
    const name = (document.querySelector('.drawer-head .name') || {}).innerText || ''
    return {
      name: name.replace(/\\s+/g, ' ').trim().slice(0, 40),
      price: (document.querySelector('.current-price') || {}).innerText || '',
      loadingHistory: /正在载入历史/.test(t),
      loadingGuide: /正在载入项目内涵/.test(t),
      wholePageLoading: /正在载入详情/.test(t),
    }
  })()`)
  console.log('挂住分片时的页面:', JSON.stringify(early, null, 2))

  check('分片没到就画出了项目名称', Boolean(early.name), early.name)
  check('分片没到就画出了价格', Boolean(early.price), String(early.price).replace(/\s+/g, ' ').slice(0, 60))
  check('不再整页停在「正在载入详情」', !early.wholePageLoading)
  check('详情区各自显示载入中', early.loadingHistory || early.loadingGuide, `history=${early.loadingHistory} guide=${early.loadingGuide}`)

  held.forEach((p) => { send('Fetch.continueRequest', { requestId: p.requestId }) })
  await send('Fetch.disable')
  await sleep(9000)

  const after = await run(`(() => {
    const t = document.body.innerText.replace(/\\s+/g, ' ')
    return {
      stillLoading: /正在载入历史|正在载入项目内涵/.test(t),
      hasHistory: /调价历史/.test(t),
      detailFailed: /未能载入/.test(t),
      text: t.slice(0, 200),
    }
  })()`)
  console.log('放行后的页面:', JSON.stringify(after, null, 2))

  check('放行后详情渲染完成', !after.stillLoading && !after.detailFailed, after.text)
  check('调价历史区块在', after.hasHistory)
  check('没有回退去拉整包 details.json', wholePackCalls.length === 0, `${wholePackCalls.length} 次`)
  check('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160))

  edge.kill(); server.close()
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1) })
