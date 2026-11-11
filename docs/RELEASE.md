# Release checklist (maintainers)

The plugin ships as one npm package; the WeChat target has no separate artefact.
Run this before tagging a release or opening a pull request.

## 1. Build and test

```sh
npm ci
npm run build
npm test            # 159 tests; 49 fail on a Windows box without gh/cloudflared/Codex
npm run acceptance  # 21 checks; browser checks skip when no Chrome is installed
npm run trace       # the requirement→evidence table still points at real tests
```

`npm test` is the source of truth for behaviour. On a machine without `gh`,
`cloudflared` or the Codex CLI the publish/tunnel/codex tests fail for
environmental reasons — compare the failing names with a run on a clean `main`
before blaming the change. `npm run acceptance` is the end-to-end guard for the
WeChat target and writes `../artifacts/acceptance/REPORT.md`.

## 2. WeChat-specific regression list

These are the capabilities a release must not lose. Each has a test; the
acceptance run covers most of them end to end.

| Capability | Test | Acceptance |
| --- | --- | --- |
| 2D export boots and plays | `test/wechat.test.mjs` | ✅ |
| 3D export (three.js inlined, WebGL composited) | `test/wechat.test.mjs` | ✅ (`renders through WebGL`) |
| HUD / title / result cards redrawn on canvas | `test/wechat.test.mjs` | screenshot |
| Ads: one interstitial, rewarded revive, analytics | `test/wechat.test.mjs` | ✅ (`no ad is forced at boot`) |
| IAP: licence gate, demo mode, pay server call | `test/wechat.test.mjs` | — |
| Package report and subpackage | `test/size.test.mjs`, `test/wechat.test.mjs` | ✅ |
| Device tier caps the render scale | `test/wechat.test.mjs` | ✅ (`device tier reported`) |
| Audio through InnerAudioContext | `test/wechat.test.mjs` | ✅ (`audio plays a tone`) |
| Boot metrics and realtime error logging | `test/wechat.test.mjs` | ✅ |
| DevTools CLI error mapping | `test/devtools.test.mjs` | — |
| Launch wizard + RELEASE.md | `test/release.test.mjs`, `test/journey.test.mjs` | ✅ |
| Pre-review risks | `test/review.test.mjs` | ✅ |
| CI upload kit | `test/ci.test.mjs` | — |
| Sidebar export button, wizard, monetization panel | `test/client.test.mjs` | — |
| Materials match the exported game (ad units, rating, round, events) | `test/consistency.test.mjs` | ✅ (`materials match the export`) |
| Demo purchase runs without a signing endpoint | `test/wechat.test.mjs` | ✅ (`demo purchase returns dryRun`) |

## 3. Version and package

```sh
npm version 0.1.0-rc.N --no-git-tag-version
npm run build
npm pack --pack-destination ../artifacts
```

The plugin manager treats an unchanged version as already installed, so the
version must move before a local install picks up new code.

## 4. Install into the desktop profile

Use the Harness plugin manager (the `dsh` CLI refuses the desktop profile):

```text
plugin_manager install_bundle  file:<abs path to the tarball>
```

Then verify with the installed build, not the source tree: run
`artifacts`-style verification or re-run the acceptance script against an export
produced by the installed plugin.

## 5. Upstream

```sh
npm run upstream   # is upstream still at the base commit, and does the series still apply?
npm run upstream -- --build   # also apply the series in a worktree, build it and run the WeChat tests there

Expected output when the fork is healthy:

```text
upstream origin/main: up-to-date
  series    applies cleanly
  build     ok
  tests     58 pass, 0 fail, 0 skipped
```

CI runs the same command nightly (`.github/workflows/upstream-drift.yml`); in a GitHub fork origin
is the fork, so the workflow adds the original repository as `upstream` and passes `--remote upstream`.
git format-patch 93459aa..HEAD -o ../artifacts/upstream-pr --no-signature
```

Apply the series in a clean worktree at the base commit and compare tree hashes
before opening the PR; `docs/upstream/wechat-minigame.md` is the PR body.

## 6. What a release must not claim

- That a game passed WeChat review, filing or licensing — only the console decides.
- That ads or in-app purchases earn anything; the plugin proves they are wired.
- That 3D runs at 60 fps on every phone; the tier caps the render scale, nothing more.
