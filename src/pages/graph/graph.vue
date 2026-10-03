<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ContentNotice from '../../components/ContentNotice.vue'
import HomePill from '../../components/HomePill.vue'
import SearchTermsNotice from '../../components/SearchTermsNotice.vue'
import { loadSearchTerms, searchTermRevision } from '../../lib/search-terms'
import { useContentTranslation, contentRevision } from '../../lib/content'
import { tibetanFontReady } from '../../lib/font'
import { onLoad, onShareAppMessage, onShareTimeline, onShow } from '@dcloudio/uni-app'
import {
  addDrugClassEdges,
  buildStar,
  drugColor,
  HC_COLOR,
  LABEL_FONT,
  nodeRadius,
  REL_COLOR,
  REL_ORDER,
  SPEC_COLOR,
  starLabel,
  topHub,
  type GraphData,
  type GraphNode,
} from '../../lib/graph'
import { categoryLabel, drugKindText, edgeRelText, hcKindText, locale, localeClass, t } from '../../lib/i18n'
import { loadItemSpecs, loadSpec, specAsSearchItem, specCodeOf, specNodeId, isSpecNode, type ItemSpecs, type SpecDetail } from '../../lib/nhcSpec'
import { enableShare, shareQuery } from '../../lib/share'
import { catalogReady } from '../../lib/store'
import { routeValue } from '../../lib/route'
import { orderDirectoryHits, searchCatalog } from '../../lib/search'
import { applyChrome, themeMode } from '../../lib/theme'
import { isConsumable, isDrug, isLimitedDrug, isSpec, type CatalogEdge, type SearchItem } from '../../lib/types'

const MAX_VISIBLE_LINKS = 8
onShow(() => { void loadSearchTerms() })
const { ct, original } = useContentTranslation(true)
/** 标签行高：字号 10 再留一点行距，两行才不会糊成一片。 */
const LABEL_LINE = LABEL_FONT + 6

/**
 * 一个节点的标签折行和宽度。换中心、入场、视图过渡、拖动、捏合每一帧都要画标签，
 * 而折行只取决于「译文 + 限/规前缀」，跟帧无关：算一次记在节点上，后面的帧直接取。
 * 用 WeakMap 而不是挂到节点对象上 —— 节点是布局算出来的共享结构，不往里塞字段。
 * 节点对象每次换中心都是新建的，旧的自然被回收；译文变了（语言、翻译批次、
 * 审定术语、显示原文、藏文字体）由下面的 watch 整张丢掉重算。
 * draw 和 fitView 必须用同一份：适配视图按的宽度和画出来的宽度要是同一个数。
 */
type LabelLayout = { rows: string[]; width: number }
let labelLayouts = new WeakMap<Node, LabelLayout>()

function labelLayout(node: Node): LabelLayout {
  const cached = labelLayouts.get(node)
  if (cached) return cached
  const rows = starLabel(ct(node.label), Boolean(node.limited), Boolean(node.spec))
  let widest = 0
  rows.forEach((row) => {
    let pixels = 0
    Array.from(row).forEach((char) => {
      // 藏文元音和上下加字算在前一个基字上，不另占宽度；西文按半个字宽。
      // 和 starLabelWidth 里的估算用同一套规则，环半径才不会算偏。
      if (/[ཱ-྄྆-྇ྍ-ྼ]/.test(char)) return
      pixels += /[\x00-\xff]/.test(char) ? LABEL_FONT * 0.5 : LABEL_FONT
    })
    if (pixels > widest) widest = pixels
  })
  const laid = { rows, width: widest + 14 }
  labelLayouts.set(node, laid)
  return laid
}

const graph = ref<GraphData | null>(null)
const seed = ref('')
const center = ref('')
/** 点着节点一路走下去的路径，用来「返回」 */
const trail = ref<string[]>([])
const error = ref('')
const catalogWarnings = ref(false)
const catalogLoading = ref(false)
const ready = ref(false)
const showAllLinks = ref(false)
/** 关联节点的入场只在换中心时播一次。showAllLinks 一变列表就重渲染，
 *  动画挂在列表上的话，展开「另外 N 条」会把前 8 条也从头播一遍。 */
const relatedFresh = ref(false)
let relatedFreshTimer = 0

function replayRelated() {
  relatedFresh.value = false
  clearTimeout(relatedFreshTimer)
  relatedFreshTimer = setTimeout(() => {
    relatedFresh.value = true
  }, 30) as unknown as number
}
const graphQuery = ref('')
const tibetanQuery = computed(() => /[\u0f00-\u0fff]/.test(graphQuery.value))
const legendRelations = ['spec', 'name', 'audit', 'indication', 'consumable', 'hcclass', 'class', 'text']

type Node = GraphData['nodes'][number]
type Point = { x: number; y: number }
type TouchLike = { clientX?: number; clientY?: number; pageX?: number; pageY?: number; x?: number; y?: number }

const nodesRef = ref<Node[]>([])
const linksRef = ref<GraphData['links']>([])
const viewRef = ref({ x: 0, y: 0, zoom: 1 })
const canvasRef = ref<unknown>(null)
const ctxRef = ref<unknown>(null)
const dprRef = ref(1)
const sizeRef = ref({ w: 0, h: 0, left: 0, top: 0 })
const byIdRef = ref<Map<string, SearchItem>>(new Map())
const edgesRef = ref<CatalogEdge[]>([])
/** 耗材那两类边：耗材分类相近（推断）和医保智能审核规则（官方）。和目录边分开存。 */
const hcEdgesRef = ref<CatalogEdge[]>([])
/** 技术规范的节点和边：按当前中心临时取，和目录数据分开存，不混进目录。 */
const specByIdRef = ref<Map<string, SearchItem>>(new Map())
const specEdgesRef = ref<CatalogEdge[]>([])
/** 取规范的请求序号：晚返回的旧请求不能覆盖新中心。 */
let specRequest = 0
/** 已经问过规范的中心（哪怕答案是「没有」）：避免每次切中心都重问一遍。 */
const specFetched = new Set<string>()

const allEdges = computed(() => edgesRef.value.concat(specEdgesRef.value, hcEdgesRef.value))

function graphItem(id: string): SearchItem | undefined {
  return specByIdRef.value.get(id) || byIdRef.value.get(id)
}

const dark = computed(() => themeMode.value === 'dark')
const palette = computed(() =>
  dark.value
    ? {
        surface: '#171e2b',
        text: '#eef2f8',
        muted: '#9aa6b8',
        border: '#334056',
        primary: '#8ba8ff',
        primarySoft: '#263760',
        service: '#314057',
        serviceStroke: '#71809a',
        spec: '#8b93ff',
        specStroke: '#0f1522',
        hc: '#22b8d8',
        hcStroke: '#0f1522',
        grid: '#253044',
        labelBg: '#202a3b',
      }
    : {
        surface: '#ffffff',
        text: '#1a1d26',
        muted: '#697386',
        border: '#dfe5ee',
        primary: '#2660ff',
        primarySoft: '#edf2ff',
        service: '#e9eef7',
        serviceStroke: '#9aa8bd',
        spec: SPEC_COLOR,
        specStroke: '#ffffff',
        hc: HC_COLOR,
        hcStroke: '#ffffff',
        grid: '#edf1f6',
        labelBg: '#ffffff',
      },
)

const stats = computed(() => {
  const g = graph.value
  if (!g || !g.nodes.length) return { drugs: 0, services: 0, specs: 0, hc: 0, links: 0, dropped: 0 }
  const drugs = g.nodes.filter((node) => node.drug).length
  const specs = g.nodes.filter((node) => node.spec).length
  const hc = g.nodes.filter((node) => node.hc).length
  return { drugs, services: g.nodes.length - drugs - specs - hc, specs, hc, links: g.links.length, dropped: g.dropped }
})

const selectedItem = computed(() => (center.value ? graphItem(center.value) || null : null))
const backItem = computed(() => {
  const id = trail.value[trail.value.length - 1]
  return id ? graphItem(id) || null : null
})

const headText = computed(() => {
  const g = graph.value
  if (!g || g.nodes.length <= 1) return t('graph.emptyHead')
  return t('graph.centerHead', { name: ct(selectedItem.value?.name), count: g.nodes.length - 1 })
})

const zoomLabel = computed(() => `${Math.round(viewRef.value.zoom * 100)}%`)
const graphEmpty = computed(() => Boolean(graph.value && graph.value.nodes.length <= 1))

let graphSearchTimer = 0
let graphSearchVersion = 0
const graphResults = ref<SearchItem[]>([])
/** 下拉结果的入场只在「换了一批结果」时播一次。挂在列表上又每敲一个字
 *  重渲染的话，边打字边看会一直从头淡入。 */
const resultsFresh = ref(false)
let resultsFreshTimer = 0

function replayResults() {
  resultsFresh.value = false
  clearTimeout(resultsFreshTimer)
  resultsFreshTimer = setTimeout(() => {
    resultsFresh.value = true
  }, 30) as unknown as number
}

function refreshGraphResults() {
  const version = ++graphSearchVersion
  const query = graphQuery.value
  if (graphSearchTimer) clearTimeout(graphSearchTimer)
  if (!query.trim()) {
    graphResults.value = []
    return
  }
  // 目录有几万条，每敲一个字就整库检索会把输入卡住。等一拍再算，连着打字只算最后一次。
  graphSearchTimer = setTimeout(() => {
    if (version !== graphSearchVersion) return
    const next = orderDirectoryHits(searchCatalog(graphCatalog(), query)).slice(0, 6)
    const prev = graphResults.value
    graphResults.value = next
    if (next.length && next.map((item) => item.id).join('\u0000') !== prev.map((item) => item.id).join('\u0000')) replayResults()
  }, 80) as unknown as number
}

watch(graphQuery, refreshGraphResults)

// 同一对节点可能同时有多条不同类型的边，取可信度最高的那条，和画布上的连线一致。
const selectedLinks = computed(() => {
  const id = center.value
  if (!id) return []
  const best = new Map<string, string>()
  const out: Array<{ id: string; name: string; rel: string; code: string; spec: boolean; page: number }> = []
  allEdges.value.forEach((edge) => {
    let other = ''
    if (edge.drugId === id) other = edge.serviceId
    else if (edge.serviceId === id) other = edge.drugId
    if (!other) return
    const previous = best.get(other)
    if (!previous || (REL_ORDER[edge.rel] || 0) > (REL_ORDER[previous] || 0)) best.set(other, edge.rel)
  })
  best.forEach((rel, other) => {
    const item = graphItem(other)
    if (!item) return
    out.push({ id: other, name: item.name, rel, code: item.code || '', spec: isSpec(item), page: Number(item.page || 0) })
  })
  return out.sort((a, b) => (REL_ORDER[b.rel] || 0) - (REL_ORDER[a.rel] || 0) || a.name.localeCompare(b.name, 'zh-CN'))
})

const visibleSelectedLinks = computed(() =>
  showAllLinks.value ? selectedLinks.value : selectedLinks.value.slice(0, MAX_VISIBLE_LINKS),
)
const hiddenSelectedLinks = computed(() => Math.max(0, selectedLinks.value.length - MAX_VISIBLE_LINKS))

/** 技术规范和医保智能审核规则都是原文对应，不是推断，别跟着别的边一起标「推断关系」。 */
function relatedRel(row: { rel: string; spec: boolean; page: number }) {
  if (row.spec) return t('graph.specRel', { page: row.page })
  if (row.rel === 'audit') return `${edgeRelText('audit')} · ${t('graph.official')}`
  return `${edgeRelText(row.rel)} · ${t('graph.inferred')}`
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function draw() {
  const ctx = ctxRef.value as CanvasRenderingContext2D | null
  const canvas = canvasRef.value as { width: number; height: number } | null
  if (!ctx || !canvas) return
  const w = sizeRef.value.w
  const h = sizeRef.value.h
  const zoom = viewRef.value.zoom
  const p = palette.value
  // 每次都从 dpr 变换重来，不假设画布上留着什么：initCanvas 在 H5 上实测会被调多次
  // （onLoad 触发多次），每次都拿同一个 context，谁少配平一次 save/restore，残留的
  // 变换就会带到下一张图上。变换只在 draw 里铺，initCanvas 不碰。
  ctx.setTransform(dprRef.value, 0, 0, dprRef.value, 0, 0)
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = p.surface
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.translate(w / 2 + viewRef.value.x, h / 2 + viewRef.value.y)
  ctx.scale(zoom, zoom)

  const reach = Math.max(w, h) / zoom + 60
  ctx.strokeStyle = p.grid
  ctx.lineWidth = 1 / zoom
  ctx.globalAlpha = 0.5
  let gx = -reach
  while (gx <= reach) {
    ctx.beginPath()
    ctx.moveTo(gx, -reach)
    ctx.lineTo(gx, reach)
    ctx.stroke()
    gx += 48
  }
  let gy = -reach
  while (gy <= reach) {
    ctx.beginPath()
    ctx.moveTo(-reach, gy)
    ctx.lineTo(reach, gy)
    ctx.stroke()
    gy += 48
  }

  // 星形布局里每条边都从中心出发，所以不存在交叉；全部同权画就行。
  // 边跟着两端里入场较慢的那个节点一起淡出：节点还是点的时候边不该先齐。
  // linkAlpha 提到循环外，循环里的块级声明降级 ES5 会顶掉同名引用，见 README。
  let linkAlpha = 0
  let linkAlphaB = 0
  linksRef.value.forEach((link) => {
    const a = nodesRef.value[link.a]
    const b = nodesRef.value[link.b]
    if (!a || !b) return
    linkAlpha = nodeRevealOf(a.id, link.a === 0)
    linkAlphaB = nodeRevealOf(b.id, link.b === 0)
    if (linkAlphaB < linkAlpha) linkAlpha = linkAlphaB
    ctx.strokeStyle = REL_COLOR[link.rel] || p.muted
    ctx.globalAlpha = 0.5 * linkAlpha
    ctx.lineWidth = 1.4 / zoom
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  })

  nodesRef.value.forEach((node, i) => {
    const r = nodeRadius(node)
    const isCenter = i === 0
    const reveal = nodeRevealOf(node.id, isCenter)
    ctx.globalAlpha = reveal
    ctx.save()
    ctx.translate(node.x, node.y)
    ctx.scale(0.82 + 0.18 * reveal, 0.82 + 0.18 * reveal)
    ctx.translate(-node.x, -node.y)
    if (isCenter) {
      ctx.globalAlpha = 0.16 * reveal
      ctx.fillStyle = p.primary
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = reveal
    }
    ctx.fillStyle = node.drug ? drugColor(node.drugKind, p.primary) : node.spec ? p.spec : node.hc ? p.hc : p.service
    ctx.strokeStyle = isCenter ? p.primary : node.drug ? '#ffffff' : node.spec ? p.specStroke : node.hc ? p.hcStroke : p.serviceStroke
    ctx.lineWidth = (isCenter ? 2.6 : 1.2) / zoom
    ctx.beginPath()
    // 四种节点四种形状：药品圆、收费项目方、技术规范菱形、医用耗材三角 —— 光靠颜色分不出色觉差异。
    if (node.drug) ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
    else if (node.spec) {
      ctx.moveTo(node.x, node.y - r)
      ctx.lineTo(node.x + r, node.y)
      ctx.lineTo(node.x, node.y + r)
      ctx.lineTo(node.x - r, node.y)
      ctx.closePath()
    } else if (node.hc) {
      // 三角形要往下多占一点：重心偏上才看得像正三角，和菱形、方块也才分得开。
      ctx.moveTo(node.x, node.y - r * 1.15)
      ctx.lineTo(node.x + r, node.y + r * 0.8)
      ctx.lineTo(node.x - r, node.y + r * 0.8)
      ctx.closePath()
    } else ctx.rect(node.x - r, node.y - r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
    if (node.limited) {
      ctx.fillStyle = '#f59e0b'
      ctx.beginPath()
      ctx.arc(node.x + r * 0.72, node.y - r * 0.72, 2.8 / zoom, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  })

  // 节点少（最多 9 个），标签就全画出来 —— 这才是「看清关系」的关键。
  // 字号和 starLabelWidth 里估算布局用的是同一个值，布局才不会算错。
  // 标签底盘的位置提到循环外算：入场时节点从中心长出来，底盘要跟着节点的缩放一起走，
  // 不能停在终点上让字先到、点后到。循环里不开块级声明，降级 ES5 会顶掉同名引用，见 README。
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${LABEL_FONT}px ${locale.value === 'bo' ? '"QhybTibetan", ' : ''}sans-serif`
  let labelReveal = 0
  let labelScale = 0
  let labelTop = 0
  nodesRef.value.forEach((node, i) => {
    const laid = labelLayout(node)
    const rows = laid.rows
    const width = laid.width
    labelReveal = nodeRevealOf(node.id, i === 0)
    labelScale = 0.82 + 0.18 * labelReveal
    labelTop = node.y * labelScale + nodeRadius(node) + 6
    ctx.globalAlpha = 0.94 * labelReveal
    ctx.fillStyle = p.labelBg
    ctx.fillRect(node.x * labelScale - width / 2, labelTop - 2, width, rows.length * LABEL_LINE + 4)
    ctx.fillStyle = p.text
    rows.forEach((row, i) => {
      ctx.fillText(row, node.x * labelScale, labelTop + LABEL_LINE * (i + 0.5))
    })
  })

  ctx.globalAlpha = 1
  ctx.restore()
}

function localPoint(touch: TouchLike): Point {
  const left = sizeRef.value.left
  const top = sizeRef.value.top
  if (typeof touch.clientX === 'number' && typeof touch.clientY === 'number') return { x: touch.clientX - left, y: touch.clientY - top }
  if (typeof touch.pageX === 'number' && typeof touch.pageY === 'number') return { x: touch.pageX - left, y: touch.pageY - top }
  return { x: Number(touch.x || 0), y: Number(touch.y || 0) }
}

function toWorld(localX: number, localY: number) {
  const w = sizeRef.value.w
  const h = sizeRef.value.h
  return {
    x: (localX - w / 2 - viewRef.value.x) / viewRef.value.zoom,
    y: (localY - h / 2 - viewRef.value.y) / viewRef.value.zoom,
  }
}

function nodeAt(localX: number, localY: number): number {
  const p = toWorld(localX, localY)
  let hit = -1
  nodesRef.value.forEach((node, i) => {
    const r = nodeRadius(node) + 14
    const dx = p.x - node.x
    const dy = p.y - node.y
    if (dx * dx + dy * dy <= r * r) hit = i
  })
  return hit
}

let panning = false
let moved = false
let lastPoint: Point = { x: 0, y: 0 }
let pinching = false
let pinchDistance = 0
let pinchZoom = 1
let pinchWorld: Point = { x: 0, y: 0 }
/** 换中心时的视图过渡。拖动或捏合一开始就把进行中的过渡作废，免得手指和动画抢位置。 */
let viewTweenToken = 0
let viewTweenTimer = 0
const VIEW_TWEEN_MS = 260
/** 节点入场：中心先亮，邻居按环上的顺序错开一小拍淡入并放大到原位。 */
let nodeRevealToken = 0
let nodeRevealTimer = 0
let nodeRevealAt = 0
let nodeRevealOrder: string[] = []
/** 节点编号到入场顺序的对照，跟着 nodeRevealOrder 一起换。
 *  draw 一帧里每个节点、每条边都要查一次顺序，数组 indexOf 是从头找，
 *  这一下提到换中心时算好，帧里只剩一次取数。 */
let nodeRevealIndex = new Map<string, number>()
const NODE_REVEAL_MS = 240
const NODE_REVEAL_STAGGER = 26

function nodeRevealOf(id: string, centerNode: boolean): number {
  if (!nodeRevealAt) return 1
  const order = nodeRevealIndex.get(id)
  const delay = (centerNode ? 0 : (order === undefined ? 0 : order) + 1) * NODE_REVEAL_STAGGER
  const t = (Date.now() - nodeRevealAt - delay) / NODE_REVEAL_MS
  if (t >= 1) return 1
  if (t <= 0) return 0
  return 1 - (1 - t) * (1 - t) * (1 - t)
}

function startNodeReveal() {
  const token = ++nodeRevealToken
  nodeRevealAt = Date.now()
  nodeRevealOrder = nodesRef.value.map((node) => node.id)
  nodeRevealIndex = new Map<string, number>()
  nodeRevealOrder.forEach((nodeId, i) => {
    nodeRevealIndex.set(nodeId, i)
  })
  // 用画布自己的逐帧回调而不是 setTimeout 每隔 16 毫秒重画：setTimeout 没有跟屏幕刷新对齐，
  // 到点了才排进队列，帧就挤在一起，入场看起来一顿一顿。回调里不另开块级声明，
  // 降级 ES5 时 var 提升会顶掉上面的参数，见 README。
  const canvas = canvasRef.value as { requestAnimationFrame?: (cb: () => void) => number } | null
  const schedule = canvas && canvas.requestAnimationFrame
    ? (cb: () => void) => canvas.requestAnimationFrame!(cb)
    : (cb: () => void) => setTimeout(cb, 16) as unknown as number
  const step = () => {
    if (token !== nodeRevealToken) return
    draw()
    if (Date.now() - nodeRevealAt < NODE_REVEAL_MS + NODE_REVEAL_STAGGER * nodeRevealOrder.length) {
      nodeRevealTimer = schedule(step)
    } else {
      nodeRevealAt = 0
      draw()
    }
  }
  nodeRevealTimer = schedule(step)
}

function distance(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * 捏合的开头和后续各自成函数，而不是在 onTouchStart/onTouchMove 里写成 if 块。
 * 块里的 const 被压缩器改名后可能和外面的参数同名（e/a/u 之类），微信把 ES6 降成 ES5 时
 * `var` 提升会顶掉参数 —— scripts/check_es5_shadow.mjs 专门拦这个，实测就是这么报出来的。
 * 拆成独立函数后函数体内没有嵌套的块级声明，压缩器怎么改名都撞不上参数。
 */
function beginPinch(touches: TouchLike[]): boolean {
  if (touches.length < 2) return false
  viewTweenToken += 1
  const first = localPoint(touches[0])
  const second = localPoint(touches[1])
  const spot = midpoint(first, second)
  pinching = true
  pinchDistance = Math.max(1, distance(first, second))
  pinchZoom = viewRef.value.zoom
  pinchWorld = toWorld(spot.x, spot.y)
  panning = false
  moved = true
  return true
}

function trackPinch(touches: TouchLike[]): boolean {
  if (touches.length < 2) return false
  const first = localPoint(touches[0])
  const second = localPoint(touches[1])
  const spot = midpoint(first, second)
  // 两指中点钉在原来的世界坐标上，缩放才不会往左上角跑
  const zoom = clamp((pinchZoom * distance(first, second)) / pinchDistance, 0.6, 2.4)
  viewRef.value.zoom = zoom
  viewRef.value.x = spot.x - sizeRef.value.w / 2 - pinchWorld.x * zoom
  viewRef.value.y = spot.y - sizeRef.value.h / 2 - pinchWorld.y * zoom
  draw()
  return true
}

function onTouchStart(e: { touches: TouchLike[] }) {
  const touches = e.touches || []
  if (beginPinch(touches)) return
  const t = touches[0]
  if (!t) return
  viewTweenToken += 1
  lastPoint = localPoint(t)
  panning = true
  moved = false
}

function onTouchMove(e: { touches: TouchLike[] }) {
  const touches = e.touches || []
  if (pinching && trackPinch(touches)) return
  const t = touches[0]
  if (!t) return
  const point = localPoint(t)
  const dx = point.x - lastPoint.x
  const dy = point.y - lastPoint.y
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
  lastPoint = point
  if (panning) {
    viewRef.value.x += dx
    viewRef.value.y += dy
    draw()
  }
}

function onTouchEnd() {
  if (pinching) {
    pinching = false
    panning = false
    return
  }
  // 判断和取点都摊在函数体一层：块里的 const 会被压缩器改成短名，
  // 降级 ES5 时提到函数顶，压掉同名引用（同 check_es5_shadow 的那类）。
  const wasTap = panning && !moved
  panning = false
  if (!wasTap) return
  // 0 是中心自己，点它没有意义
  const hit = nodeAt(lastPoint.x, lastPoint.y)
  if (hit > 0) focusNode(nodesRef.value[hit].id)
}

/**
 * 只取这个中心的规范关系，不换中心。
 * onReady 给「必须等数据才画得出」的调用方（规范节点不在目录里）；不给就只在真有新边时补画一次。
 */
function loadSpecsFor(id: string, onReady?: () => void) {
  if (specFetched.has(id)) return
  const version = ++specRequest
  void fetchSpecNeighbors(id).then((result) => {
    if (version !== specRequest) return
    specFetched.add(id)
    const added = addSpecNeighbors(result.items, result.edges)
    if (onReady) onReady()
    else if (added) applyCenter(id, false)
  })
}

/** 换中心：重算星形、视图平滑过渡过去。位置是确定算出来的，过渡只改缩放和平移，不会跳错。 */
function focusNode(id: string, push = true) {
  if (id === center.value) return false
  const previous = center.value
  const ready = !isSpecNode(id) || specFetched.has(id)
  if (ready) {
    if (push && previous) trail.value = [...trail.value, previous]
    applyCenter(id)
    loadSpecsFor(id)
    return true
  }
  // 规范节点要等数据到了才画得出，那就等到了再换中心 —— 先换会闪一个空图。
  loadSpecsFor(id, () => {
    if (push && previous) trail.value = [...trail.value, previous]
    applyCenter(id)
  })
  return false
}

function applyCenter(id: string, resetQuery = true) {
  const built = buildStar(allEdges.value, mergedById(), id)
  if (!built.nodes.length) return false
  graph.value = built
  nodesRef.value = built.nodes
  linksRef.value = built.links
  center.value = built.center
  showAllLinks.value = false
  replayRelated()
  if (resetQuery) graphQuery.value = ''
  // 先开入场计时再适配：fitView 在位移很小的时候会当场 draw 一次，
  // 计时还没开的话那一帧节点是满不透明的，下一帧才跳回 0 开始淡入。
  startNodeReveal()
  fitView()
  return true
}

/** 合并后的节点表按两张源表的身份记一份。
 *  buildStar 的邻接缓存认的就是这张表的身份：每次调用都 new Map 的话，
 *  换中心时整张邻接表都会重算一遍。规范节点是后来才并进去的，所以规范表变了也要重做。 */
let mergedByIdCache: { base: Map<string, SearchItem>; spec: Map<string, SearchItem>; out: Map<string, SearchItem> } | null = null

function mergedById(): Map<string, SearchItem> {
  const base = byIdRef.value
  const spec = specByIdRef.value
  if (mergedByIdCache && mergedByIdCache.base === base && mergedByIdCache.spec === spec) return mergedByIdCache.out
  const out = new Map<string, SearchItem>(base)
  spec.forEach((item, id) => out.set(id, item))
  mergedByIdCache = { base, spec, out }
  return out
}

/** 图谱搜索框每敲一个字都要把整张节点表摊成数组再检索。节点表只在目录
 *  重新加载时才换，摊出来的数组按表的身份记一份，连着打字就不用每次重摊。 */
let graphCatalogCache: { base: Map<string, SearchItem>; out: SearchItem[] } | null = null

function graphCatalog(): SearchItem[] {
  const base = byIdRef.value
  if (graphCatalogCache && graphCatalogCache.base === base) return graphCatalogCache.out
  const out = Array.from(base.values())
  graphCatalogCache = { base, out }
  return out
}

/**
 * 取这个中心的规范关系。规范是定价的上游，所以两个方向都要：
 * 收费项目问「我由哪些规范形成」，规范问「我形成了哪些收费项目」。
 */
async function fetchSpecNeighbors(id: string): Promise<{ items: SearchItem[]; edges: CatalogEdge[] }> {
  const items: SearchItem[] = []
  const edges: CatalogEdge[] = []
  let detail: SpecDetail | null = null
  let node: SearchItem | null = null
  let links: ItemSpecs | null = null
  if (isSpecNode(id)) {
    detail = await loadSpec(specCodeOf(id))
    if (!detail) return { items, edges }
    node = specAsSearchItem(detail.spec)
    items.push(node)
    detail.items.forEach((serviceId) => {
      edges.push({ drugId: id, serviceId, rel: 'spec', src: 'nhc-spec' })
    })
    return { items, edges }
  }
  links = await loadItemSpecs(id)
  links.specs.forEach((spec) => {
    const specNode = specAsSearchItem(spec)
    items.push(specNode)
    edges.push({ drugId: specNode.id, serviceId: id, rel: 'spec', src: 'nhc-spec' })
  })
  return { items, edges }
}

/** 已经取到的规范节点只增不减：来回切中心时不必重取，也不会把上一张图撕掉。 */
function addSpecNeighbors(items: SearchItem[], edges: CatalogEdge[]): boolean {
  const next = new Map(specByIdRef.value)
  const seen = new Set<string>()
  const added: CatalogEdge[] = []
  let changed = false
  items.forEach((item) => {
    if (!next.has(item.id)) {
      next.set(item.id, item)
      changed = true
    }
  })
  if (changed) specByIdRef.value = next
  if (!edges.length) return changed
  allEdges.value.forEach((edge) => seen.add(`${edge.drugId}\u0000${edge.serviceId}`))
  edges.forEach((edge) => {
    const key = `${edge.drugId}\u0000${edge.serviceId}`
    if (seen.has(key)) return
    seen.add(key)
    added.push(edge)
  })
  if (added.length) {
    specEdgesRef.value = specEdgesRef.value.concat(added)
    changed = true
  }
  return changed
}

function goBack() {
  const previous = trail.value[trail.value.length - 1]
  if (!previous) return
  trail.value = trail.value.slice(0, -1)
  focusNode(previous, false)
}

function focusSearchItem(item: SearchItem) {
  graphQuery.value = ''
  graphResults.value = []
  focusNode(item.id)
}

function beginViewTween(targetZoom: number, targetX: number, targetY: number) {
  const fromZoom = viewRef.value.zoom
  const fromX = viewRef.value.x
  const fromY = viewRef.value.y
  if (Math.abs(fromZoom - targetZoom) < 0.01 && Math.abs(fromX - targetX) < 1 && Math.abs(fromY - targetY) < 1) {
    viewRef.value.zoom = targetZoom
    viewRef.value.x = targetX
    viewRef.value.y = targetY
    draw()
    return
  }
  const token = ++viewTweenToken
  const started = Date.now()
  // 和入场同一套逐帧回调：setTimeout 不跟屏幕刷新对齐，平移会一顿一顿。
  // 回调里不另开块级声明，降级 ES5 时 var 提升会顶掉上面的参数，见 README。
  const canvas = canvasRef.value as { requestAnimationFrame?: (cb: () => void) => number } | null
  const schedule = canvas && canvas.requestAnimationFrame
    ? (cb: () => void) => canvas.requestAnimationFrame!(cb)
    : (cb: () => void) => setTimeout(cb, 16) as unknown as number
  const step = () => {
    if (token !== viewTweenToken) return
    const t = Math.min(1, (Date.now() - started) / VIEW_TWEEN_MS)
    const k = 1 - (1 - t) * (1 - t) * (1 - t)
    viewRef.value.zoom = fromZoom + (targetZoom - fromZoom) * k
    viewRef.value.x = fromX + (targetX - fromX) * k
    viewRef.value.y = fromY + (targetY - fromY) * k
    draw()
    if (t < 1) viewTweenTimer = schedule(step)
  }
  viewTweenTimer = schedule(step)
}

/**
 * 把整张图缩放到刚好装下。布局是确定的，所以这一次适配就是终态 ——
 * 旧版只在 initCanvas 里调一次，那时节点还摆在初始圆环上，力导向随后把图摊开，
 * 缩放就永远停在了错误的档位上（实测总览被撑到 140%，四周全被裁掉）。
 * 边界按「节点圆 + 标签」一起算，标签也就不会被切掉。
 */
function fitView() {
  const nodes = nodesRef.value
  if (!nodes.length) return
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  nodes.forEach((node) => {
    const r = nodeRadius(node)
    const laid = labelLayout(node)
    const half = laid.width / 2
    const left = Math.min(node.x - r, node.x - half)
    const right = Math.max(node.x + r, node.x + half)
    const top = node.y - r
    // 标签一律画在节点下方，两行时底盘要按两行留，否则最低那个节点的第二行会被切掉。
    const bottom = node.y + r + 6 + laid.rows.length * LABEL_LINE
    if (left < minX) minX = left
    if (right > maxX) maxX = right
    if (top < minY) minY = top
    if (bottom > maxY) maxY = bottom
  })
  const width = Math.max(80, maxX - minX)
  const height = Math.max(80, maxY - minY)
  const pad = 16
  const targetZoom = clamp(
    Math.min((sizeRef.value.w - pad * 2) / width, (sizeRef.value.h - pad * 2) / height),
    0.6,
    1.6,
  )
  beginViewTween(targetZoom, -((minX + maxX) / 2) * targetZoom, -((minY + maxY) / 2) * targetZoom)
}

function zoomBy(delta: number) {
  // 手动缩放是点一下到位，不跟视图过渡抢：先把进行中的过渡停掉，再直接落在新档位上。
  viewTweenToken += 1
  viewRef.value.zoom = clamp(viewRef.value.zoom + delta, 0.6, 2.4)
  draw()
}
function resetView() {
  trail.value = []
  if (seed.value && seed.value !== center.value) focusNode(seed.value, false)
  else fitView()
}

function openItem(id: string) {
  // 技术规范没有价格，也没有目录详情页，进的是规范自己的页面。
  if (isSpecNode(id)) {
    uni.navigateTo({ url: `/pages/spec/spec?code=${encodeURIComponent(specCodeOf(id))}` })
    return
  }
  const hit = byIdRef.value.get(id)
  if (!hit) return
  const key = isDrug(hit) ? 'drug' : 'id'
  uni.navigateTo({ url: `/pages/detail/detail?${key}=${encodeURIComponent(id)}` })
}

function initCanvas() {
  const query = uni.createSelectorQuery()
  query
    .select('#graph')
    .fields({ node: true, size: true, rect: true })
    .exec((res) => {
      const first = res && res[0]
      if (!first || !first.node) {
        error.value = t('graph.canvasFail')
        return
      }
      const canvas = first.node
      const dpr = uni.getSystemInfoSync().pixelRatio || 1
      canvasRef.value = canvas
      ctxRef.value = canvas.getContext('2d')
      dprRef.value = dpr
      // 位图按 dpr 放大，但这里不再 ctx.scale(dpr)：变换交给 draw() 自己用
      // setTransform 铺，免得这里被调用多次时一层层叠上去。
      canvas.width = first.width * dpr
      canvas.height = first.height * dpr
      sizeRef.value = { w: first.width, h: first.height, left: first.left, top: first.top }
      ready.value = true
      // 第一次适配是从空白画布落位，直接到位，不从 0 过渡。
      viewTweenToken += 1
      // 入场计时要在这一次 draw 之前开：showGraph 在画布还没出来时就开过一次，
      // 那一轮多半已经走完，不在这里重开，第一次打开图谱节点就是直接出现的。
      if (nodesRef.value.length) startNodeReveal()
      fitView()
    })
}

function applyCatalog(data: Awaited<ReturnType<typeof catalogReady>>, id: string) {
  edgesRef.value = addDrugClassEdges(data.edges, data.byId)
  hcEdgesRef.value = data.hcEdges
  byIdRef.value = data.byId
  // 目录换了，规范节点和边要重新取：它们的对端就是目录条目。
  // 序号也要往前推一格，让换目录前发出去的请求回来时认不出自己。
  specRequest += 1
  specByIdRef.value = new Map()
  specEdgesRef.value = []
  specFetched.clear()
  const wanted = id || topHub(edgesRef.value, data.byId)
  if (isSpecNode(wanted)) {
    // 分享链接直接指向技术规范：规范本身不在目录里，取回来才画得出。
    loadSpecsFor(wanted, () => applyCenter(wanted, false))
    return
  }
  showStar(wanted)
}

/**
 * 以这个条目为中心画一张星形图。
 * 目录里查得到它、它却一个邻居都没有，那不是「查无此人」：它和别的条目本来就没关系，
 * 关系在规范那边 —— 而规范不在目录包里，这一刻还没取回来。等规范到了再画一次，
 * 确实还是空的就只画它自己，空状态文案会说明「没有可验证的关联」。
 * 绝不能换成热门条目：用户点开的是注射器，画出来的却是免疫球蛋白，这就是「跳到无关的界面」。
 * 只有编号在目录里根本不存在时（分享链接指向已下架或改名的条目）才退到热门条目，
 * 那种情况不该给一个空页面。
 */
function showStar(id: string) {
  let built = buildStar(allEdges.value, mergedById(), id)
  if (!built.nodes.length && byIdRef.value.has(id)) {
    loadSpecsFor(id, () => {
      const retry = buildStar(allEdges.value, mergedById(), id)
      showGraph(retry.nodes.length ? retry : loneNode(id))
    })
    return
  }
  if (!built.nodes.length) built = buildStar(allEdges.value, mergedById(), topHub(edgesRef.value, byIdRef.value))
  showGraph(built)
}

/** 目录里有、关系一条都没有的条目：以它自己为唯一节点，让空状态说真话，而不是换个条目。 */
function loneNode(id: string): GraphData {
  const item = mergedById().get(id)
  const nodes: GraphNode[] = []
  if (!item) return { nodes, links: [], center: id, dropped: 0 }
  nodes.push({
    id,
    label: item.name,
    drug: isDrug(item),
    spec: isSpec(item),
    hc: isConsumable(item),
    hcKind: isConsumable(item) ? item.hcKind : undefined,
    drugKind: isDrug(item) ? item.kind : undefined,
    limited: isLimitedDrug(item),
    degree: 0,
    rel: '',
    x: 0,
    y: 0,
  })
  return { nodes, links: [], center: id, dropped: 0 }
}

function showGraph(built: GraphData) {
  graph.value = built
  nodesRef.value = built.nodes
  linksRef.value = built.links
  center.value = built.center
  // 这条路径是「等规范数据到了才画得出来」：initCanvas 早跑完了，那时一个节点都没有，
  // 它的 fitView 直接空转返回。不在这里补一次，画布会一直是白的（要等用户拖一下才画），
  // 而且就算被 watch 顺手画出来，也是没适配过的原始缩放。
  // 入场计时先开：fitView 位移很小会当场 draw，计时没开的那一帧节点是满不透明的。
  startNodeReveal()
  if (ready.value) fitView()
  // 中心定了再把它的技术规范接上来：先有规范，才有这一屏的定价项目。
  loadSpecsFor(built.center)
}

function loadGraph() {
  if (catalogLoading.value) return
  catalogLoading.value = true
  error.value = ''
  void catalogReady()
    .then((data) => {
      catalogWarnings.value = Boolean(data.warnings.length)
      applyCatalog(data, center.value || seed.value)
      initCanvas()
    })
    .catch((err) => {
      error.value = err instanceof Error ? err.message : t('home.loadFail')
    })
    .finally(() => { catalogLoading.value = false })
}

onLoad((query) => {
  applyChrome()
  enableShare()
  seed.value = routeValue(query?.id)
  loadGraph()
})

onShow(() => {
  applyChrome()
  // 没有常驻的动画循环，回到页面时得自己重画一遍，否则画布可能是空的。
  draw()
})

watch([locale, contentRevision, searchTermRevision, original, tibetanFontReady], () => {
  labelLayouts = new WeakMap<Node, LabelLayout>()
  draw()
})

const shareTitle = computed(() => {
  const item = selectedItem.value
  return item ? t('graph.share', { name: ct(item.name) }) : t('graph.shareDefault')
})

onShareAppMessage(() => ({
  title: shareTitle.value,
  path: `/pages/graph/graph${center.value ? `?id=${encodeURIComponent(center.value)}` : ''}`,
}))

onShareTimeline(() => ({
  title: shareTitle.value,
  query: shareQuery({ id: center.value }),
}))
</script>

<template>
  <view class="yb-page graph-page" :class="[{ 'theme-dark': dark }, localeClass]">
    <HomePill />
    <view class="graph-head">
      <view class="graph-eyebrow">{{ t('graph.eyebrow') }}</view>
      <view class="graph-title">{{ t('graph.title') }}</view>
      <view class="graph-sub">{{ headText }}</view>
    </view>

    <view v-if="graph && graph.nodes.length" class="graph-stats">
      <view class="graph-stat"><text class="graph-stat-value">{{ stats.drugs }}</text><text class="graph-stat-label">{{ t('graph.drugNodes') }}</text></view>
      <view class="graph-stat"><text class="graph-stat-value">{{ stats.services }}</text><text class="graph-stat-label">{{ t('graph.serviceNodes') }}</text></view>
      <view v-if="stats.specs" class="graph-stat"><text class="graph-stat-value">{{ stats.specs }}</text><text class="graph-stat-label">{{ t('graph.specNodes') }}</text></view>
      <view class="graph-stat"><text class="graph-stat-value">{{ stats.links }}</text><text class="graph-stat-label">{{ t('graph.visibleLinks') }}</text></view>
      <view v-if="stats.hc" class="graph-stat"><text class="graph-stat-value">{{ stats.hc }}</text><text class="graph-stat-label">{{ t('graph.hcNodes') }}</text></view>
    </view>

    <ContentNotice />
    <SearchTermsNotice :query="graphQuery" />
    <view v-if="catalogWarnings && !error" class="home-notice">{{ t('audit.partialCatalog') }}<button class="yb-btn is-ghost" :disabled="catalogLoading" @click="loadGraph">{{ t('audit.retry') }}</button></view>
    <view v-if="error" class="graph-error">{{ error }}<button class="yb-btn is-ghost" @click="loadGraph">{{ t('audit.retry') }}</button></view>
    <view v-else class="graph-shell">
      <view class="graph-search-wrap">
        <text class="graph-search-icon">⌕</text>
        <input v-model="graphQuery" class="graph-search-input" :class="{ 'is-tibetan': tibetanQuery }" type="text" :placeholder="t('graph.search')" placeholder-class="graph-search-placeholder" confirm-type="search" />
        <text v-if="graphQuery" class="graph-search-clear" hover-class="is-press" :hover-stay-time="80" @click="graphQuery = ''">×</text>
        <view v-if="graphResults.length" class="graph-search-results" :class="{ 'is-fresh': resultsFresh }">
          <view v-for="item in graphResults" :key="item.id" class="graph-search-result" hover-class="is-press" :hover-stay-time="80" @click="focusSearchItem(item)">
            <view class="graph-search-kind" :class="{ drug: isDrug(item), hc: isConsumable(item) }">{{ isDrug(item) ? t('graph.drugShort') : isConsumable(item) ? t('graph.hcShort') : t('graph.serviceShort') }}</view>
            <view class="graph-search-result-main"><text><text>{{ ct(item.name) }}</text><text v-if="isLimitedDrug(item)" class="graph-limit-badge">{{ t('common.limitedShort') }}</text></text><text class="graph-search-code">{{ item.code || (isDrug(item) ? drugKindText(item.kind) : isConsumable(item) ? hcKindText(item.hcKind) : categoryLabel(item.cat1)) }}</text></view>
          </view>
        </view>
      </view>
      <view class="graph-toolbar">
        <view class="graph-toolbar-hint">{{ t('graph.gesture') }}</view>
        <view class="graph-tools">
          <view class="graph-tool" hover-class="is-press" :hover-stay-time="80" @click="zoomBy(-0.15)">−</view>
          <view class="graph-zoom">{{ zoomLabel }}</view>
          <view class="graph-tool" hover-class="is-press" :hover-stay-time="80" @click="zoomBy(0.15)">＋</view>
          <view class="graph-tool graph-tool-wide" hover-class="is-press" :hover-stay-time="80" @click="fitView">{{ t('graph.fit') }}</view>
          <view class="graph-tool graph-tool-wide" hover-class="is-press" :hover-stay-time="80" @click="resetView">{{ t('graph.reset') }}</view>
        </view>
      </view>

      <view class="graph-canvas-box">
        <canvas id="graph" canvas-id="graph" type="2d" class="graph-canvas" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="onTouchEnd" />
        <view v-if="backItem" class="graph-back" hover-class="is-press" :hover-stay-time="80" @click="goBack">
          <text class="graph-back-arrow">‹</text>
          <text class="graph-back-name">{{ ct(backItem.name) }}</text>
        </view>
        <view v-if="!ready" class="graph-canvas-hint">{{ t('graph.loading') }}</view>
        <view v-else-if="graphEmpty" class="graph-canvas-hint">{{ t('graph.empty') }}</view>
      </view>
      <view class="graph-legend">
        <view class="graph-legend-item"><view class="graph-legend-dot drug" />{{ t('common.drug') }}</view>
        <view class="graph-legend-item"><view class="graph-legend-dot service" />{{ t('common.service') }}</view>
        <view class="graph-legend-item"><view class="graph-legend-diamond" :style="{ background: SPEC_COLOR }" />{{ t('graph.specTag') }}</view>
        <view class="graph-legend-item"><view class="graph-legend-triangle" :style="{ background: HC_COLOR }" />{{ t('common.consumable') }}</view>
        <view v-for="rel in legendRelations" :key="rel" class="graph-legend-item"><view class="graph-legend-line" :style="{ background: REL_COLOR[rel] || '#94a3b8' }" /><text>{{ edgeRelText(rel) }}</text></view>
      </view>

      <view v-if="stats.dropped" class="graph-truncation"><text class="graph-truncation-mark">i</text><text>{{ t('graph.truncated', { count: stats.dropped }) }}</text></view>
    </view>

    <view class="graph-note"><view class="graph-note-title">{{ t('graph.how') }}</view><view>{{ t('graph.howBody') }}</view><view v-if="stats.hc" class="graph-note-extra">{{ t('graph.hcNote') }}</view></view>

    <view v-if="selectedItem" class="graph-selection">
      <view class="graph-selection-top"><view class="graph-selection-kicker">{{ t('graph.currentCenter') }}</view></view>
      <view class="graph-selection-head"><view class="graph-selection-name">{{ ct(selectedItem.name) }}</view><text v-if="isLimitedDrug(selectedItem)" class="graph-limit-badge">{{ t('common.limitedShort') }}</text><view class="graph-tag" :class="{ spec: isSpec(selectedItem), hc: isConsumable(selectedItem) }">{{ isSpec(selectedItem) ? t('graph.specTag') : isConsumable(selectedItem) ? hcKindText(selectedItem.hcKind) : isDrug(selectedItem) ? drugKindText(selectedItem.kind) || t('common.drug') : categoryLabel(selectedItem.cat1) || t('common.medicalService') }}</view></view>
      <view v-if="isDrug(selectedItem) && selectedItem.remark" class="graph-limit">{{ t('graph.limitRange', { text: ct(selectedItem.remark) }) }}</view>
      <view v-if="isSpec(selectedItem)" class="graph-limit">{{ t('graph.specPage', { page: selectedItem.page }) }}<text class="graph-spec-note">{{ t('graph.specNote') }}</text></view>
      <view v-if="isConsumable(selectedItem) && selectedItem.source" class="graph-limit">{{ t('hc.detail.source') }}：{{ ct(selectedItem.source) }}</view>
      <view class="graph-related-head"><text>{{ t('graph.relatedNodes') }}</text><text class="graph-related-count">{{ t('common.count', { count: selectedLinks.length }) }}</text></view>
      <scroll-view v-if="visibleSelectedLinks.length" scroll-y class="graph-related-list" :class="{ 'is-fresh': relatedFresh }">
        <view v-for="row in visibleSelectedLinks" :key="row.id" class="graph-related-row" hover-class="is-press" :hover-stay-time="80" @click="openItem(row.id)">
          <view class="graph-related-icon" :class="{ drug: isDrug(graphItem(row.id)), spec: row.spec, hc: isConsumable(graphItem(row.id)) }">{{ row.spec ? t('graph.specShort') : isDrug(graphItem(row.id)) ? t('graph.drugShort') : isConsumable(graphItem(row.id)) ? t('graph.hcShort') : t('graph.serviceShort') }}</view>
          <view class="graph-related-main"><text class="graph-related-name">{{ ct(row.name) }}</text><text class="graph-related-rel">{{ relatedRel(row) }}</text></view>
          <text class="graph-related-arrow">›</text>
        </view>
      </scroll-view>
      <view v-else class="graph-empty-related">{{ isSpec(selectedItem) ? t('graph.specEmpty') : t('graph.noRelated') }}</view>
      <view v-if="hiddenSelectedLinks && !showAllLinks" class="graph-more" hover-class="is-press" :hover-stay-time="80" @click="showAllLinks = true">{{ t('graph.expandMore', { count: hiddenSelectedLinks }) }}</view>
      <view v-if="showAllLinks && hiddenSelectedLinks" class="graph-more" hover-class="is-press" :hover-stay-time="80" @click="showAllLinks = false">{{ t('graph.collapse') }}</view>
      <view class="graph-selection-actions"><view class="graph-open" hover-class="is-press" :hover-stay-time="80" @click="openItem(selectedItem.id)">{{ isSpec(selectedItem) ? t('graph.openSpec') : t('graph.open') }}</view><view class="graph-focus" hover-class="is-press" :hover-stay-time="80" @click="fitView">{{ t('graph.fitView') }}</view></view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.graph-page { padding: 28rpx 24rpx calc(48rpx + env(safe-area-inset-bottom)); }
.graph-head { padding: 8rpx 8rpx 20rpx; }
.graph-eyebrow, .graph-selection-kicker { color: var(--yb-primary); font-size: 22rpx; font-weight: 700; letter-spacing: .12em; }
.graph-title { margin-top: 8rpx; font-size: 46rpx; font-weight: 760; letter-spacing: -.04em; }
.graph-sub { margin-top: 8rpx; color: var(--yb-text-3); font-size: 23rpx; line-height: 1.5; }
.graph-stats { display: flex; gap: 12rpx; margin-bottom: 16rpx; }
.graph-stat { flex: 1; min-width: 0; padding: 18rpx 16rpx 16rpx; border: 1rpx solid var(--yb-border); border-radius: 20rpx; background: var(--yb-surface); }
.graph-stat-value { display: block; color: var(--yb-text); font-size: 34rpx; font-weight: 760; line-height: 1.05; }
.graph-stat-label { display: block; margin-top: 8rpx; color: var(--yb-text-3); font-size: 22rpx; }
.graph-error { padding: 48rpx 24rpx; border: 1rpx solid var(--yb-border); border-radius: 24rpx; background: var(--yb-surface); color: var(--yb-text-3); text-align: center; }
.graph-shell { overflow: hidden; border: 1rpx solid var(--yb-border); border-radius: 28rpx; background: var(--yb-surface); box-shadow: 0 14rpx 44rpx rgba(27,47,86,.08); }
.theme-dark .graph-shell { box-shadow: 0 14rpx 44rpx rgba(0,0,0,.24); }
.graph-search-wrap { position: relative; display: flex; align-items: center; gap: 10rpx; margin: 16rpx 16rpx 0; padding: 0 14rpx; min-height: 72rpx; border: 1rpx solid var(--yb-border); border-radius: 18rpx; background: var(--yb-bg); }
.graph-search-icon { flex: none; color: var(--yb-text-3); font-size: 34rpx; line-height: 1; }
.graph-search-input { min-width: 0; flex: 1; height: 68rpx; border: 0; background: transparent; color: var(--yb-text); font-size: 25rpx; }
.graph-search-input.is-tibetan { font-family: 'QhybTibetan', 'Microsoft Himalaya', serif; font-size: 30rpx; }
.graph-search-clear { width: 42rpx; height: 42rpx; flex: none; border-radius: 50%; background: var(--yb-clear-bg); color: var(--yb-text-3); font-size: 30rpx; line-height: 38rpx; text-align: center; }
.graph-search-results { position: absolute; z-index: 5; left: -1rpx; right: -1rpx; top: 78rpx; overflow: hidden; border: 1rpx solid var(--yb-border); border-radius: 18rpx; background: var(--yb-surface); box-shadow: 0 16rpx 40rpx rgba(26,45,90,.16); }
.theme-dark .graph-search-results { box-shadow: 0 16rpx 40rpx rgba(0,0,0,.35); }
/* 下拉结果跟着关键词长出来，和关联节点同一个拍子。is-fresh 只在结果换了一批时
   重新加上，同一个词敲到一半不重播。关键帧写在页面里：页面样式是隔离的，全局的取不到。 */
@keyframes yb-suggest-in {
  from { opacity: 0; transform: translateY(16rpx); }
  to { opacity: 1; transform: translateY(0); }
}
.graph-search-results.is-fresh > .graph-search-result {
  animation: yb-suggest-in 0.28s cubic-bezier(0.22, 0.8, 0.3, 1) both;
}
.graph-search-results.is-fresh > .graph-search-result:nth-child(2) { animation-delay: 0.03s; }
.graph-search-results.is-fresh > .graph-search-result:nth-child(3) { animation-delay: 0.06s; }
.graph-search-results.is-fresh > .graph-search-result:nth-child(4) { animation-delay: 0.09s; }
.graph-search-results.is-fresh > .graph-search-result:nth-child(5) { animation-delay: 0.12s; }
.graph-search-results.is-fresh > .graph-search-result:nth-child(6) { animation-delay: 0.15s; }
.graph-search-result { display: flex; align-items: center; gap: 12rpx; min-height: 76rpx; padding: 0 16rpx; border-bottom: 1rpx solid var(--yb-border); }
.graph-search-result:last-child { border-bottom: 0; }
.graph-search-kind { display: flex; align-items: center; justify-content: center; width: 38rpx; height: 38rpx; flex: none; border-radius: 10rpx; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 20rpx; font-weight: 700; }
.graph-search-kind.drug { border-radius: 50%; background: #e8f0ff; color: #2563eb; }
.graph-search-kind.hc { background: #e0f7fb; color: #0e7490; }
.graph-search-result-main { min-width: 0; flex: 1; }
.graph-search-result-main > text { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.graph-search-result-main > text:first-child { color: var(--yb-text); font-size: 25rpx; }
.graph-search-code { margin-top: 2rpx; color: var(--yb-text-3); font-size: 20rpx; }
.graph-limit-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 34rpx; height: 34rpx; margin-left: 8rpx; padding: 0 8rpx; border-radius: 8rpx; background: #fff0d2; color: #b45309; font-size: 20rpx; font-weight: 800; line-height: 34rpx; vertical-align: middle; }
.graph-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12rpx; padding: 16rpx 16rpx 12rpx 20rpx; border-bottom: 1rpx solid var(--yb-border); }
.graph-toolbar-hint { min-width: 220rpx; flex: 1; color: var(--yb-text-3); font-size: 21rpx; line-height: 1.4; }
.graph-tools { display: flex; align-items: center; gap: 6rpx; flex: none; }
.graph-tool, .graph-zoom { display: flex; align-items: center; justify-content: center; width: 54rpx; height: 50rpx; border: 1rpx solid var(--yb-border); border-radius: 12rpx; background: var(--yb-surface); color: var(--yb-text-2); font-size: 27rpx; line-height: 1; }
.graph-zoom { width: 68rpx; border-color: transparent; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 21rpx; }
.graph-tool-wide { width: auto; padding: 0 14rpx; font-size: 22rpx; }
.graph-canvas-box { position: relative; width: 100%; height: 760rpx; background: var(--yb-surface); }
.graph-canvas { display: block; width: 100%; height: 100%; }
.graph-loading, .graph-canvas-hint { position: absolute; left: 50%; top: 50%; padding: 12rpx 20rpx; border: 1rpx solid var(--yb-border); border-radius: 999rpx; background: var(--yb-surface); color: var(--yb-text-3); font-size: 22rpx; transform: translate(-50%,-50%); pointer-events: none; white-space: nowrap; }
.graph-back { position: absolute; left: 16rpx; top: 16rpx; z-index: 3; display: flex; align-items: center; gap: 4rpx; max-width: 320rpx; padding: 8rpx 18rpx 8rpx 12rpx; border: 1rpx solid var(--yb-border); border-radius: 999rpx; background: rgba(255,255,255,.92); color: var(--yb-text-2); font-size: 22rpx; backdrop-filter: blur(8px); }
.theme-dark .graph-back { background: rgba(23,30,43,.92); }
.graph-back-arrow { flex: none; font-size: 30rpx; line-height: 1; }
.graph-back-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.graph-legend { display: flex; flex-wrap: wrap; gap: 12rpx 18rpx; padding: 16rpx 18rpx; border-top: 1rpx solid var(--yb-border); color: var(--yb-text-3); font-size: 21rpx; }
.graph-legend-item { display: inline-flex; align-items: center; gap: 6rpx; white-space: nowrap; }
.graph-legend-dot { width: 13rpx; height: 13rpx; border: 2rpx solid #fff; border-radius: 50%; background: var(--yb-primary); box-shadow: 0 0 0 1rpx rgba(60,76,105,.3); }
.graph-legend-dot.service { border-radius: 3rpx; background: #dbe4f2; }
.graph-legend-diamond { width: 12rpx; height: 12rpx; margin: 0 1rpx; border: 2rpx solid #fff; box-shadow: 0 0 0 1rpx rgba(60,76,105,.3); transform: rotate(45deg); }
/* 耗材的三角形：和画布上的节点同形，用 clip-path 画比边框技巧稳 */
.graph-legend-triangle { width: 15rpx; height: 13rpx; margin: 0 1rpx; background: #0891b2; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.graph-legend-line { width: 22rpx; height: 4rpx; border-radius: 4rpx; }
.graph-truncation, .graph-note { display: flex; gap: 10rpx; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.55; }
.graph-truncation { align-items: center; padding: 14rpx 18rpx; border-top: 1rpx solid var(--yb-border); background: var(--yb-primary-soft); color: var(--yb-primary); }
.graph-truncation-mark { display: inline-flex; align-items: center; justify-content: center; width: 28rpx; height: 28rpx; flex: none; border-radius: 50%; background: var(--yb-primary); color: var(--yb-btn-fg); font-size: 20rpx; font-weight: 700; animation: yb-trunc-in 0.4s cubic-bezier(0.22, 0.8, 0.3, 1) both; }
@keyframes yb-trunc-in {
  from { opacity: 0; transform: scale(0.4); }
  to { opacity: 1; transform: scale(1); }
}
.graph-note { display: block; margin: 18rpx 6rpx; }
.graph-note-title { margin-bottom: 4rpx; color: var(--yb-text-2); font-size: 23rpx; font-weight: 700; }
.graph-note-extra { margin-top: 8rpx; color: var(--yb-text-3); font-size: 22rpx; line-height: 1.55; }
.graph-selection { padding: 22rpx; border: 1rpx solid var(--yb-border); border-radius: 26rpx; background: var(--yb-surface); box-shadow: 0 12rpx 36rpx rgba(27,47,86,.06); }
.graph-selection-top, .graph-selection-head, .graph-related-head, .graph-selection-actions { display: flex; align-items: center; }
.graph-selection-top, .graph-related-head { justify-content: space-between; }
.graph-selection-head { flex-wrap: wrap; gap: 12rpx; margin-top: 8rpx; }
.graph-selection-name { min-width: 0; flex: 1; color: var(--yb-text); font-size: 34rpx; font-weight: 750; line-height: 1.35; }
.graph-tag { padding: 6rpx 14rpx; border-radius: 999rpx; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 21rpx; white-space: nowrap; }
.graph-tag.spec { background: #eceafe; color: #4f46e5; }
.graph-tag.hc { background: #e0f7fb; color: #0e7490; }
.graph-limit { margin-top: 12rpx; color: var(--yb-text-3); font-size: 23rpx; line-height: 1.55; }
.graph-spec-note { display: block; margin-top: 6rpx; }
.graph-related-head { margin-top: 20rpx; padding-top: 16rpx; border-top: 1rpx solid var(--yb-border); color: var(--yb-text-2); font-size: 25rpx; font-weight: 700; }
.graph-related-count { color: var(--yb-text-3); font-size: 22rpx; font-weight: 400; }
.graph-related-list { max-height: 360rpx; margin-top: 6rpx; }
/* 关联节点跟着中心一起长出来，和首页结果行同一个拍子。
   is-fresh 只在换中心时重新加上，展开「另外 N 条」不再播一遍。
   关键帧写在这里而不是全局：页面样式是隔离的，全局的 yb-in 在这里取不到。 */
@keyframes yb-related-in {
  from { opacity: 0; transform: translateY(20rpx); }
  to { opacity: 1; transform: translateY(0); }
}
.graph-related-list.is-fresh > .graph-related-row {
  animation: yb-related-in 0.32s cubic-bezier(0.22, 0.8, 0.3, 1) both;
}
.graph-related-list.is-fresh > .graph-related-row:nth-child(2) { animation-delay: 0.03s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(3) { animation-delay: 0.06s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(4) { animation-delay: 0.09s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(5) { animation-delay: 0.12s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(6) { animation-delay: 0.15s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(7) { animation-delay: 0.18s; }
.graph-related-list.is-fresh > .graph-related-row:nth-child(8) { animation-delay: 0.21s; }
.graph-related-row { display: flex; align-items: center; gap: 12rpx; min-height: 76rpx; border-bottom: 1rpx solid var(--yb-border); }
.graph-related-row:last-child { border-bottom: 0; }
.graph-related-icon { display: flex; align-items: center; justify-content: center; width: 42rpx; height: 42rpx; flex: none; border-radius: 10rpx; background: var(--yb-primary-soft); color: var(--yb-primary); font-size: 21rpx; font-weight: 700; }
.graph-related-icon.drug { border-radius: 50%; background: #e8f0ff; color: #2563eb; }
.graph-related-icon.spec { border-radius: 6rpx; background: #eceafe; color: #4f46e5; }
.graph-related-icon.hc { background: #e0f7fb; color: #0e7490; }
.graph-related-main { min-width: 0; flex: 1; }
.graph-related-name, .graph-related-rel { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.graph-related-name { color: var(--yb-text); font-size: 26rpx; }
.graph-related-rel { margin-top: 2rpx; color: var(--yb-text-3); font-size: 20rpx; }
.graph-related-arrow { flex: none; color: var(--yb-text-3); font-size: 34rpx; }
.graph-empty-related, .graph-empty-copy { color: var(--yb-text-3); font-size: 23rpx; line-height: 1.55; }
.graph-empty-related { padding: 18rpx 0; }
.graph-more { padding: 14rpx 0 2rpx; color: var(--yb-primary); font-size: 23rpx; text-align: center; }
.graph-selection-actions { gap: 12rpx; margin-top: 18rpx; }
.graph-open, .graph-focus { flex: 1; min-height: 76rpx; border-radius: 16rpx; font-size: 25rpx; line-height: 76rpx; text-align: center; }
.graph-open { background: var(--yb-btn); color: var(--yb-btn-fg); font-weight: 700; }
.graph-focus { border: 1rpx solid var(--yb-chip-on-border); background: var(--yb-primary-soft); color: var(--yb-primary); }
.lang-bo .graph-title { line-height: 1.5; letter-spacing: 0; }
.lang-bo .graph-toolbar-hint, .lang-bo .graph-note, .lang-bo .graph-truncation { line-height: 1.85; }
.lang-en .graph-stat-label { min-height: 56rpx; line-height: 1.3; }
</style>
