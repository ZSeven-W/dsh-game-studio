// The generated CI kit is only useful if it actually uploads when the secrets are
// present. miniprogram-ci is a real WeChat package, so this runs the generated
// script against a stub with the same default export and checks the arguments it
// hands over — plus the honest failure when the key is missing.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { writeWechatCi } from '../src/ci.ts'

const run = promisify(execFile)

/** A fake miniprogram-ci: records the Project and upload options it is given. */
async function stubCi(exportDir, record) {
  const dir = join(exportDir, 'node_modules', 'miniprogram-ci')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'miniprogram-ci', version: '0.0.0-stub', type: 'module', main: 'index.js' }), 'utf8')
  await writeFile(join(dir, 'index.js'), `import { appendFileSync } from 'node:fs'
export class Project {
  constructor(options) {
    appendFileSync(${JSON.stringify(record)}, JSON.stringify({ kind: 'project', options }) + '\\n')
  }
}
export async function upload(options) {
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ kind: 'upload', options }) + '\\n')
  return { subPackageInfo: [], pluginInfo: [] }
}
export default { Project, upload }
`, 'utf8')
}

async function exportedProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'ci-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exportDir = join(root, 'export')
  await mkdir(exportDir, { recursive: true })
  // The minimum a mini-game project must carry for the upload script.
  await writeFile(join(exportDir, 'game.js'), '// game\n', 'utf8')
  await writeFile(join(exportDir, 'game.json'), JSON.stringify({ deviceOrientation: 'portrait' }), 'utf8')
  await writeFile(join(exportDir, 'project.config.json'), JSON.stringify({ appid: 'wx1234567890abcdef', compileType: 'game' }), 'utf8')
  return { root, exportDir }
}

test('the generated upload script uploads with the AppID, version and key it is given', async (t) => {
  const { root, exportDir } = await exportedProject(t)
  await writeWechatCi(exportDir, { appid: 'wx1234567890abcdef', version: '1.4.2', desc: 'from ci' })
  const record = join(root, 'record.jsonl')
  await stubCi(exportDir, record)
  const key = join(root, 'private.key')
  await writeFile(key, 'key', 'utf8')

  const { stdout } = await run(process.execPath, [join(exportDir, 'ci', 'upload.mjs')], {
    cwd: exportDir,
    env: { ...process.env, WECHAT_APPID: 'wx1234567890abcdef', WECHAT_PRIVATE_KEY: key, VERSION: '1.4.2', DESC: 'from ci' },
  })
  assert.match(stdout, /uploaded/u)

  const lines = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const project = lines.find((entry) => entry.kind === 'project').options
  const upload = lines.find((entry) => entry.kind === 'upload').options
  assert.equal(project.appid, 'wx1234567890abcdef')
  assert.equal(project.type, 'miniGame')
  assert.ok(project.projectPath.endsWith('export'))
  assert.equal(project.privateKeyPath, key)
  assert.equal(upload.version, '1.4.2')
  assert.equal(upload.desc, 'from ci')
  assert.equal(upload.setting.es6, true)
})

test('without the upload key the script stops with the console hint', async (t) => {
  const { exportDir } = await exportedProject(t)
  await writeWechatCi(exportDir, { appid: 'wx1234567890abcdef' })
  await stubCi(exportDir, join(tmpdir(), 'unused-record.jsonl'))
  await assert.rejects(
    run(process.execPath, [join(exportDir, 'ci', 'upload.mjs')], { cwd: exportDir, env: { ...process.env, WECHAT_PRIVATE_KEY: '' } }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(String(error.stderr), /WECHAT_PRIVATE_KEY is missing/u)
      assert.match(String(error.stderr), /开发管理/u)
      return true
    },
  )
})
