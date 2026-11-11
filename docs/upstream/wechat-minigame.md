# WeChat mini-game export target

This series adds a third publish target to the plugin, next to the self-contained
HTML export and GitHub Pages: a **WeChat mini-game project** that the user imports
into WeChat DevTools and publishes from the WeChat console.

The plugin's positioning does not change. The game is still made, built, played
and art-swapped exactly as before; WeChat is another output of the same project,
and the original HTML export, playtests, game wall and GitHub Pages paths are
untouched.

Base commit: `93459aafc9436d66364f05b804a7841d399c2594` (current `main`).

## What the user gets

1. **One click in the sidebar** — 导出微信小游戏 writes
   `<game>/export/wechat/<slug>/` with `game.js`, `game.json`,
   `project.config.json`, `assets/*.png` and a README.
2. **2D and 3D** — the collector template and voxel/three.js games both export.
   three.js is inlined into `game.js`; the game's own `game.js` is appended
   byte-for-byte unchanged.
3. **A wx.* runtime adapter** — mini-games have no DOM and one on-screen canvas,
   so the adapter provides `window`/`document`/`Image`/`localStorage`/pointer
   events on top of `wx.*`, composites WebGL frames onto the screen canvas, and
   redraws the HUD, title card and result card from `window.__gameState()`.
4. **DevTools CLI automation** — open / preview / upload through the IDE's own
   CLI, with the service-port requirement explained instead of silently failing.
5. **A launch wizard** — 14 steps from registering the mini-game to publishing it,
   each with an owner (WeChat console / plugin / user), prerequisites, and a
   persistent status file; it writes `RELEASE.md` (copy-paste console texts) next
   to the export.
6. **A pre-review check** — `REVIEW.md` lists the 12 reasons mini-games actually
   get rejected and which of them this project is heading for.
7. **Commercialization** — ad unit IDs (one interstitial between rounds, a
   rewarded video only when the player taps 看广告复活, never forced), and in-app
   purchases behind a licence + merchant gate.
8. **Quality** — package report against the 4 MB / 30 MB limits, render scale
   capped by device benchmark, boot/fps metrics, and crash reporting to
   `wx.getRealtimeLogManager`.

## Commits

One small commit per change, so a reviewer can take them apart; the patch series in
`artifacts/upstream-pr/` is the authoritative list (and the count grows with every
review fix, so it is not quoted here).
The capabilities, in order:

1. export target (2D adapter, tool, sidebar button, tests, docs)
2. 3D three.js support (engine inlined, runtime order)
3. WebGL compositing and the canvas HUD
4. WeChat DevTools CLI automation
5. launch wizard and `RELEASE.md`
6. the sidebar wizard panel
7. advertisements and analytics
8. the pre-review checklist (`REVIEW.md`)
9. in-app purchases behind the licence gate
10. package budget and device-aware render scale
11. boot/fps metrics and realtime error logging
12. the sidebar monetization panel
13. CI upload kit
14. automatic assets subpackage

Version bumps ride along with the feature commit that needed them, matching the
repository's existing `release: 0.1.0-rc.N` convention.

## Compatibility and risk

- **No new runtime dependencies.** `playwright-core` (already a dependency, used
  by the playtests) rasterises SVG slot art, and three.js is the already-vendored
  engine. No network access is added to the plugin.
- **Existing behaviour is untouched.** `game_studio_export`, playtests, the game
  wall, `game_studio_publish`, share links and every existing tool keep their
  signatures; the new work is additive.
- **Game code is never rewritten.** The exporter concatenates
  `adapter → (three.js) → window.GAME → game.js`; the original `game.js` bytes are
  preserved.
- **Everything optional is feature-detected.** Ad, payment and realtime-log APIs
  are used only when present; a base library without them plays the game.
- **3D needs WebGL2** (three.js r187 requirement). The adapter shows a readable
  card on devices without it instead of a black screen; 2D has no such
  requirement.
- Size: the new Host code is ~120 KB of source; the exported project for the 3D
  template is ~860 KB, well inside WeChat's 4 MB main package.

## Testing

- `npm test`: 240 tests, 187 pass. The 49 failures are environmental on this
  Windows machine and identical before this series (no `gh` CLI, no `cloudflared`,
  Codex CLI tests, path-separator assertions); 4 tests skip without a browser.
- New suites: `test/wechat.test.mjs` (23), `test/devtools.test.mjs` (6),
  `test/release.test.mjs` (7), `test/commerce.test.mjs` (4),
  `test/review.test.mjs` (7), `test/size.test.mjs` (6), `test/ci.test.mjs` (3),
  `test/consistency.test.mjs` (3), `test/journey.test.mjs` (2), plus Host-level
  contracts in `test/host.test.mjs` (47).
- Contract and documentation guards: `test/codes.test.mjs` (error-code table and
  sources agree), `test/claims.test.mjs` (no over-promising copy, boundaries stay),
  `test/copy.test.mjs` (Chinese punctuation), `test/changelog.test.mjs` (every
  entry names a real commit), `test/releasing.test.mjs` (the release checklist),
  `test/workflows.test.mjs` (CI evidence and the nightly drift job),
  `test/client-runtime.test.mjs` (the built sidebar bundle loads and registers
  its tabs), `test/journey-user.test.mjs` (the whole user journey in order),
  `test/devtools-doctor.test.mjs` (CLI/port/AppID diagnosis),
  `test/devtools-command.test.mjs` (upload through a fake CLI marks the wizard
  step), `test/ci-upload.test.mjs` (the generated upload script runs).
- Browser tests boot the **exported** project in a mock `wx.*` environment in
  headless Chrome: 2D and 3D boot, WebGL compositing, HUD, one interstitial, a
  rewarded revive, both IAP modes, render-scale tiers, and metrics/error logging.
- Manually verified against three real projects: `man-100-floors` (custom 2D),
  the collector template, and a voxel game (`lantern-isle-3d`, 860 KB, boot 426 ms
  in the harness).

## Boundaries

- The plugin does not replace WeChat review, filing (备案) or legal compliance;
  it guides, checks and records, and says so in every generated document.
- In-app purchases need a game licence (版号), a merchant ID and a server that
  signs orders. The plugin ships the client skeleton and never signs or collects
  money; without a signing endpoint the flow runs in an explicit demo mode.
- Ads only show with real ad unit IDs; the plugin never claims a game is allowed
  to monetize.

## Review order

1. `src/wechat.ts` and `src/wechat-runtime.js` (the new target and adapter).
2. `src/devtools.ts`, `src/release.ts`, `src/review.ts`, `src/commerce.ts`,
   `src/size.ts` (the new capabilities, each self-contained).
3. `src/index.ts` tool/command wiring and `src/client/index.tsx` (one button and
   one panel).


