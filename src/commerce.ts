/**
 * Monetization for the WeChat export: the ad unit IDs created in the WeChat
 * console, whether ads are switched on, and the analytics switch.
 *
 * This module only stores and validates that configuration. The exported
 * runtime reads the embedded copy and talks to wx.createRewardedVideoAd /
 * wx.createInterstitialAd; nothing here can show an ad on its own. Ads are never
 * forced: the runtime shows an interstitial between rounds at most once, and a
 * rewarded video only when the player taps the revive button.
 */
import { join } from 'node:path'
import { paths } from './project.ts'
import { readJson, StudioError, writeJson } from './util.ts'

export interface IapConfig {
  enabled: boolean
  /** 版号 / 审批文号. Required to switch IAP on: virtual payment needs it. */
  licenseNumber?: string
  /** 微信支付商户号. Required to switch IAP on. */
  merchantId?: string
  /** Endpoint that returns signData/paySig/signature for wx.requestMidasPaymentGameItem. */
  payUrl?: string
}

export interface CommerceState {
  schema: 1
  enabled: boolean
  ads: { interstitial?: string; rewarded?: string }
  iap: IapConfig
  analytics: boolean
  updatedAt: string
}

export interface CommerceCheck {
  ok: boolean
  problems: string[]
  notes: string[]
}

/** WeChat ad unit IDs look like `adunit-0123456789abcdef`, in the game's own console. */
export const AD_UNIT_PATTERN = /^adunit-[a-z0-9]{6,}$/iu

export function commerceFile(dir: string): string {
  return join(paths.studio(dir), 'wechat-commerce.json')
}

export async function loadCommerce(dir: string): Promise<CommerceState> {
  const saved = await readJson<CommerceState>(commerceFile(dir)).catch(() => null)
  if (saved?.schema === 1) {
    return { ...saved, ads: saved.ads ?? {}, iap: saved.iap ?? { enabled: false } }
  }
  return { schema: 1, enabled: false, ads: {}, iap: { enabled: false }, analytics: true, updatedAt: new Date().toISOString() }
}

export async function saveCommerce(dir: string, state: CommerceState): Promise<CommerceState> {
  state.updatedAt = new Date().toISOString()
  await writeJson(commerceFile(dir), state)
  return state
}

function checkUnit(id: string | undefined, label: string, problems: string[]): void {
  if (id === undefined || id === '') return
  if (!AD_UNIT_PATTERN.test(id.trim())) {
    problems.push(`${label} 的广告位 ID 看起来不对：应以 adunit- 开头（当前是 "${id}"）。`)
  }
}

export function commerceCheck(state: CommerceState): CommerceCheck {
  const problems: string[] = []
  const notes: string[] = []
  checkUnit(state.ads.interstitial, '插屏广告', problems)
  checkUnit(state.ads.rewarded, '激励视频', problems)
  if (state.enabled && !state.ads.interstitial && !state.ads.rewarded) {
    problems.push('已开启广告但没有填任何广告位 ID；导出后不会展示广告。')
  }
  if (state.enabled) {
    notes.push('广告位 ID 来自小游戏后台「流量主 → 广告位管理」；开通流量主需要满足微信的独立访客门槛（以后台显示为准）。')
    notes.push('导出的游戏只在两局之间展示一次插屏，激励视频只由玩家点「看广告复活」触发，不强制观看。')
  }
  if (state.ads.rewarded && !state.ads.interstitial) notes.push('只配置了激励视频：不会自动弹插屏。')
  if (state.enabled && state.analytics) {
    notes.push('埋点用 wx.reportEvent 上报（事件名 game_*）；必须先在后台「数据 → 指标 / 事件管理」建同名事件，否则会被丢弃。')
  }

  if (state.iap?.enabled) {
    if (!state.iap.licenseNumber) problems.push('开通内购必须填写游戏版号（审批文号）；没有版号不能做虚拟支付。')
    if (!state.iap.merchantId) problems.push('开通内购必须填写微信支付商户号。')
    if (state.iap.payUrl && !/^https:\/\//iu.test(state.iap.payUrl)) problems.push('内购签名服务的地址必须是 https://（微信要求安全传输）。')
    if (state.iap.licenseNumber && state.iap.merchantId) {
      notes.push(state.iap.payUrl
        ? '内购会先请求你的签名服务，再调用 wx.requestMidasPaymentGameItem（小游戏道具直购）；插件不代签、不代收款。'
        : '没有配置签名服务地址：内购以「演示模式」运行，只验证流程，不会产生真实订单。')
      if (state.iap.payUrl) {
        notes.push('签名服务需要返回 signData（JSON 字符串，含 mode:"goods"、offerId、buyQuantity、env、currencyType、platform、zoneId、productId、goodsPrice、outTradeNo、attach）、paySig 和 signature。')
        notes.push('paySig = HMAC-SHA256(支付 AppKey, "requestMidasPaymentGameItem&" + signData)；signature 为用户态签名，两者都必须在服务端算。')
      }
    }
  }
  return { ok: problems.length === 0, problems, notes }
}

export async function updateCommerce(
  dir: string,
  patch: {
    enabled?: boolean
    interstitial?: string | null
    rewarded?: string | null
    analytics?: boolean
    iapEnabled?: boolean
    licenseNumber?: string | null
    merchantId?: string | null
    payUrl?: string | null
  },
): Promise<CommerceState> {
  const state = await loadCommerce(dir)
  if (patch.enabled !== undefined) state.enabled = patch.enabled
  if (patch.analytics !== undefined) state.analytics = patch.analytics
  if (patch.interstitial !== undefined) {
    const value = patch.interstitial === null ? '' : patch.interstitial.trim()
    if (value === '') delete state.ads.interstitial
    else state.ads.interstitial = value
  }
  if (patch.rewarded !== undefined) {
    const value = patch.rewarded === null ? '' : patch.rewarded.trim()
    if (value === '') delete state.ads.rewarded
    else state.ads.rewarded = value
  }
  if (patch.iapEnabled !== undefined) state.iap.enabled = patch.iapEnabled
  if (patch.licenseNumber !== undefined) {
    const value = patch.licenseNumber === null ? '' : patch.licenseNumber.trim()
    if (value === '') delete state.iap.licenseNumber
    else state.iap.licenseNumber = value
  }
  if (patch.merchantId !== undefined) {
    const value = patch.merchantId === null ? '' : patch.merchantId.trim()
    if (value === '') delete state.iap.merchantId
    else state.iap.merchantId = value
  }
  if (patch.payUrl !== undefined) {
    const value = patch.payUrl === null ? '' : patch.payUrl.trim()
    if (value === '') delete state.iap.payUrl
    else state.iap.payUrl = value
  }
  const check = commerceCheck(state)
  if (!check.ok) throw new StudioError(check.problems.join(' '), 'BAD_AD_UNIT')
  await saveCommerce(dir, state)
  return state
}

export interface EmbeddedCommerce {
  enabled: true
  interstitial?: string
  rewarded?: string
  analytics: boolean
  iap?: { enabled: true; dryRun: boolean; payUrl?: string }
}

/** What the exporter embeds into window.GAME; null when monetization is off. */
export function embedCommerce(state: CommerceState): EmbeddedCommerce | null {
  const iap = state.iap?.enabled && state.iap.licenseNumber && state.iap.merchantId
    ? {
        enabled: true as const,
        dryRun: !state.iap.payUrl,
        ...(state.iap.payUrl ? { payUrl: state.iap.payUrl } : {}),
      }
    : null
  if (!state.enabled && !iap) return null
  const embedded: EmbeddedCommerce = {
    enabled: true,
    analytics: state.analytics !== false,
  }
  if (state.ads.interstitial) embedded.interstitial = state.ads.interstitial
  if (state.ads.rewarded) embedded.rewarded = state.ads.rewarded
  if (iap) embedded.iap = iap
  return embedded
}

