/** Sidebar copy. Tool names and descriptions stay English on purpose (model-facing). */
export const NS = 'gameStudio'

export const zh = {
  'tab.title': '游戏工坊 · {name}',
  'tab.loading': '正在载入游戏…',
  'tab.noBuild': '还没有构建，让 agent 运行 game_studio_build。',
  'tab.clickToPlay': '点一下画面开始玩，键盘方向键 / WASD 移动',
  'tab.reload': '重新载入',
  'tab.rebuild': '重新构建',
  'tab.export': '导出 HTML',
  'tab.exportWechat': '导出微信小游戏',
  'tab.exportedWechat': '已导出微信工程：{dir}',
  'tab.release': '上线向导',
  'tab.checkEnv': '检查环境',
  'tab.envReady': '环境检查通过：可以预览并上传。',
  'tab.envHints': '环境检查：{hints}',
  'tab.envCliMissing': '没找到微信开发者工具（或它的命令行）。请安装开发者工具后再试。',
  'tab.envPortClosed': '开发者工具的服务端口没开：工具 → 设置 → 安全设置 → 服务端口 → 开启，然后重新检查。',
  'tab.envTourist': '工程还是 touristappid：可以预览，但要上传必须换成真实小游戏 AppID（带 appid 重新导出）。',
  'tab.releaseProgress': '已完成 {done}/{total} · {percent}%',
  'tab.releaseMaterials': '生成发布材料',
  'tab.releaseReview': '审核自查',
  'tab.releaseReviewSaved': '审核自查已写入 {file}（{count} 个风险）',
  'tab.commerce': '商业化',
  'tab.commerceSave': '保存',
  'tab.commerceSaved': '已保存，下一次导出会写进游戏',
  'tab.commerceEnabled': '广告',
  'tab.commerceInterstitial': '插屏广告位',
  'tab.commerceRewarded': '激励视频广告位',
  'tab.commerceIap': '内购',
  'tab.commerceLicence': '版号',
  'tab.commerceMerchant': '商户号',
  'tab.commercePayUrl': '签名服务',
  'tab.commerceDataHint': '上线后到微信后台看：数据分析（留存/时长/来源）、流量主（广告收入）、实时日志（错误）。插件上报的事件：game_round_start、game_round_end、game_ad_interstitial、game_ad_rewarded、game_iap_paid。',
  'tab.releaseMaterialsSaved': '发布材料已写入：{file}',
  'tab.releaseDevtools': '打开开发者工具',
  'tab.releaseDevtoolsOpened': '已在微信开发者工具中打开导出工程',
  'tab.releaseOwner.wechat': '微信后台',
  'tab.releaseOwner.plugin': '插件',
  'tab.releaseOwner.user': '你',
  'tab.releaseBlocked': '等待前置步骤',
  'tab.share': '手机扫码',
  'tab.sharePublic': '公网链接（30 分钟）',
  'tab.shareOpening': '正在建立…',
  'tab.shareHint': '用同一 Wi-Fi 下的手机扫码就能玩；重新构建后在手机上刷新即可看到最新版。',
  'tab.sharePublicHint': '任何网络都能打开，拿到链接的人都能玩。到 {time} 自动关闭。',
  'tab.shareCopy': '复制链接',
  'tab.shareUntil': '{time} 自动关闭',
  'tab.unshare': '停止分享',
  'tab.noTunnelMac': '公网链接需要先安装 cloudflared。macOS 上运行：{install}',
  'tab.noTunnelWin': '公网链接需要先安装 cloudflared。Windows 上运行：{install}',
  'tab.noTunnelLinux': '公网链接需要先安装 cloudflared。Linux 请从官方页面下载安装：{install}',
  'tab.publish': '发布到 GitHub',
  'tab.publishUpdate': '更新发布',
  'tab.publishing': '正在发布…',
  'tab.publishConfirmHint': '将上传到你的公开仓库，任何人都能看到',
  'tab.publishConfirmYes': '确认发布',
  'tab.publishCancel': '取消',
  'tab.publishedHint': '已发布到 GitHub Pages（{repo}）',
  'tab.publishDeploying': 'GitHub 正在部署，一两分钟后可以打开',
  'tab.publishOutdated': '有新的构建还没发布',
  'tab.unpublish': '从 GitHub 删除',
  'tab.unpublishing': '正在删除…',
  'tab.unpublishConfirmHint': '将从你的公开仓库删除这个游戏，已发布的链接将失效',
  'tab.unpublishConfirmYes': '确认删除',
  'tab.noGhMac': '发布到 GitHub 需要先安装 GitHub CLI（gh）。macOS 上运行：{install}，然后运行 gh auth login 登录。',
  'tab.noGhWin': '发布到 GitHub 需要先安装 GitHub CLI（gh）。Windows 上运行：{install}，然后运行 gh auth login 登录。',
  'tab.noGhLinux': '发布到 GitHub 需要先安装 GitHub CLI（gh）。请从官方页面安装：{install}，然后运行 gh auth login 登录。',
  'tab.ghNotLoggedIn': 'GitHub CLI 还没有登录。请在终端运行 gh auth login 登录你的 GitHub 账号。',
  'tab.ghFailed': '连接 GitHub 失败，检查网络或代理后重试',
  'tab.repoNotOurs': '仓库 {repo} 已存在且不是本插件创建的，不会往里写入。请在配置中把 githubRepo 改成别的仓库名。',
  'tab.versions': '版本',
  'tab.restore': '回到这版',
  'tab.exported': '已导出：{file}',
  'tab.build': '构建 {id} · {size}',
  'tab.assets': '素材',
  'tab.current': '当前',
  'tab.currentRendered': '当前 · 游戏内',
  'tab.currentTemplate': '当前 · 模板图标',
  'tab.sourceTemplate': '模板素材',
  'tab.sourceEdited': '项目内绘制',
  'tab.spend': '本项目已生成：{parts}',
  'tab.spendOpenai': 'OpenAI {count} 张 ≈ {usd}',
  'tab.spendCodex': 'Codex {count} 张（订阅额度）',
  'tab.revert': '撤回',
  'tab.apply': '用这张',
  'tab.failed': '未通过：{problems}',
  'tab.noCandidates': '还没有候选，让 agent 为「{slot}」生成素材',
  'tab.gameError': '游戏报错：{message}',
  'tab.phase': '状态：{phase} · 得分 {score}',
  'tab.busy': '处理中…',
  'tab.jobRunning': '{provider} 正在生成 · 已完成 {done}/{count} · 已用 {elapsed}',
  'tab.jobFailed': '{provider} 生成失败：{detail}',
  'tab.jobPartial': '{provider} 有 {failed} 张没生成出来：{detail}',
  'tab.jobInterrupted': '{provider} 生成被中断（DSH 重启过），请重新生成',
  'tab.jobRecovered': '{provider} 生成时 DSH 重启过，已画好的 {done} 张已找回',
  'tab.jobRecoveredPartial': '{provider} 生成时 DSH 重启过，找回 {done}/{count} 张，其余请重新生成',
  'row.open': '打开游戏工坊',
  'row.running': '处理中',
  'row.failed': '失败',
  'row.create': '创建了游戏',
  'row.build': '构建完成',
  'row.candidates': '生成了 {count} 个候选',
  'row.background': '{provider} 正在后台生成 {count} 张，好了会出现在右栏',
  'row.apply': '已换上新素材',
  'row.revert': '已撤回素材',
  'row.export': '已导出',
  'row.publish': '已发布到 GitHub Pages',
  'guide.title': '游戏工坊 · 游戏墙',
  'guide.description': '这个工作区里做过的游戏，点开就能玩',
  'shelf.title': '游戏墙',
  'shelf.count': '{count} 款',
  'shelf.refresh': '刷新',
  'shelf.scanning': '正在找这个工作区里的游戏…',
  'shelf.empty': '这个工作区里还没有游戏。在对话里说一句，比如「做一个小游戏：小猫在厨房偷鱼干，别撞上扫地机器人」。',
  'shelf.partial': '工作区比较大，只找了前面一部分文件夹。',
  'shelf.noSession': '先打开一个会话，才能看到它工作区里的游戏。',
  'shelf.notBuilt': '还没构建',
  'shelf.versions': '{count} 个版本',
  'shelf.play': '打开《{title}》',
  'shelf.all': '全部',
  'shelf.online': '在线',
  'shelf.onlineBadge': '在线 · {source}',
  'shelf.sources': '在线源',
  'shelf.sourcesCount': '在线源 ({count})',
  'shelf.sourcePlaceholder': 'finiking/dsh-games 或 https://…',
  'shelf.sourceAdd': '添加',
  'shelf.sourceAdding': '正在添加…',
  'shelf.sourceAdded': '已订阅 {name}（共 {count} 款）',
  'shelf.sourceEmpty': '还没有订阅在线游戏源。输入仓库（如 finiking/dsh-games）或游戏链接即可添加。',
  'shelf.sourceStatusOk': '正常',
  'shelf.sourceStatusLoading': '加载中…',
  'shelf.sourceStatusError': '失败：{reason}',
  'shelf.sourceUpdated': '上次更新 {time}',
  'shelf.sourceRemove': '移除',
  'shelf.sourceFromWorkspace': '工作区',
  'shelf.backToWall': '← 返回游戏墙',
  'shelf.onlineFrom': '来自 {host} · 内容由对方提供',
  'shelf.openExternal': '在新窗口打开',
  'shelf.sortRecent': '最近修改',
  'shelf.sortVersions': '版本最多',
  'shelf.sortName': '名称',
  'shelf.export': '导出游戏墙',
  'shelf.exportHint': '把墙上现在显示的本地游戏打包成一个离线网页（不含在线游戏），点哪个玩哪个，可以发给朋友',
  'shelf.exporting': '正在导出…',
  'shelf.exported': '已导出：{file}（{count} 款 · {size}）',
  'shelf.exportSkipped': '另有 {count} 款还没构建，没放进去。',
  'shelf.exportFailed': '导出失败：{message}',
  'shelf.publish': '发布游戏墙',
  'shelf.publishHint': '把墙上当前显示的本地游戏发布到你的 GitHub Pages 公开仓库（不含在线游戏）',
  'shelf.publishing': '正在发布…',
  'shelf.published': '游戏墙已发布：{url}',
}

export const en: typeof zh = {
  'tab.title': 'Game Studio · {name}',
  'tab.loading': 'Loading the game…',
  'tab.noBuild': 'Not built yet. Ask the agent to run game_studio_build.',
  'tab.clickToPlay': 'Click the game to play; arrow keys / WASD to move',
  'tab.reload': 'Reload',
  'tab.rebuild': 'Rebuild',
  'tab.export': 'Export HTML',
  'tab.exportWechat': 'Export WeChat mini-game',
  'tab.exportedWechat': 'WeChat project exported: {dir}',
  'tab.release': 'Launch wizard',
  'tab.checkEnv': 'Check environment',
  'tab.envReady': 'Environment ready: preview and upload can run.',
  'tab.envHints': 'Environment: {hints}',
  'tab.envCliMissing': 'WeChat DevTools (or its CLI) was not found. Install it, then check again.',
  'tab.envPortClosed': 'The DevTools service port is closed: 工具 → 设置 → 安全设置 → 服务端口 → on, then check again.',
  'tab.envTourist': 'The project still uses the tourist AppID: preview works, but uploading needs the real mini-game AppID (re-export with it).',
  'tab.releaseProgress': '{done}/{total} done · {percent}%',
  'tab.releaseMaterials': 'Write release materials',
  'tab.releaseReview': 'Pre-review check',
  'tab.releaseReviewSaved': 'Review check written to {file} ({count} risks)',
  'tab.commerce': 'Monetization',
  'tab.commerceSave': 'Save',
  'tab.commerceSaved': 'Saved; the next export picks it up',
  'tab.commerceEnabled': 'Ads',
  'tab.commerceInterstitial': 'Interstitial unit',
  'tab.commerceRewarded': 'Rewarded unit',
  'tab.commerceIap': 'Purchases',
  'tab.commerceLicence': 'Licence',
  'tab.commerceMerchant': 'Merchant ID',
  'tab.commercePayUrl': 'Signing endpoint',
  'tab.commerceDataHint': 'After launch, watch the WeChat console: Analytics (retention, session length, sources), Traffic owner (ad revenue) and Realtime logs (errors). The plugin reports game_round_start, game_round_end, game_ad_interstitial, game_ad_rewarded and game_iap_paid.',
  'tab.releaseMaterialsSaved': 'Release materials written: {file}',
  'tab.releaseDevtools': 'Open DevTools',
  'tab.releaseDevtoolsOpened': 'Opened the export in WeChat DevTools',
  'tab.releaseOwner.wechat': 'WeChat console',
  'tab.releaseOwner.plugin': 'Plugin',
  'tab.releaseOwner.user': 'You',
  'tab.releaseBlocked': 'Waiting on earlier steps',
  'tab.share': 'Play on phone',
  'tab.sharePublic': 'Public link (30 min)',
  'tab.shareOpening': 'Opening…',
  'tab.shareHint': 'Scan with a phone on the same Wi-Fi to play; after a rebuild, refresh on the phone.',
  'tab.sharePublicHint': 'Anyone on any network with this link can play. Closes at {time}.',
  'tab.shareCopy': 'Copy link',
  'tab.shareUntil': 'Closes at {time}',
  'tab.unshare': 'Stop sharing',
  'tab.noTunnelMac': 'A public link requires cloudflared. On macOS, run: {install}',
  'tab.noTunnelWin': 'A public link requires cloudflared. On Windows, run: {install}',
  'tab.noTunnelLinux': 'A public link requires cloudflared. On Linux, install from: {install}',
  'tab.publish': 'Publish to GitHub',
  'tab.publishUpdate': 'Update published',
  'tab.publishing': 'Publishing…',
  'tab.publishConfirmHint': 'Will upload to your public repository; anyone can view the files',
  'tab.publishConfirmYes': 'Confirm publish',
  'tab.publishCancel': 'Cancel',
  'tab.publishedHint': 'Published on GitHub Pages ({repo})',
  'tab.publishDeploying': 'GitHub is deploying; it should be ready in a minute or two',
  'tab.publishOutdated': 'A newer build has not been published yet',
  'tab.unpublish': 'Remove from GitHub',
  'tab.unpublishing': 'Removing…',
  'tab.unpublishConfirmHint': 'Will remove this game from your public repository; its link will stop working',
  'tab.unpublishConfirmYes': 'Confirm remove',
  'tab.noGhMac': 'Publishing to GitHub requires GitHub CLI (gh). On macOS, run: {install}, then sign in with gh auth login.',
  'tab.noGhWin': 'Publishing to GitHub requires GitHub CLI (gh). On Windows, run: {install}, then sign in with gh auth login.',
  'tab.noGhLinux': 'Publishing to GitHub requires GitHub CLI (gh). Install from: {install}, then sign in with gh auth login.',
  'tab.ghNotLoggedIn': 'GitHub CLI is not signed in. Run gh auth login in your terminal to sign in to your GitHub account.',
  'tab.ghFailed': 'Could not connect to GitHub; check your network or proxy and try again',
  'tab.repoNotOurs': 'Repository {repo} already exists and was not created by this plugin. Set githubRepo in config to a different repository name.',
  'tab.versions': 'Versions',
  'tab.restore': 'Go back',
  'tab.exported': 'Exported: {file}',
  'tab.build': 'Build {id} · {size}',
  'tab.assets': 'Assets',
  'tab.current': 'Current',
  'tab.currentRendered': 'Current · in game',
  'tab.currentTemplate': 'Current · template icon',
  'tab.sourceTemplate': 'template art',
  'tab.sourceEdited': 'drawn in project',
  'tab.spend': 'Generated in this project: {parts}',
  'tab.spendOpenai': 'OpenAI {count} ≈ {usd}',
  'tab.spendCodex': 'Codex {count} (plan usage)',
  'tab.revert': 'Revert',
  'tab.apply': 'Use this',
  'tab.failed': 'Failed: {problems}',
  'tab.noCandidates': 'No candidates yet. Ask the agent to generate art for "{slot}".',
  'tab.gameError': 'Game error: {message}',
  'tab.phase': 'Phase: {phase} · score {score}',
  'tab.busy': 'Working…',
  'tab.jobRunning': '{provider} is drawing · {done}/{count} done · {elapsed}',
  'tab.jobFailed': '{provider} failed: {detail}',
  'tab.jobPartial': '{provider} missed {failed}: {detail}',
  'tab.jobInterrupted': '{provider} was interrupted (DSH restarted); generate again',
  'tab.jobRecovered': '{provider} was cut off by a DSH restart; the {done} finished image(s) were kept',
  'tab.jobRecoveredPartial': '{provider} was cut off by a DSH restart; kept {done} of {count}, generate the rest again',
  'row.open': 'Open Game Studio',
  'row.running': 'Working',
  'row.failed': 'Failed',
  'row.create': 'Game created',
  'row.build': 'Built',
  'row.candidates': '{count} candidates generated',
  'row.background': '{provider} is drawing {count} in the background; they will appear in the sidebar',
  'row.apply': 'New asset applied',
  'row.revert': 'Asset reverted',
  'row.export': 'Exported',
  'row.publish': 'Published to GitHub Pages',
  'guide.title': 'Game Studio · My games',
  'guide.description': 'Games made in this workspace, ready to play',
  'shelf.title': 'My games',
  'shelf.count': '{count} games',
  'shelf.refresh': 'Refresh',
  'shelf.scanning': 'Looking for games in this workspace…',
  'shelf.empty': 'No games in this workspace yet. Ask in the chat, for example: "Make a small game: a kitten steals dried fish in a kitchen without bumping into the robot vacuum."',
  'shelf.partial': 'This workspace is large; only the first folders were searched.',
  'shelf.noSession': 'Open a session to see the games in its workspace.',
  'shelf.notBuilt': 'Not built yet',
  'shelf.versions': '{count} versions',
  'shelf.play': 'Open "{title}"',
  'shelf.all': 'All',
  'shelf.online': 'Online',
  'shelf.onlineBadge': 'Online · {source}',
  'shelf.sources': 'Online sources',
  'shelf.sourcesCount': 'Online sources ({count})',
  'shelf.sourcePlaceholder': 'finiking/dsh-games or https://…',
  'shelf.sourceAdd': 'Add',
  'shelf.sourceAdding': 'Adding…',
  'shelf.sourceAdded': 'Subscribed to {name} ({count} games)',
  'shelf.sourceEmpty': 'No online game sources yet. Enter a repo (e.g. finiking/dsh-games) or game link to add one.',
  'shelf.sourceStatusOk': 'OK',
  'shelf.sourceStatusLoading': 'Loading…',
  'shelf.sourceStatusError': 'Failed: {reason}',
  'shelf.sourceUpdated': 'Updated {time}',
  'shelf.sourceRemove': 'Remove',
  'shelf.sourceFromWorkspace': 'Workspace',
  'shelf.backToWall': '← Back to wall',
  'shelf.onlineFrom': 'From {host} · provided by third party',
  'shelf.openExternal': 'Open in new window',
  'shelf.sortRecent': 'Recent',
  'shelf.sortVersions': 'Most versions',
  'shelf.sortName': 'Name',
  'shelf.export': 'Export wall',
  'shelf.exportHint': 'Pack the local games shown here into one offline web page (online games are not included); send it to friends',
  'shelf.exporting': 'Exporting…',
  'shelf.exported': 'Exported: {file} ({count} games · {size})',
  'shelf.exportSkipped': '{count} more were never built and were left out.',
  'shelf.exportFailed': 'Export failed: {message}',
  'shelf.publish': 'Publish wall',
  'shelf.publishHint': 'Publish the local games shown here to your public GitHub Pages repository (online games are not included)',
  'shelf.publishing': 'Publishing…',
  'shelf.published': 'Game wall published: {url}',
}

export type Key = keyof typeof zh

export interface PublishedInfo {
  url: string
  siteUrl?: string
  repo: string
  slug: string
  publishedAt: string
  buildId: string
  status?: 'built' | 'building'
}

export function publishState(
  published: PublishedInfo | null | undefined,
  currentBuildId: string | null | undefined,
  t: (key: Key, params?: Record<string, string>) => string,
): {
  status: 'unpublished' | 'published' | 'outdated'
  hasUpdate: boolean
  deploying: boolean
  buttonLabel: string
  hint: string | null
  outdatedHint: string | null
} {
  if (!published || typeof published.url !== 'string' || !published.url) {
    return {
      status: 'unpublished',
      hasUpdate: false,
      deploying: false,
      buttonLabel: t('tab.publish'),
      hint: null,
      outdatedHint: null,
    }
  }
  const hasUpdate = Boolean(currentBuildId && published.buildId && published.buildId !== currentBuildId)
  const deploying = published.status === 'building'
  return {
    status: hasUpdate ? 'outdated' : 'published',
    hasUpdate,
    deploying,
    buttonLabel: hasUpdate ? t('tab.publishUpdate') : t('tab.publish'),
    hint: deploying ? t('tab.publishDeploying') : t('tab.publishedHint', { repo: published.repo }),
    outdatedHint: hasUpdate ? t('tab.publishOutdated') : null,
  }
}

export function shareCopy(
  share: { expiresAt: string; scope?: 'lan' | 'public' },
  t: (key: Key, params?: Record<string, string>) => string,
  time: string,
): { hint: string; until: string | null; isPublic: boolean } {
  if (share.scope === 'public') {
    return { hint: t('tab.sharePublicHint', { time }), until: null, isPublic: true }
  }
  return { hint: t('tab.shareHint'), until: t('tab.shareUntil', { time }), isPublic: false }
}

export function commandErrorCopy(
  text: string,
  t: (key: Key, params?: Record<string, string>) => string,
): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; platform?: unknown; install?: unknown; repo?: unknown }
    if (parsed && typeof parsed === 'object') {
      if (parsed.code === 'NO_TUNNEL') {
        const platform = parsed.platform === 'win32' || parsed.platform === 'linux' ? parsed.platform : 'darwin'
        const defaultInstall = platform === 'win32'
          ? 'winget install --id Cloudflare.cloudflared'
          : platform === 'linux'
            ? 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
            : 'brew install cloudflared'
        const install = typeof parsed.install === 'string' && parsed.install ? parsed.install : defaultInstall
        const key: Key = platform === 'win32' ? 'tab.noTunnelWin' : platform === 'linux' ? 'tab.noTunnelLinux' : 'tab.noTunnelMac'
        return t(key, { install })
      }
      if (parsed.code === 'NO_GH') {
        const platform = parsed.platform === 'win32' || parsed.platform === 'linux' ? parsed.platform : 'darwin'
        const defaultInstall = platform === 'win32'
          ? 'winget install --id GitHub.cli'
          : platform === 'linux'
            ? 'https://cli.github.com'
            : 'brew install gh'
        const install = typeof parsed.install === 'string' && parsed.install ? parsed.install : defaultInstall
        const key: Key = platform === 'win32' ? 'tab.noGhWin' : platform === 'linux' ? 'tab.noGhLinux' : 'tab.noGhMac'
        return t(key, { install })
      }
      if (parsed.code === 'GH_NOT_LOGGED_IN') {
        return t('tab.ghNotLoggedIn')
      }
      if (parsed.code === 'GH_FAILED') {
        return t('tab.ghFailed')
      }
      if (parsed.code === 'REPO_NOT_OURS') {
        const repo = typeof parsed.repo === 'string' && parsed.repo ? parsed.repo : 'dsh-games'
        return t('tab.repoNotOurs', { repo })
      }
    }
  } catch {
    // Plain error string from other actions; show as-is.
  }
  return text
}

export const SHARE_HEARTBEAT_MAX_AGE_MS = 60_000

export interface ShareHeartbeat {
  url: string
  at: string
}

export function liveShare<S extends { url: string; expiresAt: string }>(
  share: S | null | undefined,
  heartbeat: ShareHeartbeat | null | undefined,
  now = Date.now(),
): S | undefined {
  if (!share || !heartbeat) return undefined
  if (typeof share.url !== 'string' || !share.url || heartbeat.url !== share.url) return undefined
  const expiresAt = Date.parse(share.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined
  const beatAt = Date.parse(heartbeat.at)
  if (!Number.isFinite(beatAt) || now - beatAt > SHARE_HEARTBEAT_MAX_AGE_MS) return undefined
  return share
}

