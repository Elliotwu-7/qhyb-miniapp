<script setup lang="ts">
import { computed } from 'vue'
import { useContentTranslation } from '../lib/content'
import { fitClass } from '../lib/fit'
const { ct, ctSoft } = useContentTranslation()
import HopList from './HopList.vue'
import ReactionBar from './ReactionBar.vue'
import PriceFigure from './PriceFigure.vue'
import { laterDateText, isEffectivelyStopped, isUpcoming, isUpcomingExecute, currentPriceOf, nextPriceOf, priceByLevel } from '../lib/status'
import { levelLabel } from '../lib/price'
import { categoryLabel, drugKindText, hcKindText, payLabel, pharmacopoeiaText, t } from '../lib/i18n'
import { isConsumable, isDrug, isLimitedDrug, isSpec, type HospitalLevel, type SearchItem } from '../lib/types'
import type { PharmacopoeiaHit } from '../lib/api'

const props = defineProps<{
  item: SearchItem
  level: HospitalLevel
  hops?: Array<{ item: SearchItem; rel: string }>
  pharmacopoeia?: PharmacopoeiaHit[]
}>()

// 用固定的空数组，不要写 `hops || []` —— 那每次渲染都是新引用，微信小程序会认为
// 数据变了，整列重新下发。
const NO_HOPS: Array<{ item: SearchItem; rel: string }> = []

const emit = defineEmits<{
  open: []
  jump: [id: string]
  /** 手指按上去就发，用来在点击生效之前把详情分片拉下来。 */
  warm: []
}>()

const specCard = computed(() => isSpec(props.item))
const drug = computed(() => isDrug(props.item))
const consumable = computed(() => isConsumable(props.item))
const stopped = computed(() => isEffectivelyStopped(props.item))
const upcoming = computed(() => isUpcoming(props.item))
const pending = computed(() => isUpcomingExecute(props.item))
const cardClass = computed(() => {
  const bits = ['result-card']
  // 规范不是收费项目也不是耗材，没有在用/停用那一套，先短路掉。
  if (specCard.value) return [...bits, 'is-spec'].join(' ')
  if (drug.value) return [...bits, 'is-drug'].join(' ')
  if (consumable.value) bits.push('is-consumable')
  if (stopped.value) bits.push('is-stopped')
  if (props.item.merged && !pending.value) bits.push('is-merged')
  if (pending.value) bits.push('is-pending')
  if (upcoming.value) bits.push('is-soon')
  return bits.join(' ')
})
const liveLabel = computed(() => t('result.beforeStopLevel', { level: levelLabel(props.level) }))
/** 耗材的规格型号在详情分片里，卡片只报注册证下有几个规格。 */
const hcPriceText = computed(() => t(`hc.price.${props.item.hcPriceLabel}`))
const hcIsRange = computed(() => (props.item.hcPrice || '').includes('~'))
/** 名字太长（中文长项目名，或切到英文/藏文后变长的同一条）就降一档字号，见 lib/fit.ts。 */
const nameFit = computed(() => fitClass(ct(props.item.name)))
</script>

<template>
  <!-- 整张卡片都是进详情的入口：以前只有标题那一块绑了事件，卡片下半截和两侧留白点了没反应。
       赞/踩/反馈条和 hop 跳转各自 stop 掉，不会连带开详情。 -->
  <view :class="cardClass" hover-class="is-press" :hover-stay-time="80" @touchstart="emit('warm')" @click="emit('open')">
    <!-- 技术规范卡：命中的是规范条目本身（线上规范库），没有价格、没有 hop，
         所以只印名称、类别标记、编号和页码。赞/踩/反馈照给：反馈正是用来报
         「这条规范对不上」的。 -->
    <template v-if="specCard">
      <view class="result-main">
        <view class="result-name" :class="nameFit">
          <text>{{ ct(item.name) }}</text>
          <text class="limit-badge spec-kind">{{ t('common.spec') }}</text>
        </view>
        <view class="result-meta">
          <text>{{ item.code || t('result.noCode') }}</text>
          <text v-if="item.page">{{ t('spec.pageLabel', { page: item.page }) }}</text>
        </view>
      </view>
      <ReactionBar :item="item" />
    </template>
    <template v-else-if="drug">
      <view v-if="item.paid === false" class="status-strip stop">{{ item.kind === 'excluded' ? t('result.fundExcluded') : t('result.commercial') }}</view>
      <view v-if="item.special" class="status-strip pending">{{ t('result.special') }}</view>
      <view class="result-main">
        <view class="result-name" :class="nameFit"><text>{{ ct(item.name) }}</text><text v-if="isLimitedDrug(item)" class="limit-badge">{{ t('common.limitedShort') }}</text></view>
        <view class="result-meta">
          <text>{{ item.kind ? drugKindText(item.kind) : t('common.drug') }}</text>
          <text v-if="item.payClass">{{ payLabel(item.payClass) }}</text>
          <text v-if="item.forms?.length">{{ item.forms.map(ct).join(' / ') }}</text>
          <text v-if="item.protocol">{{ ct(item.protocol) }}</text>
        </view>
        <view v-if="item.remark" class="result-note">{{ ct(item.remark) }}</view>
        <!-- 药典出处由列表页按当前这一页的药品名批量问来，卡片自己不发请求 -->
        <view v-for="(hit, i) in pharmacopoeia" :key="i" class="result-note">{{ t('drug.pharmacopoeia') }}：{{ pharmacopoeiaText(hit) }}</view>
      </view>
      <HopList :hops="hops || NO_HOPS" as-drug @jump="emit('jump', $event)" />
      <ReactionBar :item="item" />
    </template>
    <template v-else-if="consumable">
      <view v-if="stopped" class="status-strip stop">{{ t('hc.status.stopped') }}</view>
      <view v-else-if="pending" class="status-strip pending">{{ t('hc.status.pending') }}</view>
      <view class="result-main">
        <view class="result-name" :class="[nameFit, { 'is-stopped': stopped }]">
          <text>{{ ct(item.name) }}</text>
          <text class="limit-badge hc-kind">{{ hcKindText(item.hcKind) }}</text>
        </view>
        <view class="result-meta">
          <text>{{ item.code || t('result.noCode') }}</text>
          <text v-if="item.cat2 || item.cat1">{{ ct(item.cat2) || categoryLabel(item.cat1) }}</text>
          <text v-if="item.hcSpecCount">{{ t('hc.card.specCount', { count: item.hcSpecCount }) }}</text>
          <text v-if="item.unit">{{ ct(item.unit) }}</text>
        </view>
        <view v-if="item.hcPrice" class="hc-price">
          <text class="hc-price-label">{{ hcPriceText }}</text>
          <text class="hc-price-value">{{ item.hcPrice }}</text>
        </view>
        <view v-if="item.hcPrice && hcIsRange" class="result-note">{{ t('hc.price.range') }}</view>
        <view v-else-if="!item.hcPrice && item.hcKind === 'product'" class="result-note">{{ t('hc.card.noPrice') }}</view>
        <view v-if="item.hcPriceLabel" class="result-note">{{ t(`hc.price.warn.${item.hcPriceLabel}`) }}</view>
        <view v-if="item.hcPublicOk" class="result-note">{{ t('hc.card.publicOk') }}</view>
        <view v-if="item.remark" class="result-note">{{ t('result.remark', { text: ct(item.remark) }) }}</view>
      </view>
      <HopList :hops="hops || NO_HOPS" head-key="hop.relatedConsumables" note-key="hop.noteConsumable" @jump="emit('jump', $event)" />
      <ReactionBar :item="item" />
    </template>
    <template v-else>
      <view v-if="stopped" class="status-strip stop">{{ t('result.stopped') }}</view>
      <view v-else-if="pending" class="status-strip pending">{{ t('result.executesAt', { date: ct(item.executeAt) }) }}</view>
      <view v-else-if="item.merged" class="status-strip merge">{{ t('result.merged') }}</view>
      <view v-else-if="upcoming" class="status-strip soon">{{ t('result.stopsAt', { date: laterDateText(item.stopAt) }) }}</view>
      <view class="result-main">
        <view class="result-name" :class="[nameFit, { 'is-stopped': stopped }]">{{ ct(item.name) }}</view>
        <view class="result-meta">
          <text>{{ item.code || t('result.noCode') }}</text>
          <text>{{ item.cat1 ? categoryLabel(item.cat1) : t('result.uncategorized') }}</text>
          <text>{{ ct(item.unit) || '/' }}</text>
          <text>{{ payLabel(item.payType) || '/' }}</text>
        </view>
        <view v-if="stopped">
          <PriceFigure :value="priceByLevel(item, level)" :level="level" mode="dead" :label="liveLabel" />
        </view>
        <view v-else-if="pending">
          <view class="price-blocked">{{ t('result.notChargeable') }}</view>
          <PriceFigure :value="nextPriceOf(item, level)" :level="level" mode="future" :label="t('result.fromDate', { date: ct(item.executeAt) })" />
        </view>
        <PriceFigure v-else :value="currentPriceOf(item, level)" :level="level" mode="live" :label="t('result.livePrice')" />
        <view v-if="stopped && item.stopAt" class="result-note">{{ ct(item.stopAt) }}</view>
        <view v-if="item.remark" class="result-note">{{ t('result.remark', { text: ct(item.remark) }) }}</view>
        <view v-if="item.usageNote" class="result-note">{{ t('guide.usage') }}：{{ ct(item.usageNote) }}</view>
      </view>
      <HopList :hops="hops || NO_HOPS" @jump="emit('jump', $event)" />
      <ReactionBar :item="item" />
      <view v-if="stopped && item.successors.length">
        <view v-for="s in item.successors" :key="s.id" class="result-cta" hover-class="is-press" :hover-stay-time="80" @click.stop="emit('jump', s.id)">{{ t('result.useInstead', { name: ctSoft(s.name) }) }}</view>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.limit-badge {
  display: inline-flex;
  align-items: center;
  min-height: 34rpx;
  margin-left: 10rpx;
  padding: 0 9rpx;
  border-radius: 8rpx;
  background: #fff0d2;
  color: #b45309;
  font-size: 20rpx;
  font-weight: 800;
  line-height: 34rpx;
  vertical-align: middle;
}
/* 耗材的类别标记和药品的「限」不是一回事，用耗材那条线的青色，别借用限制支付的琥珀色 */
.limit-badge.hc-kind {
  background: #e0f2fe;
  color: #0369a1;
  font-weight: 600;
}
/* 规范沿用关联网络里那条规范线的靛色（graph.ts 的 SPEC_COLOR），跨页面认得出是同一类东西 */
.limit-badge.spec-kind {
  background: #eceafe;
  color: #4f46e5;
  font-weight: 600;
}
.hc-price {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
  margin-top: 8rpx;
}
.hc-price-label {
  color: var(--yb-text-3);
  font-size: 22rpx;
}
.hc-price-value {
  color: var(--yb-text);
  font-size: 32rpx;
  font-weight: 700;
}
</style>
