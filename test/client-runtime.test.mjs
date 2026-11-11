// Runtime smoke test for the sidebar bundle: evaluate lib/client.js the way the
// host does (window.__ModuleLoader__.load + a require for React) and run apply()
// against a fake host context. This is the only layer that is neither TypeScript
// nor exercised by the browser tests.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  const useContext = () => ({})
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    useContext,
    forwardRef: (render) => render,
    memo: (component) => component,
    createContext: (value) => ({ Provider: null, _value: value }),
  }
  return { React, react: React, jsxRuntime: { jsx: createElement, jsxs: createElement, Fragment: React.Fragment } }
}

test('the built sidebar bundle loads and registers its tabs without a host', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load: (module) => { captured = module } } }
  const { react, jsxRuntime } = fakeReact()
  const require = (name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  }
  // Run with the bundle's `window` shadowed; other globals (EventTarget, …)
  // come from Node itself, which is why this is not a vm context.
  new Function('window', 'require', code)(fakeWindow, require)

  assert.ok(captured, 'the bundle must hand a module to __ModuleLoader__.load')
  assert.equal(captured.id, '@zseven-w/dsh-game-studio')
  const moduleExports = captured.factory(require)
  assert.equal(typeof moduleExports.apply, 'function', 'the bundle exports apply(ctx)')

  const registered = { locales: [], tabs: [], slots: [] }
  const ctx = {
    effect: (scope) => scope(),
    locale: {
      register: (ns, dictionaries) => { registered.locales.push({ ns, dictionaries }) },
      bind: (ns) => (key, params) => `${ns}:${key}${params ? JSON.stringify(params) : ''}`,
    },
    sidebarRightTabs: { register: (definition) => { registered.tabs.push(definition); return definition } },
    slots: {
      inject: (name, factory) => factory(),
      register: (definition, component) => {
        registered.slots.push({ slot: definition?.name ?? definition, key: definition?.key, component })
        return definition
      },
    },
    remote: {},
  }
  moduleExports.apply(ctx)

  assert.deepEqual(registered.locales.map((entry) => entry.ns), ['gameStudio'])
  assert.ok(registered.locales[0].dictionaries.zh && registered.locales[0].dictionaries.en,
    'both dictionaries reach the host')
  assert.equal(registered.tabs.length, 2, 'the studio tab and the shelf tab are registered')
  assert.deepEqual(registered.tabs.map((tab) => tab.id).sort(), ['@zseven-w/dsh-game-studio', '@zseven-w/dsh-game-studio/shelf'])

  const tabs = registered.slots.filter((entry) => entry.slot === 'sidebar.right.pane.tab')
  assert.equal(tabs.length, 2, 'both tab bodies are injected')
  const toolViews = registered.slots.filter((entry) => entry.slot === 'tool.call.toolview')
  assert.ok(toolViews.some((entry) => entry.component), 'tool rows are injected')
  for (const view of toolViews) {
    assert.ok(view.component && typeof view.component === 'object' || typeof view.component === 'function',
      'each tool row is a component')
  }
})
