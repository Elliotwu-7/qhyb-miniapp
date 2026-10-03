// Smoke-test the technical-spec chain in a real browser.
//
// 要验的是「先有规范，再出的项目定价」这条链在界面上真的走得通：
//   收费项目详情 → 技术规范原文 → 由这条规范形成的收费项目 → 回到项目详情
//   关联网络里规范是上游节点（菱形），从规范也能看到它形成的项目
//
// 规范数据不在小程序包里（nhc-full 有 14MB），只有 API 有。线上已经部署了
// byItem/code 两条路由，所以 SPEC_API=live 可以把规范请求转到线上，验真接口 + 真数据：
//
//   SPEC_API=live node scripts/check_spec.mjs
//
// 不带 SPEC_API 时转发到本地接口，方便改数据后先本地跑通。先起本地 API：
//
//   python -c "import sys; sys.path.insert(0,'server'); import nhc_spec; print(nhc_spec.load(nhc_spec.connect()))"
//   .venv\\Scripts\\python.exe server\\app.py        # QHYB_PORT=8799
//   node scripts/check_spec.mjs
import { freePort, startStatic, launchEdge, interceptApi, sleep } from './h5env.mjs'

// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
const PORT = await freePort()
const CDP_PORT = await freePort()
// SPEC_API=live 时把规范请求转到线上接口：线上已经部署了 code/byItem 两条路由，
// 这样验的就是真接口 + 真数据。默认仍转本地库，方便改数据后先本地跑通。
const LIVE = process.env.SPEC_API === 'live'
const NHC_API = (LIVE ? 'https://qhyb.lynkco.site/api' : process.env.SPEC_API || 'http://127.0.0.1:8799/api').replace(/\/$/, '')

/** 一个项目由恰好一条规范形成：详情页给直达入口。 */
const SOLO = { id: 'master:HHL73302:腮腺浅叶肿物切除术', name: '腮腺浅叶肿物切除术', code: 'HHL6U303', specItems: 11 }
/** 一个项目由几十条规范合并形成：详情页只能去关联网络里看。 */
const MANY = { id: 'reform:012301030010000', name: '磁共振（MR）平扫', min: 2 }
/** 搜这个词：目录里有项目、规范库里也有条目（实测规范命中 47 条）。 */
const SEARCH_TERM = '腮腺'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const waitFor = async (cdp, expr, timeout = 60000, step = 700) => {
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

// 每次换页都带上不同的 query 强制真正重载文档：只改 hash 的话 SPA 会把上一页的
// 状态留着，验的就不是「这个链接打开是什么样」了。目录带 immutable 缓存，重载不慢。
let hop = 0
const gotoHash = async (cdp, hash) => {
  hop += 1
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${hop}#${hash}` })
}

const READ_DETAIL = `(() => {
  const entries = [...document.querySelectorAll('.label-entry')].map((n) => ({
    title: (n.querySelector('.label-entry-title')?.innerText || '').trim(),
    sub: (n.querySelector('.label-entry-sub')?.innerText || '').trim(),
  }))
  return { name: (document.querySelector('.drawer-head .name, .name')?.innerText || '').trim(), entries }
})()`

const READ_SPEC = `(() => {
  const text = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\\s+/g, ' ').trim()
  return {
    title: text('.spec-title'),
    sub: text('.spec-sub'),
    english: text('.spec-english'),
    connotation: text('.spec-copy'),
    itemsHead: text('.spec-items-head'),
    items: [...document.querySelectorAll('.spec-item')].map((n) => (n.querySelector('.spec-item-name')?.innerText || '').trim()),
    empty: Boolean(document.querySelector('.spec-items .muted, .spec-page .muted')),
    missing: Boolean(document.querySelector('.spec-missing')),
    page: Boolean(document.querySelector('.spec-page')),
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  }
})()`

// 规范菱形按 SPEC_COLOR(#4f46e5) 实心填充，而规范关系线是同一个颜色，所以光数像素分不出
// 两者。只认「上下左右 2 像素也还是这个颜色」的像素：那是实心块的内部，一条不到 2 像素宽
// 的线凑不出来。
const PIXEL_SCAN = `(() => {
  const c = document.querySelector('canvas')
  if (!c || !c.getContext) return { found: false, reason: 'no canvas' }
  const ctx = c.getContext('2d')
  if (!ctx || !ctx.getImageData) return { found: false, reason: 'no 2d context' }
  const w = c.width
  const h = c.height
  const d = ctx.getImageData(0, 0, w, h).data
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return Math.abs(d[i] - 79) < 14 && Math.abs(d[i + 1] - 70) < 14 && Math.abs(d[i + 2] - 229) < 14
  }
  let hits = 0
  let core = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!at(x, y)) continue
      hits += 1
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue
      if (at(x - 2, y) && at(x + 2, y) && at(x, y - 2) && at(x, y + 2)) core += 1
    }
  }
  return { found: core > 20, core, hits, w, h }
})()`

// 搜索页的规范那一节。别处也有 .guide-row，所以先找到写着「技术规范」的那一块再取行。
const READ_SPEC_HITS = `(() => {
  const label = [...document.querySelectorAll('.surface .section-label')].find((n) => /技术规范/.test(n.innerText))
  const box = label ? label.closest('.surface') : null
  return {
    label: label ? label.innerText.replace(/\\s+/g, ' ').trim() : '',
    rows: box ? [...box.querySelectorAll('.guide-row')].map((n) => ({
      name: (n.querySelector('.dt')?.innerText || '').trim(),
      meta: (n.querySelector('.dd')?.innerText || '').trim(),
    })) : [],
  }
})()`

const OPEN_SPEC_HIT = `(() => {
  const label = [...document.querySelectorAll('.surface .section-label')].find((n) => /技术规范/.test(n.innerText))
  const row = label && label.closest('.surface').querySelector('.guide-row')
  if (!row) return ''
  const meta = (row.querySelector('.dd')?.innerText || '').trim()
  row.click()
  return meta
})()`

/**
 * 按编号认页，不按「页面上有没有 .spec-title」：H5 换页时上一张规范页可能还挂着，
 * 按选择器会读到旧标题，甚至在两张页之间读到空 body。规范页自己写着编号，用它认。
 * 读 textContent 而不是 innerText：换页动画期间 innerText 会是空的（元素还没渲染出来），
 * textContent 不受这个影响，样式也一样只看 DOM。
 */
const readSpecByCode = (code) => `(() => {
  const pages = [...document.querySelectorAll('.spec-page')]
  const detail = pages.map((n) => ({
    subText: (n.querySelector('.spec-sub')?.textContent || '').slice(0, 40),
    subInner: (n.querySelector('.spec-sub')?.innerText || '').slice(0, 40),
    verdict: n.offsetParent === null ? 'hidden' : 'visible',
  }))
  const page = pages.find((n) => (n.querySelector('.spec-sub')?.textContent || '').includes(${JSON.stringify(code)}))
  if (!page) return { page: false, title: '', sub: '', missing: false, items: [], detail }
  const text = (sel) => (page.querySelector(sel)?.textContent || '').replace(/\\s+/g, ' ').trim()
  return {
    page: true,
    detail,
    title: text('.spec-title'),
    sub: text('.spec-sub'),
    missing: Boolean(page.querySelector('.spec-missing')),
    itemsHead: text('.spec-items-head'),
    items: [...page.querySelectorAll('.spec-item')].map((n) => (n.querySelector('.spec-item-name')?.textContent || '').trim()),
  }
})()`

const READ_GRAPH = `(() => {
  const text = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\\s+/g, ' ').trim()

  return {
    center: text('.graph-selection-name'),
    tag: text('.graph-tag'),
    limit: text('.graph-limit'),
    stats: [...document.querySelectorAll('.graph-stat')].map((n) => ({
      label: (n.querySelector('.graph-stat-label')?.innerText || '').trim(),
      value: Number((n.querySelector('.graph-stat-value')?.innerText || '0').trim()),
    })),
    related: [...document.querySelectorAll('.graph-related-row')].map((n) => ({
      kind: (n.querySelector('.graph-related-icon')?.innerText || '').trim(),
      isSpec: Boolean(n.querySelector('.graph-related-icon.spec')),
      name: (n.querySelector('.graph-related-name')?.innerText || '').trim(),
      rel: (n.querySelector('.graph-related-rel')?.innerText || '').trim(),
    })),
    diamond: (() => {
      const n = document.querySelector('.graph-legend-diamond')
      if (!n) return ''
      return getComputedStyle(n).backgroundColor
    })(),
    loading: Boolean(document.querySelector('.graph-canvas-hint')),
  }
})()`

const clickEntry = (title) => `(() => {
  const hit = [...document.querySelectorAll('.label-entry')].find((n) => (n.querySelector('.label-entry-title')?.innerText || '').trim() === ${JSON.stringify(title)})
  if (!hit) return false
  hit.click()
  return true
})()`

let edge
async function main() {
  // 本地 API 没起来的话，下面的失败都会是「规范页打不开」，看不出到底是谁的问题。
  const probe = await fetch(`${NHC_API}/nhc-spec?ids=${encodeURIComponent(SOLO.id)}`).then((r) => r.json()).catch(() => null)
  if (!probe) throw new Error(`规范接口没响应：${NHC_API}（本地跑要先起 server/app.py，QHYB_PORT=8799）`)
  console.log(`规范接口（${LIVE ? '线上' : '本地'}）：${NHC_API} -> byItem=${JSON.stringify(probe.byItem)}`)

  const stat = startStatic()
  await stat.listen(PORT)
  const launched = await launchEdge(CDP_PORT)
  const cdp = launched.cdp
  edge = launched
  const proxied = []
  await interceptApi(cdp, (p) => {
    const url = p.request.url
    if (/\/api\/nhc-spec/.test(url)) {
      proxied.push(url.replace(/^https?:\/\/[^/]+/, ''))
      return { proxy: `${NHC_API}/nhc-spec${new URL(url).search}` }
    }
    return null
  })

  // 1. 项目详情：一条规范的项目给直达入口。
  //    详情页先等目录分片、再问规范，所以这个入口出现得比「目录原文」晚不少。
  await gotoHash(cdp, `/pages/detail/detail?id=${encodeURIComponent(SOLO.id)}`)
  const titled = `[...document.querySelectorAll('.label-entry-title')].some((n) => n.innerText.trim() === '技术规范原文')`
  const ok1 = await waitFor(cdp, `document.querySelectorAll('.label-entry').length > 0`)
  await waitFor(cdp, titled, 120000)
  const detail = await cdp.eval(READ_DETAIL)
  check('项目详情页打开', ok1, detail.name)
  const entry = detail.entries.find((e) => e.title === '技术规范原文')
  check('详情页有技术规范入口', Boolean(entry), JSON.stringify(detail.entries.map((e) => e.title)))
  check('单条规范时入口写「查看对应的技术规范原文」', entry?.sub === '查看对应的技术规范原文', entry?.sub)

  // 2. 进规范页：正文、编号页码、由它形成的收费项目。
  await cdp.eval(clickEntry('技术规范原文'))
  const onSpec = await waitFor(cdp, `/^#\\/pages\\/spec\\/spec/.test(location.hash)`)
  await waitFor(cdp, `document.querySelectorAll('.spec-item').length > 0`, 120000)
  const spec = await cdp.eval(READ_SPEC)
  check('从详情能进规范页', onSpec && spec.title === SOLO.name, `hash=${await cdp.eval('location.hash')} title=${spec.title}`)
  check('规范页显示规范编号和页码', spec.sub.includes(SOLO.code) && /第 \d+ 页/.test(spec.sub), spec.sub)
  check('规范页有正文', spec.connotation.length > 20, `${spec.connotation.length} 字`)
  check('规范页列出由它形成的收费项目', spec.items.includes(SOLO.name), `${spec.itemsHead} / ${JSON.stringify(spec.items.slice(0, 4))}`)
  check(`规范页项目数与本条规范一致（${SOLO.specItems}）`, spec.itemsHead.includes(`${SOLO.specItems} 项`), spec.itemsHead)

  // 3. 规范页上的项目能点回详情：这条链要能双向走。
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.spec-item')].find((n) => (n.querySelector('.spec-item-name')?.innerText || '').trim() === ${JSON.stringify(SOLO.name)})
    if (!row) return false
    row.click()
    return true
  })()`)
  const backDetail = await waitFor(cdp, `/^#\\/pages\\/detail\\/detail/.test(location.hash)`)
  const back = backDetail ? await cdp.eval(READ_DETAIL) : { name: '' }
  check('规范页上的项目点得回详情页', backDetail && back.name.includes(SOLO.name), `${back.name} hash=${await cdp.eval('location.hash')}`)

  // 4. 多条规范合并的项目：详情页入口改成去关联网络。
  await gotoHash(cdp, `/pages/detail/detail?id=${encodeURIComponent(MANY.id)}`)
  await waitFor(cdp, `[...document.querySelectorAll('.label-entry-sub')].some((n) => /条技术规范合并形成/.test(n.innerText))`, 120000)
  const many = await cdp.eval(READ_DETAIL)
  const manyEntry = many.entries.find((e) => e.title === '技术规范原文')
  check('多条规范的项目也进关联网络', Boolean(manyEntry) && /条技术规范合并形成/.test(manyEntry.sub), manyEntry?.sub)

  // 5. 关联网络：规范是上游节点，画成菱形，配色一致。
  await gotoHash(cdp, `/pages/graph/graph?id=${encodeURIComponent(MANY.id)}`)
  const centered = await waitFor(cdp, `(document.querySelector('.graph-selection-name')?.innerText || '').trim() === ${JSON.stringify(MANY.name)}`, 120000)
  await waitFor(cdp, `document.querySelector('.graph-related-icon.spec')`, 120000)
  const graph = await cdp.eval(READ_GRAPH)
  check('关联网络以该项目为中心', centered, graph.center)
  const specStat = graph.stats.find((s) => s.label === '规范节点')
  check('图上有规范节点计数', Boolean(specStat) && specStat.value >= MANY.min, JSON.stringify(graph.stats))
  const specRow = graph.related.find((r) => r.isSpec)
  check('邻居里有规范节点', Boolean(specRow), JSON.stringify(graph.related.slice(0, 4)))
  check('规范关系写明页码、标为上游', /技术规范 · 第 \d+ 页/.test(specRow?.rel || ''), specRow?.rel)
  check('图例有菱形规范标记且用同一配色', graph.diamond === 'rgb(79, 70, 229)', graph.diamond)

  // 6. 从图谱里的规范邻居点进规范页。
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.graph-related-row')].find((n) => n.querySelector('.graph-related-icon.spec'))
    if (!row) return false
    row.click()
    return true
  })()`)
  const graphToSpec = await waitFor(cdp, `/^#\\/pages\\/spec\\/spec/.test(location.hash)`)
  await waitFor(cdp, `document.querySelector('.spec-title')`, 120000)
  const specFromGraph = graphToSpec ? await cdp.eval(READ_SPEC) : { title: '', missing: true }
  check('图谱里的规范点得进规范页', graphToSpec && !specFromGraph.missing && specFromGraph.title.length > 0, `${specFromGraph.title} hash=${await cdp.eval('location.hash')}`)

  // 7. 以规范为中心：规范是上游，图上要看得到它形成的收费项目。
  await gotoHash(cdp, `/pages/graph/graph?id=${encodeURIComponent(`nhc:${SOLO.code}`)}`)
  const specCentered = await waitFor(cdp, `(document.querySelector('.graph-selection-name')?.innerText || '').trim() === ${JSON.stringify(SOLO.name)}`, 120000)
  await waitFor(cdp, `document.querySelectorAll('.graph-related-row').length > 0`, 120000)
  const specGraph = await cdp.eval(READ_GRAPH)
  check('分享链接直接指向规范也能画出图', specCentered, specGraph.tag)
  check('规范节点标为技术规范并写出页码', specGraph.tag === '技术规范' && /第 \d+ 页/.test(specGraph.limit), `${specGraph.tag} | ${specGraph.limit}`)
  const priced = specGraph.related.filter((r) => !r.isSpec)
  check('规范节点铺开它形成的收费项目', priced.length > 0 && priced.some((r) => r.name.includes('腮腺')), `${priced.length} 项 ${JSON.stringify(priced.slice(0, 3))}`)
  check('规范节点上方还有上游说明', /先有规范/.test(specGraph.limit), specGraph.limit.slice(0, 60))

  // 8. 画布上真的画出了菱形：DOM 里的图例只能说明配色常量对，说明不了节点画没画出来。
  const pixels = await cdp.eval(PIXEL_SCAN)
  check('画布上真画出了规范菱形节点', pixels.found, JSON.stringify(pixels))

  // 9. 搜索也要找得到规范：搜一个词，规范那一节要出条目，点进去就是规范页。
  await gotoHash(cdp, `/pages/index/index?q=${encodeURIComponent(SEARCH_TERM)}`)
  await waitFor(cdp, `document.querySelectorAll('.guide-row .dt').length > 0`, 120000)
  const hits = await cdp.eval(READ_SPEC_HITS)
  check('搜索结果里列出对应的技术规范', hits.rows.length > 0 && /第 \d+ 页/.test(hits.rows[0].meta), `${hits.label} / ${JSON.stringify(hits.rows.slice(0, 2))}`)
  const clicked = await cdp.eval(OPEN_SPEC_HIT)
  const hitCode = String(clicked || '').split('·')[0].trim()
  check('搜索结果里的规范带编号和页码', /^[A-Za-z0-9]+$/.test(hitCode) && /第 \d+ 页/.test(String(clicked)), String(clicked))
  // 别拿「hash 变了」当到达信号：这一跳在线上数据下比 60 秒还慢，等 hash 会等到超时，
  // 然后再去读，读到的还是上一页。直接轮询「读出来的是不是这一条」，等多久都认。
  const clickAt = Date.now()
  let fromSearch = { page: false, title: '', sub: '', missing: true, items: [], detail: [] }
  const until = Date.now() + 180000
  for (;;) {
    fromSearch = await cdp.eval(readSpecByCode(hitCode))
    if (fromSearch.page && fromSearch.title.length > 0) break
    if (Date.now() >= until) break
    await sleep(700)
  }
  const waited = Math.round((Date.now() - clickAt) / 1000)
  const hitHash = await cdp.eval('location.hash')
  check('搜索结果里的规范点得开', /^#\/pages\/spec\/spec/.test(hitHash) && fromSearch.page && !fromSearch.missing && fromSearch.title.length > 0,
    `${fromSearch.title || '（无标题）'}｜等待 ${waited}s｜hash=${hitHash}｜${JSON.stringify(fromSearch.detail)}`)

  check(LIVE ? '规范请求确实走的是线上接口' : '规范请求确实走的是本地接口', proxied.some((u) => u.includes('ids=')) && proxied.some((u) => u.includes('code=')), JSON.stringify([...new Set(proxied)].slice(0, 4)))
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
