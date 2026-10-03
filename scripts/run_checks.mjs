// 跑一遍 scripts/check_*.mjs，逐个记退出码和最后一行。
//
// 串行跑：这些检查都要起 headless Edge，抢的是同一段 CDP 端口，并行会互相干扰。
// 单个检查超过 12 分钟就杀掉（正常最长的 check_graph_page 约 1 分钟），免得整晚挂在一个上面。
//
//   node scripts/run_checks.mjs            全部
//   node scripts/run_checks.mjs h5 spec    只跑名字里含 h5、spec 的
//
// 微信模拟器那三项（check_wechat_search / check_wechat_terms 用 9431，check_privacy_wechat 用
// 9432）要先用开发者工具的 CLI 起自动化，而且**同一个项目同时只能有一个自动化实例** ——
// 起了 9432，9431 那个会被顶掉，两个脚本会 0 秒断连。所以它们不在这条串行流水里能一次全绿：
// 分两趟，先 `cli.bat auto --auto-port 9431` 跑那两项，再 `--auto-port 9432` 跑隐私那项。
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2)
const names = readdirSync(here)
  .filter((f) => f.startsWith('check_') && f.endsWith('.mjs'))
  .filter((f) => !filters.length || filters.some((part) => f.includes(part)))
  .sort()

const results = []
for (const name of names) {
  const started = Date.now()
  const tail = []
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, name)], { cwd: join(here, '..') })
    let buffered = ''
    const eat = (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''
      tail.push(...lines.filter((line) => line.trim()))
      if (tail.length > 40) tail.splice(0, tail.length - 40)
    }
    child.stdout.on('data', (d) => eat(d.toString()))
    child.stderr.on('data', (d) => eat(d.toString()))
    const killer = setTimeout(() => { tail.push('WATCHDOG: 超过 12 分钟，杀掉'); child.kill() }, 720000)
    child.on('close', (c) => { clearTimeout(killer); resolve(c) })
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  results.push({ name, code, seconds, tail: tail.slice(-1)[0] || '(无输出)' })
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}  ${seconds}s  ${results.at(-1).tail.slice(0, 110)}`)
}

const failed = results.filter((r) => r.code !== 0)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.some((r) => r.name.includes('wechat'))) {
  console.log('提示：微信模拟器那几项 0 秒失败通常是自动化端口没起、或被另一个实例顶掉，不是产品坏了。')
}
process.exit(failed.length ? 1 : 0)
