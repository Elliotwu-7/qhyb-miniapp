/**
 * 参考资料汇编的展示层：种类名、字段名、适用范围名。
 *
 * 这批资料是国家／上海市／山东省的规范性文件原文，条目本身是中文，界面上不翻译。
 * 只有外层的框架词（适用范围、资料集、分册……）走 i18n —— 和目录里的药品名一样，
 * 原文照登，翻译的只是我们自己的话。
 */
import { t } from './i18n'
import type { RefItem, RefMeta, RefMetaDataset } from './api'

export type { RefItem, RefMeta, RefMetaDataset } from './api'

/** 适用范围。顺序按服务端 meta.scopeOrder，这里只是没有 meta 时的兜底。 */
export const REF_SCOPES = ['全国', '上海市', '山东省']

/** 每页条数。服务端上限 60，取小一点免得手机上一次渲染太重。 */
export const REF_PAGE_SIZE = 20

export const REF_KIND_LABEL: Record<string, string> = {
  drug: '药品目录',
  'drug-code': '药品编码库',
  service: '医疗服务项目',
  essential: '基本药物目录',
  dip: 'DIP 分组方案',
  offlabel: '超说明书用药共识',
}

/** 明细里长文本字段的中文名。和 scripts/build_refdata.py 的 LABELS 保持一致。 */
export const REF_FIELD_LABEL: Record<string, string> = {
  connotation: '项目内涵',
  excluded: '除外内容',
  payMethod: '支付办法',
  limitScope: '限定支付范围',
  techClass: '技术分类',
  mylimit: '院内限制说明',
  trial: '是否试运行',
  memo: '备注',
  evidence: '证据等级及依据',
  usage: '具体用法',
  indication: '适应证',
  recommend: '推荐意见',
  population: '人群',
  section: '章节',
  table: '来源表',
  page: '原书页码',
  seq: '原书序号',
  spec: '剂型、规格',
  func: '功能',
  maker: '生产厂家',
  packUnit: '包装单位',
  orderCode: '目录顺序编码',
  feeType: '费用类别',
  western: '中西药标志',
  nationalCode: '国家医保编码',
  insuranceCode: '医保编码',
  effectiveAt: '信息起效日期',
  expireAt: '信息失效日期',
}

/** 站点不公开医保支付标准：后端已经不发行这几栏，界面再挡一道。 */
const HIDDEN_DETAIL: Record<string, true> = { payStandard: true, payRatio: true, payRaw: true, code: true, name: true, id: true }

/** 翻译缺失时 t() 会把 key 原样返回，据此回落到中文原名。 */
function translated(key: string, fallback: string) {
  const value = t(key)
  return value === key ? fallback : value
}

export function refKindLabel(kind: string) {
  return translated(`ref.kind.${kind}`, REF_KIND_LABEL[kind] || kind || '')
}

export function refFieldLabel(key: string) {
  return translated(`ref.field.${key}`, REF_FIELD_LABEL[key] || key)
}

/** 适用范围是数据里的原值，只在显示时换成外面的说法。 */
export function refScopeLabel(scope: string) {
  return translated(`ref.scope.${scope}`, scope)
}

/** 明细里要展示的字段，去掉空的和不该露的。 */
export function refDetailRows(item: RefItem | null): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = []
  const detail = item?.detail
  if (!detail) return rows
  Object.keys(detail).forEach((key) => {
    const value = detail[key]
    if (!value || HIDDEN_DETAIL[key]) return
    rows.push({ key, value })
  })
  return rows
}

/** 一个适用范围下有几条：徽标和页头都要用。 */
export function refScopeCount(meta: RefMeta | null, scope: string) {
  let total = 0
  if (meta) {
    meta.datasets.forEach((row) => {
      if (row.scope === scope) total += row.count
    })
  }
  return total
}

/**
 * 分册名是各份资料自己的，跨资料集筛就没有意义。只在「已经锁定到某一份」时出分册条：
 * 选了资料集，或者这个适用范围下本来就只有一份（山东省）。否则一份资料的分册永远选不到。
 */
export function activeDataset(inScope: RefMetaDataset[], ds: string): RefMetaDataset | null {
  let found: RefMetaDataset | null = null
  inScope.forEach((row) => {
    if (row.key === ds) found = row
  })
  if (found) return found
  return inScope.length === 1 ? inScope[0] : null
}

/** 适用范围的徽标配色用 ascii 类名，样式表里按类写。 */
export function refScopeClass(scope: string) {
  if (scope === '全国') return 'is-cn'
  if (scope === '上海市') return 'is-sh'
  if (scope === '山东省') return 'is-sd'
  return ''
}

/** 分册条超过这个数就不铺了：DIP 那种几十章的铺出来比结果还长。 */
export const REF_PART_LIMIT = 10
