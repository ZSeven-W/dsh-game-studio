// Build the Host entry (lib/index.js, ESM, host packages external), the
// standalone MCP server (lib/mcp-server.js + plugins/game-studio/scripts/mcp-server.mjs),
// and the browser module (lib/client.js) in the loader shape dsh-web requires:
// `window.__ModuleLoader__.load({ id, factory })`, React from the host.
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const pluginDir = join(root, 'plugins/game-studio')

await rm(join(root, 'lib'), { recursive: true, force: true })
await mkdir(join(root, 'lib'), { recursive: true })
await mkdir(join(pluginDir, 'scripts'), { recursive: true })
await mkdir(join(pluginDir, 'assets'), { recursive: true })
await mkdir(join(pluginDir, 'vendor'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Host packages come from the DSH installation; pngjs and undici ship as dependencies.
  external: ['@deepseek-ai/*', 'pngjs', 'undici', 'playwright-core'],
  logLevel: 'warning',
})

for (const outfile of [
  join(root, 'lib/mcp-server.js'),
  join(pluginDir, 'scripts/mcp-server.mjs'),
]) {
  await build({
    entryPoints: [join(root, 'src/mcp-server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Bundle pngjs & undici directly so the standalone MCP plugin runs with zero npm deps at startup;
    // playwright-core stays external and resolves from node_modules or ~/.dsh-game-studio/repo-root.
    external: ['playwright-core'],
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        'const require = __dshCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'warning',
  })
  await chmod(outfile, 0o755)
}

const client = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'warning',
})
const source = client.outputFiles[0].text
if (/__CLIENT_INTERNALS_DO_NOT_USE|__SECRET_INTERNALS_DO_NOT_USE/u.test(source)) {
  throw new Error('Client bundle contains React internals; host React must remain external')
}
await writeFile(join(root, 'lib/client.js'), [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source,
  'return module.exports; } });',
  '',
].join('\n'))

// Game runtimes a project can ask for in game.json `runtime`. Exported games
// cannot reach the network, so each is bundled into one classic script that
// the game build inlines ahead of game.js.
const three = JSON.parse(await readFile(join(root, 'node_modules/three/package.json'), 'utf8'))
await build({
  stdin: { contents: "import * as THREE from 'three'; window.THREE = THREE;", resolveDir: root, loader: 'js' },
  outfile: join(root, 'lib/vendor/three.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  legalComments: 'none',
  banner: { js: `/* three.js ${three.version} | MIT License | Copyright 2010-2025 three.js authors | https://threejs.org/ */` },
  logLevel: 'warning',
})
await writeFile(join(root, 'lib/vendor/three.LICENSE.txt'), await readFile(join(root, 'node_modules/three/LICENSE'), 'utf8'))

// Keep plugins/game-studio self-contained when Codex copies it into ~/.codex/plugins/cache/...
await rm(join(pluginDir, 'template'), { recursive: true, force: true })
for (const tpl of ['collector', 'voxel']) {
  await mkdir(join(pluginDir, 'template', tpl), { recursive: true })
  for (const item of ['game.js', 'game.json', 'assets']) {
    await cp(join(root, 'template', tpl, item), join(pluginDir, 'template', tpl, item), { recursive: true })
  }
}
await cp(join(root, 'lib/vendor/three.js'), join(pluginDir, 'vendor/three.js'))
await cp(join(root, 'lib/vendor/three.LICENSE.txt'), join(pluginDir, 'vendor/three.LICENSE.txt'))
await cp(join(root, 'icon.svg'), join(pluginDir, 'assets/icon.svg'))
await cp(join(root, 'LICENSE'), join(pluginDir, 'LICENSE'))

console.log(
  `built lib/index.js, lib/client.js, lib/mcp-server.js, plugins/game-studio/scripts/mcp-server.mjs and vendor/three.js (three ${three.version})`,
)
