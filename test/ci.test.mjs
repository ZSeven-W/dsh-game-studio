// CI upload kit: the files a repo needs to upload a mini-game version without
// the DevTools UI, and the guard that it never ships without a real AppID.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeWechatCi } from '../src/ci.ts'

async function exportedProject(t, { appid = 'wx1234567890abcdef', config = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-ci-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'lantern-isle')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'game.js'), '// game\n')
  if (config) await writeFile(join(dir, 'project.config.json'), JSON.stringify({ appid, compileType: 'game' }))
  return dir
}

test('the CI kit writes an upload script, a workflow and a README', async (t) => {
  const dir = await exportedProject(t)
  const result = await writeWechatCi(dir, { version: '1.2.3', desc: 'first build' })
  assert.equal(result.appid, 'wx1234567890abcdef')
  assert.deepEqual(result.files.sort(), ['.github/workflows/wechat-upload.yml', 'ci/README.md', 'ci/upload.mjs'])

  const script = await readFile(join(dir, 'ci', 'upload.mjs'), 'utf8')
  assert.match(script, /miniprogram-ci/u)
  assert.match(script, /type: process\.env\.WECHAT_PROJECT_TYPE \|\| 'miniGame'/u)
  assert.match(script, /ci\.upload\(/u)
  assert.match(script, /WECHAT_PRIVATE_KEY/u)

  const flow = await readFile(join(dir, '.github', 'workflows', 'wechat-upload.yml'), 'utf8')
  assert.match(flow, /workflow_dispatch/u)
  assert.match(flow, /actions\/checkout@v4/u)
  assert.match(flow, /npm install miniprogram-ci/u)
  assert.match(flow, /secrets\.WECHAT_APPID/u)
  assert.match(flow, /secrets\.WECHAT_PRIVATE_KEY/u)
  assert.match(flow, /"1\.2\.3"/u, 'the default version reaches the workflow input')

  const readme = await readFile(join(dir, 'ci', 'README.md'), 'utf8')
  assert.match(readme, /上传密钥/u)
  assert.match(readme, /不会提交审核/u)
})

test('CI files are refused without a real AppID or an export', async (t) => {
  const tourist = await exportedProject(t, { appid: 'touristappid' })
  await assert.rejects(writeWechatCi(tourist), /real mini-game AppID/u)

  const missing = await exportedProject(t, { config: false })
  await assert.rejects(writeWechatCi(missing), /export the mini-game first/u)
})

test('a hostile version string cannot break out of the generated script', async (t) => {
  const dir = await exportedProject(t)
  await writeWechatCi(dir, { version: "1.0.0'; process.exit(1); //" })
  const script = await readFile(join(dir, 'ci', 'upload.mjs'), 'utf8')
  assert.doesNotMatch(script, /process\.exit\(1\); \/\//u)
  assert.match(script, /VERSION \|\| '1\.0\.0process\.exit1'/u)
})
