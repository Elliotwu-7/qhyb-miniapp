import { computed, ref } from 'vue'
import {
  mpAdReward,
  mpCancel,
  mpCheckin,
  mpLogin,
  mpLogout,
  mpQuery,
  mpRegister,
  mpSettings,
  type MpProfile,
  type QuotaInfo,
} from './api'
import { failError, failMessage } from './fail'
import { t } from './i18n'
import type { HospitalLevel } from './types'

const TOKEN_KEY = 'qhyb.mpToken'
const LEVEL_KEY = 'qhyb.hospitalLevel'
let pendingLevelWrites = 0
let levelQueue: Promise<void> = Promise.resolve()
let loginRequest: Promise<MpProfile> | null = null
let levelChosenLocally = false

export const hospitalLevel = ref<HospitalLevel>('L3')
export const token = ref('')
export const profile = ref<MpProfile | null>(null)
export const sessionError = ref('')
export const sessionBusy = ref(false)

export const loggedIn = computed(() => Boolean(token.value && profile.value?.openid))
export const registered = computed(() => Boolean(loggedIn.value && profile.value?.registered))
export const quota = computed<QuotaInfo | null>(() => profile.value?.quota || null)

function isLevel(value: unknown): value is HospitalLevel {
  return value === 'L3' || value === 'L2' || value === 'L1'
}

export function applyProfile(next: MpProfile, nextToken?: string) {
  if (nextToken) {
    token.value = nextToken
    uni.setStorageSync(TOKEN_KEY, nextToken)
  }
  profile.value = next
  if (!pendingLevelWrites && !levelChosenLocally && isLevel(next.hospitalLevel)) {
    hospitalLevel.value = next.hospitalLevel
    uni.setStorageSync(LEVEL_KEY, next.hospitalLevel)
  }
}

function clearSession() {
  token.value = ''
  profile.value = null
  sessionError.value = ''
  uni.removeStorageSync(TOKEN_KEY)
}

export function loadLocalSettings() {
  const storedLevel = uni.getStorageSync(LEVEL_KEY)
  if (isLevel(storedLevel)) hospitalLevel.value = storedLevel
  const storedToken = uni.getStorageSync(TOKEN_KEY)
  if (typeof storedToken === 'string' && storedToken) token.value = storedToken
}

export async function setHospitalLevel(level: HospitalLevel) {
  levelChosenLocally = true
  hospitalLevel.value = level
  uni.setStorageSync(LEVEL_KEY, level)
  sessionError.value = ''
  if (!token.value) return
  pendingLevelWrites += 1
  // Serialize writes so the server also ends with the user's last selection.
  levelQueue = levelQueue.then(async () => {
    try {
      applyProfile(await withAuth((tok) => mpSettings(tok, level)))
      if (pendingLevelWrites === 1) sessionError.value = ''
    } catch (err) {
      if (pendingLevelWrites === 1) sessionError.value = failMessage(err, t('error.saveLevel'))
    } finally {
      pendingLevelWrites -= 1
    }
  })
  return levelQueue
}

function wxLoginCode(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  uni.login({
    provider: 'weixin',
    success: (res) => {
      if (res.code) resolve(res.code)
      else reject(new Error(t('error.loginCode')))
    },
    fail: (err) => reject(failError(err, t('error.loginCode'))),
  })
  return promise
}

export async function loginWithWeChat() {
  sessionBusy.value = true
  sessionError.value = ''
  try {
    await refreshLogin()
  } catch (err) {
    sessionError.value = failMessage(err, t('error.login'))
    throw err
  } finally {
    sessionBusy.value = false
  }
}

async function refreshLogin() {
  if (!loginRequest) {
    loginRequest = wxLoginCode().then(mpLogin).then((next) => {
      applyProfile(next, next.token)
      return next
    }).finally(() => { loginRequest = null })
  }
  return loginRequest
}

async function withAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
  if (!token.value) await refreshLogin()
  if (!token.value) throw new Error(sessionError.value || t('error.loginFirst'))
  // msg 声明在 try 外面：catch 块里的 const 降级成 ES5 会提升成 var，见 README
  let msg = ''
  try {
    return await fn(token.value)
  } catch (err) {
    msg = failMessage(err, '')
    if ((err as { statusCode?: number })?.statusCode !== 401 && !msg.includes('未登录') && !msg.includes('401')) throw err
    token.value = ''
    uni.removeStorageSync(TOKEN_KEY)
    await refreshLogin()
    if (!token.value) throw new Error(sessionError.value || t('error.loginFirst'))
    return await fn(token.value)
  }
}

export async function restoreSession() {
  loadLocalSettings()
  sessionBusy.value = true
  try {
    await refreshLogin()
  } catch (err) {
    sessionError.value = failMessage(err, t('error.login'))
  } finally {
    sessionBusy.value = false
  }
}

export async function doCheckin() {
  const next = await withAuth((tok) => mpCheckin(tok))
  applyProfile(next)
  return next
}

export async function registerAccount(body: { nickname: string; avatar?: string; phoneCode?: string }) {
  sessionBusy.value = true
  sessionError.value = ''
  // next 声明在 try 外面：留在块里的话，压缩后可能和模块级的 fail 引用撞名，
  // 微信降级 ES5 时提升成函数作用域的 var，catch 里的 failMessage 就没了。
  let next: MpProfile | null = null
  try {
    next = await withAuth((tok) => mpRegister(tok, body))
    applyProfile(next)
    return next
  } catch (err) {
    sessionError.value = failMessage(err, t('login.fail'))
    throw err
  } finally {
    sessionBusy.value = false
  }
}

export async function logoutAccount() {
  try {
    if (token.value) await mpLogout(token.value)
  } catch {
    /* still clear local */
  }
  clearSession()
}

export async function cancelAccount() {
  await withAuth((tok) => mpCancel(tok))
  clearSession()
}

export async function consumeQuery(q: string) {
  const next = await withAuth((tok) => mpQuery(tok, q))
  applyProfile(next)
  return next
}

export async function claimAdReward() {
  const next = await withAuth((tok) => mpAdReward(tok))
  applyProfile(next)
  return next
}
