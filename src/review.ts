/**
 * Pre-submission review: the mistakes that get WeChat mini-games rejected, and
 * which of them this particular game is about to make.
 *
 * This is a checklist, not a promise. 过审由微信决定; the plugin only points at
 * the usual reasons and at the state of this project so the user fixes what is
 * cheap to fix before submitting.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findWechatExport } from './devtools.ts'
import { loadManifest, paths } from './project.ts'
import { loadRelease, type ReleaseState } from './release.ts'

export interface ReviewReason {
  id: string
  stage: 'material' | 'compliance' | 'build' | 'review' | 'monetization'
  title: string
  why: string
  fix: string
}

export interface ReviewRisk {
  id: string
  severity: 'blocker' | 'warning'
  title: string
  fix: string
}

/** Why mini-games get rejected in practice. Keep each fix actionable. */
export const REVIEW_REASONS: ReviewReason[] = [
  {
    id: 'category-mismatch',
    stage: 'material',
    title: '服务类目与内容不符',
    why: '类目决定需要的资质；挂着休闲游戏类目却出现社交、直播、支付等能力，会被要求补资质或直接驳回。',
    fix: '按实际玩法选类目；要加内购就先补齐游戏类目和版号，再改类目。',
  },
  {
    id: 'name-infringement',
    stage: 'material',
    title: '名称或图标侵权、蹭知名 IP',
    why: '名称、图标、简介里出现他人商标或知名作品名，是最高频的驳回原因之一。',
    fix: '用原创名称与图标；简介只描述玩法，不写「官方」「正版」等词。',
  },
  {
    id: 'no-age-rating',
    stage: 'compliance',
    title: '缺少适龄提示',
    why: '按《网络游戏适龄提示》团体标准，游戏需要在显著位置展示 8+/12+/16+ 提示。',
    fix: '在标题页或启动首屏固定展示适龄提示，文案见导出的 RELEASE.md。',
  },
  {
    id: 'no-privacy',
    stage: 'compliance',
    title: '隐私保护指引缺失或不实',
    why: '收集信息但没有配置隐私指引，或声明与实际调用不符，会被限制接口或驳回。',
    fix: '后台「设置 → 服务内容声明 → 用户隐私保护指引」按实际收集的信息填写。',
  },
  {
    id: 'not-recorded',
    stage: 'compliance',
    title: '小游戏备案未完成',
    why: '未完成备案的小游戏无法发布；备案与版本审核是两条线，顺序不能反。',
    fix: '先在后台完成小游戏备案，再提交版本审核。',
  },
  {
    id: 'crash-or-black-screen',
    stage: 'build',
    title: '审核时闪退、黑屏或无法进入',
    why: '审核员在一台普通设备上打开就失败，是最直接的驳回理由。',
    fix: '用真机预览跑一遍：能从标题页进入、能玩完一局、结算页能重开；3D 要确认设备支持 WebGL2。',
  },
  {
    id: 'no-test-account',
    stage: 'review',
    title: '没有给测试账号或审核路径',
    why: '需要登录或付费才能体验的游戏，若没提供测试账号，审核无法验证核心玩法。',
    fix: '在版本说明里写清审核路径；需要登录时提供可用的测试账号。',
  },
  {
    id: 'package-too-large',
    stage: 'build',
    title: '包体超过限制',
    why: '主包 4 MB、总包 30 MB；超限无法上传或导致加载失败。',
    fix: '压缩纹理、删除没用到的素材，必要时用分包。',
  },
  {
    id: 'misleading-ads',
    stage: 'monetization',
    title: '广告遮挡操作或诱导点击',
    why: '广告盖住按钮、伪装成游戏元素、强制观看，都会被驳回或限制流量主能力。',
    fix: '插屏只在两局之间出现，激励视频必须由玩家主动点击，且要能跳过或拒绝。',
  },
  {
    id: 'iap-without-license',
    stage: 'monetization',
    title: '无版号开通内购',
    why: '网络游戏内购需要《网络游戏电子出版物审批》（版号）；没有版号不能开虚拟支付。',
    fix: '先取得版号并开通微信支付商户号，再在后台开通虚拟支付。',
  },
  {
    id: 'forcing-share',
    stage: 'review',
    title: '诱导分享、诱导关注',
    why: '强制或奖励分享到群、朋友圈属于违规运营，会被限制能力。',
    fix: '不要把分享和奖励绑定；分享只作为可选的传播手段。',
  },
  {
    id: 'sensitive-content',
    stage: 'review',
    title: '内容含违规元素',
    why: '地图、真实货币兑换、赌博玩法、烟酒暴力等元素在审核中会被重点检查。',
    fix: '保持单机休闲玩法；不确定的元素先删掉再提交。',
  },
]

export interface ReviewCheckOptions {
  exportDir?: string
}

function stepDone(state: ReleaseState, id: string): boolean {
  return state.steps[id]?.status === 'done'
}

/** Which of the common rejections this project is actually heading for. */
export async function reviewRisks(dir: string, state?: ReleaseState, options: ReviewCheckOptions = {}): Promise<ReviewRisk[]> {
  const release = state ?? await loadRelease(dir)
  const manifest = await loadManifest(dir).catch(() => null)
  const exportDir = options.exportDir ?? findWechatExport(dir)
  const risks: ReviewRisk[] = []

  if (!release.appid || release.appid === 'touristappid' || !/^wx[0-9a-z]{8,}$/iu.test(release.appid)) {
    risks.push({
      id: 'appid',
      severity: 'blocker',
      title: '还没有真实 AppID',
      fix: '在后台拿到 AppID，用 game_studio_export_wechat 的 appid 参数重新导出，或改导出目录里 project.config.json 的 appid。',
    })
  }
  if (!release.ageRating) {
    risks.push({ id: 'age-rating', severity: 'warning', title: '还没选适龄级别', fix: '让 agent 设置 ageRating（8+/12+/16+），并把提示做进首屏。' })
  }
  if (!release.category) {
    risks.push({ id: 'category', severity: 'warning', title: '还没确定服务类目', fix: '在后台选与内容一致的类目，并把结果记进向导。' })
  }
  if (!stepDone(release, 'record')) {
    risks.push({ id: 'record', severity: 'blocker', title: '小游戏备案还没完成', fix: '后台「设置 → 基本设置 → 小游戏备案」；备案通过后再提交版本。' })
  }
  if (!stepDone(release, 'record-icp')) {
    risks.push({
      id: 'record-icp',
      severity: 'warning',
      title: '小程序备案（ICP）是否适用还没确认',
      fix: '在后台「设置 → 基本设置」确认是否需要小程序/ICP 备案；需要就提交。它和小游戏备案是两个入口。',
    })
  }
  if (!stepDone(release, 'privacy')) {
    risks.push({ id: 'privacy', severity: 'warning', title: '隐私保护指引还没配置', fix: '按实际收集的信息填写后台的用户隐私保护指引；不收集也要如实声明。' })
  }
  if ((release.monetization === 'iap' || release.monetization === 'both') && !stepDone(release, 'iap')) {
    risks.push({ id: 'iap', severity: 'blocker', title: '选了内购但版号/商户号还没就绪', fix: '先取得版号并开通微信支付商户号；没有版号就不要开虚拟支付。' })
  }
  if (!exportDir) {
    risks.push({ id: 'export', severity: 'warning', title: '还没有微信工程', fix: '先导出微信小游戏工程，再在开发者工具里真机预览。' })
  } else {
    let bytes = 0
    try {
      const walk = async (current: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) await walk(full)
          else bytes += (await stat(full)).size
        }
      }
      await walk(exportDir)
    } catch { bytes = 0 }
    if (bytes > 4 * 1024 * 1024) {
      risks.push({
        id: 'size',
        severity: 'blocker',
        title: `微信工程 ${(bytes / 1048576).toFixed(1)} MB，超过 4 MB 主包`,
        fix: '压缩纹理或删掉没用到的素材；素材仍太大时用分包。',
      })
    } else if (bytes > 3 * 1024 * 1024) {
      risks.push({ id: 'size-warn', severity: 'warning', title: `微信工程 ${(bytes / 1048576).toFixed(1)} MB，接近 4 MB 主包`, fix: '留点余量：主包还会加上引擎和代码。' })
    }
  }

  if (manifest && Object.keys(manifest.slots ?? {}).length === 0) {
    risks.push({ id: 'no-slots', severity: 'warning', title: '游戏没有素材槽位', fix: '确认游戏自己画画面，否则导出后是空白。' })
  }
  return risks
}

export function reviewMarkdown(risks: ReviewRisk[], title: string): string {
  const lines = [
    `# ${title} · 审核风险自查`,
    '',
    '> 过审与备案由微信决定。这份清单只指出常见驳回原因和你这个工程当前的状态，按它改可以少踩坑。',
    '',
    '## 你现在的风险',
    '',
  ]
  if (risks.length === 0) lines.push('- 暂未发现明显风险；提交前仍建议真机跑一遍。')
  for (const risk of risks) {
    lines.push(`- ${risk.severity === 'blocker' ? '**必须先解决**' : '建议先处理'}：${risk.title}`, `  - 处理：${risk.fix}`)
  }
  lines.push('', '## 常见驳回原因（按阶段）', '')
  const stages: Array<[ReviewReason['stage'], string]> = [
    ['material', '名称与素材'], ['compliance', '合规与资质'], ['build', '构建与体验'],
    ['review', '审核材料'], ['monetization', '商业化'],
  ]
  for (const [stage, label] of stages) {
    const items = REVIEW_REASONS.filter(reason => reason.stage === stage)
    if (items.length === 0) continue
    lines.push(`### ${label}`, '')
    for (const reason of items) {
      lines.push(`- **${reason.title}**：${reason.why}`, `  - 怎么改：${reason.fix}`)
    }
    lines.push('')
  }
  lines.push('## 提交前检查', '', '- [ ] 真机预览：能进入、能玩完一局、结算能重开。', '- [ ] 适龄提示与隐私指引按实际内容填写。', '- [ ] 备案已通过、AppID 不是 touristappid。', '')
  return lines.join('\n')
}

export async function reviewGuide(dir: string, options: ReviewCheckOptions & { title?: string } = {}): Promise<{ file: string; markdown: string; risks: ReviewRisk[] }> {
  const state = await loadRelease(dir)
  const risks = await reviewRisks(dir, state, options)
  const manifest = await loadManifest(dir).catch(() => null)
  const title = options.title ?? state.gameName ?? manifest?.title ?? '小游戏'
  const markdown = reviewMarkdown(risks, title)
  const exportDir = options.exportDir ?? findWechatExport(dir)
  const file = exportDir ? join(exportDir, 'REVIEW.md') : join(paths.exportDir(dir), 'wechat-review.md')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, markdown, 'utf8')
  return { file, markdown, risks }
}



