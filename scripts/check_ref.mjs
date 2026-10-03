// 参考资料汇编页：入口、适用范围分区、检索、明细、深链。
//
// 这批数据（59,359 条、整包 18 MB）只在服务端建索引，不进小程序包，所以这里验的是
// 「页面拿服务端结果渲染」，不是本地索引。先把本地接口起起来：
//
//   cd yibao-query
//   .venv\Scripts\python.exe server\app.py        # QHYB_PORT=8787，QHYB_REF_DB 指到本地库
//   node scripts/check_ref.mjs                    # 在本仓库根目录，REF_API 默认 http://127.0.0.1:8787/api
//
// REF_API=... 可以换一个接口（比如线上 https://qhyb.lynkco.site/api），验的就是那一份。
import { freePort, startStatic, launchEdge, interceptApi, sleep } from './h5env.mjs'
import { writeFile } from 'node:fs/promises'

const PORT = await freePort()
const CDP_PORT = await freePort()
const REF_API = (process.env.REF_API || 'http://127.0.0.1:8787/api').replace(/\/$/, '')

/** 三个适用范围各自的总数，和服务端 meta 一致。 */
const COUNTS = { 全国: 19776, 上海市: 39259, 山东省: 324 }
const DEEP = 'ref:cn-drug-2025:西药:439'
const DEEP_NAME = '卡托普利'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const waitFor = async (cdp, expr, timeout = 60000, step = 500) => {
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

// 每次换页都带上不同的 query 强制真正重载文档：只改 hash 的话 SPA 会把上一页的状态留着。
let hop = 0
const gotoHash = async (cdp, hash) => {
  hop += 1
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${hop}#${hash}` })
}

/** 截图落在仓库根，用来人眼过一遍排布。 */
const shot = async (cdp, name) => {
  await writeFile(new URL(`../${name}`, import.meta.url), Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'))
}

const READ = `(() => {
  const page = document.querySelector('.ref-page')
  if (!page) return { page: false }
  const text = (sel) => (page.querySelector(sel)?.innerText || '').replace(/\\s+/g, ' ').trim()
  const chips = (sel) => [...page.querySelectorAll(sel + ' .ref-chip')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim())
  return {
    page: true,
    scopes: [...page.querySelectorAll('.ref-scope-tab')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()),
    activeScope: [...page.querySelectorAll('.ref-scope-tab')].filter((n) => n.className.includes('is-on')).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()),
    datasets: chips('.ref-dataset-chips'),
    parts: chips('.ref-part-chips'),
    hasDatasetRow: Boolean(page.querySelector('.ref-dataset-chips')),
    hasPartRow: Boolean(page.querySelector('.ref-part-chips')),
    count: text('.ref-count'),
    names: [...page.querySelectorAll('.ref-name')].map((n) => (n.innerText || '').trim()),
    badges: [...new Set([...page.querySelectorAll('.ref-badge')].map((n) => (n.innerText || '').trim()))],
    kinds: [...new Set([...page.querySelectorAll('.ref-kind')].map((n) => (n.innerText || '').trim()))],
    parts_shown: [...new Set([...page.querySelectorAll('.ref-part')].map((n) => (n.innerText || '').trim()))],
    empty: Boolean(page.querySelector('.ref-notice')),
    detailOpen: Boolean(page.querySelector('.ref-detail')),
    detail: (page.querySelector('.ref-detail')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    // 展开的明细在卡片里面，条目名在卡片头上，不在明细里
    openCardName: (() => {
      const box = page.querySelector('.ref-card .ref-detail')
      const card = box ? box.closest('.ref-card') : null
      return card ? (card.querySelector('.ref-name')?.innerText || '').trim() : ''
    })(),
    // 深链那一条不一定在当前这一页，会被插到列表最前面
    firstCardName: (page.querySelector('.ref-card .ref-name')?.innerText || '').trim(),
    about: (page.querySelector('.surface')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    overflow: page.scrollWidth > window.innerWidth + 1,
  }
})()`

const clickScope = (name) => `(() => {
  const hit = [...document.querySelectorAll('.ref-scope-tab')].find((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(name)}))
  if (!hit) return false
  hit.click()
  return true
})()`

const clickChip = (row, text) => `(() => {
  const box = document.querySelector(${JSON.stringify(row)})
  if (!box) return false
  const hit = [...box.querySelectorAll('.ref-chip')].find((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)}))
  if (!hit) return false
  hit.click()
  return true
})()`

// uni-app 的 <input> 在 H5 里渲染成 <uni-input class="ref-search-input"><input>，
// 类名落在外层，真正要写值的是里面那个。
const typeQuery = (value) => `(() => {
  const input = document.querySelector('.ref-search-input input')
  if (!input) return false
  input.value = ${JSON.stringify(value)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

// 藏文下只看界面词。范围名、首枚筛选条、计数这些是 t() 出的；条目名和资料集名
// 是服务端给的中文原文（照登不译），不能算回落。
const BO_READ = `(() => {
  const page = document.querySelector('.ref-page')
  if (!page) return { lang: false }
  const text = (sel) => (page.querySelector(sel)?.innerText || '').replace(/\\s+/g, ' ').trim()
  const chrome = [
    text('.ref-eyebrow'), text('.ref-title'), text('.ref-sub'), text('.ref-count'),
    text('.ref-scopes'), text('.ref-dataset-chips .ref-chip'), text('.ref-part-chips .ref-chip'),
    text('.ref-notice'), text('.ref-more'),
  ].join(' ')
  const detail = page.querySelector('.ref-detail')
  const labelText = (box) => (box ? [...box.querySelectorAll('.ref-field-key, .ref-block-title')].map((n) => (n.innerText || '').trim()).join(' ') : '')
  return {
    lang: Boolean(document.querySelector('.lang-bo')),
    labels: [...page.querySelectorAll('.ref-scope-tab')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()),
    chrome,
    han: (chrome.match(/[\\u4e00-\\u9fff]+/g) || []),
    about: text('.surface'),
    detailLabels: labelText(detail),
    detailHan: (labelText(detail).match(/[\\u4e00-\\u9fff]+/g) || []),
    // uni-app 的 H5 把 placeholder 渲染成一个独立的占位元素，不在 input 属性上
    placeholder: (() => {
      const box = page.querySelector('.ref-search-input')
      const el = box?.querySelector('.uni-input-placeholder')
      const input = box?.querySelector('input')
      return ((el?.innerText || '') || (input?.placeholder || '')).trim()
    })(),
    overflow: page.scrollWidth > window.innerWidth + 1,
  }
})()`

let edge
async function main() {  const probe = await fetch(`${REF_API}/ref-datasets`).then((r) => r.json()).catch(() => null)
  if (!probe?.ok) throw new Error(`参考资料接口没响应：${REF_API}（本地跑要先起 server/app.py，QHYB_PORT=8787）`)
  console.log(`参考资料接口：${REF_API} -> total=${probe.total}`)

  const stat = startStatic()
  await stat.listen(PORT)
  const launched = await launchEdge(CDP_PORT)
  edge = launched
  const cdp = launched.cdp
  const proxied = []
  await interceptApi(cdp, (p) => {
    const url = p.request.url
    if (!/\/api\/ref(-datasets)?(\?|$)/.test(url)) return null
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    proxied.push(path)
    return { proxy: `${REF_API}${path.replace(/^\/api/, '')}` }
  })

  // 1. 首页入口
  await gotoHash(cdp, '/pages/index/index')
  const onHome = await waitFor(cdp, `document.querySelectorAll('.chip').length > 0`)
  const entry = await cdp.eval(`[...document.querySelectorAll('.chip')].some((n) => (n.innerText || '').trim() === '参考资料汇编')`)
  check('首页有参考资料入口', onHome && entry)

  await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.chip')].find((n) => (n.innerText || '').trim() === '参考资料汇编')
    hit.click()
  })()`)
  const opened = await waitFor(cdp, `document.querySelector('.ref-page') && document.querySelectorAll('.ref-scope-tab').length === 3`)
  check('点得进参考资料页', opened)

  // 2. 三份来源各自成区，数字和服务端一致
  await waitFor(cdp, `document.querySelectorAll('.ref-name').length > 0 || document.querySelector('.ref-notice')`)
  let view = await cdp.eval(READ)
  check('三个适用范围各自成区', view.scopes.length === 3 && view.scopes[0].startsWith('全国') && view.scopes[1].startsWith('上海市') && view.scopes[2].startsWith('山东省'), JSON.stringify(view.scopes))
  check(`全国 ${COUNTS.全国} 条`, view.scopes[0].includes(String(COUNTS.全国)), view.scopes[0])
  check(`上海市 ${COUNTS.上海市} 条`, view.scopes[1].includes(String(COUNTS.上海市)), view.scopes[1])
  check(`山东省 ${COUNTS.山东省} 条`, view.scopes[2].includes(String(COUNTS.山东省)), view.scopes[2])
  check('默认落在全国，列表里只有全国条目', JSON.stringify(view.badges) === JSON.stringify(['全国']), JSON.stringify(view.badges))
  check('默认列表有内容', view.names.length > 0, `${view.names.length} 条`)

  // 3. 切到上海市：条目换成上海的，资料集条出现
  await cdp.eval(clickScope('上海市'))
  const shReached = await waitFor(cdp, `(() => { const b=[...new Set([...document.querySelectorAll('.ref-badge')].map((n)=>n.innerText.trim()))]; return b.length===1 && b[0]==='上海市' })()`)
  view = await cdp.eval(READ)
  check('切到上海市后只剩上海条目', shReached && JSON.stringify(view.badges) === JSON.stringify(['上海市']), JSON.stringify(view.badges))
  check('上海市列出三份资料', view.datasets.length === 4, JSON.stringify(view.datasets))
  check('没锁定资料集时不出分册条', !view.hasPartRow)

  // 4. 锁定一份资料后，分册才有意义；再锁定一个分册，结果真的收窄
  await cdp.eval(clickChip('.ref-dataset-chips', '上海药品目录2024'))
  const locked = await waitFor(cdp, `(() => {
    const box = document.querySelector('.ref-part-chips')
    return Boolean(box) && [...box.querySelectorAll('.ref-chip')].some((n) => n.innerText.trim().startsWith('中药饮片'))
  })()`)
  view = await cdp.eval(READ)
  check('锁定资料集后按该集的分册筛选', locked && view.hasPartRow && view.parts.some((t) => t.startsWith('中药饮片')), JSON.stringify(view.parts))
  await cdp.eval(clickChip('.ref-part-chips', '中药饮片'))
  const partLocked = await waitFor(cdp, `(() => {
    const shown = [...new Set([...document.querySelectorAll('.ref-part')].map((n) => n.innerText.trim()))]
    return shown.length === 1 && shown[0] === '中药饮片'
  })()`)
  view = await cdp.eval(READ)
  check('分册筛选真的收窄了结果', partLocked && JSON.stringify(view.parts_shown) === JSON.stringify(['中药饮片']), JSON.stringify(view.parts_shown))
  await shot(cdp, 'ref-shanghai.png')

  // 5. 山东省：只有一份资料，资料集条该让位给分册条
  await cdp.eval(clickScope('山东省'))
  const sdReached = await waitFor(cdp, `(() => { const b=[...new Set([...document.querySelectorAll('.ref-badge')].map((n)=>n.innerText.trim()))]; return b.length===1 && b[0]==='山东省' })()`)
  view = await cdp.eval(READ)
  check('切到山东省后只剩山东条目', sdReached && JSON.stringify(view.badges) === JSON.stringify(['山东省']), JSON.stringify(view.badges))
  check('山东省单份资料不出资料集选择条', !view.hasDatasetRow)
  // 分册条第一枚是「全部分册」，所以 8 章显示 9 枚
  check('山东省按章出八个分册', view.hasPartRow && view.parts.length === 9, JSON.stringify(view.parts))
  check('山东省是超说明书用药共识', view.kinds.includes('超说明书用药共识'), JSON.stringify(view.kinds))
  await shot(cdp, 'ref-shandong.png')

  // 6. 检索：名称、拼音都能命中
  await cdp.eval(clickScope('全国'))
  await waitFor(cdp, `(() => { const b=[...new Set([...document.querySelectorAll('.ref-badge')].map((n)=>n.innerText.trim()))]; return b.length===1 && b[0]==='全国' })()`)
  await cdp.eval(typeQuery('卡托普利'))
  await waitFor(cdp, `[...document.querySelectorAll('.ref-name')].some((n) => n.innerText.trim() === '卡托普利')`)
  view = await cdp.eval(READ)
  check('全国范围内按名称检到卡托普利', view.names.includes(DEEP_NAME), JSON.stringify(view.names.slice(0, 4)))
  const cnNames = view.names

  await cdp.eval(typeQuery('ktpl'))
  await waitFor(cdp, `[...document.querySelectorAll('.ref-name')].some((n) => n.innerText.trim() === '卡托普利')`)
  view = await cdp.eval(READ)
  check('拼音首字母也检得到', view.names.includes(DEEP_NAME), JSON.stringify(view.names.slice(0, 4)))

  // 同一个词在两个适用范围里必须是各自的结果，不能互相顶替
  await cdp.eval(typeQuery('卡托普利'))
  await waitFor(cdp, `[...document.querySelectorAll('.ref-name')].some((n) => n.innerText.trim() === '卡托普利')`)
  await cdp.eval(clickScope('上海市'))
  await waitFor(cdp, `(() => { const b=[...new Set([...document.querySelectorAll('.ref-badge')].map((n)=>n.innerText.trim()))]; return b.length===1 && b[0]==='上海市' && document.querySelectorAll('.ref-name').length>0 })()`)
  view = await cdp.eval(READ)
  check('同名药品在两个范围下结果是各自那份', JSON.stringify(cnNames) !== JSON.stringify(view.names), `${cnNames.length} vs ${view.names.length}`)

  // 7. 明细：点开一条，编号、资料集都在，支付标准不在
  await cdp.eval(`(() => { const n=document.querySelector('.ref-card-main'); if (n) n.click() })()`)
  const detailed = await waitFor(cdp, `Boolean(document.querySelector('.ref-detail')) && !/正在取明细/.test(document.querySelector('.ref-detail').innerText)`)
  view = await cdp.eval(READ)
  check('点得开明细', detailed && view.detailOpen)
  check('明细里有资料集和编号', view.detail.includes('资料集') && view.detail.includes('编号'), view.detail.slice(0, 80))
  check('明细里没有支付标准/支付比例', !/支付标准|支付比例|自负比例/.test(view.detail), view.detail.slice(0, 80))
  check('页面上说明了不公开医保支付标准', /不公开医保支付标准/.test((await cdp.eval(READ)).about), (await cdp.eval(READ)).about.slice(0, 60))

  // 8. 深链直接打开那一条
  await gotoHash(cdp, `/pages/ref/ref?ref=${encodeURIComponent(DEEP)}`)
  const deepOpen = await waitFor(cdp, `(() => {
    const box = document.querySelector('.ref-detail')
    return Boolean(box) && (box.innerText || '').includes(${JSON.stringify(DEEP)})
  })()`)
  view = await cdp.eval(READ)
  check('?ref=<id> 直接打开那一条', deepOpen && view.openCardName === DEEP_NAME, view.detail.slice(0, 100))
  check('深链条目插在列表最前面', view.openCardName === DEEP_NAME && view.firstCardName === DEEP_NAME, view.firstCardName)
  check('深链条目的 id 露在明细里', view.detail.includes(DEEP), view.detail.slice(-60))

  // 9. 窄屏排布
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true })
  await sleep(400)
  view = await cdp.eval(READ)
  check('320px 无横向溢出', !view.overflow)
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  // 10. 藏文：这一页的框架词必须真译出来。t() 找不到 key 会原样回落中文，
  //     页面看着一切正常，所以这里逐条盯住，别让回落当成已完成。
  await gotoHash(cdp, '/pages/me/me')
  const hasSwitcher = await waitFor(cdp, `document.querySelectorAll('.language-opt').length > 0`)
  const switched = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.language-opt')].find((n) => (n.innerText || '').trim() === 'བོད་ཡིག')
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await gotoHash(cdp, '/pages/ref/ref')
  const boReady = await waitFor(cdp, `document.querySelector('.ref-page') && document.querySelectorAll('.ref-scope-tab').length === 3`)
  await waitFor(cdp, `document.querySelectorAll('.ref-name').length > 0 || document.querySelector('.ref-notice')`)
  const bo = await cdp.eval(BO_READ)
  check('切得到藏文，页面进入藏文模式', hasSwitcher && switched && boReady && bo.lang === true)
  check('藏文下三个适用范围是藏文且带条数',
    bo.labels.length === 3 && bo.labels.every((s) => /[ༀ-࿿]/.test(s) && /\d/.test(s)),
    JSON.stringify(bo.labels))
  check('藏文下框架词没有回落中文', bo.han.length === 0, JSON.stringify(bo.han))
  check('藏文下说明段是藏文', /[ༀ-࿿]/.test(bo.about) && bo.about.length > 80, bo.about.slice(0, 40))
  check('藏文下搜索示例仍留着中文检索词',
    /[ༀ-࿿]/.test(bo.placeholder) && !/[一-鿿]/.test(bo.placeholder.replace('卡托普利、ktpl、A19.000x004', '')),
    bo.placeholder)

  // 明细里的字段名同样是界面词。等的时候别认中文的「正在取明细」——藏文下那句提示也是藏文，
  // 拿它当判据会永远为真，等于没等，读到的还是加载中的空壳。
  await cdp.eval(`(() => { const n=document.querySelector('.ref-card-main'); if (n) n.click() })()`)
  const boDetail = await waitFor(cdp, `document.querySelectorAll('.ref-detail .ref-field-key').length > 0`)
  const boView = await cdp.eval(BO_READ)
  check('藏文下明细字段名是藏文',
    boDetail && /[ༀ-࿿]/.test(boView.detailLabels) && !/[一-鿿]/.test(boView.detailLabels),
    boDetail ? JSON.stringify(boView.detailHan) : '明细一直没出来')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true })
  await sleep(400)
  const boNarrow = await cdp.eval(BO_READ)
  check('藏文在 320px 无横向溢出', !boNarrow.overflow)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await shot(cdp, 'ref-tibetan.png')
  await cdp.eval(`location.hash='#/pages/me/me'`)
  await waitFor(cdp, `document.querySelectorAll('.language-opt').length > 0`)
  await cdp.eval(`(() => { const n=document.querySelectorAll('.language-opt')[0]; if (n) n.click() })()`)

  check('参考资料请求确实走了接口', proxied.some((u) => u.includes('/ref-datasets')) && proxied.some((u) => u.includes('/ref?')), JSON.stringify([...new Set(proxied.map((u) => u.split('?')[0]))]))
  check('无未捕获运行时异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | ').slice(0, 240))
}

main()
  .catch((err) => {
    console.error('ERROR', err.message)
    results.push({ name: 'harness', ok: false, detail: err.message })
  })
  .finally(() => {
    try { edge?.kill() } catch {}
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
