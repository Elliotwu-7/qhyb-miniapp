// 画布标签的折行与宽度估算。
//
// 这是「知识图谱看不清」的直接病灶，所以单独钉住：标签原来一刀切在 6 个字，
// 全目录 42.8% 的条目会和同名前缀的邻居渲染成一模一样（四个「经皮穿刺插管…」、
// 两个「造血干细胞移植后植活状态…」），看图的人根本分不出点的是哪个。
//
// 这里不连浏览器，直接用 esbuild 把 src/lib/graph.ts 打成一个临时模块，
// 断言的是应用真正跑的那份代码，不是抄一遍的副本。
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'G:\\qhyb-miniapp'
const require = createRequire(join(ROOT, 'node_modules', 'x.js'))
const esbuild = require(join(ROOT, 'node_modules', '.pnpm', 'esbuild@0.20.2', 'node_modules', 'esbuild', 'lib', 'main.js'))

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const outDir = mkdtempSync(join(tmpdir(), 'qyb-label-'))
const outFile = join(outDir, 'graph.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'lib', 'graph.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
})
const { starLabel, starLabelWidth, LABEL_FONT } = await import(`file:///${outFile.replace(/\\/g, '/')}`)

// 折行不许吃掉字：两行拼起来要么等于原名，要么是「砍掉尾巴 + 省略号」。
function rebuilt(name, limited) {
  const rows = starLabel(name, limited)
  return rows.join('')
}

check(starLabel('鼻炎片').length === 1, '一行放得下就不折行', starLabel('鼻炎片').join('/'))
check(starLabel('造血干细胞计数').length === 1, '8 个字仍在一行内', starLabel('造血干细胞计数').join('/'))

const ten = starLabel('造血干细胞超低温冻存')
check(ten.length === 2 && ten.every((r) => r.length <= 8), '超过 8 个字折成两行且每行不超 8 个字', ten.join('/'))
check(ten.join('') === '造血干细胞超低温冻存', '折行不丢字', ten.join('/'))
// 调用点传的是原始名字 + limited 标记，前缀由 starLabel 自己拼。
check(starLabel('格菲妥单抗注射液', true).join('') === '限 · 格菲妥单抗注射液', '「限 · 」前缀先拼进正文再折行，不丢字', starLabel('格菲妥单抗注射液', true).join('/'))

// 技术规范常常和它定出的收费项目同名（「腮腺浅叶肿物切除术」两边都这么写），
// 画布上一个是菱形一个是方块，名字却一模一样 —— 「规 · 」前缀是唯一的区分。
const specName = '腮腺浅叶肿物切除术'
check(starLabel(specName, false, true).join('') === `规 · ${specName}`, '「规 · 」前缀先拼进正文再折行，不丢字', starLabel(specName, false, true).join('/'))
check(starLabel(specName).join('') !== starLabel(specName, false, true).join(''), '同名的技术规范与定价项目渲染后能区分', `${starLabel(specName).join('')} ≠ ${starLabel(specName, false, true).join('')}`)
check(starLabelWidth(specName, false, true) > starLabelWidth(specName), '前缀算进了环半径的宽度估算', `${starLabelWidth(specName, false, true)} > ${starLabelWidth(specName)}`)

// 硬切 8/8 会把「限 · 格菲妥单抗注射液」切成「限 · 格菲妥单抗注」+「射液」这种两字尾巴，
// 对半分才不留孤字。
const rows12 = starLabel('格菲妥单抗注射液', true)
check(Math.abs(rows12[0].length - rows12[1].length) <= 1, '两行对半分，不留孤零零的短尾行', rows12.join('/'))

const long = starLabel('X线摄影成像-床旁X线摄影（加收）')
check(long.length === 2, '超长名字仍是两行', long.join('/'))
check(long[1].endsWith('…'), '超长名字末行加省略号', long.join('/'))
check(long.join('').length === 16, '超长名字截到 16 个字', `${long.join('').length} 字`)

// 两个只差一个字的真实目录名，渲染出来必须不一样 —— 这就是原来分不出的那一对。
const a = starLabel('造血干细胞移植后植活状态定性分析').join('')
const b = starLabel('造血干细胞移植后植活状态定量分析').join('')
check(a !== b, '仅一字之差的两个条目渲染后仍能区分', `${a} ≠ ${b}`)
check(a.length === 16 && b.length === 16, '两个名字都完整放得下', `${a.length}/${b.length} 字`)

// 环半径是拿标签宽度倒推的。宽度必须按最宽的那一行算，不能把两行加起来 ——
// 加起来环会算宽一倍，整体缩放变小、字跟着糊；算窄了标签就会叠在一起。
const w16 = starLabelWidth('造血干细胞移植后植活状态定性分析')
const w8 = starLabelWidth('造血干细胞移植后')
check(Math.abs(w16 - w8) < 0.01, '16 个字的宽度＝8 个字的宽度，两行不叠加', `${w16} vs ${w8}`)
check(w16 > LABEL_FONT, '宽度估算不是常数', String(w16))

// 全目录口径：渲染后仍有歧义的条目占比。折行前是 42.8%，现在应当明显低于此。
let ambiguous = ''
try {
  const pack = await (await fetch('https://qhyb.lynkco.site/data/search.json')).json()
  const nameAt = pack.f.indexOf('name')
  const rendered = new Map()
  for (const row of pack.r) {
    const name = String(row[nameAt] || '')
    if (!name) continue
    const key = starLabel(name).join('')
    if (!rendered.has(key)) rendered.set(key, new Set())
    rendered.get(key).add(name)
  }
  let clash = 0
  let total = 0
  for (const names of rendered.values()) {
    total += names.size
    if (names.size > 1) clash += names.size
  }
  const pct = (clash / total) * 100
  ambiguous = `${pct.toFixed(1)}%（${clash}/${total}）`
  check(pct < 15, '渲染后仍分不清的条目占比低于 15%', ambiguous)
} catch (err) {
  console.log(`SKIP  全目录歧义率（取不到目录：${err.message}）`)
}

rmSync(outDir, { recursive: true, force: true })
console.log(`\n${failed ? `${failed} 项未通过` : '全部通过'}`)
process.exit(failed ? 1 : 0)
