/**
 * 名称、标题的字号自适应。
 *
 * 目录里有「经皮穿刺脑血管腔内支架置入术」这种十五六个字的长项目名，药品名还能更长；
 * 切到英文、藏文之后同一条又要再长一截。卡片上的名字只有两行，硬字号的结果是要么被截掉
 * 半个字，要么第二行只填了三分之一看着很散。
 *
 * 这里按「视觉宽度」分档 —— 一个汉字算 1，一个拉丁字母/数字算 0.55，藏文算 0.8（叠字比
 * 拉丁字母高）。调用方只拿档位，具体缩到多大由各自的样式定（卡片和详情页基数不同）。
 */

/** 单个字符的视觉宽度权重。 */
function charWeight(code: number): number {
  if (code === 9 || code === 10 || code === 32) return 0.35
  if (code >= 0xf00 && code <= 0xfff) return 0.8 // 藏文，叠字比拉丁字母高
  if (code >= 0x2e80) return 1 // 汉字、假名、谚文、全角标点
  return 0.55 // 拉丁字母、数字、半角标点
}

/**
 * 一段文字的视觉宽度。
 * 用下标循环 + charCodeAt，不用展开也不用 for…of：小程序要降到 ES5，那两种写法会被降成
 * 函数作用域的变量（见 README「不要用 for...of」）。
 */
export function textWidth(text: string): number {
  const value = text || ''
  let width = 0
  for (let i = 0; i < value.length; i += 1) width += charWeight(value.charCodeAt(i))
  return width
}

/**
 * 字号档位 0~3，0 是原样不缩。
 *
 * 档位按卡片正文的版面标定：375px 屏、页面留白 32rpx、卡片留白 28rpx，正文实际可用
 * 约 315px；卡片名字基数是 34rpx＝17px，一行放得下约 18.5 个字，两行 37 个字。所以
 * 22 字以上就往下缩一档 —— 那种长度两行里第二行不满，缩一档反而更整齐；超过 40 字才用
 * 最小档。详情页标题基数大、行数不限，套同一套档位（缩得比卡片少）。
 */
export function fitTier(text: string): number {
  const width = textWidth(text)
  if (width <= 22) return 0
  if (width <= 30) return 1
  if (width <= 40) return 2
  return 3
}

/** 「fit-1」这样的类名；0 档给空串，模板里可以直接 `:class="fitClass(name)"`。 */
export function fitClass(text: string): string {
  const tier = fitTier(text)
  return tier ? `fit-${tier}` : ''
}
