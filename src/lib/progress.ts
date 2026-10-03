import { computed, ref } from 'vue'

/**
 * 目录载入进度，0~1。
 *
 * 七个包按线上 gzip 之后的字节数加权，不是按「完成了几个包」：3KB 的 meta 和
 * 1.29MB 的 search 各占一格的话，进度条会在最后一条上僵住，看着像卡死。
 * 数字取自各包的 Content-Length，数据改版后不必精确，比例对就行。
 */
const PACK_BYTES: Record<string, number> = {
  search: 1293808,
  'hc-items': 361916,
  drugs: 170674,
  'hc-links': 160517,
  usage: 21892,
  edges: 7114,
  meta: 3241,
}

const TOTAL_BYTES = Object.keys(PACK_BYTES).reduce((sum, key) => sum + PACK_BYTES[key], 0)

/** 这一轮里哪些包已经落地。用对象不用 Set：Set 在低版本基础库上要被降级垫片包一层。 */
const arrived: Record<string, boolean> = {}
let doneBytes = 0

export const catalogProgress = ref(0)

export function resetCatalogProgress() {
  Object.keys(PACK_BYTES).forEach((key) => {
    arrived[key] = false
  })
  doneBytes = 0
  catalogProgress.value = 0
}

/** 一个包回来了（成功失败都算「这一格结束了」——失败的那个由 warnings 交代）。 */
export function stepCatalogProgress(key: string) {
  if (arrived[key]) return
  arrived[key] = true
  doneBytes += PACK_BYTES[key] || 0
  catalogProgress.value = TOTAL_BYTES ? Math.min(1, doneBytes / TOTAL_BYTES) : 0
}

/**
 * 进度条读数：有真实百分比就给百分比，没有就给 undefined 走不定态。
 *
 * 两种情况没有百分比：一个包都还没落地（0，画一条 0 宽的条子等于没画），
 * 以及目录已经下完（1，此时还在等的必然是别的请求 —— 目录已在内存里时点详情
 * 等的是单条预览，几十毫秒的来回，报不出比例）。这两种都给来回扫的条子。
 */
export const catalogBar = computed(() => {
  const at = catalogProgress.value
  return at > 0 && at < 1 ? at : undefined
})
