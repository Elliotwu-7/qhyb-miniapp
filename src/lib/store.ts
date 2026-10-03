import { hopEdgesOf, loadCatalog, loadMeta } from './data'
import { buildNameIndex } from './search'
import type { CatalogEdge, CatalogMeta, HcLink, SearchItem } from './types'

type Catalog = {
  items: SearchItem[]
  drugs: SearchItem[]
  consumables: SearchItem[]
  edges: CatalogEdge[]
  hcEdges: CatalogEdge[]
  /** 医保智能审核规则那 2648 行原文：项目详情页按 id 现查，不进图也不进卡片。 */
  auditLinks: HcLink[]
  /** 结果卡片用的关联：目录关系 + 耗材分类，不含审核规则（太长）。 */
  hopEdges: CatalogEdge[]
  meta: CatalogMeta
  warnings: string[]
  byName: Map<string, SearchItem>
  byId: Map<string, SearchItem>
  byCode: Map<string, SearchItem>
}

let catalogLoading: Promise<Catalog> | null = null
let catalogCache: Catalog | null = null

/** 目录是否已经在内存里。详情页靠它决定要不要先按 id 问服务端要一条。 */
export function catalogCached() {
  return catalogCache !== null
}
let metaLoading: Promise<CatalogMeta> | null = null
let metaCache: CatalogMeta | null = null

export function metaReady() {
  if (catalogCache) return Promise.resolve(catalogCache.meta)
  if (metaCache) return Promise.resolve(metaCache)
  if (!metaLoading) {
    metaLoading = loadMeta()
      .then((meta) => {
        metaCache = meta
        return meta
      })
      .catch((err) => {
        metaLoading = null
        throw err
      })
  }
  return metaLoading
}

export function catalogReady() {
  if (catalogCache) return Promise.resolve(catalogCache)
  if (!catalogLoading) {
    catalogLoading = loadCatalog()
      .then((data) => {
        const byName = buildNameIndex(data.items)
        const byId = new Map<string, SearchItem>()
        const byCode = new Map<string, SearchItem>()
        data.items.forEach((item) => {
          byId.set(item.id, item)
          if (item.code && !byCode.has(item.code)) byCode.set(item.code, item)
        })
        data.drugs.forEach((drug) => byId.set(drug.id, drug))
        // 耗材进 byId，但**不进 items**：items 是收费项目，首页「在用 N 项」、
        // 分类筛选、合并处理都按它算，混进 4748 条耗材会把口径整个改掉。
        // 走进 byId 是为了跳转、图谱和关联能按 id 找到它。
        data.consumables.forEach((item) => byId.set(item.id, item))
        catalogCache = {
          items: data.items,
          drugs: data.drugs,
          consumables: data.consumables,
          edges: data.edges,
          hcEdges: data.hcEdges,
          auditLinks: data.auditLinks,
          hopEdges: hopEdgesOf(data.edges, data.hcEdges),
          meta: data.meta,
          warnings: data.warnings,
          byName,
          byId,
          byCode,
        }
        metaCache = data.meta
        const result = catalogCache
        if (data.warnings.length) catalogCache = null
        return result
      })
      .catch((err) => {
        catalogLoading = null
        throw err
      })
      .finally(() => { catalogLoading = null })
  }
  return catalogLoading
}
