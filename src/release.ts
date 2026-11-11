/**
 * The WeChat mini-game release wizard.
 *
 * Publishing a mini-game is mostly work in the WeChat admin console that no
 * plugin can do for the user: register the mini-game, verify the company,
 * choose a category, show an age rating, file the 小游戏备案, apply for a game
 * licence before in-app purchases, and submit the build for review. What this
 * module does is turn that into a checklist with owners, prerequisites and
 * copy-paste materials, so a user with no game experience can follow it and the
 * agent can say exactly what to do next.
 *
 * It never claims a step is done because it guessed: only the user marks console
 * steps, and the plugin marks the steps it really ran (export, upload).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadManifest, paths } from './project.ts'
import { readJson, StudioError, writeJson } from './util.ts'

export type ReleaseStage = 'account' | 'material' | 'compliance' | 'build' | 'review' | 'launch' | 'growth'
export type ReleaseOwner = 'wechat' | 'plugin' | 'user'
export type ReleaseStepStatus = 'todo' | 'done' | 'skipped'
export type Monetization = 'none' | 'iaa' | 'iap' | 'both'
export type AgeRating = '8+' | '12+' | '16+'

export interface ReleaseStep {
  id: string
  stage: ReleaseStage
  title: string
  /** wechat = 需在微信后台完成, plugin = 插件可自动, user = 在本机/开发者工具里做 */
  owner: ReleaseOwner
  why: string
  how: string[]
  /** Steps that must be done first. */
  needs?: string[]
  /** Marked when the plugin has a tool for it. */
  automate?: 'export-wechat' | 'devtools-open' | 'devtools-upload'
  /** Only shown for these monetization choices; undefined = always. */
  onlyFor?: Monetization[]
}

export interface ReleaseStepState {
  status: ReleaseStepStatus
  note?: string
  updatedAt: string
}

export interface ReleaseState {
  schema: 1
  appid?: string
  gameName?: string
  category?: string
  ageRating?: AgeRating
  monetization?: Monetization
  steps: Record<string, ReleaseStepState>
  createdAt: string
  updatedAt: string
}

export interface ReleaseStatus {
  game: string
  appid: string
  monetization: Monetization
  ageRating: AgeRating | null
  progress: { done: number; total: number; percent: number }
  steps: Array<ReleaseStep & { status: ReleaseStepStatus; blocked: boolean; note?: string }>
  next: Array<{ id: string; title: string; owner: ReleaseOwner; how: string[] }>
  blocked: Array<{ id: string; title: string; missing: string[] }>
}

const STAGE_LABEL: Record<ReleaseStage, string> = {
  account: '账号与主体',
  material: '名称与素材',
  compliance: '合规与资质',
  build: '构建与上传',
  review: '审核与发布',
  launch: '上线',
  growth: '运营与商业化',
}

export const RELEASE_STAGE_LABELS = STAGE_LABEL

/** Everything the plugin knows about launching a WeChat mini-game in China. */
export function releasePlan(monetization: Monetization = 'none'): ReleaseStep[] {
  const steps: ReleaseStep[] = [
    {
      id: 'register',
      stage: 'account',
      title: '注册小游戏账号',
      owner: 'wechat',
      why: '小游戏必须挂在微信公众平台的「小游戏」类别下，普通小程序账号不能当小游戏发布。',
      how: [
        '打开 https://mp.weixin.qq.com → 立即注册 → 选择「小游戏」。',
        '用一个没有绑定过公众号/小程序的邮箱注册，按提示填写主体信息。',
        '注册完成后在「设置 → 基本设置」里能看到 AppID（形如 wx 开头的一串字符）。',
      ],
    },
    {
      id: 'verify',
      stage: 'account',
      title: '主体认证',
      owner: 'wechat',
      why: '个人主体可以发布基础小游戏，但内购、部分流量主能力和部分类目要求企业主体并完成微信认证。',
      how: [
        '后台「设置 → 基本设置 → 主体信息」发起微信认证（企业通常 300 元/年，以页面为准）。',
        '认证期间按提示提交营业执照、法人信息等材料。',
        '个人主体开发者可跳过，但发布前请先确认你要用的类目和变现方式是否允许个人主体。',
      ],
      needs: ['register'],
    },
    {
      id: 'appid',
      stage: 'account',
      title: '把 AppID 填进工程',
      owner: 'plugin',
      why: '开发者工具编译/预览可以用测试号，但上传版本必须使用真实 AppID。',
      how: [
        '把后台的 AppID 告诉 agent，或自行修改导出目录里的 project.config.json 的 appid。',
        '也可以用插件的微信导出重新导出并传入 appid。',
      ],
      needs: ['register'],
      automate: 'export-wechat',
    },
    {
      id: 'basic-info',
      stage: 'material',
      title: '填写名称、简介与图标',
      owner: 'wechat',
      why: '审核会看名称是否与内容相符、简介是否描述清楚玩法，图标要清晰无明显侵权。',
      how: [
        '后台「设置 → 基本设置」填写小游戏名称（上线后改名有限制，先想好）。',
        '简介一句话说清玩法，不要写「最好玩」这类绝对化用语。',
        '上传 144×144 以上的方形图标；名称/图标不要蹭知名 IP。',
      ],
      needs: ['register'],
    },
    {
      id: 'category',
      stage: 'material',
      title: '选择服务类目',
      owner: 'wechat',
      why: '类目决定需要的资质。小游戏通常选「游戏」下的子类目（如休闲游戏），选错会被驳回或要求补资质。',
      how: [
        '后台「设置 → 基本设置 → 服务类目」选择与小游戏内容一致的类目。',
        '如果计划接内购，类目和资质要求会更严格，先按后台提示准备材料。',
      ],
      needs: ['register'],
    },
    {
      id: 'age-rating',
      stage: 'compliance',
      title: '适龄提示',
      owner: 'plugin',
      why: '按《网络游戏适龄提示》团体标准，游戏需要在启动/显著位置展示 8+/12+/16+ 适龄提示。',
      how: [
        '在向导里选择适龄级别，插件会给出对应的展示文案。',
        '把提示做进游戏的首屏（当前模板会在标题页留位置），或至少在启动时展示。',
      ],
    },
    {
      id: 'privacy',
      stage: 'compliance',
      title: '用户隐私保护指引',
      owner: 'wechat',
      why: '只要收集或使用用户信息（登录、手机号、位置等），就必须在后台配置隐私保护指引，否则相关接口会被限制。',
      how: [
        '后台「设置 → 服务内容声明 → 用户隐私保护指引」按实际收集的信息填写。',
        '插件会生成一份可直接改的草案（get 材料）。不收集信息也要如实声明。',
      ],
      needs: ['register'],
    },
    {
      id: 'record',
      stage: 'compliance',
      title: '小游戏备案',
      owner: 'wechat',
      why: '按监管要求，新上架的小游戏需要先完成备案；未备案无法发布。',
      how: [
        '后台「设置 → 基本设置 → 小游戏备案」发起备案，填写主体、负责人、游戏内容说明等。',
        '备案由主管部门审核，通常需要数个工作日；被退回时按备注补齐材料。',
        '备案通过后再提交版本审核，顺序不要反。',
      ],
      needs: ['register', 'verify'],
    },
    {
      id: 'record-icp',
      stage: 'compliance',
      title: '小程序备案（如适用）',
      owner: 'wechat',
      why: '「小游戏备案」之外，部分主体和服务还需要完成小程序备案（ICP 备案）；两条线都要过，缺一条会影响发布。',
      how: [
        '后台「设置 → 基本设置」查看是否还有「小程序备案 / ICP 备案」的待办提示。',
        '按提示提交主体与服务信息；它和小游戏备案是两个入口，不要只做一条。',
        '两项都完成后再提交版本审核；是否适用以后台提示为准。',
      ],
      needs: ['register', 'verify'],
    },
    {
      id: 'export',
      stage: 'build',
      title: '导出微信小游戏工程',
      owner: 'plugin',
      why: '导出目录就是开发者工具要导入的工程，2D/3D 都支持。',
      how: ['在侧栏点「导出微信小游戏」，或让 agent 调用 game_studio_export_wechat。'],
      automate: 'export-wechat',
    },
    {
      id: 'devtools',
      stage: 'build',
      title: '在开发者工具里编译与真机预览',
      owner: 'user',
      why: '上传前必须真机跑一遍：触摸、安全区、机型性能、分包加载都只能在这里发现。',
      how: [
        '打开微信开发者工具 → 导入项目 → 选择导出目录 → 项目类型选「小游戏」。',
        '需要先在「工具 → 设置 → 安全设置」打开服务端口，插件才能调用 CLI。',
        '用「预览」扫码在真机上试玩，重点看：能否开始、按钮是否可点、低端机帧率、切后台再回来是否正常。',
      ],
      needs: ['export'],
      automate: 'devtools-open',
    },
    {
      id: 'upload',
      stage: 'build',
      title: '上传版本',
      owner: 'plugin',
      why: '上传后版本才出现在后台「版本管理」里，才能提交审核。',
      how: [
        '确认 project.config.json 已是真实 AppID。',
        '让 agent 调用 game_studio_wechat_devtools（action=upload）或自己用开发者工具「上传」。',
      ],
      needs: ['appid', 'devtools'],
      automate: 'devtools-upload',
    },
    {
      id: 'submit',
      stage: 'review',
      title: '提交审核',
      owner: 'wechat',
      why: '提交时要填写版本说明、测试账号、功能页面路径；信息缺失是最常见的驳回原因。',
      how: [
        '后台「版本管理」选择刚上传的版本 → 提交审核。',
        '按插件生成的材料填写版本说明与测试账号（如无需登录就写「无需登录」）。',
        '审核通常 1–7 个工作日；被驳回时按驳回理由改完再提。',
      ],
      needs: ['record', 'record-icp', 'upload'],
    },
    {
      id: 'publish',
      stage: 'launch',
      title: '发布上线',
      owner: 'wechat',
      why: '审核通过后仍需手动点「发布」，版本才会对用户可见。',
      how: ['后台「版本管理 → 审核通过 → 发布」。', '发布后用微信搜索小游戏名称，确认可以打开。'],
      needs: ['submit'],
    },
    {
      id: 'analytics',
      stage: 'growth',
      title: '接数据与错误监控',
      owner: 'plugin',
      why: '没有数据就不知道玩家卡在哪；小游戏有现成的数据与异常上报能力。',
      how: [
        '后台「数据分析」看留存、时长、来源；小游戏支持每日/实时数据。',
        '接入 wx.getRealtimeLogManager / wx.onError 上报异常（插件可给接入片段）。',
      ],
      needs: ['publish'],
    },
    {
      id: 'iaa',
      stage: 'growth',
      title: '接入广告（IAA）',
      owner: 'wechat',
      why: '广告是免费游戏的主要变现方式，需要先开通流量主，且对用户量有门槛。',
      how: [
        '后台「流量主」申请开通；微信对开通有独立访客（UV）门槛（以后台显示的当前要求为准）。',
        '开通后创建广告位，把广告位 ID 填进游戏；插件可生成激励视频/插屏的接入骨架。',
        '广告不能强制观看、不能遮挡操作区域，否则会被驳回或限制能力。',
      ],
      needs: ['publish'],
      onlyFor: ['iaa', 'both'],
    },
    {
      id: 'iap',
      stage: 'growth',
      title: '接入内购（IAP）',
      owner: 'wechat',
      why: '内购需要《网络游戏电子出版物审批》（版号）、企业主体与微信支付商户号，三样缺一不可。',
      how: [
        '先确认游戏有版号；没有版号的游戏不能开内购，这是硬性要求。',
        '后台开通微信支付并绑定商户号（企业主体）。',
        '用虚拟支付接口实现购买，插件可生成最小接入骨架与订单校验说明。',
      ],
      needs: ['publish'],
      onlyFor: ['iap', 'both'],
    },
  ]
  return steps.filter(step => !step.onlyFor || step.onlyFor.includes(monetization))
}

function now(): string {
  return new Date().toISOString()
}

export function releaseFile(dir: string): string {
  return join(paths.studio(dir), 'wechat-release.json')
}

export async function loadRelease(dir: string): Promise<ReleaseState> {
  const saved = await readJson<ReleaseState>(releaseFile(dir)).catch(() => null)
  if (saved?.schema === 1 && saved.steps) return saved
  const stamp = now()
  return { schema: 1, steps: {}, createdAt: stamp, updatedAt: stamp }
}

export async function saveRelease(dir: string, state: ReleaseState): Promise<ReleaseState> {
  state.updatedAt = now()
  await writeJson(releaseFile(dir), state)
  return state
}

function isDone(state: ReleaseState, id: string): boolean {
  return state.steps[id]?.status === 'done'
}

/** Steps that are relevant and not yet done, plus the ones held back by a prerequisite. */
export function releaseStatus(dir: string, state: ReleaseState, plan: ReleaseStep[]): ReleaseStatus {
  const steps = plan.map((step) => {
    const entry = state.steps[step.id]
    const missing = (step.needs ?? []).filter(id => !isDone(state, id))
    return {
      ...step,
      status: entry?.status ?? 'todo' as ReleaseStepStatus,
      blocked: missing.length > 0,
      note: entry?.note,
    }
  })
  const relevant = steps.filter(step => step.status !== 'skipped')
  const done = relevant.filter(step => step.status === 'done').length
  const next = relevant.filter(step => step.status === 'todo' && !step.blocked)
  return {
    game: dir,
    appid: state.appid ?? '',
    monetization: state.monetization ?? 'none',
    ageRating: state.ageRating ?? null,
    progress: { done, total: relevant.length, percent: relevant.length === 0 ? 0 : Math.round((done / relevant.length) * 100) },
    steps,
    next: next.slice(0, 3).map(step => ({ id: step.id, title: step.title, owner: step.owner, how: step.how })),
    blocked: relevant
      .filter(step => step.status === 'todo' && step.blocked)
      .map(step => ({ id: step.id, title: step.title, missing: (step.needs ?? []).filter(id => !isDone(state, id)) })),
  }
}

/** Merge the caller's answers and one optional step update into the saved state. */
export async function updateRelease(
  dir: string,
  patch: { step?: string; status?: ReleaseStepStatus; note?: string; appid?: string; gameName?: string; category?: string; ageRating?: AgeRating; monetization?: Monetization },
): Promise<{ state: ReleaseState; status: ReleaseStatus }> {
  const state = await loadRelease(dir)
  if (patch.appid !== undefined) state.appid = patch.appid.trim()
  if (patch.gameName !== undefined) state.gameName = patch.gameName.trim()
  if (patch.category !== undefined) state.category = patch.category.trim()
  if (patch.ageRating !== undefined) state.ageRating = patch.ageRating
  if (patch.monetization !== undefined) state.monetization = patch.monetization
  if (patch.step !== undefined) {
    const plan = releasePlan(state.monetization ?? 'none')
    if (!plan.some(entry => entry.id === patch.step)) {
      throw new StudioError(`Unknown release step "${patch.step}"; known steps: ${plan.map(entry => entry.id).join(', ')}`, 'BAD_RELEASE_STEP')
    }
    const status = patch.status ?? 'done'
    if (!['todo', 'done', 'skipped'].includes(status)) {
      throw new StudioError(`Unknown release status "${status}"; use todo, done or skipped.`, 'BAD_RELEASE_STATUS')
    }
    state.steps[patch.step] = { status, note: patch.note, updatedAt: now() }
  }
  await saveRelease(dir, state)
  return { state, status: releaseStatus(dir, state, releasePlan(state.monetization ?? 'none')) }
}

/** Trigger markers the plugin may set by itself, because it really did the work. */
export async function markReleaseDone(dir: string, step: string, note: string): Promise<void> {
  const state = await loadRelease(dir)
  state.steps[step] = { status: 'done', note, updatedAt: now() }
  await saveRelease(dir, state)
}

const AGE_RATING_COPY: Record<AgeRating, string> = {
  '8+': '本游戏适合 8 周岁及以上用户使用。',
  '12+': '本游戏适合 12 周岁及以上用户使用。',
  '16+': '本游戏适合 16 周岁及以上用户使用。',
}

export interface ReleaseMaterials {
  markdown: string
  file: string
}

/**
 * Copy-paste text for the console: category suggestion, age-rating card, privacy
 * policy draft, filing blurb and the review note. Written next to the export so
 * it sits in the same folder the user imports.
 */
export async function releaseMaterials(
  dir: string,
  options: { exportDir?: string; manifestTitle: string; style?: string; orientation?: string; slots?: number },
): Promise<ReleaseMaterials> {
  const state = await loadRelease(dir)
  // The materials should describe this game, not a generic template.
  const manifest = await loadManifest(dir).catch(() => null)
  const title = state.gameName || options.manifestTitle || manifest?.title || '未命名小游戏'
  const style = options.style ?? manifest?.style
  const orientation = options.orientation ?? manifest?.orientation
  const roundSeconds = Math.max(1, Math.round(Number(manifest?.rules?.duration ?? 60)))
  const runtimes = Array.isArray(manifest?.runtime) ? manifest.runtime : []
  const is3d = runtimes.includes('three')
  const rating = state.ageRating ?? '8+'
  const category = state.category || '游戏 > 休闲游戏（以微信后台可选项为准）'
  const monetization = state.monetization ?? 'none'
  const lines = [
    `# ${title} · 微信小游戏发布材料`,
    '',
    '> 这些文字可以直接复制到微信公众平台的对应表单里。提交前请按实际情况修改，尤其是主体信息和隐私相关表述。',
    '> 要求与门槛以微信后台最新要求为准，过审与备案由微信和主管部门决定。',
    '',
    '## 1. 基本信息',
    '',
    `- 名称：${title}`,
    `- 一句话简介：${style ? `${style} 风格的小游戏，` : ''}收集与躲避的轻度玩法，单局约 ${roundSeconds} 秒。`,
    `- 建议类目：${category}`,
    `- 屏幕方向：${orientation === 'landscape' ? '横屏' : '竖屏'}`,
    `- 游戏标签：休闲、收集、单机（以后台可选项为准）`,
    '',
    '## 2. 适龄提示',
    '',
    `- 适龄级别：${rating}`,
    `- 游戏内展示文案：${AGE_RATING_COPY[rating]}`,
    '- 展示位置：启动首屏（模板标题页）固定展示，不遮挡开始按钮。',
    '- 依据：《网络游戏适龄提示》团体标准；最终以审核意见为准。',
    '',
    '## 3. 用户隐私保护指引（草案）',
    '',
    '**自检结论：本游戏不处理用户个人信息**——没有登录、手机号、位置、相册、通讯录；分数与静音状态只写在 `wx.setStorage` 的本机缓存里，不上传。',
    '',
    '- 后台位置：设置 → 服务内容声明 → 用户隐私保护指引，按「不收集」如实勾选，不要多勾。',
    '- 不需要在游戏内放隐私入口：平台只在调用受保护接口时才要求授权弹窗。',
    '- 广告与埋点只上报事件名和数值（如 `game_round_end` 带分数），不含个人信息。',
    '- 如果你之后加了微信登录、好友排行、客服或上传图片：先在后台补充对应指引，再在调用受保护接口前用 `wx.requirePrivacyAuthorize` 触发授权弹窗，并处理 `onNeedPrivacyAuthorization`。',
    '- 如后续接入内购，按实际调用的接口补充声明（例如订单信息）。',
    '',
    '## 4. 小游戏备案 / 小程序备案（内容说明）',
    '',
    `${title} 是一款${options.style ? `${options.style} 风格的` : ''}休闲小游戏，单机运行，不含用户生成内容、不含社交与充值（如已接入内购，请改为「含虚拟支付」并附版号信息）。`,
    '',
    '- 主要内容：收集道具、躲避障碍，单局时长约 1 分钟。',
    '- 内容自查：无地图、无文字聊天、无真实货币兑换、无烟酒暴力元素。',
    '- 备案提醒：小游戏备案与小程序（ICP）备案是两个入口，按后台提示把两条都完成再提交审核。',
    '',
    '## 5. 版本审核说明',
    '',
    `- 版本：${state.appid ? `AppID ${state.appid}` : '（上传时使用真实 AppID）'}`,
    `- 游戏名称：${title}`,
    `- 审核路径：启动即进入标题页（底部显示「适龄提示 ${rating}」）→ 点击/轻触开始 → 单局约 ${roundSeconds} 秒 → 结算页可直接重开。`,
    `- 玩法概述：${style ? `${style} 风格；` : ''}收集道具、躲避障碍的轻度玩法，无文字聊天、无用户生成内容。`,
    ...(monetization === 'iaa' || monetization === 'both' ? ['- 广告位置：两局之间最多展示一次插屏；激励视频只在失败后主动点击「看广告复活」时出现。'] : []),
    ...(monetization === 'iap' || monetization === 'both' ? ['- 虚拟支付：仅道具直购，版号与商户号需在后台开通后才能使用。'] : []),
    '- 测试账号：无需登录。',
    is3d ? '- 已知限制：3D 画面需要支持 WebGL2 的机型；低端机会自动降低分辨率与帧率。' : '- 已知限制：无特殊权限要求。',
    '',
    '## 6. 变现（当前选择：' + monetization + '）',
    '',
    monetization === 'iaa' || monetization === 'both'
      ? '- IAA：需要先在后台开通流量主并满足 UV 门槛，再创建广告位并把广告位 ID 填进游戏。'
      : '- 未选择广告变现。',
    monetization === 'iap' || monetization === 'both'
      ? '- IAP：需要《网络游戏电子出版物审批》（版号）、企业主体与微信支付商户号，三样缺一不可。'
      : '- 未选择内购变现。',
    '- 插件只做接入骨架与合规检查，不承诺过审、备案或收入。',
    '',
    '## 7. 数据事件（可选）',
    '',
    '- 游戏会用 `wx.reportEvent` 上报这些事件，名称固定：',
    '  `game_round_start`、`game_round_end`、`game_ad_interstitial`、`game_ad_rewarded`、',
    '  `game_iap_order`、`game_iap_dry_run`、`game_iap_paid`、`game_iap_failed`。',
    '- 事件必须现在后台建好同名事件（「数据 → 指标 / 事件管理」），否则上报会被丢弃、后台看不到数据。',
    '- 基础库需 2.14.4 及以上；低版本会自动降级到 `wx.reportAnalytics`（如果宿主支持）。',
    '',
    '## 8. 上线后看什么',
    '',
    '| 想看什么 | 后台位置 | 对应事件 / 指标 | 怎么判断 |',
    '| --- | --- | --- | --- |',
    '| 有人玩吗、留得住吗 | 数据分析 → 概况 / 留存 | — | 次留有数就说明有人回来；全是 0 先查分享与入口 |',
    '| 一局能不能玩完 | 数据分析 → 自定义分析 | `game_round_start` / `game_round_end` | 两者数量接近说明多数人能打完一局 |',
    '| 广告有没有展示 | 流量主 → 数据 / 自定义分析 | `game_ad_interstitial` / `game_ad_rewarded` | 有播放但收入长期为 0，先查流量主与广告位状态 |',
    '| 广告为什么失败 | 实时日志 + 广告事件 | `game_ad_error`（带错误码） | 1004 偶尔出现正常；1002/1005/1008 要回后台处理 |',
    '| 内购有没有成交 | 虚拟支付后台 + 自定义分析 | `game_iap_order` / `game_iap_paid` / `game_iap_failed` | 没有 `game_iap_paid` 且是演示模式 → 属正常（未接签名服务） |',
    '| 线上报错 | 实时日志 | RealtimeLog（最多前 20 条，之后折叠） | 出现折叠提示说明错误很多，先看第一条 |',
    '| 是不是快撑爆内存了 | 自定义分析 | `game_memory_warning`（带 level） | 零星可接受；持续出现要换小素材或降分包 |',
    '',
    '提示：这些事件要先在「数据 → 指标 / 事件管理」建同名事件（见上一节），否则后台看不到。',
    '',
    '## 9. 上线前检查',
    '',
    '- [ ] 已在真机预览：能开始、能玩完一局、结算页可重开。',
    '- [ ] 已确认包体（主包 4 MB / 总包 30 MB）与基础库版本。',
    '- [ ] AppID 已替换为真实值（不是 touristappid）。',
    '- [ ] 小游戏备案已通过；需要时报关小程序（ICP）备案。',
    '- [ ] 适龄提示与隐私指引已按实际内容填写。',
    '- [ ] 要看的埋点事件已在后台建好（见上一节）。',
    '',
  ]
  const markdown = lines.join('\n')
  const target = options.exportDir ? join(options.exportDir, 'RELEASE.md') : join(paths.exportDir(dir), 'wechat-release.md')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, markdown, 'utf8')
  return { markdown, file: target }
}






