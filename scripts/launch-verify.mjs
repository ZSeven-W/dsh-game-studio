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

  check('导出工程存在', existsSync(dir), dir, '先导出：侧栏「导出微信小游戏」')
  const gameJson = readJson(join(dir, 'game.json'))
  const projectJson = readJson(join(dir, 'project.config.json'))
  check('game.json 与 project.config.json 都在', Boolean(gameJson && projectJson),
    gameJson && projectJson ? 'ok' : 'missing', '重新导出，或检查导出目录是否被移动')
  check('game.json 声明了分包', Boolean(gameJson?.subpackages?.length),
    gameJson?.subpackages ? JSON.stringify(gameJson.subpackages) : 'none', '用当前插件重新导出')

  const appid = projectJson?.appid ?? ''
  check('AppID 不是 touristappid', Boolean(appid) && appid !== 'touristappid', appid || '(empty)',
    '带真实 appid 重新导出：game_studio_export_wechat {"appid":"wx..."}')
  check('appid 形如 wx 开头', /^wx[0-9a-f]{16}$/u.test(appid), appid,
    '去微信后台「开发 → 开发设置」复制 AppID（18 位，wx 开头）')

  check('发布材料已生成', existsSync(join(dir, 'RELEASE.md')), 'RELEASE.md',
    '侧栏「生成发布材料」')
  check('审核自查已生成', existsSync(join(dir, 'REVIEW.md')), 'REVIEW.md',
    '侧栏「审核自查」')

  if (!skipDevtools) {
    try {
      const doctor = await devtoolsDoctor()
      check('开发者工具 CLI 能找到', doctor.cliFound, doctor.cli ?? 'not found',
        '安装微信开发者工具，并在设置里打开服务端口')
      check('开发者工具服务端口已开', doctor.portOpen, `port ${doctor.port}`,
        '工具 → 设置 → 安全设置 → 服务端口 → 开启')
      check('工具看到的是真实 AppID', Boolean(doctor.appid) && !doctor.tourist, doctor.appid ?? '(none)',
        '带真实 appid 重新导出')
    } catch (error) {
      check('开发者工具体检可运行', false, String(error?.message ?? error), '先确认本机装了开发者工具')
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
  const result = await verifyLaunch({ project, skipDevtools: args.includes('--skip-devtools') })
  if (!result.ok) process.exitCode = 1
}
