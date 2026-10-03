// Browser smoke test for the three-language switch shared by H5 and WeChat.
import { freePort } from './h5env.mjs'
import { createServer } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp\\dist\\build\\h5'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
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
  const profile = mkdtempSync(join(tmpdir(), 'qhyb-i18n-'))
  edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=430,950', 'about:blank'], { stdio: 'ignore' })
  const ws = new WebSocket(await debuggerUrl())
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#/pages/me/me` })
  await sleep(2500)

  const buttons = await cdp.eval(`([...document.querySelectorAll('.language-opt')].map((n) => n.innerText.trim()))`)
  check('语言切换器显示三种语言', buttons.join('|') === '中文|བོད་ཡིག|English', buttons.join(' | '))

  await cdp.eval(`(() => { const n=[...document.querySelectorAll('.language-opt')].find((x)=>x.innerText.trim()==='English'); n?.click(); return !!n })()`)
  await sleep(500)
  const englishMe = await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,1200)`)
  check('英文即时覆盖“我的”页', englishMe.includes('Language') && englishMe.includes('Price level') && englishMe.includes('About & notices'), englishMe.slice(0, 180))
  const englishNav = await cdp.eval(`({ route: location.hash, title: document.querySelector('.uni-page-head__title')?.innerText || '', doc: document.title })`)
  check('英文原生标题同步', englishNav.doc === 'Me', JSON.stringify(englishNav))
  check('英文根节点布局类生效', await cdp.eval(`Boolean(document.querySelector('.lang-en'))`))

  await cdp.eval(`location.hash='#/pages/index/index'`)
  await sleep(1800)
  const englishHome = await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,900)`)
  check('英文跨页面保持', englishHome.includes('Qinghai public price directory') && englishHome.includes('Search medical services, drugs and consumables'), englishHome.slice(0, 160))
  check('英文诊疗、药品、耗材、规范入口对等', await cdp.eval(`JSON.stringify([...document.querySelectorAll('.scope-tab')].map((n) => n.innerText.trim())) === JSON.stringify(['All', 'Medical service', 'Drug', 'Medical consumable', 'Specification'])`))

  await cdp.eval(`location.hash='#/pages/me/me'`)
  await sleep(700)
  await cdp.eval(`(() => { const n=[...document.querySelectorAll('.language-opt')].find((x)=>x.innerText.trim()==='བོད་ཡིག'); n?.click(); return !!n })()`)
  await sleep(500)
  const tibetanMe = await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,1200)`)
  check('藏文即时覆盖“我的”页', tibetanMe.includes('སྐད་ཡིག') && tibetanMe.includes('རིན་གོང་རིམ་པ'), tibetanMe.slice(0, 180))
  const tibetanNav = await cdp.eval(`({ route: location.hash, title: document.querySelector('.uni-page-head__title')?.innerText || '', doc: document.title })`)
  check('藏文原生标题同步', tibetanNav.doc === 'ངའི', JSON.stringify(tibetanNav))
  check('藏文根节点布局类生效', await cdp.eval(`Boolean(document.querySelector('.lang-bo'))`))

  await cdp.eval(`location.hash='#/pages/index/index'`)
  await sleep(1800)
  const tibetanHome = await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,900)`)
  check('藏文跨页面保持', tibetanHome.includes('མཚོ་སྔོན་སྤྱི་བསྒྲགས་རིན་གོང་དཀར་ཆག') && tibetanHome.includes('སྨན་བཅོས་རྣམ་གྲངས་དང་སྨན། མཁོ་ཆས་འཚོལ་བ'), tibetanHome.slice(0, 160))
  check('藏文类型入口完整翻译', await cdp.eval(`JSON.stringify([...document.querySelectorAll('.scope-tab')].map((n) => n.innerText.trim())) === JSON.stringify(['ཚང་མ', 'སྨན་བཅོས་རྣམ་གྲངས', 'སྨན', 'སྨན་བཅོས་མཁོ་ཆས', 'ལག་རྩལ་ཚད་གཞི'])`))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true })
  check('藏文入口在窄屏内完整排布', await cdp.eval(`(() => { const tabs = [...document.querySelectorAll('.scope-tab')]; return tabs.length === 5 && tabs.every((n) => n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= innerWidth) })()`))
  const checkSheet = async (language, applyText) => {
    await cdp.eval(`document.querySelectorAll('.scope-tab')[2].click()`)
    await sleep(300)
    await cdp.eval(`document.querySelector('.filter-trigger').click()`)
    await sleep(400)
    const sheet = await cdp.eval(`(() => {
      const panel = document.querySelector('.filter-sheet')
      const apply = document.querySelector('.filter-apply')
      const cells = [...document.querySelectorAll('.filter-option')]
      const r = apply.getBoundingClientRect()
      return { text: panel.innerText, fits: cells.every((n) => n.scrollWidth <= n.clientWidth + 1), button: apply.innerText.trim(), footerVisible: r.top >= 0 && r.bottom <= innerHeight }
    })()`)
    check(`${language} 筛选面板已翻译且长选项不横向溢出`, sheet.button === applyText && !/[\u4e00-\u9fff]/.test(sheet.text) && sheet.fits && sheet.footerVisible, JSON.stringify({ button: sheet.button, fits: sheet.fits, footerVisible: sheet.footerVisible }))
    await writeFile(new URL(`../search-filters-${language}.png`, import.meta.url), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await cdp.eval(`document.querySelector('.filter-close').click()`)
  }
  await checkSheet('bo', 'གཏན་འཁེལ')
  await cdp.eval(`location.hash='#/pages/me/me'`)
  await sleep(500)
  await cdp.eval(`document.querySelectorAll('.language-opt')[2].click()`)
  await cdp.eval(`location.hash='#/pages/index/index'`)
  await sleep(700)
  await checkSheet('en', 'Apply')
  check('切换过程无运行时异常', cdp.errors.length === 0, cdp.errors.slice(0, 1).join(' | '))
}

main().catch((err) => { console.error('ERROR', err.message); checks.push(false) }).finally(() => {
  try { edge?.kill() } catch { /* ignore */ }
  server.close()
  const passed = checks.filter(Boolean).length
  console.log(`\n${passed}/${checks.length} passed`)
  process.exit(passed === checks.length ? 0 : 1)
})
