// 缺包重试只重拉缺的那个包。
//
// store 在任何一个包缺失时会把整份目录丢掉（warnings 非空 → catalogCache = null），
// 这样「重试」才有意义。但重新 loadCatalog 不该把已经拿到的 search.json.gz（733KB）
// 和别的包再拉一遍、再解包一遍：目录文件在一个版本内是不变的，拉到就留着。
//
// 这里把 hc-links 挡掉模拟「手机上有一个包没回来」，点首页的「重试」，然后看第二次
// 拉目录的请求里还有没有已经成功过的那些包。
import { freePort, startStatic, launchEdge, sleep } from './h5env.mjs'

// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
const PORT = await freePort()
const CDP_PORT = await freePort()
const ORIGIN = `http://127.0.0.1:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
/** 卡在哪一步要能看出来：CDP 那头不回应时 await 是永远不落的，光看空输出分不清。 */
const stage = (name) => console.log(`[stage] ${name}`)

/** 目录文件在 /data/release.json 给出的 base 下，认路径尾巴就够。 */
const PACKS = ['search.json', 'search.json.gz', 'meta.json', 'usage.json', 'drugs.json', 'edges.json', 'hc-items.json', 'hc-links.json']

function packOf(url) {
  const hit = PACKS.find((name) => url.includes(`/${name}`))
  return hit || ''
}

/** i18n-search.ts: audit.partialCatalog / audit.retry —— 抄的是显示文案，改词要跟着改。 */
const PARTIAL = '部分目录或关联数据未加载完成'
const RETRY = '重新加载'

let edge
async function main() {
  stage('起静态服务')
  const stat = startStatic()
  await stat.listen(PORT)
  stage('起 Edge + CDP')
  const launched = await launchEdge(CDP_PORT)
  const cdp = launched.cdp
  edge = launched

  // Network 事件自己收：Cdp 只转发异常和控制台错误，请求列表得挂在同一个 ws 上。
  const seen = []
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Network.requestWillBeSent') {
      const pack = packOf(msg.params.request.url)
      if (pack) seen.push(pack)
    }
  })
  await cdp.send('Network.enable')

  const waitFor = async (expr, timeout = 30000, step = 500) => {
    const until = Date.now() + timeout
    for (;;) {
      try {
        if (await cdp.eval(expr)) return true
      } catch {
        /* 页面正在跳转，下一轮再问 */
      }
      if (Date.now() >= until) return false
      await sleep(step)
    }
  }

  const count = (name) => seen.filter((n) => n === name).length

  // 1. 挡掉 hc-links：首页要能出「部分目录未加载完成」和重试按钮，而不是白屏。
  stage('挡掉 hc-links')
  await cdp.send('Network.setBlockedURLs', { urls: ['*hc-links.json*'] })
  stage('打开首页')
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?t=packretry-1` })
  const partial = await waitFor(`/部分目录或关联数据未加载完成/.test(document.body.innerText)`)
  check('缺包时首页给「部分目录或关联数据未加载完成」', partial, (await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,90)`)))
  const first = { search: count('search.json.gz') + count('search.json'), usage: count('usage.json'), hc: count('hc-items.json.gz') + count('hc-items.json') }
  check('第一次目录请求把检索包拉下来了', first.search >= 1, JSON.stringify(first))

  // 2. 放开 hc-links，点「重试」：这一次只该补 hc-links。
  stage('放开 hc-links 并点重试')
  await cdp.send('Network.setBlockedURLs', { urls: [] })
  const clicked = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.home-notice .yb-btn')].find((b) => /${RETRY}/.test(b.innerText))
    btn?.click(); return !!btn
  })()`)
  check('首页有重新加载按钮', clicked)
  const recovered = await waitFor(`!/${PARTIAL}/.test(document.body.innerText)`)
  check('重试后目录补齐（提示消失）', recovered, (await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,90)`)))

  // 3. 关键契约：重试没有把已经成功的包再拉一遍。
  const again = { search: count('search.json.gz') + count('search.json'), usage: count('usage.json'), hc: count('hc-items.json.gz') + count('hc-items.json') }
  check('重试不重拉检索包', again.search === first.search, `第一次 ${first.search} 次 / 重试后 ${again.search} 次`)
  check('重试不重拉使用说明', again.usage === first.usage, `第一次 ${first.usage} 次 / 重试后 ${again.usage} 次`)
  check('重试不重拉耗材包', again.hc === first.hc, `第一次 ${first.hc} 次 / 重试后 ${again.hc} 次`)
  check('重试补上了缺的 hc-links', count('hc-links.json.gz') + count('hc-links.json') >= 2, `${count('hc-links.json.gz') + count('hc-links.json')} 次`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (cdp.errors.length) console.log('未捕获异常:', cdp.errors)
  return failed.length ? 1 : 0
}

try {
  // CDP 不回应时 await 永远不落，整个检查会挂在那里、输出文件里什么都没有。
  // 兜底：到点直接判失败退出，别让它装死。
  const watchdog = setTimeout(() => {
    console.error(`FAIL  检查超时未结束（${results.length} 步已有结论）`)
    process.exit(1)
  }, 240000)
  watchdog.unref()
  process.exitCode = await main()
} catch (err) {
  console.error('FAIL  检查本身出错 —', err?.message || err)
  process.exitCode = 1
} finally {
  await edge?.close?.()
}

// 静态服务和浏览器连接会把事件循环撑着，只设 exitCode 进程不退出。
// 后台跑的时候管道一直不结束，输出就一直不落盘 —— 看起来像卡死，其实是跑完了没退。
process.exit(process.exitCode ?? 0)
