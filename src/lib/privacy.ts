import { ref } from 'vue'
import { t } from './i18n'

// WeChat passes a function, not an object with a resolve method. Agreement is
// valid only after the native agreePrivacyAuthorization button event.
type Resolver = (result: { event: 'agree' | 'disagree'; buttonId?: string }) => void
type PrivacyPlatform = {
  onNeedPrivacyAuthorization?: (listener: (resolve: Resolver) => void) => void
  openPrivacyContract?: (options: { fail: () => void }) => void
}

export const PRIVACY_BUTTON_ID = 'qhyb-privacy-agree'
export const privacyVisible = ref(false)
let wired = false
let active = false
let pending: Resolver[] = []

function platform(): PrivacyPlatform {
  return (typeof wx !== 'undefined' ? wx : uni) as unknown as PrivacyPlatform
}

function settle(result: { event: 'agree' | 'disagree'; buttonId?: string }) {
  const resolvers = pending
  pending = []
  privacyVisible.value = false
  resolvers.forEach((resolve) => {
    try { resolve(result) } catch { /* One ended request must not strand the rest. */ }
  })
}

export function declinePrivacy() {
  settle({ event: 'disagree' })
}

/** Bind only to agreeprivacyauthorization, never to an ordinary tap or modal. */
export function agreePrivacy() {
  if (!active || !privacyVisible.value) return
  settle({ event: 'agree', buttonId: PRIVACY_BUTTON_ID })
}

export function setPrivacyPromptActive(value: boolean) {
  active = value
  if (value) watchPrivacy()
  else declinePrivacy()
}

export function watchPrivacy() {
  if (wired) return
  const api = platform()
  if (typeof api.onNeedPrivacyAuthorization !== 'function') return
  try {
    api.onNeedPrivacyAuthorization((resolve) => {
      if (typeof resolve !== 'function') return
      if (!active) {
        try { resolve({ event: 'disagree' }) } catch { /* Request already ended. */ }
        return
      }
      if (pending.indexOf(resolve) < 0) pending.push(resolve)
      privacyVisible.value = true
    })
    wired = true
  } catch {
    // No synthetic authorization on old SDKs or subscription failure. The
    // platform's own privacy checks remain enabled and registration can retry.
  }
}

export function openPrivacyContract() {
  const fail = () => uni.showToast({ title: t('privacy.openFail'), icon: 'none' })
  let api: PrivacyPlatform
  try {
    api = platform()
    if (typeof api.openPrivacyContract !== 'function') { fail(); return }
    api.openPrivacyContract({ fail })
  } catch { fail() }
}
