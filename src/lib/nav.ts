/**
 * 小程序里「返回」到底该回到哪。
 *
 * 分享卡和扫码进来的页面，微信给的页面栈里只有这一页。这种栈上原生的返回箭头会
 * **退出小程序**；而 uni.navigateBack 既不退也不报错 —— 2026-09-25 在模拟器里实测
 * 过：栈和当前页都不变，fail 回调不触发，自动化连接也没断。所以「navigateBack 失败
 * 就兜底」那种写法在单页栈上根本不会执行，是死代码（register.vue 原来就踩在这里）。
 *
 * 要退回就自己先看栈：还有上一页才 navigateBack，只有这一页就直接走首页 tab。
 * 首页是 tabBar 页，navigateTo / redirectTo 都到不了，只有 switchTab 行。
 */

/** 首页：查询 tab。 */
export const HOME_ROUTE = '/pages/index/index'

/**
 * 当前页面栈深度。取不到栈信息时按 1 算 —— 宁可多给一个「返回首页」的按钮，
 * 也不要少给一条出路。
 */
export function stackDepth(): number {
  // 声明在 try 外面：块里的 const 降级成 ES5 时会提升成 var，见 README
  let pages: Array<{ route?: string }> = []
  try {
    pages = getCurrentPages() as Array<{ route?: string }>
  } catch {
    return 1
  }
  return pages.length
}

/** 栈里只有这一页：微信原生返回箭头在这种页面上会退出小程序。 */
export function soloStack(): boolean {
  return stackDepth() <= 1
}

/** 回首页。switchTab 到不了（理论上不会）才退到 reLaunch。 */
export function goHome(): void {
  try {
    uni.switchTab({
      url: HOME_ROUTE,
      fail: () => {
        try {
          uni.reLaunch({ url: HOME_ROUTE, fail: () => {} })
        } catch {
          /* 到这一步没有别的路可走了 */
        }
      },
    })
  } catch {
    /* 到这一步没有别的路可走了 */
  }
}

/**
 * 页面自己的「返回」：有上一页就退回去，没有（分享/扫码直接进这一页）就回首页。
 *
 * 不要写成 `navigateBack({ fail: goHome })` —— 单页栈上 fail 不会触发。
 */
export function backOrHome(): void {
  if (stackDepth() > 1) {
    uni.navigateBack({ delta: 1, fail: goHome })
    return
  }
  goHome()
}
