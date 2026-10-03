import type { ItemDetail, SearchItem, Successor } from './types'
import { isEffectivelyStopped, isUpcoming, laterDateText } from './status'
import { usageRowsFor, type UsageRow } from './usage'
import { t } from './i18n'

export type GuideSheet = {
  connotation: string
  priceNote: string
  mergeNote: string
  mergeFrom: string[]
  successors: Successor[]
  inheritedFrom: string
  usageRows: UsageRow[]
  missing: boolean
}

export function parentCodes(code: string): string[] {
  const raw = (code || '').trim()
  if (!raw) return []
  const flagged = raw.endsWith('T')
  const core = flagged ? raw.slice(0, -1) : raw
  const suffix = flagged ? 'T' : ''
  const out: string[] = []
  const add = (value: string) => {
    if (value && value !== raw && !out.includes(value)) out.push(value)
  }
  if (core.length >= 3) add(`${core.slice(0, -3)}000${suffix}`)
  if (core.length >= 4) add(`${core.slice(0, -4)}0000${suffix}`)
  return out
}

export function parentNameStem(name: string): string {
  const text = (name || '').trim()
  if (!/(加收|扩展)/.test(text)) return ''
  const stem = text.split(/[-—－]/)[0].replace(/[（(](加收|扩展)[）)]/g, '').trim()
  return stem && stem !== text ? stem : ''
}

export function findParentItem(
  item: SearchItem,
  findByCode: (code: string) => SearchItem | undefined,
  findByName: (name: string) => SearchItem | undefined,
): SearchItem | undefined {
  if (!/(加收|扩展)/.test(item.name)) return undefined
  const byCode = parentCodes(item.code)
    .map((code) => findByCode(code))
    .find((hit) => Boolean(hit && hit.id !== item.id))
  if (byCode) return byCode
  const stem = parentNameStem(item.name)
  if (!stem) return undefined
  const hit = findByName(stem)
  return hit && hit.id !== item.id ? hit : undefined
}

export function resolveGuide(
  item: SearchItem,
  detail?: ItemDetail | null,
  parent?: SearchItem | null,
  parentDetail?: ItemDetail | null,
): GuideSheet {
  let connotation = (detail?.connotation || '').trim()
  let inheritedFrom = ''
  // inherited 声明在 if 外面：块里的 const 降级成 ES5 会提升成 var，见 README
  let inherited = ''
  if (!connotation && parent) {
    inherited = (parentDetail?.connotation || '').trim()
    if (inherited) {
      connotation = inherited
      inheritedFrom = parent.name
    }
  }
  const priceNote = (detail?.priceNote || '').trim()
  const mergeNote = (detail?.mergeNote || '').trim()
  const mergeFrom = item.mergeFrom || []
  const successors = item.successors || []
  const usageBlob = (item.usageNote || parent?.usageNote || '').trim()
  const usageRows = usageBlob ? usageRowsFor(usageBlob, item.name) : []
  const hasMerge = Boolean(mergeNote || mergeFrom.length || successors.length)
  return {
    connotation,
    priceNote,
    mergeNote,
    mergeFrom,
    successors,
    inheritedFrom,
    usageRows,
    missing: !connotation && !priceNote && !hasMerge,
  }
}

export function mergeAtNote(item: SearchItem, translate: (text: string) => string = (text) => text) {
  if (!item.successors.length) return translate(item.stopAt)
  const date = laterDateText(item.stopAt)
  const names = item.successors.map((s) => translate(s.name))
  if (names.length === 1) return t('guide.mergeOne', { date, name: names[0] })
  return t('guide.mergeMany', { date, name: names[0], count: names.length })
}

export function integrateLines(item: SearchItem, guide: GuideSheet, translate: (text: string) => string = (text) => text) {
  const upcoming = isUpcoming(item)
  const stopped = isEffectivelyStopped(item)
  const lines: string[] = []
  // 局部量都放在函数顶层，不留在 if / else 块里：块级声明被压缩后可能和模块级引用
  // 撞名，微信降级 ES5 提升成 var 会顶掉上面 isUpcoming / isEffectivelyStopped 的引用。
  const successorNames = guide.successors.map((row) => translate(row.name))
  const mergeFromShown = guide.mergeFrom.slice(0, 4).map(translate).join(' / ')
  const mergeFromExtra = guide.mergeFrom.length > 4 ? t('guide.more') : ''
  if (guide.mergeNote) lines.push(translate(guide.mergeNote))
  if (upcoming && !stopped && guide.successors.length) lines.push(mergeAtNote(item, translate))
  else if (stopped && guide.successors.length) {
    lines.push(
      successorNames.length === 1
        ? t('guide.useOne', { name: successorNames[0] })
        : t('guide.useMany', { name: successorNames[0], count: successorNames.length }),
    )
  }
  if (guide.mergeFrom.length) {
    lines.push(t('guide.integratedFrom', { names: mergeFromShown, more: mergeFromExtra }))
  }
  return [...new Set(lines)]
}
