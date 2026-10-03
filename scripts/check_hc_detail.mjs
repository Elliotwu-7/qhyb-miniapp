// 耗材详情页的三套数据面：医保耗材目录（版本沿革 / 材质规格）、挂网产品（规格与价格 /
// 企业 / 耗材编码）、带量采购（中选规格 / 中选项目 / 不含中选价），外加公示未生效、
// 已废止两种状态条，以及收费项目详情页上的医保智能审核规则那一块。
//
// 每个用例都直接开详情页（H5 里详情不要登录，登录门只挡着首页的搜索）。目录包每次导航
// 都要重下，所以一条要等十几秒，取 6 个样本是有意的：再多的导航换不来新断言。
//
// 运行：node scripts/check_hc_detail.mjs
import { freePort, startStatic, launchEdge, sleep } from './h5env.mjs'

// 端口问系统要（见 h5env.freePort）：摇骰子会撞上本机常驻程序，0 秒崩在启动那一步。
const PORT = await freePort()
const CDP_PORT = await freePort()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 一页读干净：区块名、行、色块、折叠按钮、价格头、状态条，不逐条去点 DOM 猜。 */
const READ = `(() => {
  const t = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const head = document.querySelector('.hc-head-price')
  const banner = document.querySelector('.banner')
  const section = (n) => {
    const box = n.closest('.surface') || document.body
    return {
      label: t(n.innerText),
      rows: box.querySelectorAll('.hc-row').length,
      chips: box.querySelectorAll('.hc-chip').length,
      codes: box.querySelectorAll('.hc-chip.is-code').length,
      auditGroups: box.querySelectorAll('.audit-group').length,
      auditRows: box.querySelectorAll('.audit-row').length,
      auditJumps: box.querySelectorAll('.audit-row .jump').length,
      auditOther: box.querySelectorAll('.audit-row .audit-other').length,
      more: [...box.querySelectorAll('.history-more')].map((x) => t(x.innerText)),
      // 说明文字（价格口径提示、不含中选价、单边说明）都在区块最后，单独收一份：
      // 区块正文动辄上千字，截断了正好会把这些尾巴切掉。
      muted: [...box.querySelectorAll('.muted')].map((x) => t(x.innerText)),
      text: t(box.innerText).slice(0, 900),
    }
  }
  return {
    name: t(document.querySelector('.drawer-head .name')?.innerText),
    body: t(document.body.innerText),
    rows: [...document.querySelectorAll('.desc-row')].map((r) => [t(r.querySelector('.k')?.innerText), t(r.querySelector('.v')?.innerText)]),
    sections: [...document.querySelectorAll('.section-label')].map(section),
    headPrice: head ? { label: t(head.querySelector('.hc-price-label')?.innerText), value: t(head.querySelector('.hc-price-value')?.innerText) } : null,
    banner: t(banner?.innerText),
    bannerClass: banner ? banner.className : '',
    ok: Boolean(document.querySelector('.hc-ok')),
  }
})()`

const sectionOf = (page, prefix) => page.sections.find((s) => s.label.startsWith(prefix)) || null
/** 「规格与价格（18）」里的括号数：区块名自带序号，用它比数字符串更稳。 */
const countIn = (label) => Number((String(label).match(/（(\d+)）/) || [])[1] || 0)

let edge
async function main() {
  const stat = startStatic()
  await stat.listen(PORT)
  const launched = await launchEdge(CDP_PORT)
  const cdp = launched.cdp
  edge = launched

  let seenErrors = 0
  const newErrors = () => {
    const fresh = cdp.errors.slice(seenErrors)
    seenErrors = cdp.errors.length
    return fresh
  }

  let hop = 0
  /**
   * 打开一条详情，等 `ready` 那个选择器出现再读。
   *
   * 两处坑：换 hash 不会重载文档，SPA 会留着上一条的 `item`，所以地址栏前头挂一个
   * 变化的 `?t=`；而名字和 desc-row 是条目包给的、明细分片是第二次请求，等
   * `.section-label` 会早读到空的分片，必须等到分片自己那块内容画出来。
   */
  const open = async (id, ready) => {
    newErrors()
    hop += 1
    await cdp.goto(`http://127.0.0.1:${PORT}/?t=${hop}#/pages/detail/detail?id=${encodeURIComponent(id)}`)
    const until = Date.now() + 120000
    let last = ''
    for (;;) {
      try {
        if (await cdp.eval(`document.querySelector(${JSON.stringify(ready)}) !== null`)) break
        last = await cdp.eval(`(document.querySelector('.drawer-head .name')?.innerText || '').trim()`)
      } catch { /* 页面正在跳转，下一轮再问 */ }
      if (Date.now() >= until) throw new Error(`详情页没渲染出 ${ready}：${id}${last ? `（当前是 ${last}）` : ''}`)
      await sleep(700)
    }
    await sleep(400)
    return cdp.eval(READ)
  }

  // 1. 挂网产品：编码即注册证号，价格按规格落在明细分片里 —— 18 个规格只有 2 个填了
  //    挂网价，另外 16 个是其他省份参考价，所以「口径不一致」那句必须出现。
  const product = await open('hcp:国械注准20153130031', '.hc-row')
  check('挂网产品详情：标题与注册证号',
    product.name.includes('房间隔缺损封堵器') && product.rows.find(([k]) => k === '注册证号')?.[1] === '国械注准20153130031',
    `${product.name} / 注册证号 ${product.rows.find(([k]) => k === '注册证号')?.[1]}`)
  check('挂网产品的价格带口径与数值', product.headPrice?.value === '20000' && product.headPrice?.label === '挂网价', JSON.stringify(product.headPrice))
  check('挂网产品不另印耗材编码行（编码就是注册证号）', !product.rows.some(([k]) => k === '耗材编码'), JSON.stringify(product.rows.map(([k]) => k)))
  check('价格口径提示写清不等于支付标准', Boolean(product.headPrice) && product.body.includes('不等于医保支付标准'), product.body.includes('不等于医保支付标准') ? '' : product.body.slice(0, 120))
  check('填写比例按规格算：共 18 个、2 个填了挂网价', product.body.includes('共 18 个规格，其中 2 个填了挂网价'))
  check('同证下口径不一致时说明以规格为准', product.body.includes('价格口径不一致'))
  const variants = sectionOf(product, '规格与价格')
  check('规格与价格只铺前 8 条，其余折起来', variants?.rows === 8 && variants.more.includes('展开其余 10 条'), JSON.stringify({ label: variants?.label, rows: variants?.rows, more: variants?.more }))
  check('规格与价格标了总数', countIn(variants?.label) === 18, String(variants?.label))
  check('采购价不是支付标准的提示在规格区块里', Boolean(variants?.muted.some((m) => m.includes('都是采购价格'))), JSON.stringify(variants?.muted))
  const firms = sectionOf(product, '企业')
  check('企业区块列出生产企业与配送企业', Boolean(firms?.text.includes('上海锦葵医疗器械股份有限公司') && firms.text.includes('生产企业') && firms.text.includes('配送企业')), firms?.text.slice(0, 90))
  const codes = sectionOf(product, '耗材编码')
  check('耗材编码逐个列出并折叠', countIn(codes?.label) === 18 && codes.codes === 12 && codes.more.includes('展开其余 6 条'), JSON.stringify({ label: codes?.label, codes: codes?.codes, more: codes?.more }))
  check('挂网产品没有版本沿革（那是目录条目才有的）', !sectionOf(product, '版本沿革'))

  // 2. 医保耗材目录条目：分类路径、版本沿革、材质规格、公立机构目录标记。
  const catalog = await open('hc:AAAA01', '.hc-row')
  check('目录条目详情：编码与分类路径',
    catalog.name.includes('避光输液器') && catalog.rows.find(([k]) => k === '耗材编码')?.[1] === 'AAAA01' && Boolean(catalog.rows.find(([k]) => k === '目录分类')?.[1]),
    JSON.stringify(catalog.rows.map(([k, v]) => [k, String(v).slice(0, 28)])))
  check('目录条目没有价格头也没有价格提示', catalog.headPrice === null && !catalog.body.includes('共 7 个规格，其中'))
  const versions = sectionOf(catalog, '版本沿革')
  check('版本沿革逐版列支付类别与出处', versions?.rows === 4 && versions.text.includes('乙类') && versions.text.includes('青海省医保医用耗材目录（2020年版）'), JSON.stringify({ rows: versions?.rows, text: versions?.text?.slice(0, 160) }))
  const specs = sectionOf(catalog, '材质与规格')
  check('材质与规格按材质-规格成对列出', countIn(specs?.label) === 7 && specs.rows === 7, JSON.stringify({ label: specs?.label, rows: specs?.rows }))
  check('材质与规格不折叠（7 条没到阈值）', specs?.more.length === 0, JSON.stringify(specs?.more))
  check('列入公立机构目录的标记在', catalog.ok && catalog.body.includes('同时列入青海省公立医疗机构医用耗材目录'))
  check('目录条目没有规格与价格区块（价格只挂在注册证上）', !sectionOf(catalog, '规格与价格'))

  // 3. 带量采购：中选规格一大串（105 条只铺 12 条），没有中选价要写清楚。
  const lot = await open('hcl:99d8a32f', '.hc-chip')
  check('带量采购详情：标题与中选项目', lot.name.includes('一次性使用腔镜直线型切割吻合器及组件') && lot.rows.find(([k]) => k === '中选项目')?.[1] === '腔镜吻合器（重庆牵头省际联盟）', JSON.stringify(lot.rows.map(([k, v]) => [k, String(v).slice(0, 26)])))
  const lotSpecs = sectionOf(lot, '中选规格')
  check('中选规格只铺前 12 条并折叠', countIn(lotSpecs?.label) === 105 && lotSpecs.chips === 12 && lotSpecs.more.includes('展开其余 93 条'), JSON.stringify({ label: lotSpecs?.label, chips: lotSpecs?.chips, more: lotSpecs?.more }))
  check('带量采购说明不含中选价', lot.body.includes('中选结果只收录中选规格，不含中选价'))
  check('带量采购不铺规格与价格、也不铺耗材编码', !sectionOf(lot, '规格与价格') && !sectionOf(lot, '耗材编码') && lot.headPrice === null)
  const lotFirms = sectionOf(lot, '企业')
  check('企业区块回落到条目上的生产企业', Boolean(lotFirms?.text.includes('湖南康呈医疗科技有限公司')), lotFirms?.text?.slice(0, 60) || '(没有企业区块)')

  const toggled = await cdp.eval(`(() => {
    const box = [...document.querySelectorAll('.surface')].find((s) => (s.querySelector('.section-label')?.innerText || '').includes('中选规格'))
    const btn = box?.querySelector('.history-more')
    if (!btn) return null
    btn.click()
    return true
  })()`)
  await sleep(500)
  const expanded = await cdp.eval(`(() => {
    const box = [...document.querySelectorAll('.surface')].find((s) => (s.querySelector('.section-label')?.innerText || '').includes('中选规格'))
    return { chips: box.querySelectorAll('.hc-chip').length, more: [...box.querySelectorAll('.history-more')].map((x) => x.innerText.trim()) }
  })()`)
  check('中选规格点开就是全部 105 条，按钮变「收起」', toggled === true && expanded.chips === 105 && expanded.more.join('') === '收起', JSON.stringify(expanded))

  // 4. 两个状态：公示未生效、已废止。耗材只有这两档加在用，没有合并那一说。
  const pending = await open('hc:AABC04', '.hc-row')
  check('公示未生效的耗材走 banner-pending 并带上公示说明', pending.bannerClass.includes('banner-pending') && pending.banner.includes('公示未生效') && pending.banner.includes('2026 年 6 月公示'), pending.banner)
  const stopped = await open('hc:AAAB08', '.hc-row')
  check('已废止的耗材走 banner-stop 并带上废止说明', stopped.bannerClass.includes('banner-stop') && stopped.banner.includes('已废止') && stopped.banner.includes('2020 年版未沿用'), stopped.banner)
  check('耗材详情不出现收费项目那套分级价格行', !stopped.rows.some(([k]) => /三级|二级|一级/.test(k)), JSON.stringify(stopped.rows.map(([k]) => k)))
  check('耗材详情不带关联网络的诊断说明', !stopped.body.includes('有效成分') && !stopped.body.includes('价格构成'))

  // 5. 医保智能审核规则：只有收费项目会命中。特级护理被 27 条规则点到 —— 其中 24 条
  //    是「a 是特级护理」，另有 3 条是别的主项把自己算在特级护理头上，两个方向都要收。
  //    最长的重复收费那组 24 条，每组只留 5 条：5 + 1 + 2 = 8 行，3 行是单边（点不进去）。
  const audit = await open('master:ACAD0001:特级护理', '.audit-group')
  const block = sectionOf(audit, '医保智能审核规则')
  // hc-links 是 { links, meta }，不是字段包。它一旦被当成坏包丢掉，审核规则和耗材分类
  // 相近这两层关系会静默消失，页面上只留一句「部分目录或关联数据未加载完成」。
  check('目录与关联数据都加载完整（没有部分加载的提示）', !audit.body.includes('部分目录或关联数据未加载完成'), audit.body.slice(0, 80))
  check('审核规则按规则分组，每组只留前 5 条', block?.auditGroups === 3 && block.auditRows === 8, JSON.stringify({ groups: block?.auditGroups, rows: block?.auditRows }))
  check('审核规则标了总条数', block?.label.includes('27 条'), String(block?.label))
  check('审核规则写清是官方规则、不代表临床判断', Boolean(block?.text.includes('是官方规则') && block?.text.includes('不代表临床判断')))
  check('两边都能落到条目上的那 5 行可以点进去', block?.auditJumps === 5 && block.auditOther === 3, JSON.stringify({ jumps: block?.auditJumps, other: block?.auditOther }))
  check('长组折叠成「展开其余 19 条」', block?.more.includes('展开其余 19 条'), JSON.stringify(block?.more))
  check('查不到编码的 3 条单独说明', block?.muted.some((m) => /另有 3 条规则涉及的项目在现行目录里查不到编码/.test(m)), JSON.stringify(block?.muted))
  check('耗材详情不带审核规则', !sectionOf(catalog, '医保智能审核规则') && !sectionOf(product, '医保智能审核规则') && !sectionOf(lot, '医保智能审核规则'))

  check('全部用例无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | ').slice(0, 200))
}

main()
  .catch((err) => {
    console.error('ERROR', err.message)
    results.push({ name: 'harness', ok: false, detail: err.message })
  })
  .finally(() => {
    try { edge?.kill() } catch { /* 已经退了 */ }
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
