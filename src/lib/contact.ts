/** 反馈微信号。首页页脚、关于页、我的页都从这里取，改的时候不会漏一处。 */
export const FEEDBACK_WECHAT = 'lynkcolove'

/**
 * 复制反馈微信号。
 * 小程序进不了别人的聊天窗口，所谓「一键直达」能给到的就是：点一下复制，再去微信粘贴，
 * 不用自己记号码、也不用在通讯录里搜。
 *
 * 以前只接了 success，而这条在微信里**默认就是失败的**：setClipboardData 属于隐私接口，
 * 用户没同意隐私协议时直接报 `errno 104 privacy permission is not authorized`（2026-09-25
 * 在开发者工具里实测到）。一声不响，用户看到的就是「反馈微信无效」。现在失败也把号弹出来，
 * 照着输还能加；页脚文案本身也带着号（见 i18n 的 contact.action），不依赖复制成功。
 */
export function copyFeedbackWeChat(toast: string, title: string) {
  uni.setClipboardData({
    data: FEEDBACK_WECHAT,
    success: () => uni.showToast({ title: toast, icon: 'none' }),
    fail: () => uni.showModal({ title, content: FEEDBACK_WECHAT, showCancel: false }),
  })
}
