---
name: game-studio
description: Build playable 2D Canvas and 3D Three.js WebGL games with @zseven-w/dsh-game-studio, verify with headless Chrome playtests (Web & WeChat Mini Game capsule simulation), generate transparent AI art, export < 4 MB WeChat Mini Game packages (`wx-minigame/`) with CLI upload, and publish to GitHub Pages.
---

# DSH Game Studio (`@zseven-w/dsh-game-studio`)

Use this skill whenever creating, iterating on, playtesting, skinning, exporting, or publishing a 2D or 3D browser game or **WeChat Mini Game (微信小游戏)**.

> **Workspace Path Rule (Codex / Claude Plugin Hosts)**: Always pass `workspaceDir` (set to your active project working directory) on every `game_studio_*` tool call so relative `path` resolves inside the user's workspace rather than the plugin cache.

## Core Workflow

1. **Create from a clean template (`game_studio_create`)**:
   - `"collector"` (default): 2D Canvas game (`720×1280` portrait or `1280×720` landscape).
   - `"voxel"`: 3D Three.js WebGL game with instanced blocks, procedural models (`MODELS`), shadows, and synthesized WebAudio.
   - Rename or define `slots` in `game.json` after the game's actual characters/props. If targeting **WeChat Mini Game**, give the game a pure simplified Chinese `title`.

2. **Edit single-source `game.js` & `game.json`, then build (`game_studio_build`)**:
   - Read `game.json` and `game.js` before editing.
   - Keep `window.__gameState()` (and `window.__autoplay(state)` for puzzle/card/match/management games not steered by arrow keys) so headless playtests exercise the real gameplay loop.
   - Check syntax (`node --check game.js`) and call `game_studio_build` with a concise version `note`.

3. **Verify visually in headless Chrome (`game_studio_playtest`)**:
   - Call `game_studio_playtest` (`rules: '{"duration": 4}'` for quick end-screen verification) instead of writing custom Playwright scripts.
   - Inspect the returned screenshots (`title`, `mid`, `end`, `characters`), FPS, and zero-error / zero-network-request checks.
   - When targeting **WeChat Mini Game**, pass `platform: "wechat"`: this injects `window.wx`, enforces the single-WebGL check, and draws WeChat's top-right `••• | ◎` capsule at `(291, 51)–(378, 83)` on screenshots so any top-right UI collision is immediately visible.

4. **Optional AI Art Skinning (`game_studio_generate_asset` → `game_studio_apply_asset`)**:
   - Generate candidate transparent sprites or backgrounds via `openai` (`OPENAI_API_KEY`) or `codex` (local Codex CLI).
   - Every sprite is automatically alpha-checked, cropped, and centered. Apply the chosen `#number` with `game_studio_apply_asset` (revertible via `game_studio_revert_asset`).

5. **WeChat Mini Game Dual-Target Architecture (`game_studio_export_wechat` & `game_studio_upload_wechat`)**:
   - **Single Canvas Only**: Real iOS/Android WeChat (`JSC`/`V8`) has **no HTML DOM renderer** (`<div>`/`<button>` overlays will not appear on phones) and **only 1 active WebGL context**. Draw all HUD/menus/modals either on 2D Canvas or on an offscreen 2D Canvas uploaded to a Three.js `CanvasTexture` ortho plane on the main `#game` WebGL canvas.
   - **Capsule Safe Area**: Read `(window.GAME.safeArea && window.GAME.safeArea.topHudY) || 88` so top-right buttons/timers stay below WeChat's native capsule.
   - **Zero-Interstitial IAA**: Never add forced pop-up or bottom banner ads. Bind voluntary reward buttons (revive, extra shuffle, 2× settlement coins) to `window.GAME.watchRewardedAd(slot, onReward)` — before 100 UV (`adUnitIds.default === ""`), it automatically grants free `"首发限免"` rewards with zero broken-ad errors.
   - **4.00 MB Main-Package Budget**: `game_studio_export_wechat` audits uploadable bytes against `4,194,304 B`, rasterizes `.svg` slots to `.png`, and writes `wx-minigame/WECHAT_SUBMISSION_DRAFT.md` (with the 5 mandatory MP qualification system descriptions and the official CADPA `8+` native splash screenshot rule).
   - **Experience QR Upload**: Once the user provides a real `wx...` AppID, call `game_studio_upload_wechat` (`version: "1.0.0"`, player-facing Chinese `desc`) to push directly to `mp.weixin.qq.com`.

6. **Live Preview & Permanent Publishing (`game_studio_share` / `game_studio_publish`)**:
   - Call `game_studio_share` to open a local LAN HTTP URL (or `public: true` via `cloudflared`) for immediate phone/browser testing.
   - Call `game_studio_publish` (requires signed-in `gh` CLI) when the user asks for a permanent GitHub Pages URL, or `game_studio_export_wall` for an offline multi-game arcade page.
