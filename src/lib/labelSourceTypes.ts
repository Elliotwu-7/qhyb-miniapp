export type ProductRef = { id: string; name: string; company: string; approval: string; strength: string; match: 'same_name' | 'different_name' }
export type ApprovalSource = { name: string; holder: string; instruction: string; date: string; state: string; url: string; fetchedAt: string; snapshotSha256: string; row: number; section: number; reviewed: false }
export type LabelSources = { products: ProductRef[]; cde: ApprovalSource[] }
export type LabelProduct = { id: string; fields: Record<string, string[]>; reviewed: false; origin: { url: string; sha256: string; fetchedAt: string; commit: string; archiveSha256: string } }
export const productUrl = /^https:\/\/cnb\.cool\/netcsk\/DrugSpec\/-\/blob\/[a-f0-9]{40}\/json_data\/sms[0-9]+\.json$/
export function unpackSources(row: Record<string, unknown>): LabelSources | undefined {
  if (row.schema !== 2) return undefined
  if (!Array.isArray(row.products) || !Array.isArray(row.cde)) throw new Error('Invalid source index')
  const products = row.products as ProductRef[]
  const cde = row.cde as ApprovalSource[]
  if (products.some((p) => !p || !/^[a-f0-9]{24}$/.test(p.id) || !['same_name', 'different_name'].includes(p.match) || ['name', 'company', 'approval', 'strength'].some((k) => typeof p[k as keyof ProductRef] !== 'string'))) throw new Error('Invalid product reference')
  if (cde.some((p) => !p || p.reviewed !== false || p.url !== 'https://www.cde.org.cn/main/xxgk/getFtjpzqdList' || ['name','holder','instruction','date','state','fetchedAt'].some((k) => typeof p[k as keyof ApprovalSource] !== 'string'))) throw new Error('Invalid approval source')
  return { products, cde }
}
export function unpackProduct(raw: unknown, id: string): LabelProduct {
  const p = raw as LabelProduct
  if (!p || p.id !== id || p.reviewed !== false || !p.fields || !p.origin || !productUrl.test(p.origin.url) || !/^[a-f0-9]{64}$/.test(p.origin.sha256) || Object.keys(p.fields).some((k) => !Array.isArray(p.fields[k]) || p.fields[k].some((v) => typeof v !== 'string'))) throw new Error('Invalid product source')
  return p
}
export function productRows(p: LabelProduct): Array<[string, string]> {
  return Object.keys(p.fields).filter((key) => !['通用名称','生产企业','批准文号','规格'].includes(key)).map((key) => [key, p.fields[key].filter((v) => v.trim()).join('\n\n')] as [string, string]).filter((row) => row[1])
}
