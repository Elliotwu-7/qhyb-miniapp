import { t } from './i18n'

export type MemberTier = 'member' | 'silver' | 'gold'

export type MemberNext = {
  tier: MemberTier
  label: string
  needTotal: number
  needStreak: number
}

export type MemberInfo = {
  tier: MemberTier
  label: string
  since: number
  next: MemberNext | null
  progress: number
}

function tierLabel(tier: MemberTier) {
  if (tier === 'gold') return t('member.gold')
  if (tier === 'silver') return t('member.silver')
  return t('member.basic')
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n))
}

export function memberFromCheckin(total: number, _streak = 0, created = 0): MemberInfo {
  const days = Math.max(0, Math.trunc(total || 0))
  if (days >= 30) {
    return { tier: 'gold', label: tierLabel('gold'), since: created || 0, next: null, progress: 1 }
  }
  if (days >= 7) {
    return {
      tier: 'silver',
      label: tierLabel('silver'),
      since: created || 0,
      next: {
        tier: 'gold',
        label: tierLabel('gold'),
        needTotal: Math.max(0, 30 - days),
        needStreak: 0,
      },
      progress: Number(clamp01((days - 7) / 23).toFixed(4)),
    }
  }
  return {
    tier: 'member',
    label: tierLabel('member'),
    since: created || 0,
    next: {
      tier: 'silver',
      label: tierLabel('silver'),
      needTotal: Math.max(0, 7 - days),
      needStreak: 0,
    },
    progress: Number(clamp01(days / 7).toFixed(4)),
  }
}

export function formatMemberSince(since: number): string {
  if (!since) return ''
  const d = new Date(since * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function nextHint(info: MemberInfo): string {
  const nxt = info.next
  if (!nxt) return t('member.max')
  if (nxt.needTotal > 0) return t('member.next', { count: nxt.needTotal, level: nxt.label })
  return t('member.upgrade', { level: nxt.label })
}
