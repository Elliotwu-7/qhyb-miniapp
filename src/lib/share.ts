/**
 * 小程序转发的公共入口。
 *
 * 右上角「···」里「转发给朋友」和「分享到朋友圈」是两个独立开关：
 * uni.showShareMenu 不传 menus 时只打开前者，朋友圈必须显式点名，否则入口根本不出现。
 *
 * 菜单能否开启由微信和当前 AppID 的权限决定。完整菜单不可用时尝试只开启
 * 好友转发；两者都不可用时仍允许正常浏览，不能让可选功能导致页面报错。
 *
 * 页面本身要分别在 onShareAppMessage / onShareTimeline 里给内容，这个函数只负责把
 * 菜单项打开。
 */
export function enableShare(): void {
  // H5 里没有这个 API；#ifdef 已经把它挡在 mp-weixin 之外，这里再兜一层，
  // 免得条件编译万一没生效就在浏览器里抛错。
  // #ifdef MP-WEIXIN
  if (typeof uni.showShareMenu !== 'function') return
  const enableFriendsOnly = () => {
    try {
      uni.showShareMenu({
        withShareTicket: false,
        menus: ['shareAppMessage'],
        fail: () => {},
      })
    } catch {
      // 某些运行环境会同步抛错；分享不可用不影响页面浏览。
    }
  }
  try {
    uni.showShareMenu({
      withShareTicket: false,
      menus: ['shareAppMessage', 'shareTimeline'],
      // 必须传 fail：否则 uni 会返回 Promise，权限拒绝会成为未处理的 rejection。
      fail: enableFriendsOnly,
    })
  } catch {
    enableFriendsOnly()
  }
  // #endif
}

/**
 * 朋友圈的 onShareTimeline 只接受 query（问号后面那段），不能给 path ——
 * 它是「分享当前页」，页面路径由微信自己定。所以这里把参数拼成 query 字符串。
 */
export function shareQuery(params: Record<string, string>): string {
  const parts: string[] = []
  Object.keys(params).forEach((key) => {
    const value = params[key]
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`)
  })
  return parts.join('&')
}
