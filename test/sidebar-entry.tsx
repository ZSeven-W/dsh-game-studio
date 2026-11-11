// Browser entry for the sidebar screenshots: load the real client bundle source,
// run apply() with a fake host, and render the studio tab with fixture data.
import { apply } from '../src/client/index.tsx'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

interface Fixtures {
  release: unknown
  commerce: unknown
  state: unknown
}

const fixtures = (window as unknown as { __FIXTURES__: Fixtures }).__FIXTURES__
const containerWidth = (window as unknown as { __WIDTH__?: number }).__WIDTH__ ?? 372
let uploaded = false
const components = new Map<string, unknown>()
let dictionary: Record<string, string> = {}

const format = (template: string, params?: Record<string, string>): string => template
  .replace(/\{(\w+)\}/gu, (_match, key: string) => params?.[key] ?? `{${key}}`)

const ctx = {
  effect: (scope: () => void) => scope(),
  locale: {
    register: (_ns: string, dictionaries: { zh: Record<string, string> }) => { dictionary = dictionaries.zh },
    bind: () => (key: string, params?: Record<string, string>) => format(dictionary[key] ?? key, params),
  },
  sidebarRightTabs: { register: () => undefined },
  slots: {
    inject: (_name: string, factory: () => unknown) => factory(),
    register: (definition: { key: string }, component: unknown) => {
      components.set(definition.key, component)
      return definition
    },
  },
  remote: {},
}
apply(ctx)

const Tab = components.get('@zseven-w/dsh-game-studio') as (props: unknown) => unknown
const t = ctx.locale.bind()

const readBytes = async (_session: string, path: string) => {
  if (path.endsWith('.studio/state.json')) {
    return { data: new TextEncoder().encode(JSON.stringify(fixtures.state)) }
  }
  if (path.endsWith('.png')) {
    // A stand-in QR picture so the panel's preview block renders.
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 160
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 160, 160)
      context.fillStyle = '#111111'
      for (let y = 0; y < 20; y += 1) {
        for (let x = 0; x < 20; x += 1) {
          if ((x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0) context.fillRect(x * 8, y * 8, 8, 8)
        }
      }
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return { data: new Uint8Array(await blob!.arrayBuffer()) }
  }
  if (path.endsWith('dist/index.html')) {
    return { data: new TextEncoder().encode('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#10151f;color:#e8ecf5;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><div style="font-size:22px;font-weight:600">Lantern Isle</div><div style="opacity:.7;margin-top:6px">游戏预览区（截图用占位）</div></div></body>') }
  }
  return { data: new Uint8Array() }
}

const runCommand = async (_session: string, input: string) => {
  // Remember the upload so the next status read shows the step done, the way the
  // host's markReleaseDone does.
  if (input.startsWith('wechat-release {')) {
    const base = fixtures.release as { steps?: Array<{ id: string; status: string }>; progress?: unknown }
    // A step click sends an update: flip that step so the panel really re-renders.
    if (Array.isArray(base.steps) && input.includes('"step"')) {
      const payload = JSON.parse(input.slice('wechat-release '.length)) as { step?: string }
      const steps = base.steps.map((step) => (step.id === payload.step ? { ...step, status: step.status === 'done' ? 'todo' : 'done' } : step))
      const done = steps.filter((step) => step.status === 'done').length
      return { ok: true, text: JSON.stringify({ ...base, steps, progress: { done, total: steps.length, percent: Math.round((done * 100) / steps.length) } }) }
    }
    if (!uploaded || !Array.isArray(base.steps)) return { ok: true, text: JSON.stringify(fixtures.release) }
    const steps = base.steps.map((step) => (step.id === 'upload' ? { ...step, status: 'done' } : step))
    const done = steps.filter((step) => step.status === 'done').length
    return { ok: true, text: JSON.stringify({ ...base, steps, progress: { done, total: steps.length, percent: Math.round((done * 100) / steps.length) } }) }
  }
  if (input.startsWith('wechat-commerce')) return { ok: true, text: JSON.stringify(fixtures.commerce) }
  if (input.startsWith('wechat-devtools')) {
    if (input.includes('"preview"')) {
      return { ok: true, text: JSON.stringify({ action: 'preview', project: '/tmp/lantern-isle-3d/export/wechat/lantern-isle-3d', qr: 'export/wechat/lantern-isle-3d/preview.png' }) }
    }
    if (input.includes('"upload"')) {
      uploaded = true
      return { ok: true, text: JSON.stringify({ action: 'upload', project: '/tmp/lantern-isle-3d/export/wechat/lantern-isle-3d', output: 'upload ok' }) }
    }
    return {
      ok: true,
      text: JSON.stringify({
        ready: false,
        problems: [
          { code: 'port_closed', hint: 'service port closed' },
          { code: 'tourist_appid', hint: 'tourist appid' },
        ],
        hints: [
          'WeChat DevTools must have its service port on: 工具 → 设置 → 安全设置 → 服务端口 → 开启，然后重新运行。',
          'The project uses the tourist AppID: preview works, but uploading needs the real mini-game AppID.',
        ],
      }),
    }
  }
  return { ok: true, text: '{}' }
}

const props = {
  useTabInfo: () => ({ tab: { contentId: 'dsh-resource://game-studio/session/s1/lantern-isle-3d' } }),
  t,
  readBytes,
  runCommand,
}

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(createElement('div', { style: { width: containerWidth, maxWidth: '100%', boxSizing: 'border-box', padding: 12, fontFamily: 'system-ui, "Segoe UI", sans-serif', background: 'transparent' } },
  createElement(Tab as never, props as never)))
