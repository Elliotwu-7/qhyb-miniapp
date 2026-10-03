import { markRaw } from 'vue'
import { currentUseHint, isCurrentlyChargeable, isEffectivelyStopped, isUpcoming, isUpcomingExecute } from './status'
import { isConsumable, isDrug, isLimitedDrug, type SearchItem } from './types'
import { normalizeSearchText, translatedNameMatch } from './search-terms'

export type IndexedItem = SearchItem & {
  nameN: string
  aliasesN: string[]
  codeLower: string
  contentN: string
  piJoin: string
  pyJoin: string
  /** 每个名字各自的拼音首字母，名字和别名分开存。子序列那一档必须逐个名字比，
   *  不能拿拼在一起的 piJoin 比 —— 见 scoreItem。 */
  piParts: string[]
  /** piParts 里出现过的字符并集。查询里有字符不在这里，子序列就不可能成立，
   *  那一档可以直接跳过，不必逐个名字去走。 */
  piChars: string
  chargeable: boolean
  stopped: boolean
  pending: boolean
  upcoming: boolean
}

function asIndexed(item: SearchItem): IndexedItem | null {
  return 'nameN' in item ? (item as IndexedItem) : null
}

function norm(s: string) {
  return normalizeSearchText(s)
}

/** 内容兜底的 DF 上限：一次查询在内涵里命中多少条以上就不启用内容兜底。
 *
 * 内涵列里有大量跨项目反复出现的词——「不含」在 3272 条里出现、「检查」1759 条、
 * 「手术」1846 条。放它们进结果，用户搜「不含」会拿到三千条，等于没搜。13445 条里
 * 1% 是 134：卡在这里，「护理」(96)、「心脏」(104)、「导尿」(94)、「清创」(108)
 * 这类真能靠内涵捞回结果的词进得来，「肿瘤」(369)、「骨折」(431)、「材料」(323)
 * 这类靠名字就够、内涵只会添乱的进不来。
 *
 * 客户端没有全量 DF 表，但每次查询本来就要遍历一遍全量条目，顺手把没命中标题的
 * 内涵命中攒下来即可 ——见 searchCatalog。
 */
const CONTENT_DF_MAX = 134

function contentOf(item: SearchItem): string {
  const indexed = asIndexed(item)
  return indexed ? indexed.contentN : norm(item.contentText || '')
}

/** 名字和别名的倒排，按条目建一次，不按传入的数组建。
 *  首页和图谱每次查询都传一份新数组（filter、Array.from 出来的），按数组身份缓存等于每次重算，
 *  比全量扫描还慢。条目本身是稳定对象，所以倒排挂在模块上，用 WeakSet 记谁已经进过索引。
 *  索引只决定「谁值得打分」，打分、排序、内容兜底的上限都和全量扫描一致。
 *  拼音是子序列匹配、编码字段短、藏文别名是查询时才到的，这三样不进倒排：
 *  纯字母数字或带藏文的查询退回全量扫描。
 *  三字覆盖三个字以上的查询；两字查询（「透析」「护理」这类最常搜的词）走单独的二字倒排，
 *  三字倒排覆盖不了它们，以前只能整库打分。 */
const NAME_TRIGRAM = 3
const NAME_BIGRAM = 2
const nameTrigram = new Map<string, SearchItem[]>()
const nameBigram = new Map<string, SearchItem[]>()
const nameTrigramIndexed = new WeakSet<SearchItem>()

/** 内涵也走同一份倒排，但和名字分开存。
 *  名字倒排只用来决定「谁值得打分」，内涵倒排只用来决定「谁进内容兜底」：
 *  名字里不含这个词、内涵里含的条目，必须从内涵倒排里捞得回来，否则结果会变短。
 *  三字覆盖三个字以上的查询；两字查询走单独的二字倒排，否则「透析」「护理」这类
 *  最常搜的词在内容兜底上还是整库扫一遍。高频词（「不含」三千多条）的桶很大，
 *  那种查询本来就过不了 CONTENT_DF_MAX，捞回来也用不上。 */
const contentTrigram = new Map<string, SearchItem[]>()
const contentBigram = new Map<string, SearchItem[]>()

/** 编码的倒排，和名字同一套：两字查询走二字，三字以上走三字。
 *  诊疗项目编码是 8 到 16 位数字，中文查询的片段在里面一个都没有，倒排直接给出空桶，
 *  那一万多条编码比对就整个省掉。纯字母数字的查询（照着单子抄编码、拼音）不进这里，
 *  仍然整库打分 —— 拼音是子序列匹配，倒排覆盖不了。 */
const codeTrigram = new Map<string, SearchItem[]>()
const codeBigram = new Map<string, SearchItem[]>()

function indexNameTrigrams(item: SearchItem) {
  if (nameTrigramIndexed.has(item)) return
  nameTrigramIndexed.add(item)
  const indexed = asIndexed(item)
  const fields = indexed ? [indexed.nameN, ...indexed.aliasesN] : [norm(item.name), ...item.aliases.map(norm)]
  addTrigrams(nameTrigram, fields, item, NAME_TRIGRAM)
  addTrigrams(nameBigram, fields, item, NAME_BIGRAM)
  addTrigrams(contentTrigram, [contentOf(item)], item, NAME_TRIGRAM)
  addTrigrams(contentBigram, [contentOf(item)], item, NAME_BIGRAM)
  addTrigrams(codeTrigram, [codeOf(item)], item, NAME_TRIGRAM)
  addTrigrams(codeBigram, [codeOf(item)], item, NAME_BIGRAM)
}

function codeOf(item: SearchItem): string {
  const indexed = asIndexed(item)
  return indexed ? indexed.codeLower : (item.code || '').toLowerCase()
}

function addTrigrams(index: Map<string, SearchItem[]>, texts: string[], item: SearchItem, size: number) {
  const seen = new Set<string>()
  texts.forEach((text) => {
    if (text.length < size) return
    let from = 0
    let gram = ''
    let bucket: SearchItem[] | undefined
    while (from <= text.length - size) {
      gram = text.slice(from, from + size)
      from += 1
      // 名字和别名经常重叠（「腹膜透析」既是名字也是别名），同一个片段在同一条目里
      // 只记一次。记两次的话，查询侧按桶里的条数去重之前就会把同一条目算成两条，
      // 内容兜底的命中条数会被抬高，CONTENT_DF_MAX 那道门就和全量扫描对不上。
      if (seen.has(gram)) continue
      seen.add(gram)
      bucket = index.get(gram)
      if (bucket) bucket.push(item)
      else index.set(gram, [item])
    }
  })
}

const EMPTY_BUCKET: SearchItem[] = []

/** 一份条目数组的成员集合，按数组身份记。
 *  倒排桶是全目录共用的，每次查询都要拿「这份数组里有谁」去过滤；数组是调用方
 *  filter 出来的，同一份会被名字、编码、内涵三套倒排各用一次。集合只回答
 *  「在不在」，条目本身不变，所以按数组身份记一次，后面的查询直接取。 */
const membersByArray = new WeakMap<SearchItem[], Set<SearchItem>>()

function membersOf(items: SearchItem[]): Set<SearchItem> {
  const cached = membersByArray.get(items)
  if (cached) return cached
  const built = new Set<SearchItem>(items)
  membersByArray.set(items, built)
  return built
}

/** 倒排覆盖得了这次查询就给候选（空数组表示确实没有），覆盖不了返回 null 让调用方全量扫。
 *  两个字的查询走二字倒排，三个字以上走最稀有的三字。 */
function trigramCandidates(items: SearchItem[], qn: string): SearchItem[] | null {
  if (qn.length === NAME_BIGRAM) return rarestBucket(nameBigram, items, qn, NAME_BIGRAM)
  return rarestBucket(nameTrigram, items, qn, NAME_TRIGRAM)
}

/** 内涵倒排只在名字倒排也覆盖得了的时候才用：两边都收窄，结果才和全量扫一致。
 *  两个字的查询走二字倒排，三个字以上走最稀有的三字。 */
function contentCandidates(items: SearchItem[], qn: string): SearchItem[] | null {
  if (qn.length === NAME_BIGRAM) return rarestBucket(contentBigram, items, qn, NAME_BIGRAM)
  return rarestBucket(contentTrigram, items, qn, NAME_TRIGRAM)
}

/** 编码倒排和名字倒排互相独立，所以中文查询在这里是空桶，调用方就不用再逐条对编码。
 *  纯字母数字和藏文的查询由 rarestBucket 退回 null，调用方改走全量扫描。 */
function codeCandidates(items: SearchItem[], qn: string): SearchItem[] | null {
  if (qn.length === NAME_BIGRAM) return rarestBucket(codeBigram, items, qn, NAME_BIGRAM)
  return rarestBucket(codeTrigram, items, qn, NAME_TRIGRAM)
}

function rarestBucket(index: Map<string, SearchItem[]>, items: SearchItem[], qn: string, size: number): SearchItem[] | null {
  if (qn.length < size || /^[a-z0-9]+$/i.test(qn)) return null
  // 藏文别名不在倒排里：translatedNameMatch 是查询时才查到的，藏文查询只能整库打分。
  if (/[ཀ-ྼ]/.test(qn)) return null
  let rarest: SearchItem[] | undefined
  let from = 0
  let bucket: SearchItem[] | undefined
  let rows: SearchItem[] = EMPTY_BUCKET
  while (from <= qn.length - size) {
    bucket = index.get(qn.slice(from, from + size))
    rows = bucket || EMPTY_BUCKET
    if (!rarest || rows.length < rarest.length) rarest = rows
    from += 1
  }
  if (!rarest || !rarest.length) return EMPTY_BUCKET
  // 倒排是全目录共用的一份，这份查询只认传进来的这些条目。
  // 成员集合按数组身份记一份：首页每次查询都 filter 出新数组，同一份数组里
  // 名字、编码、内涵三套倒排各要建一次，而一次查询要查三类目录。数组本身不变，
  // 只是反复拿来问「在不在」，建一次就够了。
  const allow = membersOf(items)
  const out: SearchItem[] = []
  rarest.forEach((item) => {
    if (allow.has(item)) out.push(item)
  })
  return out
}

function piCharUnion(parts: string[]): string {
  const seen: Record<string, 1> = {}
  let out = ''
  let ch = ''
  parts.forEach((part) => {
    let k = 0
    while (k < part.length) {
      ch = part.charAt(k)
      k += 1
      if (seen[ch]) continue
      seen[ch] = 1
      out += ch
    }
  })
  return out
}

/** 查询的每个字符都在条目的首字母并集里，子序列才有可能成立。 */
function piCharsCovers(chars: string, qn: string): boolean {
  let k = 0
  while (k < qn.length) {
    if (chars.indexOf(qn.charAt(k)) < 0) return false
    k += 1
  }
  return true
}

function isSubsequence(haystack: string, needle: string) {
  if (!needle || needle.length < 2) return false
  // 拼音首字母都是 BMP 字符，按下标取码点和按字符取是一回事，不必每次 Array.from
  // 拆一遍（旧写法每个候选条目都要分配一个数组）。
  let i = 0
  let j = 0
  const last = needle.length
  const end = haystack.length
  while (j < end) {
    if (haystack.charAt(j) === needle.charAt(i)) {
      i += 1
      if (i === last) return true
    }
    j += 1
  }
  return false
}

function aliasHit(item: SearchItem, qn: string, tibetan: boolean): 'exact' | 'part' | null {
  const indexed = asIndexed(item)
  const aliases = indexed ? indexed.aliasesN : item.aliases.map(norm)
  // 藏文别名是查询时才取到的，而且只有藏文查询才用得上：中文、拼音、编码的查询
  // 规整之后不含藏文字母，不可能和藏文别名对上，这一查每条都白做。
  const translated = tibetan ? translatedNameMatch(item.name, qn) : null
  if (aliases.includes(qn) || translated === 'exact') return 'exact'
  return aliases.some((an) => an.includes(qn)) || translated === 'part' ? 'part' : null
}

export function prepareSearchItems(items: SearchItem[], now = new Date()): IndexedItem[] {
  items.forEach((item) => {
    const rec = item as IndexedItem
    rec.nameN = norm(item.name)
    rec.aliasesN = item.aliases.map(norm)
    rec.codeLower = (item.code || '').toLowerCase()
    rec.contentN = norm(item.contentText || '')
    rec.piJoin = `${item.pi}${item.aliasPi}`.replace(/\s+/g, '')
    rec.pyJoin = `${item.py}${item.aliasPy}`.replace(/\s+/g, '')
    rec.piParts = [item.pi, ...String(item.aliasPi || '').split(/\s+/).filter(Boolean)]
    rec.piChars = piCharUnion(rec.piParts)
    rec.stopped = isEffectivelyStopped(item, now)
    rec.pending = isUpcomingExecute(item, now)
    rec.upcoming = isUpcoming(item, now)
    rec.chargeable = !rec.stopped && !rec.pending
    markRaw(item)
    indexNameTrigrams(item)
  })
  return items as IndexedItem[]
}

export function buildNameIndex(items: SearchItem[]): Map<string, SearchItem> {
  const byName = new Map<string, SearchItem>()
  items.forEach((item) => {
    if (!byName.has(item.name)) byName.set(item.name, item)
  })
  return byName
}

export function scoreItem(item: SearchItem, query: string, contentDf = 0, contentAllowed = false): number {
  return scoreItemNorm(item, query.trim(), contentDf, contentAllowed)
}

/** 查询已经规整过的打分。searchCatalog 一次查询要给成百上千条打分，规整和
 *  字母判定只和查询有关、和条目无关，提到外面算一次，别让每条都重做。 */
function scoreItemNorm(item: SearchItem, qn: string, contentDf = 0, contentAllowed = false, alpha = /^[a-z0-9]+$/i.test(qn), tibetan = /[ༀ-࿿]/.test(qn)): number {
  if (!qn) return 0
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  // 判定用的是规整后的查询而不是用户原样输入：normalizeSearchText 会把全角折成半角
  // （ＦＡＭＯＴＩＤＩＮＥ → famotidine），拿原始串去比 /^[a-z0-9]+$/ 会把中文输入法
  // 全角状态下敲的英文、拼音、首字母缩写整条拼音阶梯都跳过，用户什么也搜不到。
  // alpha 由调用方算好传进来：一次查询里它是个常量，别让每条都重判一次。
  const alias = aliasHit(item, qn, tibetan)
  const exactName = nameN === qn
  const pending = indexed ? indexed.pending : isUpcomingExecute(item)
  const stopped = indexed ? indexed.stopped : isEffectivelyStopped(item)
  const chargeable = indexed ? indexed.chargeable : isCurrentlyChargeable(item)
  // piJoin / pyJoin 提到函数顶层，不留在下面的 else-if 块里：块级声明被压缩后
  // 可能和模块级引用撞名，微信降级 ES5 时提升成 var，上面几行的引用就变 undefined。
  const piJoin = indexed ? indexed.piJoin : `${item.pi}${item.aliasPi}`.replace(/\s+/g, '')
  const pyJoin = indexed ? indexed.pyJoin : `${item.py}${item.aliasPy}`.replace(/\s+/g, '')
  // 子序列那一档必须逐名字比。拿拼在一起的 piJoin 比的话，一个收了几十个别名的
  // 条目（「临床量表评估(他评)」有 100 个）会把自己变成一段上千字母的字母汤，
  // 随便什么英文或拼音串都能在里面找到子序列 —— 实测 400 个随机 10 字母串里
  // 能命中 411 次，全是这类条目。真实药物名「Famotidine」也这么被它捞进来。
  const piParts = indexed ? indexed.piParts : [item.pi, ...String(item.aliasPi || '').split(/\s+/).filter(Boolean)]
  const piChars = indexed ? indexed.piChars : piCharUnion(piParts)
  const mergedLive = item.merged && chargeable
  let score = 0

  if (alias === 'exact' && mergedLive) score = 5000
  else if (exactName && stopped) score = 4500
  else if (exactName) score = 4000
  else if (nameN.startsWith(qn) && mergedLive) score = 3600
  else if (nameN.startsWith(qn) && chargeable) score = 3200
  else if (alias === 'exact') score = 2800
  else if (nameN.includes(qn)) score = 2200
  else if (codeLower.includes(qn)) score = 2000
  else if (alias === 'part') score = 1600
  else if (alpha) {
    if (item.pi === qn || item.pi.startsWith(qn)) score = 1400
    else if (piJoin.includes(qn)) score = 1200
    else if (piCharsCovers(piChars, qn) && piParts.some((part) => isSubsequence(part, qn))) score = 900
    else if (pyJoin.includes(qn)) score = 700
  }

  if (score === 0 && contentAllowed && contentOf(item).includes(qn)) {
    // 内容兜底排在整个标题阶梯之下：名字、别名、编码、拼音全都没命中才轮到它。
    // 600 分比最低的一档标题命中（700，拼音子串）还低，所以它只会把结果变长，
    // 不会把原来排在前面挤下去。contentAllowed 由调用方在确认命中条数不超过
    // CONTENT_DF_MAX 之后才置上，免得「不含」「检查」这类高频词整库都进来。
    score = 600
  }

  if (score === 0) return 0
  if (chargeable) score += 80
  if (pending) score -= 420
  if (stopped && !exactName) score -= 80
  score -= Math.max(0, nameN.length - qn.length) * 1.5
  return score
}

export function searchCatalog(items: SearchItem[], query: string): SearchItem[] {
  const q = query.trim()
  if (!q) return items
  const qn = norm(q)
  // 字母判定和藏文判定都只和查询有关，提到循环外面算一次：拼音那一档是子序列匹配，
  // 纯字母数字的查询退回全量扫描，每条都要重判一次的话这一下就被放大一万多倍。
  // 藏文别名只对得上含藏文字母的查询，中文和拼音查询不必每条都去查一次别名表。
  const alpha = /^[a-z0-9]+$/i.test(qn)
  const tibetan = /[ༀ-࿿]/.test(qn)
  const ranked: Array<{ s: number; item: SearchItem }> = []
  // 内容兜底的候选先攒着，等扫完才知道命中条数有没有超过 CONTENT_DF_MAX。
  // 名字和别名有三字倒排：查询满三个字且不是纯字母数字时，先在倒排圈出的候选里打分，
  // 其余条目的名字和别名不可能含这个查询，只查编码和内涵。拼音那一档是子序列匹配、
  // 藏文别名是查询时才取到的，这两种查询不走倒排，整库打分。
  const contentHits: SearchItem[] = []
  items.forEach(indexNameTrigrams)
  const narrowed = trigramCandidates(items, qn)
  const contentPool = narrowed ? contentCandidates(items, qn) : null
  // 编码倒排和名字倒排互相独立：中文查询在编码倒排里是空桶，那一万多条编码比对就整个省掉。
  const codePool = narrowed ? codeCandidates(items, qn) : null
  // covered 必须声明在函数顶层：压缩后它和参数 query 同名（都变成 t），
  // 写在 else 分支里的话，微信降级 ES5 时 var 提升会把查询参数冲掉。
  const covered = new Set<SearchItem>()
  if (!narrowed) {
    items.forEach((item) => {
      const s = scoreItemNorm(item, qn, 0, false, alpha, tibetan)
      if (s > 0) ranked.push({ s, item })
      else if (qn.length >= 2 && contentOf(item).includes(qn)) contentHits.push(item)
    })
  } else {
    narrowed.forEach((item) => {
      if (covered.has(item)) return
      covered.add(item)
      const s = scoreItemNorm(item, qn, 0, false, alpha, tibetan)
      if (s > 0) ranked.push({ s, item })
      else if (qn.length >= 2 && contentOf(item).includes(qn)) contentHits.push(item)
    })
    // 名字倒排没覆盖到的条目，名字和别名都不可能含这个查询，只剩编码和内涵两条路。
    // 编码也有自己的倒排：中文查询在里面是空桶，这一步就整个跳过。
    // 纯字母数字的查询走不到这里（上面 !narrowed 已经整库打分了）。
    // 内涵倒排同理：高频词的桶很大，那种查询过不了 CONTENT_DF_MAX，扫不扫都一样。
    if (codePool) {
      codePool.forEach((item) => {
        if (covered.has(item)) return
        const indexed = asIndexed(item)
        const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
        if (codeLower.includes(qn)) ranked.push({ s: scoreItemNorm(item, qn, 0, false, alpha, tibetan), item })
      })
    } else {
      items.forEach((item) => {
        if (covered.has(item)) return
        const indexed = asIndexed(item)
        const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
        if (codeLower.includes(qn)) ranked.push({ s: scoreItemNorm(item, qn, 0, false, alpha, tibetan), item })
      })
    }
    if (contentPool) {
      contentPool.forEach((item) => {
        if (covered.has(item)) return
        if (qn.length >= 2 && contentOf(item).includes(qn)) contentHits.push(item)
      })
    } else {
      items.forEach((item) => {
        if (covered.has(item)) return
        if (qn.length >= 2 && contentOf(item).includes(qn)) contentHits.push(item)
      })
    }
  }
  if (contentHits.length > 0 && contentHits.length <= CONTENT_DF_MAX) {
    contentHits.forEach((item) => {
      ranked.push({ s: scoreItemNorm(item, qn, 0, true, alpha, tibetan), item })
    })
  }
  ranked.sort((a, b) => b.s - a.s)
  return ranked.map((x) => x.item)
}

export function queryHitsNameOrCode(item: SearchItem, query: string): boolean {
  const q = query.trim()
  const qn = norm(q)
  if (!qn) return false
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  if (nameN === qn || nameN.includes(qn) || codeLower === qn) return true
  if (translatedNameMatch(item.name, qn)) return true
  if (/^[a-z0-9]+$/i.test(qn) && (item.pi === qn || item.pi.startsWith(qn))) return true
  return false
}

function queryIsExactNameOrCode(item: SearchItem, query: string): boolean {
  const qn = norm(query)
  if (!qn) return false
  const indexed = asIndexed(item)
  const nameN = indexed ? indexed.nameN : norm(item.name)
  const codeLower = indexed ? indexed.codeLower : (item.code || '').toLowerCase()
  return nameN === qn || codeLower === qn || translatedNameMatch(item.name, qn) === 'exact'
}

function liveOriginals(item: SearchItem, byName: Map<string, SearchItem>): SearchItem[] {
  const out: SearchItem[] = []
  const seen = new Set<string>()
  currentUseHint(item).forEach((name) => {
    const orig = byName.get(name)
    if (!orig) return
    const chargeable = asIndexed(orig)?.chargeable ?? isCurrentlyChargeable(orig)
    if (!chargeable || seen.has(orig.id)) return
    seen.add(orig.id)
    out.push(orig)
  })
  return out
}

export function resolveCurrentHits(
  catalog: SearchItem[],
  found: SearchItem[],
  query: string,
  statusFilter: string,
  byName?: Map<string, SearchItem>,
): SearchItem[] {
  const pendingOf = (item: SearchItem) => asIndexed(item)?.pending ?? isUpcomingExecute(item)
  if (statusFilter === 'pending') return found.filter((item) => pendingOf(item))

  const q = query.trim()
  const names = byName ?? buildNameIndex(catalog)

  const extras: SearchItem[] = []
  if (q) {
    catalog.forEach((item) => {
      if (!pendingOf(item) || !queryHitsNameOrCode(item, q)) return
      extras.push(...liveOriginals(item, names))
    })
  }

  const seen = new Set<string>()
  const kept: SearchItem[] = []
  // origs 声明在回调外面：块里的 const 降级成 ES5 会提升成 var，见 README
  let origs: SearchItem[] = []
  found.forEach((item) => {
    if (item.kind) {
      if (seen.has(item.id)) return
      seen.add(item.id)
      kept.push(item)
      return
    }
    if (pendingOf(item)) {
      origs = liveOriginals(item, names)
      if (!(q && queryIsExactNameOrCode(item, q) && origs.length === 0)) return
    }
    if (seen.has(item.id)) return
    seen.add(item.id)
    kept.push(item)
  })

  const head: SearchItem[] = []
  extras.forEach((orig) => {
    if (seen.has(orig.id)) return
    seen.add(orig.id)
    head.push(orig)
  })
  return [...head, ...kept]
}

export function matchesStatus(item: SearchItem, statusFilter: string, hasQuery: boolean): boolean {
  const indexed = asIndexed(item)
  const chargeable = indexed ? indexed.chargeable : isCurrentlyChargeable(item)
  const stopped = indexed ? indexed.stopped : isEffectivelyStopped(item)
  const pending = indexed ? indexed.pending : isUpcomingExecute(item)
  const upcoming = indexed ? indexed.upcoming : isUpcoming(item)
  if (statusFilter === 'active') return chargeable
  if (statusFilter === 'stopped') return stopped
  if (statusFilter === 'merged') return item.merged
  if (statusFilter === 'upcoming') return upcoming
  if (statusFilter === 'pending') return pending
  if (!hasQuery) return chargeable
  return true
}

export type SearchScope = 'all' | 'service' | 'drug' | 'consumable' | 'spec'
export type DrugFilter = 'all' | 'classA' | 'classB' | 'limited' | 'outside'
/** 耗材的三类：医保耗材目录编码 / 挂网产品 / 带量采购中选结果。 */
export type ConsumableFilter = 'all' | 'catalog' | 'product' | 'lot'

/** 筛选结果按「源数组身份 + 筛选条件」记一份。
 *  首页每敲一个字都要把服务项目、药品、耗材各筛一遍，筛出来的数组每次都是新的，
 *  倒排那一侧按数组身份记的成员集合也就跟着每次重建。同一组筛选条件在连着打字时
 *  不会变，源数组只在目录重新加载时才换，所以按这两样记一次就够了。 */
const filteredBySource = new WeakMap<SearchItem[], Map<string, SearchItem[]>>()

function cachedFilter(source: SearchItem[], key: string, matches: (item: SearchItem) => boolean): SearchItem[] {
  // box、hit 都声明在函数顶层：写进 if 块里的 const 降级成 ES5 会提升成 var，
  // 和上面那个 box 撞成同一个绑定，见 README。
  let box = filteredBySource.get(source)
  let hit: SearchItem[] | undefined
  if (!box) {
    box = new Map<string, SearchItem[]>()
    filteredBySource.set(source, box)
  }
  hit = box.get(key)
  if (hit) return hit
  const out = source.filter(matches)
  box.set(key, out)
  return out
}

/** Partition before pagination, preserving relevance order inside each group. */
export function orderDirectoryHits(items: SearchItem[]): SearchItem[] {
  const live: SearchItem[] = []
  const drugs: SearchItem[] = []
  const consumables: SearchItem[] = []
  const pending: SearchItem[] = []
  const stopped: SearchItem[] = []
  items.forEach((item) => {
    // 状态判定放在耗材判定之前：耗材也分在用、公示未生效、已废止三档，
    // 一律并进「耗材」那一组的话，8 条还没生效的会被当成现行目录里的东西。
    const isStopped = asIndexed(item)?.stopped ?? isEffectivelyStopped(item)
    const isPending = asIndexed(item)?.pending ?? isUpcomingExecute(item)
    if (isDrug(item)) drugs.push(item)
    else if (isStopped) stopped.push(item)
    else if (isPending) pending.push(item)
    else if (isConsumable(item)) consumables.push(item)
    else live.push(item)
  })
  return [...live, ...drugs, ...consumables, ...pending, ...stopped]
}

export function searchDirectory(
  services: SearchItem[],
  drugs: SearchItem[],
  options: {
    query: string
    scope: SearchScope
    category?: string
    status?: string
    drugFilter?: DrugFilter
    consumables?: SearchItem[]
    consumableFilter?: ConsumableFilter
  },
  byName?: Map<string, SearchItem>,
): SearchItem[] {
  const query = options.query.trim()
  // Status applies to services and consumables; drug filters apply to drugs only.
  const status = options.scope === 'drug' ? '' : options.status || ''
  const category = options.scope === 'all' ? '' : options.category || ''
  // 三类各自只在「全部」和自己那一档里出现：耗材那一档不能混进收费项目和药品，
  // 反过来也一样。
  const withServices = options.scope === 'all' || options.scope === 'service'
  const withDrugs = options.scope === 'all' || options.scope === 'drug'
  const withConsumables = options.scope === 'all' || options.scope === 'consumable'
  const matchesService = (item: SearchItem) =>
    (!category || item.cat1 === category) && matchesStatus(item, status, Boolean(query))
  const servicePool = withServices ? cachedFilter(services, `svc|${category}|${status}|${query ? 1 : 0}`, matchesService) : []
  const found = withServices ? searchCatalog(servicePool, query) : []
  // Resolution may add current predecessors from the full catalog. Keep them
  // within the selected category and status, just like direct search matches.
  const serviceHits = withServices ?
    resolveCurrentHits(services, found, query, status, byName).filter(matchesService) : []
  const drugKey = `drug|${category}|${options.scope}|${options.drugFilter || ''}`
  const drugPool = !withDrugs ? [] : cachedFilter(drugs, drugKey, (item) => {
    if (category && item.cat1 !== category) return false
    if (options.scope !== 'drug') return true
    if (options.drugFilter === 'classA') return item.payClass === '甲类'
    if (options.drugFilter === 'classB') return item.payClass === '乙类'
    if (options.drugFilter === 'limited') return isLimitedDrug(item)
    if (options.drugFilter === 'outside') return item.paid === false
    return true
  })
  const drugHits = !withDrugs ? [] : searchCatalog(drugPool, query)
  // 耗材按类别筛选，不套服务项目那套分类（耗材的分类是「一、医用工具类」这种，
  // 和服务项目的分类不是一张表，挂网产品和带量采购压根没有分类）。
  const kind = options.consumableFilter || 'all'
  const matchesConsumable = (item: SearchItem) =>
    (kind === 'all' || item.hcKind === kind) && matchesStatus(item, status, Boolean(query))
  const consumableHits = !withConsumables ? []
    : searchCatalog(cachedFilter(options.consumables || [], `hc|${kind}|${status}|${query ? 1 : 0}`, matchesConsumable), query)
  return orderDirectoryHits([...serviceHits, ...drugHits, ...consumableHits])
}
