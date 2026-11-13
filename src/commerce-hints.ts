/**
 * Live checks for the 商业化 form, before anything is saved.
 *
 * Kept free of Node imports so the sidebar bundle can use the same rules the host
 * validates with: a user who ticks 内购 without a licence should see why right there.
 */
export interface CommerceForm {
  adsOn: boolean
  interstitial: string
  rewarded: string
  iapOn: boolean
  licence: string
  merchant: string
  payUrl: string
}

export function commerceFormHints(form: CommerceForm): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  const adUnits = [form.interstitial.trim(), form.rewarded.trim()].filter(Boolean)
  if (form.adsOn && adUnits.length === 0) {
    problems.push('已打开广告，但还没有填任何广告位 ID（adunit-...）。')
  }
  for (const unit of adUnits) {
    if (!unit.startsWith('adunit-')) problems.push(`广告位 ID 应以 adunit- 开头：${unit}`)
  }
  if (form.iapOn && !form.licence.trim()) {
    problems.push('内购需要游戏版号（审批文号）：先填版号再打开内购。')
  }
  if (form.iapOn && !form.merchant.trim()) {
    problems.push('内购需要微信支付商户号：先填商户号再打开内购。')
  }
  if (form.payUrl.trim() && !/^https:\/\//u.test(form.payUrl.trim())) {
    problems.push('签名服务地址必须以 https:// 开头。')
  }
  if (form.iapOn && form.licence.trim() && form.merchant.trim() && !form.payUrl.trim()) {
    notes.push('未接签名服务：内购会以演示模式运行，不会真实扣款。')
  }
  return { problems, notes }
}
