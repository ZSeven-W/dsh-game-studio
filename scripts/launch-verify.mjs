// Last-mile check once the user has a real AppID: is this exported project ready to
// upload and publish, and if not, what exactly is missing?
//
//   node scripts/launch-verify.mjs --project export/wechat/my-game
//   node scripts/launch-verify.mjs --project <dir> --skip-devtools
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { devtoolsDoctor } from '../src/devtools.ts'

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {{ project: string, skipDevtools?: boolean }} options
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string, next?: string }> }>}
 */
export async function verifyLaunch({ project, skipDevtools = false, quiet = false }) {
  const dir = resolve(project)
  const checks = []
  const check = (name, ok, detail, next) => {
    checks.push({ name, ok, detail, next })
    if (!quiet) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok && next) console.log(`      ↳ 下一步：${next}`)
    }
  }

  check('导出工程存在', existsSync(dir), dir, '先导出：侧栏点「导出微信小游戏」，它会生成 export/wechat/<游戏>/ 这样的目录')
  const gamePath = join(dir, 'game.json')
  const projectPath = join(dir, 'project.config.json')
  const gameExists = existsSync(gamePath)
  const projectExists = existsSync(projectPath)
  const gameJson = readJson(gamePath)
  const projectJson = readJson(projectPath)
  const missingNames = [gameExists ? '' : 'game.json', projectExists ? '' : 'project.config.json'].filter(Boolean)
  check('game.json 与 project.config.json 都在', gameExists && projectExists,
    missingNames.length ? `缺少 ${missingNames.join('、')}` : 'ok',
    '重新导出一次；若刚移动过目录，请把 --project 指向新的导出目录')
  check('两个 JSON 都能解析', Boolean(gameJson && projectJson),
    missingNames.length ? '文件缺失，无法解析' : gameJson && projectJson ? 'ok' : 'JSON 语法错误',
    '文件内容被改坏时不要手改：重新导出，或从导出的备份里恢复这两个 JSON')
  check('分包设置', true, gameJson?.subpackages?.length
    ? JSON.stringify(gameJson.subpackages)
    : '无需分包（素材较小）；素材超过 1.5 MB 时会自动分包')

  const appid = projectJson?.appid ?? ''
  check('AppID 不是 touristappid', Boolean(appid) && appid !== 'touristappid', appid || '(empty)',
    '带真实 AppID 重新导出：game_studio_export_wechat {"project":"...","appid":"wx..."}；AppID 在微信后台「开发 → 开发设置」复制')
  check('appid 形如 wx 开头', /^wx[0-9a-f]{16}$/u.test(appid), appid,
    'AppID 是 18 位、以 wx 开头的字符串；去微信后台「开发 → 开发设置 → 开发者 ID」复制完整值')

  check('发布材料已生成', existsSync(join(dir, 'RELEASE.md')), 'RELEASE.md',
    '侧栏点「生成发布材料」，RELEASE.md 会写在导出目录里')
  check('审核自查已生成', existsSync(join(dir, 'REVIEW.md')), 'REVIEW.md',
    '侧栏点「审核自查」，REVIEW.md 会写在导出目录里')

  if (!skipDevtools) {
    try {
      const doctor = await devtoolsDoctor()
      check('开发者工具 CLI 能找到', doctor.cliFound, doctor.cli ?? 'not found',
        '先安装微信开发者工具；装好后在「工具 → 设置 → 安全设置」里能看到 CLI 与服务端口')
      check('开发者工具服务端口已开', doctor.portOpen, `port ${doctor.port}`,
        '工具 → 设置 → 安全设置 → 服务端口 → 开启，然后重新运行本命令')
      check('工具看到的是真实 AppID', Boolean(doctor.appid) && !doctor.tourist, doctor.appid ?? '(none)',
        '当前工程仍是 touristappid：带真实 appid 重新导出后再跑自检')
    } catch (error) {
      check('开发者工具体检可运行', false, String(error?.message ?? error), '确认本机装了微信开发者工具；装在非默认路径时，用 --cli 指定它的命令行路径')
    }
  }

  const blockers = checks.filter((entry) => !entry.ok).length
  if (!quiet) {
    console.log(blockers === 0
      ? '\n可以上传：下一步在侧栏点「上传版本」，然后去微信后台提交审核'
      : `\n还有 ${blockers} 项要处理，按每条的「下一步」做`)
  }
  return { ok: blockers === 0, checks }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const project = value('--project')
  if (!project) {
    console.error('usage: node scripts/launch-verify.mjs --project <export/wechat/game> [--skip-devtools]')
    process.exit(1)
  }
  const asJson = args.includes('--json')
  const result = await verifyLaunch({ project, skipDevtools: args.includes('--skip-devtools'), quiet: asJson })
  if (asJson) console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
