// Find ES6->ES5 shadowing hazards across the built mini program bundle.
//
// The WeChat devtools lowers ES6 to ES5. There, `for (const x of xs)` becomes a
// function-scoped `var x`. If the minifier named a nested loop variable the same
// as a module-level binding that the same function also uses, the hoisted `var`
// clobbers it and the earlier read yields undefined — exactly the
// "Cannot read properties of undefined (reading 'isDrug')" crash in relatedOf.
//
// Detection works on the ES6 output (which is what the devtools receives): flag
// a function that both references a module-level binding and declares the same
// name as a nested block-scoped (const/let) binding somewhere below.
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

const ROOT = 'G:\\qhyb-miniapp'
const DIST = join(ROOT, 'dist', 'build', 'mp-weixin')
const require = createRequire(join(ROOT, 'node_modules', 'x.js'))

const parser = require(join(ROOT, 'node_modules', '.pnpm', '@babel+core@7.25.2', 'node_modules', '@babel', 'parser'))
const traverseMod = require(join(ROOT, 'node_modules', '.pnpm', '@babel+core@7.25.2', 'node_modules', '@babel', 'traverse'))
const traverse = traverseMod.default || traverseMod

// 框架预构建产物，不是本仓库源码，不在此守卫生效范围内。
const SKIP = new Set(['common/vendor.js'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function topLevelNames(ast) {
  const names = new Set()
  for (const node of ast.program.body) {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id.type === 'Identifier') names.add(d.id.name)
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      names.add(node.id.name)
    }
  }
  return names
}

const findings = []
for (const file of walk(DIST)) {
  const rel = relative(DIST, file).split('\\').join('/')
  if (SKIP.has(rel)) continue

  let ast
  let code
  try {
    code = readFileSync(file, 'utf8')
    ast = parser.parse(code, { sourceType: 'script' })
  } catch {
    continue
  }
  const globals = topLevelNames(ast)
  if (!globals.size) continue

  traverse(ast, {
    Function(path) {
      const fnScope = path.scope
      const fnNode = path.node

      // 可被顶掉的名字有两类：模块级绑定，以及本函数自己的参数/顶层声明。
      // 后者同样致命 —— `function f(n){ while(..){ const n = .. } }` 降级后
      // `var n` 和参数是同一个绑定，直接把参数冲掉。
      const shadowable = new Set(globals)
      for (const param of fnNode.params) {
        if (param.type === 'Identifier') shadowable.add(param.name)
      }
      // An expression-bodied arrow can return another function whose `body`
      // is a node, not an array. Nested functions are visited independently.
      for (const statement of fnNode.body?.type === 'BlockStatement' ? fnNode.body.body : []) {
        if (statement.type !== 'VariableDeclaration') continue
        for (const decl of statement.declarations) {
          if (decl.id.type === 'Identifier') shadowable.add(decl.id.name)
        }
      }
      // 函数名/自身也不该被块级声明遮蔽
      if (fnNode.id?.name) shadowable.add(fnNode.id.name)

      for (const name of shadowable) {
        // 只在函数体内真的用到这个名字时才值得报（没用到的遮蔽无所谓），
        // 且下面某个子作用域里又用 const/let 声明了同名
        let nested = false
        let referenced = false
        path.traverse({
          VariableDeclaration(p) {
            if (p.scope === fnScope) return
            if (p.node.kind === 'var') return
            for (const d of p.node.declarations) {
              if (d.id.type === 'Identifier' && d.id.name === name) nested = true
            }
          },
          Identifier(p) {
            if (p.node.name === name && p.isReferencedIdentifier()) referenced = true
          },
          Function(p) {
            // 嵌套函数有自己的作用域，不往下走
            p.skip()
          },
        })
        if (nested && referenced) {
          const start = fnNode.start ?? 0
          findings.push({
            file: rel,
            name,
            offset: start,
            snippet: code.slice(start, start + 160).replace(/\s+/g, ' '),
          })
        }
      }
    },
  })
}

const seen = new Set()
const unique = findings.filter((f) => {
  const k = `${f.file}:${f.offset}:${f.name}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

// 允许基线：仓库里存量还有一批同类写法（api/fail/history/price/search/session/guide…），
// 它们今天没炸，但也没人逐个验证过。基线把已知的钉住，只对**新增**报警 —— 否则这个
// 守卫永远是红的，等于没有。
const BASELINE = join(scriptDir, 'es5-shadow-baseline.json')
const counts = {}
for (const f of unique) {
  const key = `${f.file}\t${f.name}`
  counts[key] = (counts[key] || 0) + 1
}

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`, 'utf8')
  console.log(`baseline written: ${Object.keys(counts).length} entries, ${unique.length} hazards total`)
  process.exit(0)
}

let base = {}
try {
  base = JSON.parse(readFileSync(BASELINE, 'utf8'))
} catch {
  console.log('（没有基线文件；先跑一次 --update-baseline 把现状钉住）')
}

const fresh = []
for (const f of unique) {
  const key = `${f.file}\t${f.name}`
  const allowed = base[key] || 0
  const found = counts[key]
  // 同 file+name 的数量超出基线才算新增
  const over = found - allowed
  if (over > 0 && !fresh.some((x) => x.key === key)) {
    fresh.push({ key, over, sample: f })
  }
}

const known = unique.length - fresh.reduce((n, f) => n + f.over, 0)

if (process.argv.includes('--all')) {
  console.log(`全部 ${unique.length} 处：`)
  for (const f of unique) {
    console.log(`\n  ${f.file}  '${f.name}'`)
    console.log(`    ${f.snippet}`)
  }
  process.exit(0)
}

console.log(`已知（基线内）${known} 处，新增 ${fresh.reduce((n, f) => n + f.over, 0)} 处`)

if (!fresh.length) {
  console.log('CLEAN - 没有新增的 ES5 遮蔽风险')
  process.exit(0)
}

console.log('\n新增的遮蔽风险（这些必须修）：')
for (const f of fresh) {
  console.log(`\n  ${f.sample.file}  '${f.sample.name}'  x${f.over}`)
  console.log(`    ${f.sample.snippet}`)
}
process.exit(1)
