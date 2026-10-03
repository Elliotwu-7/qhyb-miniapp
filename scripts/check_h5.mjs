// Smoke-test the uni-app pages of the mini program in a real browser.
//
// The mini program targets WeChat, which can't be driven headlessly here, so we
// build the same uni-app source for H5 and exercise the shared Vue components
// and lib/* logic (search, hop filtering, drug detail) against production data.
// Assertions are scoped to the result list so the search box's own text can't
// satisfy them.
//
// 查询现在要先登录，而 H5 里没有微信，登录那条链在浏览器里走不通。所以这个检查
// 走「转发链接」进来（#/pages/index/index?q=…）：那是产品自己的入口，不经过
// 登录门，验的仍是真实目录和真实结果列表。登录门本身只能在微信里验收。
import { gunzipSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { freePort, startStatic, launchEdge, sleep } from './h5env.mjs'

// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
const PORT = await freePort()
const CDP_PORT = await freePort()
const ORIGIN = `http://127.0.0.1:${PORT}`
const SITE = 'https://qhyb.lynkco.site'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Reads the rendered result list only — never the search box.
const READ_LIST = `(() => {
  const cards = [...document.querySelectorAll('.result-card')]
  return cards.map((c) => ({
    name: (c.querySelector('.result-name')?.innerText || '').trim(),
    drug: c.classList.contains('is-drug'),
    consumable: c.classList.contains('is-consumable'),
    stopped: c.classList.contains('is-stopped'),
    pending: Boolean(c.querySelector('.status-strip.pending')),
    limited: Boolean(c.querySelector('.limit-badge')),
    hopNote: Boolean(c.querySelector('.hop-note')),
    hops: [...c.querySelectorAll('.hop-list .merge-row, .hop-list li')].map((h) => h.innerText.replace(/\\s+/g, ' ').trim()),
    text: c.innerText.replace(/\\s+/g, ' ').slice(0, 200),
  }))
})()`

/** 线上的版本和药品数：首页那两个数字要和已发布的目录对得上，不能写死。 */
async function liveCatalog() {
  const rel = await (await fetch(`${SITE}/data/release.json?t=${Date.now()}`, { cache: 'no-store' })).json()
  const base = (/^https?:/.test(rel.base) ? rel.base : SITE + rel.base).replace(/\/$/, '')
  const grab = async (name) => {
    const r = await fetch(`${base}/${name}?t=${Date.now()}`, { cache: 'no-store' })
    const buf = Buffer.from(await r.arrayBuffer())
    return JSON.parse(name.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8'))
  }
  const meta = await grab('meta.json')
  const drugs = await grab('drugs.json.gz')
  return { base, version: meta.stats.version, total: meta.stats.total, drugs: (drugs.r || []).length }
}

let edge
async function main() {
  const live = await liveCatalog()
  console.log(`线上目录 ${live.base} · 版本 ${live.version} · 药品 ${live.drugs} · 条目 ${live.total}`)

  const stat = startStatic()
  await stat.listen(PORT)
  const launched = await launchEdge(CDP_PORT)
  const cdp = launched.cdp
  edge = launched

  const waitFor = async (expr, timeout = 120000, step = 700) => {
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

  let hop = 0
  /** 走转发链接入口。每次都真正重载文档：换 hash 的话 SPA 会留着上一页的状态。 */
  const openQuery = async (text) => {
    hop += 1
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?t=${hop}#/pages/index/index?q=${encodeURIComponent(text)}` })
    return waitFor(`document.querySelectorAll('.result-card').length > 0`)
  }

  // 1. Home: catalog loads and the live count renders.
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?t=0` })
  await waitFor(`/更新至/.test(document.body.innerText)`)
  const home = await cdp.eval(`(() => {
    const t = document.body.innerText
    return { text: t.replace(/\\s+/g, ' ').slice(0, 300), cards: document.querySelectorAll('.result-card').length, version: (t.match(/更新至\\s*([^\\s·]+)/) || [])[1] || '', count: (t.match(/在用\\s*([0-9,]+)\\s*项/) || [])[1] || '' }
  })()`)
  check('小程序首页渲染', /青保查|青海公开价格目录/.test(home.text), home.text.slice(0, 120))
  check('首页版本与线上目录一致', home.version === live.version, `页面 ${home.version} / 线上 ${live.version}`)
  // 在用数是页面自己按目录算出来的（合并、失效都要看），所以不钉死具体值；
  // 对得上版本、数量级合理即可，重发目录不该让这条变红。
  check('首页「在用」计数合理', Number(String(home.count).replace(/,/g, '')) > 5000 && Number(String(home.count).replace(/,/g, '')) < live.total, `在用 ${home.count}`)
  check('首页不铺目录列表', home.cards === 0, `cards=${home.cards}`)

  // 2. Search a drug: a result card for it must render.
  await openQuery('鼻炎片')
  const drugList = await cdp.eval(READ_LIST)
  const drugNames = drugList.map((c) => c.name)
  check('搜「鼻炎片」出药品卡', drugNames.some((n) => n.includes('鼻炎片')), JSON.stringify(drugNames.slice(0, 6)))

  // 3. 海马磁共振成像: unpaid 海马 drugs must not hop onto it.
  await openQuery('海马磁共振成像')
  const noHop = await cdp.eval(READ_LIST)
  const target = noHop.find((c) => c.name.includes('海马磁共振成像'))
  check('海马磁共振成像出结果卡', Boolean(target), JSON.stringify(noHop.map((c) => c.name).slice(0, 4)))
  check('海马磁共振成像无药品 hop', Boolean(target) && !target.hopNote, `hopNote=${target?.hopNote} hops=${JSON.stringify(target?.hops)}`)

  // 4. 聚焦超声治疗鼻炎: 鼻炎片 must NOT hop onto it. 中成药按完整方名匹配，
  //    剥掉剂型只剩「鼻炎」两个字的那种词干匹配，正是已修掉的那类噪声
  //    （见《改进记录-2026-09-23-目录关联修复.md》，图谱 492→366）。
  await openQuery('聚焦超声治疗鼻炎')
  const noStem = await cdp.eval(READ_LIST)
  const svc = noStem.find((c) => c.name.includes('聚焦超声治疗鼻炎'))
  check('聚焦超声治疗鼻炎有结果卡', Boolean(svc), JSON.stringify(noStem.map((c) => c.name).slice(0, 4)))
  check('鼻炎片 不再挂到 聚焦超声治疗鼻炎', Boolean(svc) && !svc.hops.some((h) => h.includes('鼻炎片')), JSON.stringify(svc?.hops.slice(0, 3)))

  // 5. 卡托普利试验: 西药去掉剂型后缀后仍是完整药名，这条关联要留着。
  await openQuery('卡托普利试验')
  const withHop = await cdp.eval(READ_LIST)
  const trial = withHop.find((c) => c.name.includes('卡托普利试验'))
  check('卡托普利试验有结果卡', Boolean(trial), JSON.stringify(withHop.map((c) => c.name).slice(0, 4)))
  check('卡托普利 hop 仍挂得上', Boolean(trial?.hopNote) && trial.hops.some((h) => h.includes('卡托普利')), JSON.stringify(trial?.hops.slice(0, 3)))

  // Mixed ordering and the same navigation/filter affordances for both kinds.
  const clickText = async (selector, text) => {
    const clicked = await cdp.eval(`(() => {
      const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.innerText.trim() === ${JSON.stringify(text)})
      n?.click(); return !!n
    })()`)
    if (!clicked) throw new Error(`Missing ${selector}: ${text}`)
    await sleep(700)
  }
  await openQuery('肝素')
  const mixed = await cdp.eval(READ_LIST)
  // 分组顺序就是 orderDirectoryHits 的返回值：在用诊疗 → 药品 → 耗材 → 未生效 → 已停用。
  // 0/1/2/3/4 是这五组的代号，整串非降就等于说五组各就各位、没有串档。
  const groupCode = (row) => (row.drug ? 1 : row.stopped ? 4 : row.pending ? 3 : row.consumable ? 2 : 0)
  check('混合结果：在用诊疗 → 药品 → 耗材 → 已停用', mixed.map(groupCode).join(',') === '0,0,1,1,1,1,1,1,2,2,2,4', JSON.stringify(mixed.map((row) => row.name)))
  check('结果摘要分别显示三类数量', await cdp.eval(`document.querySelector('.result-summary')?.innerText.includes('诊疗 3 · 药品 6 · 耗材 3')`))

  await clickText('.scope-tab', '药品')
  let rows = await cdp.eval(READ_LIST)
  check('切换到药品保留关键词并只展示药品', rows.length === 6 && rows.every((row) => row.drug))
  await cdp.eval(`document.querySelector('.search-clear').click()`)
  await sleep(800)
  check('清空关键词后可直接浏览全部药品', await cdp.eval(`document.querySelectorAll('.result-card.is-drug').length === 40 && document.querySelector('.result-summary').innerText.includes('药品 ${live.drugs}')`))
  const openFilters = async () => {
    await cdp.eval(`document.querySelector('.filter-trigger').click()`)
    await sleep(300)
  }
  await openFilters()
  check('药品分类完整且不显示医院价格档位', await cdp.eval(`document.querySelectorAll('.category-filters .filter-option').length === 9 && !document.querySelector('.level-hint') && !document.querySelector('.service-filters')`))
  check('筛选改为换行网格，没有横向滚动条', await cdp.eval(`(() => { const grids = [...document.querySelectorAll('.filter-grid')]; return !document.querySelector('.cats-scroll') && grids.length === 2 && grids.every((n) => n.scrollWidth <= n.clientWidth + 1) })()`))
  await clickText('.category-filters .filter-option', '西药')
  await clickText('.drug-filters .filter-option', '甲类')
  check('修改草稿不会立即改变列表', await cdp.eval(`document.querySelector('.result-summary').innerText.includes('药品 ${live.drugs}')`))
  await clickText('.filter-apply', '确定')
  check('药品类别和甲类可组合筛选', await cdp.eval(`(() => { const cards = [...document.querySelectorAll('.result-card')]; return cards.length > 0 && cards.every((c) => c.querySelector('.result-meta').innerText.includes('西药') && c.querySelector('.result-meta').innerText.includes('甲类')) })()`))
  const appliedSummary = await cdp.eval(`document.querySelector('.result-summary').innerText`)
  await openFilters()
  await clickText('.filter-reset', '重置')
  await clickText('.filter-close', '取消')
  check('取消放弃未确认的重置', await cdp.eval(`document.querySelector('.result-summary').innerText`) === appliedSummary)
  await openFilters()
  await clickText('.drug-filters .filter-option', '限制支付（限）')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('../search-filters-zh.png', import.meta.url), Buffer.from(shot.data, 'base64'))
  check('确认按钮固定在屏幕内', await cdp.eval(`(() => { const r = document.querySelector('.filter-apply').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })()`))
  await clickText('.filter-apply', '确定')
  rows = await cdp.eval(READ_LIST)
  check('限制支付筛选结果均保留“限”标记', rows.length > 0 && rows.every((row) => row.limited))
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('../search-directory-zh.png', import.meta.url), Buffer.from(shot2.data, 'base64'))

  // 换到诊疗再看一遍肝素。走转发链接进来会重载，作用域本来就在默认的「全部」，
  // 所以这一条只验「诊疗标签下只有诊疗项目」；药品筛选不残留那条在下面同页验。
  await openQuery('肝素')
  await clickText('.scope-tab', '诊疗项目')
  rows = await cdp.eval(READ_LIST)
  check('切到诊疗标签后只显示诊疗项目', rows.length === 3 && rows.every((row) => !row.drug), JSON.stringify(rows.map((row) => row.name)))
  await openFilters()
  await clickText('.service-filters .filter-option', '已停用')
  await clickText('.filter-apply', '确定')
  rows = await cdp.eval(READ_LIST)
  check('已停用筛选不混入药品或在用项目', rows.length === 1 && rows.every((row) => !row.drug && row.stopped))
  await clickText('.scope-tab', '药品')
  rows = await cdp.eval(READ_LIST)
  check('从已停用切到药品不会残留诊疗状态条件', rows.length === 6 && rows.every((row) => row.drug))

  // 耗材那一档：「肝素」在耗材里命中 3 条（1 条医保耗材目录 + 2 条带量采购），
  // 按类别筛只留带量采购那两条。耗材的分类是「一、医用工具类」这种，
  // 和服务项目不是一张表，所以耗材这一档不该出现服务项目那套分类。
  await clickText('.scope-tab', '医用耗材')
  rows = await cdp.eval(READ_LIST)
  check('切到耗材标签后只展示耗材', rows.length === 3 && rows.every((row) => row.consumable && !row.drug), JSON.stringify(rows.map((row) => row.name)))
  await openFilters()
  check('耗材筛选按类别而非服务项目分类', await cdp.eval(`document.querySelectorAll('.hc-filters .filter-option').length === 4 && !document.querySelector('.category-filters') && document.querySelectorAll('.hc-status-filters .filter-option').length === 3`))
  await clickText('.hc-filters .filter-option', '带量采购')
  await clickText('.filter-apply', '确定')
  rows = await cdp.eval(READ_LIST)
  check('耗材按带量采购筛选', rows.length === 2 && rows.every((row) => row.consumable && row.text.includes('带量采购')), JSON.stringify(rows.map((row) => row.name)))

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
