export function failMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err

  // 声明全部放在函数顶层。写在 if 块里的话，微信把 ES6 降级成 ES5 时会提升成
  // 函数作用域的 var，和参数撞名就把兜底文案顶成 undefined。见 README。
  let msg = ''
  let errno = ''
  let extra = ''
  let errnoRaw: unknown
  let reasons: unknown
  let parts: string[] = []

  if (err && typeof err === 'object') {
    msg = 'errMsg' in err && typeof err.errMsg === 'string' ? err.errMsg : ''
    errnoRaw = 'errno' in err ? err.errno : undefined
    errno = typeof errnoRaw === 'number' || typeof errnoRaw === 'string' ? String(errnoRaw) : ''
    if ('exception' in err && err.exception && typeof err.exception === 'object') {
      reasons = 'reasons' in err.exception ? err.exception.reasons : undefined
      if (Array.isArray(reasons)) {
        extra = reasons
          .map((item) => {
            if (!item || typeof item !== 'object') return ''
            const reasonMsg = 'errMsg' in item && typeof item.errMsg === 'string' ? item.errMsg : ''
            const reasonErrno = 'errno' in item ? String(item.errno ?? '') : ''
            if (reasonMsg && reasonErrno) return `${reasonMsg} (${reasonErrno})`
            return reasonMsg || reasonErrno
          })
          .filter(Boolean)
          .join('; ')
      }
    }
    parts = [msg, errno ? `(${errno})` : '', extra].filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  return fallback
}

export function failError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(failMessage(err, fallback))
}

// 带位置信息的失败。真机上微信只回 `net::ERR_xxx (600001)` 这类文本，里面没有 URL，
// 报错时定位不到是哪个请求发出的；这里把 errMsg 和标签（含 URL）拼在一起，两边都留着。
export function failErrorAt(err: unknown, label: string): Error {
  if (err instanceof Error) return err
  const detail = failMessage(err, '')
  return new Error(detail ? `${detail} · ${label}` : label)
}
