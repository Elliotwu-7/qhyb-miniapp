// Does the mini program's graph page even mount? Canvas 2d differs between H5 and
// WeChat, so this only asserts the page shell renders — not the drawing.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp\\dist\\build\\h5'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 8930
const CDP_PORT = 9380
/** 「以“利多卡因”为中心」用的是弯引号，别再按直角引号写正则。 */
const CENTER_RE = /以[「“]([^」”]+)[」”]为中心 · (\d+) 个直接关联/
const CENTER_SRC = CENTER_RE.source
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

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const profile = mkdtempSync(join(tmpdir(), 'qyb-graph-h5-'))
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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0])
  })
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed')
    return r.result.value
  }
  await send('Page.enable'); await send('Runtime.enable')

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/pages/graph/graph` })
  await sleep(32000)
  const state = await run(`(() => {
    const t = document.body.innerText.replace(/\\s+/g, ' ')
    // 星形布局把统计拆成三个格子，innerText 是「9 药品节点 8 项目节点 10 可见关系」
    const m = t.match(/(\\d+)\\s*药品节点\\s*(\\d+)\\s*项目节点\\s*(\\d+)\\s*可见关系/)
    const head = t.match(${JSON.stringify(CENTER_SRC)})
    return {
      title: t.includes('关联网络'),
      note: t.includes('非正式对应'),
      canvas: !!document.querySelector('canvas'),
      stats: m ? { drugs: Number(m[1]), services: Number(m[2]), links: Number(m[3]) } : null,
      center: head ? head[1] : '',
      related: head ? Number(head[2]) : 0,
      // 星形布局的工具栏（旧的「标签」开关已经删了，改成主副标签一起画）
      toolbar: t.includes('点节点换中心') && t.includes('适配') && t.includes('重置'),
      hasSearch: !!document.querySelector('.graph-search-input'),
      text: t.slice(0, 200),
    }
  })()`)
  console.log('页面状态:', JSON.stringify(state, null, 2))

  // 再以一条耗材为中心跑一遍：导丝（hc:ABAG01）挂着 9 条「产品名与目录分类名相同」
  // 的推断关系，链到 9 张注册证。耗材节点是三角形，统计格和图例都得跟着出来。
  // 地址栏前头挂个变化的 ?t=：只换 hash 不会重载文档，SPA 会留着上一个中心。
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=2#/pages/graph/graph?id=${encodeURIComponent('hc:ABAG01')}` })
  await sleep(30000)
  const hcState = await run(`(() => {
    const t = document.body.innerText.replace(/\\s+/g, ' ')
    const head = t.match(${JSON.stringify(CENTER_SRC)})
    const nodes = t.match(/(\\d+)\\s*耗材节点/)
    return {
      center: head ? head[1] : '',
      related: head ? Number(head[2]) : 0,
      hc: nodes ? Number(nodes[1]) : 0,
      legend: !!document.querySelector('.graph-legend-triangle'),
      tag: document.querySelector('.graph-tag.hc')?.innerText.trim() || '',
      icon: document.querySelector('.graph-related-icon.hc')?.innerText.trim() || '',
      canvas: !!document.querySelector('canvas'),
      text: t.slice(0, 260),
    }
  })()`)
  console.log('耗材中心:', JSON.stringify(hcState, null, 2))
  console.log('异常:', errors.slice(0, 3))

  const hcOk =
    hcState.center.includes('导丝') &&
    hcState.related >= 8 &&
    hcState.hc >= 2 &&
    hcState.legend &&
    hcState.tag === '医保耗材目录' &&
    hcState.icon === '耗' &&
    hcState.canvas
  console.log(
    hcOk
      ? `PASS 耗材也能当中心：${hcState.center} · ${hcState.related} 条关联 · ${hcState.hc} 个耗材节点，图例与类型标签都在`
      : 'FAIL 耗材中心的关联网络没渲染出来',
  )

  const ok =
    state.title &&
    state.note &&
    state.canvas &&
    state.toolbar &&
    state.hasSearch &&
    !!state.stats &&
    state.stats.drugs + state.stats.services >= 2 &&
    state.stats.links >= 1 &&
    hcOk &&
    errors.length === 0
  console.log(
    ok
      ? `PASS 图页面能挂载并建星形图（中心「${state.center}」，${JSON.stringify(state.stats)}）；画布绘制仍需在微信里验证`
      : 'FAIL 图页面没渲染出来',
  )
  edge.kill(); server.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
