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
  if (path.endsWith('dist/index.html')) {
    return { data: new TextEncoder().encode('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#10151f;color:#e8ecf5;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><div style="font-size:22px;font-weight:600">Lantern Isle</div><div style="opacity:.7;margin-top:6px">游戏预览区（截图用占位）</div></div></body>') }
  }
  return { data: new Uint8Array() }
}

const runCommand = async (_session: string, input: string) => {
  if (input.startsWith('wechat-release {')) return { ok: true, text: JSON.stringify(fixtures.release) }
  if (input.startsWith('wechat-commerce')) return { ok: true, text: JSON.stringify(fixtures.commerce) }
  if (input.startsWith('wechat-devtools')) {
    return {
      ok: true,
      text: JSON.stringify({
        ready: false,
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
root.render(createElement('div', { style: { width: 372, padding: 12, fontFamily: 'system-ui, "Segoe UI", sans-serif', background: '#ffffff' } },
  createElement(Tab as never, props as never)))
