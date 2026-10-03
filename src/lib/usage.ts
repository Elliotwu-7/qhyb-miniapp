export type UsageRow = { title: string; body: string }

const CLAUSE_SPLIT = /(?=(?:^|\n)\s*\d+[.\u3001\uff0e.]\s*)/
const CLAUSE_HEAD = /^\s*\d+[.\u3001\uff0e.]\s*/
const SKIP_QUOTE = /价格构成|加收项|扩展项|基本物耗|部位|血管|学科/
const GENERIC_TITLES = new Set(['价格构成说明', '加收项说明', '扩展项说明', '基本物耗'])

export function splitUsageClauses(blob: string): string[] {
  const text = (blob || '').trim()
  if (!text) return []
  return text
    .split(CLAUSE_SPLIT)
    .map((part) => part.replace(CLAUSE_HEAD, '').trim())
    .filter(Boolean)
}

function quotedNames(body: string): string[] {
  const out: string[] = []
  const re = /[“"]([^”"]{2,40})[”"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push(m[1])
  return out
}

function parentStem(name: string): string {
  if (!/(加收|扩展)/.test(name)) return ''
  const stem = name.split(/[-—－]/)[0].replace(/[（(](加收|扩展)[）)]/g, '').trim()
  return stem && stem !== name ? stem : ''
}

function nameTokens(name: string): string[] {
  const stem = parentStem(name) || name
  const core = name.replace(/[（(](加收|扩展)[）)]/g, '').trim()
  const out: string[] = []
  // 这里的循环都用数组方法而不是 for...of：微信开发者工具把 for...of 降级成
  // 函数作用域的 var，循环变量一旦和模块级绑定同名就会把同函数内的引用顶掉。
  ;[name, stem, core, ...core.split(/[-—－]/)].forEach((s) => {
    const t = s.trim()
    if (t.length >= 2 && !out.includes(t)) out.push(t)
  })
  return out
}

function stripParen(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, '').trim()
}

function mentions(body: string, quotes: string[], toks: string[]): boolean {
  if (toks.some((t) => Boolean(t) && body.includes(t))) return true
  return quotes.some((q) => {
    const qcore = stripParen(q)
    return toks.some((t) => {
      const tcore = stripParen(t)
      if (!qcore || !tcore) return false
      return q.includes(t) || t.includes(q) || qcore.includes(tcore) || tcore.includes(qcore)
    })
  })
}

function clauseTitle(body: string): string {
  const head = body.slice(0, 120)
  if (head.includes('价格构成')) return '价格构成说明'
  if (head.includes('加收项')) return '加收项说明'
  if (head.includes('扩展项')) return '扩展项说明'
  if (head.includes('基本物耗') || head.includes('基本物质资源')) return '基本物耗'
  if (head.includes('计价单位')) return '计价单位'
  if (
    (head.includes('项目内涵') || head.includes('服务产出')) &&
    (head.includes('设立价格项目') || head.includes('立项') || head.includes('合并'))
  ) {
    return '类别说明'
  }
  if (head.startsWith('根据《深化医疗服务价格改革')) return '类别说明'
  return ''
}

function relatedTitle(quotes: string[], toks: string[]): string {
  const hit = quotes
    .filter((q) => !SKIP_QUOTE.test(q))
    .find((q) =>
      toks.some((t) => {
        const tcore = t.replace(/[（(].*$/, '')
        return q.includes(t) || t.includes(q) || Boolean(tcore && q.includes(tcore))
      }),
    )
  return hit || '项目相关条款'
}

function isOtherItemClause(quotes: string[], toks: string[]): boolean {
  return quotes.some((q) => q.length >= 4 && !SKIP_QUOTE.test(q) && !mentions(q, [q], toks))
}

/** Split a category usage blob into labeled rows for the current item. */
export function usageRowsFor(blob: string, name: string): UsageRow[] {
  const toks = nameTokens(name)
  const generic: UsageRow[] = []
  const related: UsageRow[] = []
  const leftover: UsageRow[] = []
  const seenGeneric = new Set<string>()
  splitUsageClauses(blob).forEach((body) => {
    const title = clauseTitle(body)
    const quotes = quotedNames(body)
    const hit = mentions(body, quotes, toks)
    if (GENERIC_TITLES.has(title)) {
      if (!seenGeneric.has(title)) {
        seenGeneric.add(title)
        generic.push({ title, body })
      }
      return
    }
    if (hit) {
      related.push({ title: title || relatedTitle(quotes, toks), body })
      return
    }
    if (isOtherItemClause(quotes, toks)) return
    leftover.push({ title: title || '类别说明', body })
  })
  return [...generic, ...related, ...leftover]
}

export function compactUsageRows(rows: UsageRow[]): UsageRow[] {
  return rows.filter((row) => !GENERIC_TITLES.has(row.title))
}
