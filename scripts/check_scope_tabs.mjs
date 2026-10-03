// 首页和搜索页那五栏是平级的：全部 / 诊疗项目 / 药品 / 医用耗材 / 技术规范。
//
// 用户报的是「耗材根本搜索不到」，而当时所有的回归都是从 `?q=` 那条路进的搜索
// （有查询时状态过滤会放宽），点栏这条路谁都没测过 —— 这条正好是用户走的那条。
// 所以这里不输关键词，直接点每一栏，验三件事：那一栏出的确实是那一类、条数和
// 首页那行统计对得上（「平级」的直接证据）、点栏过程不抛异常。
//
// 技术规范是第五栏，但不走本地目录：它命中的是线上规范库，而且那条接口要求关键词
// 至少两个字（见 index.vue 的 refreshNhc）。所以它分两段验 —— 不输词时给的是引导语，
// 另起一段带 ?q= 重载，才看得到真条目。
//
// 运行：node scripts/check_scope_tabs.mjs
import { freePort, startStatic, launchEdge, sleep } from './h5env.mjs'

// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
const PORT = await freePort()
const CDP_PORT = await freePort()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const TABS = ['全部', '诊疗项目', '药品', '医用耗材', '技术规范']

/** 一页读干净：五栏标签、首页那行统计、结果摘要四个数、卡片数与耗材标签数。 */
const READ = `(() => {
  const t = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const hero = t(document.querySelector('.hero-meta')?.innerText)
  const h = hero.match(/^更新至 (\\S+) · 诊疗在用 (\\d+) 项 · 药品 (\\d+) 条 · 耗材在用 (\\d+) 条$/)
  const summary = t(document.querySelector('.result-summary')?.innerText)
  const m = summary.match(/^(\\d+) 条 · 诊疗 (\\d+) · 药品 (\\d+) · 耗材 (\\d+)$/)
  const sm = summary.match(/^技术规范 (\\d+) 条$/)
  const rows = [...document.querySelectorAll('.result-row')]
  return {
    tabs: [...document.querySelectorAll('.scope-tab')].map((x) => t(x.innerText)),
    hero,
    heroVersion: h ? h[1] : '',
    heroHc: h ? Number(h[4]) : -1,
    summary,
    counts: m ? { total: Number(m[1]), service: Number(m[2]), drug: Number(m[3]), hc: Number(m[4]) } : null,
    specCount: sm ? Number(sm[1]) : -1,
    rows: rows.length,
    hcBadges: document.querySelectorAll('.result-row .hc-kind').length,
    specBadges: document.querySelectorAll('.result-row .spec-kind').length,
    empty: t(document.querySelector('.muted.pad')?.innerText),
    first: rows.slice(0, 2).map((r) => t(r.innerText).slice(0, 70)),
  }
})()`

let edge
async function main() {
  const stat = startStatic()
  await stat.listen(PORT)
  edge = await launchEdge(CDP_PORT)
  const cdp = edge.cdp

  /** 等在 `ready` 成立再读：固定 sleep 会把「慢」当成「坏」。 */
  const until = async (ready, label, ms = 120000) => {
    const deadline = Date.now() + ms
    let page = await cdp.eval(READ)
    for (;;) {
      if (ready(page)) return page
      if (Date.now() >= deadline) throw new Error(`${label}：等不到（当前 ${JSON.stringify({ hero: page.hero, summary: page.summary, rows: page.rows, empty: page.empty })}）`)
      await sleep(700)
      page = await cdp.eval(READ)
    }
  }

  /** 换页/加载不看固定 sleep：轮询页面上的表达式，成立就走。 */
  const waitFor = async (expr, label, ms = 60000) => {
    const deadline = Date.now() + ms
    for (;;) {
      try {
        if (await cdp.eval(expr)) return true
      } catch {
        /* 页面正在换，下一轮再问 */
      }
      if (Date.now() >= deadline) return false
      await sleep(700)
    }
  }

  const tapTab = (n) => cdp.eval(`(() => { document.querySelectorAll('.scope-tab')[${n}].click(); return true })()`)

  // 换 hash 不会重载文档，SPA 会留着上一页，所以地址栏前头挂一个变化的 ?t=。
  await cdp.goto(`http://127.0.0.1:${PORT}/?t=1#/pages/index/index`)
  const home = await until((p) => p.heroHc >= 0 && p.tabs.length === TABS.length, '首页统计那行没出来')

  check('首页五栏与诊疗项目、药品平级', JSON.stringify(home.tabs) === JSON.stringify(TABS), JSON.stringify(home.tabs))
  check('首页统计那行把耗材写进去了', Boolean(home.heroVersion) && home.heroHc > 100, home.hero)

  const tap = async (n) => {
    await tapTab(n)
    return until((p) => p.counts && p.counts.total > 0, `点「${TABS[n]}」栏后列表没出来`)
  }

  // 1 = 诊疗项目。除总数外另外两类都得是 0，卡片上也不该有耗材那个类别标签。
  const service = await tap(1)
  check('点「诊疗项目」栏：只出诊疗项目',
    service.counts.service === service.counts.total && service.counts.drug === 0 && service.counts.hc === 0 &&
      service.rows > 0 && service.hcBadges === 0,
    `${service.summary} · 卡片 ${service.rows} · 首条 ${service.first[0]}`)

  // 2 = 药品。
  const drug = await tap(2)
  check('点「药品」栏：只出药品',
    drug.counts.drug === drug.counts.total && drug.counts.service === 0 && drug.counts.hc === 0 &&
      drug.rows > 0 && drug.hcBadges === 0,
    `${drug.summary} · 卡片 ${drug.rows} · 首条 ${drug.first[0]}`)

  // 3 = 医用耗材。卡片上那个「医保耗材目录 / 挂网产品 / 带量采购」的标签是逐卡印的，
  // 所以它数出来等于卡片数，才算列表里真的每一条都是耗材，而不只是表头写着耗材。
  const hc = await tap(3)
  check('点「医用耗材」栏：出的是耗材，条数和首页那行一致',
    hc.counts.hc === hc.counts.total && hc.counts.service === 0 && hc.counts.drug === 0 &&
      hc.rows > 0 && hc.hcBadges === hc.rows && hc.counts.hc === home.heroHc,
    `${hc.summary} · 卡片 ${hc.rows}（带耗材类别标签 ${hc.hcBadges}）· 首页写的是 ${home.heroHc} · 首条 ${hc.first[0]}`)

  // 4 = 技术规范。这一档不查本地目录，命中的是线上规范库（另有一条 2 字的门槛），
  // 所以手上没关键词时给出的应该是引导语，而不是「没找到」之类的空话。
  await tapTab(4)
  const specEmpty = await until((p) => p.empty.length > 0 && p.rows === 0, '点「技术规范」栏后空态没出来')
  check('点「技术规范」栏：没有关键词时给的是搜索引导',
    specEmpty.empty === '搜索规范名称或编号，例如 静脉输液 或 HHL6U303' && specEmpty.specCount === -1,
    specEmpty.empty)

  // 带关键词重载再看一次：规范的标签页要真的出条目，条数、编号、页码、卡片标记都得有。
  await cdp.goto(`http://127.0.0.1:${PORT}/?t=9#/pages/index/index?q=${encodeURIComponent('腮腺')}`)
  await until((p) => p.counts && p.counts.total > 0, '带关键词进来后目录结果没出来')
  await tapTab(4)
  const spec = await until((p) => p.specCount > 0, '规范档没出条目')
  // 摘要里的条数是命中总数，卡片数被「展开更多」的 pageSize 截过一道，所以只要求 ≥。
  check('带关键词点「技术规范」栏：出的是规范，条数写进摘要',
    spec.specCount >= spec.rows && spec.rows > 0 && spec.specBadges === spec.rows && spec.hcBadges === 0 && /第 \d+ 页/.test(spec.first[0]),
    `${spec.summary} · 卡片 ${spec.rows}（带规范标记 ${spec.specBadges}）· 首条 ${spec.first[0]}`)

  const opened = await cdp.eval(`(() => {
    const card = document.querySelector('.result-row .result-card')
    if (!card) return ''
    const meta = (card.querySelector('.result-meta')?.innerText || '').replace(/\\s+/g, ' ').trim()
    card.click()
    return meta
  })()`)
  const onSpecPage = await waitFor(`/^#\\/pages\\/spec\\/spec/.test(location.hash)`, '规范卡没进规范页', 180000)
  // 编号和页码是两个 <text>，H5 拼出来的分隔符不必当契约，只认两样都在。
  check('规范卡点得进规范原文页', onSpecPage && /[A-Za-z0-9]/.test(opened) && /第 \d+ 页/.test(opened), `${opened}｜hash=${await cdp.eval('location.hash')}`)

  check('点栏过程没有运行时异常', cdp.errors.length === 0, JSON.stringify(cdp.errors.slice(0, 3)))

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} passed`)
  edge.kill()
  stat.close()
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('ERR', e.message)
  if (edge) edge.kill()
  process.exit(1)
})
