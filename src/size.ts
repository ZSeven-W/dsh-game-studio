/**
 * Package budget for the WeChat export.
 *
 * WeChat mini-games have a 4 MB main package and a 30 MB total package. The 4 MB
 * check must count only what stays in the main package: files under a subpackage
 * root are downloaded separately, so they count towards the total, not the main
 * package. A single oversized texture is the usual reason a main package cannot
 * be uploaded; this module measures both and says what to cut.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const MAIN_PACKAGE_LIMIT = 4 * 1024 * 1024
export const TOTAL_PACKAGE_LIMIT = 30 * 1024 * 1024
/** A single image this big is worth compressing before anything else. */
export const SINGLE_ASSET_WARN = 512 * 1024

export interface PackageEntry {
  file: string
  bytes: number
}

export interface PackageReport {
  dir: string
  totalBytes: number
  mainBytes: number
  largest: PackageEntry[]
  assets: PackageEntry[]
  warnings: string[]
  suggestions: string[]
}

async function walk(dir: string, current: string, out: PackageEntry[]): Promise<void> {
  let entries
  try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(current, entry.name)
    const relative = full.slice(dir.length + 1).split(/[\\/]/u).join('/')
    if (entry.isDirectory()) { await walk(dir, full, out); continue }
    try { out.push({ file: relative, bytes: (await stat(full)).size }) } catch { /* vanished */ }
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`
}

export async function analyzeWechatPackage(
  dir: string,
  options: { subpackageRoots?: string[] } = {},
): Promise<PackageReport> {
  const entries: PackageEntry[] = []
  await walk(dir, dir, entries)
  entries.sort((a, b) => b.bytes - a.bytes)
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const roots = (options.subpackageRoots ?? []).map(root => root.replace(/\/+$/u, '') + '/')
  const inSubpackage = (file: string): boolean => roots.some(root => file.startsWith(root))
  const mainBytes = entries.filter(entry => !inSubpackage(entry.file)).reduce((sum, entry) => sum + entry.bytes, 0)
  const assets = entries.filter(entry => entry.file.startsWith('assets/'))
  const warnings: string[] = []
  const suggestions: string[] = []

  if (mainBytes > MAIN_PACKAGE_LIMIT) {
    warnings.push(`主包约 ${mb(mainBytes)}，超过微信小游戏的 4 MB 主包限制，无法直接上传。`)
  } else if (mainBytes > MAIN_PACKAGE_LIMIT * 0.8) {
    warnings.push(`主包约 ${mb(mainBytes)}，已接近 4 MB 上限，再加素材就会超。`)
  }
  if (totalBytes > TOTAL_PACKAGE_LIMIT) warnings.push(`总包约 ${mb(totalBytes)}，超过 30 MB 总包限制。`)

  // game.js is code, not art: on a 3D export it is three.js inlined, and a big
  // bundle there is expected, so it gets an explanation instead of a warning.
  const heavy = entries.filter(entry => entry.file !== 'game.js' && entry.bytes > SINGLE_ASSET_WARN)
  for (const entry of heavy.slice(0, 5)) {
    warnings.push(`${entry.file} 单个文件 ${mb(entry.bytes)}，偏大。`)
  }
  if (heavy.length > 0) {
    suggestions.push('先把最大的几张图压小：导出前把槽位图降到实际显示尺寸（通常 256–512px 就够），或换成 WebP。')
  }
  if (mainBytes > MAIN_PACKAGE_LIMIT) {
    suggestions.push('主包超限时用分包：插件会在素材超过 1.5 MB 时自动把素材放进 assets 分包，并在游戏启动前用 wx.loadSubpackage 预下载；也可以用导出的 subpackage 选项强制开启。')
  } else if (roots.length > 0) {
    suggestions.push(`素材在分包里（${roots.join(', ')}），不计入主包；主包 ${mb(mainBytes)}，分包合计 ${mb(totalBytes - mainBytes)}。`)
  }
  const js = entries.find(entry => entry.file === 'game.js')
  if (js && js.bytes > 1024 * 1024) {
    suggestions.push(`game.js 有 ${mb(js.bytes)}（three.js 内联在内），3D 工程属正常；2D 工程出现这个体积通常说明内联了不需要的运行时。`)
  }
  if (assets.length > 8) suggestions.push(`一共 ${assets.length} 个素材文件，槽位越少主包越轻。`)
  if (entries.length > 0 && warningFree(warnings)) suggestions.push('包体在限制内：可以继续加素材，但留意 4 MB 主包。')

  return {
    dir,
    totalBytes,
    mainBytes,
    largest: entries.slice(0, 5),
    assets,
    warnings,
    suggestions,
  }
}

function warningFree(warnings: string[]): boolean {
  return warnings.length === 0
}


