// End-to-end leaflet body translations against the live service, source toggle and narrow-screen layout.
import { freePort, installLoginStub, interceptApi, sessionHandler } from './h5env.mjs'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp\\dist\\build\\h5'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
// 端口问系统要，别摇骰子：随机撞上本机常驻程序就 EADDRINUSE 崩在启动，看着像产品坏了。
const PORT = await freePort()
const CDP_PORT = await freePort()
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' }

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''))
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html') } catch { file = join(ROOT, 'index.html') }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
  } catch (err) { res.writeHead(404).end(String(err)) }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function debuggerUrl() {
  let i = 0
  while (i < 80) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* browser is still starting */ }
    await sleep(250)
    i += 1
  }
  throw new Error('devtools never came up')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const pair = this.pending.get(message.id)
        this.pending.delete(message.id)
        message.error ? pair.reject(new Error(JSON.stringify(message.error))) : pair.resolve(message.result)
      }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params?.exceptionDetails?.exception?.description || 'exception')
    })
  }
  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }, 30000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval failed')
    return result.result.value
  }
}

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let edge
async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  const profile = mkdtempSync(join(tmpdir(), 'qhyb-content-'))
  edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' })
  const ws = new WebSocket(await debuggerUrl())
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 查询现在要求先登录，而 H5 里 uni.login 拿不到微信 code。不装这个桩，说明书的
  // 翻译接口就一直不回来，检查会卡在等 .label-v 上 —— 和「产品坏了」长得一模一样。
  // 桩只替换「拿到 code」这一步，登录、取译文都还是产品自己的代码在跑。
  await installLoginStub(cdp)
  await interceptApi(cdp, sessionHandler())
  const waitFor = async (expression, timeout = 120000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await cdp.eval(expression)) return
      await sleep(600)
    }
    throw new Error(`timeout waiting for ${expression}`)
  }
  const navigate = async (path) => {
    await cdp.eval(`location.hash = ${JSON.stringify('#/' + path)}`)
    await sleep(800)
  }
  const setLanguage = async (name) => {
    await navigate('pages/me/me')
    await waitFor(`document.querySelectorAll('.language-opt').length === 3`)
    await cdp.eval(`[...document.querySelectorAll('.language-opt')].find(x=>x.innerText.trim()===${JSON.stringify(name)}).click()`)
  }
  // 说明书页改版了：药品有归档产品时先出「选择一份产品原文」，选中才出正文
  // （见 ProductSources.vue）。原来的 .label-v 只在没有归档产品的药品上出现，
  // 而现网没有这种药品了 —— 断言要跟着现在的流程走，不能还盯着老选择器。
  const snapshot = () => cdp.eval(`({
    name: document.querySelector('.label-hero-name')?.innerText || '',
    source: document.querySelector('.source-product .source-text')?.innerText || '',
    rows: [...document.querySelectorAll('.source-field')].map(x=>x.querySelector('.source-text')?.innerText.trim() || ''),
    titles: [...document.querySelectorAll('.source-field-title')].map(x=>x.innerText.trim()),
    overflow: [...document.querySelectorAll('.source-text')].some(x=>x.scrollWidth>x.clientWidth+2),
    failed: document.body.innerText.includes('Some translations are unavailable'),
  })`)
  const chooseProduct = async () => {
    await waitFor(`document.querySelectorAll('.uni-picker-item').length > 1`, 30000)
    await cdp.eval(`document.querySelectorAll('.uni-picker-item')[1].click()`)
    await sleep(400)
    await cdp.eval(`document.querySelector('.uni-picker-action-confirm')?.click()`)
  }
  // 页面上有两条速度差一个数量级的链：说明书正文走分片（小、快），药品名走
  // catalogReady() 整包目录 —— 而整包要等 search.json.gz（733KB）落地才 resolve，
  // 2026-09-25 本机实测 ~20s（见 check_detail.mjs 的时间线）。只等正文的话，快照会
  // 赶在目录前拍到兜底标题「Drug leaflet / 药品说明书」，看起来像「药名没译出来」。
  // .label-hero-tag 只在 item 到手后才渲染（label.vue:119），拿它当目录就绪的信号。
  const awaitLeaflet = async () => {
    await waitFor(`document.querySelector('.label-hero-tag')`, 90000)
    await waitFor(`(() => { const n = (document.querySelector('.label-hero-name')||{}).innerText || ''; return n.trim() !== '' && n.trim() !== '…' })()`, 60000)
    await waitFor(`document.querySelectorAll('.source-field').length >= 3`, 60000)
    await waitFor(`[...document.querySelectorAll('.source-field .source-text')].every(x=>x.innerText.trim() !== '…' && x.innerText.trim())`, 60000)
  }
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/pages/me/me` })
  await waitFor(`document.querySelectorAll('.language-opt').length === 3`)
  await setLanguage('English')
  console.log('Checking English leaflet against live translation service…')
  await navigate('pages/label/label?drug=xiyao-13')
  await chooseProduct()
  await awaitLeaflet()
  const english = await snapshot()
  // 产品标识那一行（厂家 / 批准文号 · 规格）是归档原文的引用，刻意不翻 —— 把
  // 「国药准字H10950129」译掉反而跟药盒对不上。这里只要求药品名译出、标识原样保留。
  check('英文药品名译出、产品标识原样保留', /Famotidine/i.test(english.name) && english.source.includes('国药准字'), `${english.name} | ${english.source.slice(0, 60)}`)
  check('英文说明书每段正文均译出', english.rows.length >= 3 && english.rows.every(x => x && !/[\u3400-\u9fff]/.test(x) && !/unavailable/i.test(x)), `${english.rows.length} 段: ${JSON.stringify(english.rows.map(x=>x.slice(0,60)))}`)
  check('英文长正文在窄屏内换行', !english.overflow)
  const toggleCount = await cdp.eval(`document.querySelectorAll('.content-action').length`)
  check('说明书页有原文/译文切换按钮', toggleCount >= 1, `按钮数 ${toggleCount}`)
  await cdp.eval(`document.querySelector('.content-action')?.click()`)
  await sleep(600)
  const original = await snapshot()
  check('可查看完整中文原文', original.name.includes('法莫替丁') && original.rows.some(x=>/[\u3400-\u9fff]/.test(x)), JSON.stringify(original.rows.map(x=>x.slice(0,40))))
  await cdp.eval(`document.querySelector('.content-action')?.click()`)
  await sleep(600)
  check('返回译文使用缓存', JSON.stringify((await snapshot()).rows) === JSON.stringify(english.rows))
  await setLanguage('བོད་ཡིག')
  console.log('Checking Tibetan leaflet against live translation service…')
  await navigate('pages/label/label?drug=xiyao-13')
  await chooseProduct()
  await awaitLeaflet()
  await waitFor(`[...document.fonts].some(f => f.family.includes('QhybTibetan') && f.status === 'loaded')`, 15000)
  const tibetan = await snapshot()
  check('藏文字体加载成功', await cdp.eval(`[...document.fonts].some(f => f.family.includes('QhybTibetan') && f.status === 'loaded')`))
  // “汉语拼音”那一段本来就是 Latin（值里没有汉字，ct() 原样放过），
  // 不能要求它也变成藏文；但凡是原文带汉字的段，必须逐段出藏文。
  const hanRows = original.rows.filter(x=>/[\u3400-\u9fff]/.test(x)).length
  const boRows = tibetan.rows.filter(x=>/[\u0f00-\u0fff]/.test(x)).length
  check('藏文说明书正文逐段译出', tibetan.rows.length === english.rows.length && tibetan.rows.every(x => x && !/[\u3400-\u9fff]/.test(x) && !x.includes('གནས་སྐབས་མི་འདུག')) && boRows === hanRows, `${hanRows} 段中文正文 → ${boRows} 段藏文`)
  check('切换语言没有混入上一语言译文', /[\u0f00-\u0fff]/.test(tibetan.name) && !tibetan.name.includes('Famotidine'))
  const numbers = rows => rows.join('\n').match(/\d+(?:[.,]\d+)*/g)?.sort() || []
  check('说明书剂量数字保持一致', JSON.stringify(numbers(tibetan.rows)) === JSON.stringify(numbers(original.rows)))
  check('藏文长正文在窄屏内换行', !tibetan.overflow)
  check('正文翻译过程无运行时异常', cdp.errors.length === 0, cdp.errors.slice(0, 1).join(' | '))
}

main().catch((err) => { console.error('ERROR', err.message); checks.push(false) }).finally(() => {
  try { edge?.kill() } catch { /* ignore */ }
  server.close()
  const passed = checks.filter(Boolean).length
  console.log(`\n${passed}/${checks.length} passed`)
  process.exit(passed === checks.length ? 0 : 1)
})
