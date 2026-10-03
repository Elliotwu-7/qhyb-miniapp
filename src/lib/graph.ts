import { t } from './i18n'
import { isConsumable, isDrug, isLimitedDrug, isSpec, type CatalogEdge, type SearchItem } from './types'

// 关联网络：药品和诊疗项目之间的推断边。这里只做布局和取数，画在 pages/graph 里。
// 注意：不能用 for...of —— 微信把 ES6 降到 ES5 时循环变量会被提升成函数作用域的 var，
// 撞上模块级绑定就会把同函数里更早的引用顶成 undefined。见 README。
//
// 布局为什么是「一个中心 + 一圈邻居」而不是力导向：
// 全目录只有 492 条项目边（加上同分类边共 3303 条），最大度数 10，95% 的节点度数
// 只有 1~2 —— 它本来就是一簇小星星，不是一张网。原来的力导向把 84 个节点铺在画布上，
// 只能在初始圆环上适配一次缩放（那时节点还没散开），直接画成一团糊。
// 星形布局是确定性的：半径由标签宽度倒推，画布永远正好装下，也就不需要重新适配。

export type GraphNode = {
  id: string
  label: string
  drug: boolean
  /** 技术规范条目：既不是药品也不是收费项目，画成菱形以免和两者混淆。 */
  spec: boolean
  /** 医用耗材（目录编码 / 挂网产品 / 带量采购）：画成三角形，第四种节点。 */
  hc: boolean
  hcKind?: string
  drugKind?: string
  limited?: boolean
  degree: number
  /** 与中心节点的关系类型；中心自己为空串 */
  rel: string
  x: number
  y: number
}

export type GraphLink = {
  a: number
  b: number
  rel: string
}

export type GraphData = {
  nodes: GraphNode[]
  links: GraphLink[]
  center: string
  /** 因为画布放不下而没画出来的邻居数（列表里仍然一条不少） */
  dropped: number
}

/**
 * 关系可信度排序。技术规范排在最前：它是定价的上游（先有规范，再出项目定价），
 * 所以规范节点始终出现在环的最前面，不会被别的邻居挤下去。
 * 医保智能审核规则紧随其后 —— 它是官方规则（一条规则挂一串项目），但一个项目
 * 的规范关系永远比规则关系更该先看到。推断出来的关系一律排在官方关系之后。
 */
const REL_RANK: Record<string, number> = { spec: 8, name: 7, audit: 6, indication: 5, consumable: 4, hcclass: 3, class: 2, text: 1 }

/** 列表和画布都用同一套关系排序，免得两处顺序对不上。 */
export const REL_ORDER = REL_RANK

/**
 * 一个中心最多画几个邻居。
 * 实测最大度数只有 10、且全目录只有 8 个节点超过 9，所以这个上限只压到极少数枢纽；
 * 再密下去环形半径会撑大、整体缩放随之变小，字就跟着糊了。
 */
export const MAX_STAR = 8

/**
 * 其中最多画几个技术规范。
 * 一个收费项目可以由几十条规范合并而来（实测最多 30 条），全画出来会把原来的
 * 药品—诊疗关系整个挤出画布；列表里仍然一条不少，只是画布上留最近的三条。
 */
export const MAX_SPEC = 3
const MIN_RADIUS = 126
/** 关系分组之间留的圆心角（弧度） */
const GROUP_GAP = 0.24
export const LABEL_FONT = 10
/**
 * 标签一行放几个字、最多两行。
 * 目录里的项目名中位数就有 10 个字，只留一行 6 个字时，全目录 42.8% 的条目会和
 * 同名前缀的邻居撞成一样（「造血干细胞超…」和「造血干细胞移…」还好，四个
 * 「经皮穿刺插管…」就完全分不出）。两行 8 个字能完整放下 85% 的名字，
 * 而宽度只按最长的那一行算，环半径不会被撑大。
 */
const LABEL_COLS = 8
const LABEL_ROWS = 2

const DRUG_COLORS: Record<string, string> = {
  xiyao: '#2563eb',
  zhongcheng: '#16a34a',
  tanpan: '#7c3aed',
  jingjia: '#0891b2',
  yinpian: '#b45309',
  minzu: '#be185d',
  shangbao: '#0d9488',
  excluded: '#6b7280',
}

export const REL_COLOR: Record<string, string> = {
  name: '#2563eb',
  text: '#94a3b8',
  consumable: '#0891b2',
  indication: '#7c3aed',
  class: '#f59e0b',
  spec: '#4f46e5',
  audit: '#dc2626',
  hcclass: '#65a30d',
}

/** 技术规范节点圆点的颜色，和 spec 关系线同色。 */
export const SPEC_COLOR = '#4f46e5'
/** 耗材节点圆点的颜色，和 consumable 关系线同色。 */
export const HC_COLOR = '#0891b2'

export function nodeRadius(node: Pick<GraphNode, 'drug' | 'hc' | 'degree'>): number {
  const base = node.drug ? 6 : node.hc ? 5.5 : 5
  return base + Math.min(8, Math.sqrt(node.degree) * 2.2)
}

/**
 * 画布标签按每行 8 个字折成两行，超出的部分截断加省略号。
 * 「限 · 」前缀会占掉第一行的位置，所以先拼进去再折行，两边的行宽才对得上。
 * 技术规范也带「规 · 」：规范名常常和它定出的收费项目同名（「腮腺浅叶肿物切除术」两边
 * 都这么写），不标出来，画布上就是两个一模一样的名字，看不出哪个是菱形。
 *
 * 一行放得下就不折；要折就两行对半分，不按 8 个字硬切 —— 硬切会把
 * 「限 · 格菲妥单抗注射液」切成「限 · 格菲妥单抗注」+「射液」这种两字尾巴。
 * 对半分之后每行都不超过 8 个字，starLabelWidth 取最宽的一行，环半径不会变大。
 *
 * 画布上只放得下这么多，完整名字仍然留给下面的节点卡片。
 */
export function starLabel(name: string, limited = false, spec = false): string[] {
  const prefix = limited ? `${t('common.limitedShort')} · ` : spec ? `${t('graph.specShort')} · ` : ''
  const text = `${prefix}${name}`
  if (!/[\u3400-\u9fff]/.test(name)) return wrapTranslatedLabel(text)
  if (text.length <= LABEL_COLS) return [text]
  const clipped = text.length > LABEL_COLS * LABEL_ROWS ? `${text.slice(0, LABEL_COLS * LABEL_ROWS - 1)}…` : text
  const cut = Math.ceil(clipped.length / 2)
  return [clipped.slice(0, cut), clipped.slice(cut)]
}

function labelPixels(text: string): number {
  let width = 0
  Array.from(text).forEach((char) => {
    // Tibetan vowel and subjoined signs belong to the preceding base glyph.
    if (/[\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0fbc]/.test(char)) return
    width += /[\x00-\xff]/.test(char) ? LABEL_FONT * 0.5 : LABEL_FONT
  })
  return width
}

function wrapTranslatedLabel(text: string): string[] {
  const tokens = text.match(/[^\s་༌།༎]+[\s་༌།༎]*|[\s་༌།༎]+/g) || [text]
  const rows: string[] = []
  let line = ''
  const glyphs: string[] = []
  tokens.forEach((token) => {
    if (line && labelPixels(line + token) > LABEL_COLS * LABEL_FONT) {
      rows.push(line.trim()); line = ''
    }
    line += token
  })
  if (line) rows.push(line.trim())
  return rows.slice(0, LABEL_ROWS).map((row, i) => {
    glyphs.length = 0
    Array.from(row).forEach((char) => {
      if (glyphs.length && /[\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0fbc]/.test(char)) glyphs[glyphs.length - 1] += char
      else glyphs.push(char)
    })
    let clipped = i === LABEL_ROWS - 1 && rows.length > LABEL_ROWS
    while (glyphs.length > 1 && labelPixels(glyphs.join('') + (clipped ? '…' : '')) > LABEL_COLS * LABEL_FONT) {
      glyphs.pop(); clipped = true
    }
    return glyphs.join('') + (clipped ? '…' : '')
  })
}

/**
 * 标签宽度估算：画布用 10px sans-serif，中文按一个字宽、西文按半个字宽。
 * 布局靠它倒推环半径，保证同一环上相邻节点的标签不叠在一起 —— 这正是原来
 * 「密密麻麻看不清」的直接原因，所以宽度必须参与布局，不能只在画的时候截断。
 * 折行后按最宽的那一行算：两行是上下叠的，撑开环半径的是横向宽度。
 */
export function starLabelWidth(name: string, limited = false, spec = false): number {
  let widest = 0
  starLabel(name, limited, spec).forEach((row) => {
    widest = Math.max(widest, labelPixels(row))
  })
  return widest + 14
}

export function drugColor(kind: string | undefined, fallback: string): string {
  return (kind && DRUG_COLORS[kind]) || fallback
}

/**
 * 给没有项目关系的药品补上同医保分类的邻接关系。
 * 这类边只表示目录分类相近，不表示可以互相替代，也不冒充临床适应症关系。
 */
export function addDrugClassEdges(edges: CatalogEdge[], byId: Map<string, SearchItem>): CatalogEdge[] {
  const linkedDrugs = new Set<string>()
  edges.forEach((edge) => linkedDrugs.add(edge.drugId))
  const groups = new Map<string, string[]>()
  byId.forEach((item) => {
    if (!isDrug(item)) return
    const key = item.classCode || item.className
    if (!key) return
    const rows = groups.get(key)
    if (rows) rows.push(item.id)
    else groups.set(key, [item.id])
  })
  const out = edges.slice()
  const seen = new Set<string>(edges.map((edge) => `${edge.drugId}\u0000${edge.serviceId}`))
  groups.forEach((ids) => {
    if (ids.length < 2) return
    ids.sort((a, b) => (byId.get(a)?.name || '').localeCompare(byId.get(b)?.name || '', 'zh-CN'))
    ids.forEach((id, i) => {
      if (i === 0) return
      const previous = ids[i - 1]
      if (linkedDrugs.has(id) && linkedDrugs.has(previous)) return
      const key = `${previous}\u0000${id}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ drugId: previous, serviceId: id, rel: 'class', src: 'catalog-class' })
    })
  })
  return out
}

/**
 * 以 centerId 为中心摆成一个星形：中心在原点，邻居按关系分组顺时针铺在同一环上。
 * 同组相邻、组间留空隙，于是连线一条都不会交叉。位置完全确定，没有随机数、没有迭代，
 * 所以画布一次适配就是终态。
 */
/** 邻接表只由边和端点在不在决定，和中心无关。换中心时重算整张表是白做的：
 *  同一组边和同一张 id 表算出来的结果缓存起来，边或节点变了自然对不上。 */
const adjacencyCache: {
  edges: CatalogEdge[] | null
  byId: Map<string, SearchItem> | null
  adjacency: Map<string, Set<string>>
  pairRel: Map<string, string>
} = { edges: null, byId: null, adjacency: new Map(), pairRel: new Map() }

function adjacencyOf(edges: CatalogEdge[], byId: Map<string, SearchItem>) {
  if (adjacencyCache.edges === edges && adjacencyCache.byId === byId) return adjacencyCache
  const adjacency = new Map<string, Set<string>>()
  const pairRel = new Map<string, string>()
  edges.forEach((edge) => {
    if (!byId.has(edge.drugId) || !byId.has(edge.serviceId)) return
    const near = adjacency.get(edge.drugId)
    if (near) near.add(edge.serviceId)
    else adjacency.set(edge.drugId, new Set([edge.serviceId]))
    const far = adjacency.get(edge.serviceId)
    if (far) far.add(edge.drugId)
    else adjacency.set(edge.serviceId, new Set([edge.drugId]))
    const pair = [edge.drugId, edge.serviceId].sort().join('\u0000')
    const previous = pairRel.get(pair)
    if (!previous || (REL_RANK[edge.rel] || 0) > (REL_RANK[previous] || 0)) pairRel.set(pair, edge.rel)
  })
  adjacencyCache.edges = edges
  adjacencyCache.byId = byId
  adjacencyCache.adjacency = adjacency
  adjacencyCache.pairRel = pairRel
  return adjacencyCache
}

export function buildStar(
  edges: CatalogEdge[],
  byId: Map<string, SearchItem>,
  centerId: string,
  maxNeighbors = MAX_STAR,
  maxSpec = MAX_SPEC,
): GraphData {
  // 这个模块刻意只写：函数顶层的声明 + forEach 回调。
  // 块内的 const/let 在微信降级成 ES5 时会提升成 var，撞上参数或模块级绑定
  // 就把同函数里更早的引用顶成 undefined（relatedOf 就是这样崩的）。
  const cached = adjacencyOf(edges, byId)
  const adjacency = cached.adjacency
  const pairRel = cached.pairRel
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const bucket: Array<{ rel: string; ids: string[] }> = []
  const picked: Array<{ id: string; rel: string }> = []
  const ring: Array<{ rel: string; ids: string[] }> = []
  let dropped = 0
  let widest = 0
  let arcPer = 0
  let radius = 0
  let arc = 0
  let cursor = 0
  let specPicked = 0

  const centerItem = byId.get(centerId)
  if (!centerItem) return { nodes, links, center: centerId, dropped }

  const around = adjacency.get(centerId)
  if (!around || !around.size) return { nodes, links, center: centerId, dropped }

  Array.from(around).forEach((id) => {
    const rel = pairRel.get([centerId, id].sort().join('\u0000')) || 'text'
    const slot = bucket.find((item) => item.rel === rel)
    if (slot) slot.ids.push(id)
    else bucket.push({ rel, ids: [id] })
  })
  // 关系类型按可信度排序，组内按度数排 —— 最相关的邻居摆在最前面，画布上也最靠上。
  bucket.sort((x, y) => (REL_RANK[y.rel] || 0) - (REL_RANK[x.rel] || 0))
  bucket.forEach((item) => {
    item.ids.sort(
      (x, y) =>
        (adjacency.get(y)?.size || 0) - (adjacency.get(x)?.size || 0) ||
        String(byId.get(x)?.name || '').localeCompare(String(byId.get(y)?.name || ''), 'zh-CN'),
    )
  })

  bucket.forEach((item) => {
    item.ids.forEach((id) => {
      const row = byId.get(id)
      // 变量名刻意不叫 isSpec：graph.ts 从 types 引入了同名函数，
      // 这里的块内 const 降级 ES5 会把模块引用顶成 undefined（见 README）。
      const specNode = Boolean(row && row.spec)
      if (specNode && specPicked >= maxSpec) {
        dropped += 1
        return
      }
      if (picked.length < maxNeighbors) {
        picked.push({ id, rel: item.rel })
        if (specNode) specPicked += 1
      } else {
        dropped += 1
      }
    })
  })

  picked.forEach((entry) => {
    const slot = ring.find((item) => item.rel === entry.rel)
    if (slot) slot.ids.push(entry.id)
    else ring.push({ rel: entry.rel, ids: [entry.id] })
  })

  picked.forEach((entry) => {
    const item = byId.get(entry.id)
    const width = starLabelWidth(String(item?.name || ''), isLimitedDrug(item), Boolean(item?.spec))
    if (width > widest) widest = width
  })
  arcPer = widest + 10
  radius = Math.max(MIN_RADIUS, (picked.length * arcPer) / 5)
  arc = 2 * Math.asin(Math.min(0.85, arcPer / (2 * radius)))

  nodes.push({
    id: centerId,
    label: centerItem.name,
    drug: isDrug(centerItem),
    spec: isSpec(centerItem),
    hc: isConsumable(centerItem),
    hcKind: isConsumable(centerItem) ? centerItem.hcKind : undefined,
    drugKind: isDrug(centerItem) ? centerItem.kind : undefined,
    limited: isLimitedDrug(centerItem),
    degree: around.size,
    rel: '',
    x: 0,
    y: 0,
  })

  // 从正上方起顺时针铺；每组占的圆心角由组内节点数和标签宽度决定。
  cursor = -Math.PI / 2
  ring.forEach((item, gi) => {
    item.ids.forEach((id, i) => {
      const item2 = byId.get(id)
      if (!item2) return
      const angle = cursor + arc * (i + 0.5)
      nodes.push({
        id,
        label: item2.name,
        drug: isDrug(item2),
        spec: isSpec(item2),
        hc: isConsumable(item2),
        hcKind: isConsumable(item2) ? item2.hcKind : undefined,
        drugKind: isDrug(item2) ? item2.kind : undefined,
        limited: isLimitedDrug(item2),
        degree: adjacency.get(id)?.size || 0,
        rel: item.rel,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      })
    })
    cursor += item.ids.length * arc + (gi === ring.length - 1 ? 0 : GROUP_GAP)
  })

  // 每个非中心节点都恰好有一条到中心的边，关系类型就存在节点上。
  nodes.forEach((node, i) => {
    if (i === 0) return
    links.push({ a: 0, b: i, rel: node.rel })
  })

  return { nodes, links, center: centerId, dropped }
}

/**
 * 没指定中心时画谁：度数最高的条目。实测最高是 10 条关系（格菲妥单抗注射液、
 * 肾上腺素等 8 个并列），同分按名字排，所以每次都是同一个 —— 否则转发出去的图
 * 和别人点开看到的不是一张。
 * 与其摊开 84 个节点的糊图，不如直接给一个真实、看得清的入口。
 */
export function topHub(edges: CatalogEdge[], byId: Map<string, SearchItem>): string {
  const degree = new Map<string, number>()
  let best = ''
  let bestDegree = -1
  let bestName = ''

  edges.forEach((edge) => {
    if (!byId.has(edge.drugId) || !byId.has(edge.serviceId)) return
    degree.set(edge.drugId, (degree.get(edge.drugId) || 0) + 1)
    degree.set(edge.serviceId, (degree.get(edge.serviceId) || 0) + 1)
  })

  Array.from(degree.keys()).forEach((id) => {
    const count = degree.get(id) || 0
    const name = String(byId.get(id)?.name || '')
    if (count > bestDegree || (count === bestDegree && name.localeCompare(bestName, 'zh-CN') < 0)) {
      best = id
      bestDegree = count
      bestName = name
    }
  })

  return best
}
