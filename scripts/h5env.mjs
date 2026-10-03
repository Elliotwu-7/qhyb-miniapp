// Shared browser harness for the H5 checks.
//
// Serves the H5 build, drives headless Edge over CDP, and lets a check intercept
// /api requests. Everything not intercepted still goes to production, so the
// checks keep exercising the real catalog through the real UI.
//
// Why a session has to be seeded: 查询现在要求先登录，而登录走 uni.login 拿微信
// code —— H5 里没有微信，这条链在浏览器里永远走不通。测试台只替换「拿到 code」
// 这一步（和微信会给的一样是一个 code 字符串），其余登录、扣次、失败处理都是
// 产品自己的代码在跑。微信登录本身只能在真机/开发者工具里验收。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'

export const H5_ROOT = process.env.H5_ROOT || 'G:\\qhyb-miniapp\\dist\\build\\h5'
export const EDGE = process.env.H5_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 让系统给一个空闲端口。
 *
 * 别在脚本里摇骰子选端口（`8990 + Math.random() * 80` 那种）：本机常驻程序会占着其中
 * 某个号，撞上就 EADDRINUSE 崩在启动那一步，0 秒失败、没有输出，和「端口没起」长得
 * 一模一样。2026-09-25 就撞到 9012 上的 ArmourySocketServer，白查了一轮。
 *
 * 用法：`const PORT = await freePort()`（ESM 顶层 await 可以用）。借一个再还回去，从
 * 探测到真正 listen 之间有一瞬间的空档，但比随机撞号稳得多。
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 已注册的会话。字段和 mpLogin/mpMe 的真实返回同形。 */
export const SESSION = {
  ok: true,
  token: 'harness-token',
  openid: 'harness-openid',
  registered: true,
  nickname: '测试台',
  avatar: '',
  hospitalLevel: 'L3',
  lastCheckinDate: '',
  checkedInToday: false,
  checkinStreak: 0,
  checkinTotal: 0,
  ads: { enabled: false, rewarded: { unitId: null, reserved: false } },
  quota: { dailyLimit: 50, dailyUsed: 0, dailyLeft: 50, extra: 0, remaining: 50, adBonus: 0 },
}

export function startStatic(root = H5_ROOT) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      let file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''))
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      } catch {
        file = join(root, 'index.html')
      }
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch (err) {
      res.writeHead(404).end(String(err))
    }
  })
  return {
    server,
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => server.close(),
  }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push((msg.params?.exceptionDetails?.exception?.description || 'exception').split('\n')[0])
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value ?? a.description).join(' ').split('\n')[0])
      }
    })
  }

  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, 40000)
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed')
    return res.result.value
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
  }
}

export async function targetUrl(cdpPort) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('devtools never came up')
}

/** 起一个无头 Edge，返回 {cdp, kill}。 */
export async function launchEdge(cdpPort, extraArgs = []) {
  const profile = mkdtempSync(join(tmpdir(), 'qhyb-h5-'))
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=430,900',
    ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' })
  const ws = new WebSocket(await targetUrl(cdpPort))
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  return { cdp, kill: () => { try { proc.kill() } catch { /* already gone */ } } }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
}

/**
 * 拦截 /api 请求交给 handler 决定：
 *   {json} 直接回一段 JSON；{proxy} 转给另一个后端；都不给就放行到线上。
 * 跨域预检也在这里回，否则履行了的响应会因为缺少 CORS 头被浏览器丢掉。
 */
export async function interceptApi(cdp, handler) {
  const paused = []
  const listeners = []
  const errors = []
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Fetch.requestPaused') {
      const p = msg.params
      // 这里出的错如果冒出去，请求会一直挂住，页面看起来像「功能坏了」。
      // 记下来并放行，让检查去报「谁没生效」。
      void handle().catch((err) => {
        errors.push(`${p.request.method} ${p.request.url.replace(/^https?:\/\/[^/]+/, '')}: ${err.message}`)
        cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined)
      })
      async function handle() {
        let out = null
        try {
          out = await handler(p)
        } catch (err) {
          out = { json: { ok: false, error: String(err) } }
        }
        const url = p.request.url
        if (p.request.method === 'OPTIONS') {
          await cdp.send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 204, responseHeaders: Object.entries(CORS).map(([name, value]) => ({ name, value })),
          })
          listeners.forEach((fn) => fn({ url, method: p.request.method, synthetic: true }))
          return
        }
        if (!out) {
          await cdp.send('Fetch.continueRequest', { requestId: p.requestId })
          return
        }
        paused.push(p)
        let code = 200
        let body = ''
        let type = 'application/json; charset=utf-8'
        if (out.json !== undefined) {
          body = JSON.stringify(out.json)
        } else {
          const res = await fetch(out.proxy)
          code = res.status
          body = await res.text()
          type = res.headers.get('content-type') || type
        }
        await cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: code,
          responseHeaders: [...Object.entries(CORS), ['content-type', type]].map(([name, value]) => ({ name, value })),
          body: Buffer.from(body, 'utf8').toString('base64'),
        })
        listeners.forEach((fn) => fn({ url, method: p.request.method, synthetic: true }))
      }
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  return { paused, listeners, errors }
}

/** 把 /api/mp/* 换成本地会话，其余放行。 */
export function sessionHandler(session = SESSION) {
  return (p) => {
    const path = new URL(p.request.url).pathname
    if (!path.startsWith('/api/mp/')) return null
    if (path.endsWith('/logout') || path.endsWith('/cancel')) return { json: { ok: true } }
    return { json: session }
  }
}

const LOGIN_STUB = (code) => `(() => {
  // uni-app 在启动时先 window.uni = {} 再往上挂方法，所以在这里守一个 setter：
  // 不管 login 是后来赋的还是被 Object.assign 挂上的，读到的都是这个桩。
  const stub = (opts) => {
    const o = opts || {}
    setTimeout(() => { if (o.success) o.success({ code: ${JSON.stringify(code)} }) }, 0)
  }
  let real
  Object.defineProperty(window, 'uni', {
    configurable: true,
    get() { return real },
    set(value) {
      if (value && typeof value === 'object') {
        Object.defineProperty(value, 'login', { configurable: true, get: () => stub, set() {} })
      }
      real = value
    },
  })
})()`

/**
 * 让 uni.login 不发微信也能拿到 code。
 * 要在 goto 之前装：App.vue 一起来就会登录，等页面加载完再补已经晚了。
 */
export async function installLoginStub(cdp, code = 'harness-code') {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LOGIN_STUB(code) })
}
