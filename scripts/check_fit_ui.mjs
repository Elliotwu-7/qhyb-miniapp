// 顶栏「返回首页」、长名称/长英文自动缩字号、页脚反馈入口。
//
// 用户报的三条：返回首页应该在最上面最左侧、现在太丑；长名称和长英文要自动缩小字号适配；
// 反馈微信无效。三条都是「看得见才作数」的东西，所以这里量几何、量真实字号，不看截图。
//
// 字号那一套的规则在 src/lib/fit.ts：按视觉宽度分档（汉字 1、拉丁 0.55、藏文 0.8），
// 超过 22 就降一档。这里用同一套权重在浏览器里重算一遍，逐张卡片核对「算出来的档位」和
// 「浏览器真的用了的字号」一致 —— 只断言「有个地方变小了」是不够的。
//
// 尺寸换算：视口 375px、750rpx = 375px，1rpx = 0.5px；页面留白 32rpx = 16px。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserTest, sleep } from '../../QYB/yibao-query/scripts/browser_harness.mjs'
import { installLoginStub, SESSION } from './h5env.mjs'

let checks = 0
const check = (label, ok = true) => { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }
const VERSION = 'v20260923000000-123456789abc'
const LOCAL = 'G:/QYB/yibao-query/public/data'
const QUERY = '阿莫西林'
// 目录里视觉宽度最大的一条（52.2）：34rpx 基数下两行装不下，必须落到最小档加三行。
const LONG_QUERY = '单光子发射断层显像'

// 和 src/lib/fit.ts 同一套权重与分档；两边不一致时下面的逐卡核对会直接失败。
// 卡片名和详情页标题共用这一段，别写两份。
const WEIGHT_JS = `
  const weight = (s) => {
    let w = 0
    for (let i = 0; i < (s || '').length; i += 1) {
      const c = s.charCodeAt(i)
      if (c === 9 || c === 10 || c === 32) w += 0.35
      else if (c >= 0xf00 && c <= 0xfff) w += 0.8
      else if (c >= 0x2e80) w += 1
      else w += 0.55
    }
    return w
  }
  const tier = (s) => { const w = weight(s); return w <= 22 ? 0 : w <= 30 ? 1 : w <= 40 ? 2 : 3 }
  const measure = (n) => {
    const text = n.innerText.replace(/\\s+/g, ' ').trim()
    const cs = getComputedStyle(n)
    return {
      text: text.slice(0, 28),
      weight: Math.round(weight(text) * 10) / 10,
      want: tier(text),
      got: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      clamp: cs.webkitLineClamp,
      overflow: Math.round(n.scrollWidth - n.clientWidth),
    }
  }
`
const FIT_JS = `(() => {${WEIGHT_JS}
  return {
    rows: document.querySelectorAll('.result-name').length,
    long: [...document.querySelectorAll('.result-name')].map((n) => {
      const one = measure(n)
      one.cardOverflow = Math.round(n.getBoundingClientRect().right - n.closest('.result-card').getBoundingClientRect().right)
      return one
    }),
  }
})()`
const DETAIL_FIT_JS = `(() => {${WEIGHT_JS}
  const n = document.querySelector('.drawer-head .name')
  return n ? measure(n) : null
})()`

// 每一档对应的字号（rpx → px，见 yb.scss）。卡片名和详情页标题基数不同，分开列。
const SIZE_OF_TIER = { 0: 17, 1: 15.5, 2: 14, 3: 12.5 }
const SIZE_OF_TIER_DETAIL = { 0: 22, 1: 20, 2: 18.5, 3: 17 }

await browserTest({ root: 'G:/qhyb-miniapp/dist/build/h5', width: 375, height: 900 }, async (b) => {
  // 本机的窗口尺寸不等于 CSS 视口（量到过 496px），字号和左边距就都对不上了。
  // 钉死 375px 之后 1rpx = 0.5px，下面的期望值才是可复现的（同 check_privacy_ui.mjs）。
  await b.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true })
  const json = (requestId, data) => b.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
    body: Buffer.from(JSON.stringify(data)).toString('base64'),
  })
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const path = new URL(request.url).pathname
    try {
      if (request.method === 'OPTIONS') { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'GET,POST,OPTIONS' }] }); return }
      if (path.startsWith('/api/')) { await json(requestId, SESSION); return }
      if (path === '/data/release.json') { await json(requestId, { id: VERSION, base: `/catalog/${VERSION}` }); return }
      const body = await readFile(join(LOCAL, path.replace(/^\/catalog\/[^/]+/, '/data').slice('/data/'.length)))
      await b.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: path.endsWith('.gz') ? 'application/octet-stream' : 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
        body: body.toString('base64'),
      })
    } catch { await b.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {}) }
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://qhyb.lynkco.site/*', requestStage: 'Request' }] })
  await installLoginStub({ send: b.send })

  let visit = 0
  const search = (q) => b.send('Page.navigate', { url: `${b.origin}/?fit=${++visit}#/pages/index/index?q=${encodeURIComponent(q)}` })

  // 首页：顶栏不该出现，页脚的反馈入口要自带微信号（复制失败也还能照着输）。
  await b.send('Page.navigate', { url: `${b.origin}/?fit=0#/pages/index/index` })
  await b.waitFor(`!!document.querySelector('.site-link')`)
  const home = await b.eval(`(() => {
    const link = document.querySelector('.site-link')
    const cs = getComputedStyle(link)
    const r = link.getBoundingClientRect()
    return {
      bars: document.querySelectorAll('.top-bar').length,
      text: link.innerText.trim(),
      height: Math.round(r.height),
      radius: parseFloat(cs.borderTopLeftRadius),
      border: cs.borderTopWidth,
      bg: cs.backgroundColor,
      pageBg: getComputedStyle(document.querySelector('.yb-page')).backgroundColor,
      transition: cs.transitionDuration,
    }
  })()`)
  check(`首页不显示返回首页顶栏（${home.bars} 个）`, home.bars === 0)
  check(`页脚反馈入口写明微信号（${home.text}）`, home.text.includes('lynkcolove'))
  check(`反馈入口是可点的胶囊：高 ${home.height}px、圆角 ${Math.round(home.radius)}px`, home.height >= 30 && home.radius >= 20)
  check(`反馈入口和页脚背景分得开（${home.bg}）`, home.bg !== home.pageBg && home.bg !== 'rgba(0, 0, 0, 0)')
  check(`反馈入口有描边与过渡（${home.border} / ${home.transition}）`, home.border !== '0px' && home.transition !== '0s')

  // 搜索页：返回首页要在最上面、最左侧，而且是个像样的胶囊。
  await search(QUERY)
  await b.waitFor(`!!document.querySelector('.result-card')`)
  const bar = await b.eval(`(() => {
    const pill = document.querySelector('.back-home')
    if (!pill) return { missing: true }
    const cs = getComputedStyle(pill)
    const r = pill.getBoundingClientRect()
    const box = document.querySelector('.search-box').getBoundingClientRect()
    const tabs = document.querySelector('.scope-tabs').getBoundingClientRect()
    const chevron = pill.querySelector('.back-chevron')
    const c = chevron ? getComputedStyle(chevron) : null
    return {
      missing: false,
      bars: document.querySelectorAll('.top-bar').length,
      left: Math.round(r.left),
      top: Math.round(r.top),
      boxTop: Math.round(box.top),
      tabsTop: Math.round(tabs.top),
      height: Math.round(r.height),
      radius: parseFloat(cs.borderTopLeftRadius),
      border: cs.borderTopWidth,
      bg: cs.backgroundColor,
      pageBg: getComputedStyle(document.querySelector('.yb-page')).backgroundColor,
      transition: cs.transitionDuration,
      text: pill.innerText.trim(),
      where: (document.querySelector('.back-where') || {}).innerText,
      hasBackRow: document.querySelectorAll('.back-row').length,
      chevron: c ? { w: Math.round(chevron.getBoundingClientRect().width), transform: c.transform, border: c.borderLeftWidth } : null,
    }
  })()`)
  check('搜索页出现顶栏', !bar.missing && bar.bars === 1)
  check(`返回首页在最左侧（左边距 ${bar.left}px）`, bar.left >= 14 && bar.left <= 18)
  check(`返回首页在最上面（${bar.top} < 搜索框 ${bar.boxTop} < 五栏 ${bar.tabsTop}）`, bar.top < bar.boxTop && bar.boxTop < bar.tabsTop)
  check(`返回首页是胶囊：高 ${bar.height}px、圆角 ${Math.round(bar.radius)}px`, bar.height >= 30 && bar.radius >= 20)
  check(`返回首页和页面底色分得开（${bar.bg}）`, bar.bg !== bar.pageBg)
  check(`返回首页有描边与过渡（${bar.border} / ${bar.transition}）`, bar.border !== '0px' && bar.transition !== '0s')
  check(`返回首页的箭头是画出来的（${bar.chevron && bar.chevron.transform}）`, Boolean(bar.chevron) && bar.chevron.transform !== 'none' && bar.chevron.border !== '0px' && bar.chevron.w >= 6)
  check(`返回首页写着「${bar.text}」，右边写着「${bar.where}」`, bar.text.length > 0 && String(bar.where).length > 0)
  check('旧的返回条已经不在页面里', bar.hasBackRow === 0)

  // 点一下要真的回首页：查询清空、首页那套 hero 回来、顶栏自己消失。
  await b.eval(`document.querySelector('.back-home').click()`)
  await b.waitFor(`!!document.querySelector('.hero-copy') && !document.querySelector('.top-bar')`)
  // uni-app 的 H5 产物把 class 落在 <uni-input> 外壳上，真正的输入框是里面那个 input。
  // 输入框的值要比页面状态晚一拍才落到 DOM 上：hero 已经回来、卡片已经清空的时候，
  // 框里还可能留着旧词，再等一拍才空（小程序里是同步清的，见 miniapp-back-home-top.png）。
  await b.waitFor(`(() => {
    const wrap = document.querySelector('.search-input')
    const field = wrap && (wrap.matches('input') ? wrap : wrap.querySelector('input'))
    return !!field && field.value === ''
  })()`)
  const back = await b.eval(`(() => {
    const wrap = document.querySelector('.search-input')
    const field = wrap && (wrap.matches('input') ? wrap : wrap.querySelector('input'))
    return {
      q: field ? field.value : '(没找到输入框)',
      cards: document.querySelectorAll('.result-card').length,
      hero: !!document.querySelector('.hero-copy'),
    }
  })()`)
  check(`点返回首页后回到首页（搜索框「${back.q}」、卡片 ${back.cards} 张、hero ${back.hero}）`, back.hero && back.q === '' && back.cards === 0)

  // 长名称：目录里最长的那条必须落到最小档，名字不许溢出卡片、不许被省略号切掉。
  await search(LONG_QUERY)
  await b.waitFor(`!!document.querySelector('.result-card')`)
  const long = await b.eval(FIT_JS)
  const worst = long.long.find((n) => n.want === 3)
  check(`查「${LONG_QUERY}」能找到目录里最长的名字（${long.long.length} 张卡片）`, Boolean(worst))
  check(`「${worst ? worst.text : '—'}…」视觉宽度 ${worst ? worst.weight : '—'} → 第 3 档，字号 ${worst ? worst.got : '—'}px`, Boolean(worst) && worst.got === SIZE_OF_TIER[3])
  check(`最长的那条放宽到 ${worst ? worst.clamp : '—'} 行`, Boolean(worst) && worst.clamp === '3')
  check(`最长的那条没有撑出卡片（溢出 ${worst ? worst.cardOverflow : '—'}px）`, Boolean(worst) && worst.cardOverflow <= 0)

  // 逐卡核对：算出来的档位和浏览器真的用的字号必须一致，谁都不许横向溢出。
  // 用「显像」而不是随便一个词：它这一页四个档位都有（长项目名集中在影像类），
  // 否则整页都是第 0 档，这条断言等于没验（下面那条 tier 数量就是防这个的）。
  await search('显像')
  await b.waitFor(`!!document.querySelector('.result-card')`)
  const all = await b.eval(FIT_JS)
  const wrong = all.long.filter((n) => n.got !== SIZE_OF_TIER[n.want])
  const spilled = all.long.filter((n) => n.overflow > 0 || n.cardOverflow > 0)
  const tiers = new Set(all.long.map((n) => n.want))
  check(`逐卡核对 ${all.rows} 张卡片的字号档位都对${wrong.length ? `：错 ${JSON.stringify(wrong.slice(0, 3))}` : ''}`, all.rows > 0 && wrong.length === 0)
  check(`没有名字横向溢出或被切掉${spilled.length ? `：${JSON.stringify(spilled.slice(0, 3))}` : ''}`, spilled.length === 0)
  check(`这一页真的混着好几个档位（${[...tiers].sort().join('/')}），逐卡核对才有意义`, tiers.size >= 2)
  const shrunk = all.long.filter((n) => n.want > 0).length
  console.log(`（这一页 ${all.rows} 张卡片里有 ${shrunk} 张降了字号）`)

  // 长英文/藏文：三种语言下整页都不许横向出屏。以前只有「某几个标签单独调过字号」，
  // 没有一条断言是「整个页面不出屏」，长英文撑破版面就是这么漏掉的。
  // 只算看得见的元素：uni-app 的 H5 运行时会把一个 400×400 的量字探针放进一个 0×0、
  // visibility:hidden 的盒子里，那东西天生「出屏」但看不见也滚不到，不是版面问题。
  const OVERFLOW_JS = `(() => {
    const visible = (n) => (n.checkVisibility ? n.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) : getComputedStyle(n).visibility !== 'hidden')
    const over = [...document.querySelectorAll('body *')].filter((n) => {
      if (!visible(n)) return false
      const r = n.getBoundingClientRect()
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1)
    })
    return {
      page: Math.round(document.documentElement.scrollWidth - innerWidth),
      wide: over.slice(0, 4).map((n) => [n.tagName + (n.id ? '#' + n.id : '') + '.' + (n.className || '(无类名)'),
        '左' + Math.round(n.getBoundingClientRect().left) + ' 宽' + Math.round(n.getBoundingClientRect().width) + ' 右' + Math.round(n.getBoundingClientRect().right),
        getComputedStyle(n).position,
        n.parentElement ? n.parentElement.tagName + '.' + (n.parentElement.className || '(无类名)') : '无父'].join(' ')),
    }
  })()`
  for (const language of ['zh', 'en', 'bo']) {
    await b.eval(`localStorage.setItem('qhyb.locale', JSON.stringify({ type: 'string', data: '${language}' }))`)
    await search(LONG_QUERY)
    await b.waitFor(`!!document.querySelector('.result-card')`)
    await sleep(300)
    const wide = await b.eval(OVERFLOW_JS)
    check(`切到 ${language} 后整页不横向出屏（${wide.page}px${wide.wide.length ? ` · ${wide.wide.join(' / ')}` : ''}）`, wide.page <= 1 && wide.wide.length === 0)
  }
  await b.eval(`localStorage.setItem('qhyb.locale', JSON.stringify({ type: 'string', data: 'zh' }))`)

  // 详情页也扫一遍：长文都在这里（项目内涵、耗材规格表、审核规则），英文/藏文下最容易撑破，
  // 而详情页标题的基数比卡片大 10rpx，缩字号的档位是另一套（SIZE_OF_TIER_DETAIL）。
  for (const language of ['zh', 'en', 'bo']) {
    await b.eval(`localStorage.setItem('qhyb.locale', JSON.stringify({ type: 'string', data: '${language}' }))`)
    await search(LONG_QUERY)
    await b.waitFor(`!!document.querySelector('.result-card')`)
    await b.eval(`document.querySelector('.result-card .result-main').click()`)
    await b.waitFor(`!!document.querySelector('.drawer-head .name')`)
    await sleep(2500)
    const detail = await b.eval(DETAIL_FIT_JS)
    check(`详情页标题也按同一套档位缩（「${detail ? detail.text : '—'}…」宽度 ${detail ? detail.weight : '—'} → 第 ${detail ? detail.want : '—'} 档，字号 ${detail ? detail.got : '—'}px）`,
      Boolean(detail) && detail.got === SIZE_OF_TIER_DETAIL[detail.want])
    const wide = await b.eval(OVERFLOW_JS)
    check(`详情页切到 ${language} 后不横向出屏（${wide.page}px${wide.wide.length ? ` · ${wide.wide.join(' / ')}` : ''}）`, wide.page <= 1 && wide.wide.length === 0)
  }
  await b.eval(`localStorage.setItem('qhyb.locale', JSON.stringify({ type: 'string', data: 'zh' }))`)

  check('无未捕获页面异常', b.errors.length === 0)
  await sleep(200)
})
console.log(`${checks}/${checks} passed`)
