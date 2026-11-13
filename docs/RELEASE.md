# Release checklist (maintainers)

The plugin ships as one npm package; the WeChat target has no separate artefact.
Run this before tagging a release or opening a pull request.

## Sidebar controls this guide refers to

| Sidebar button | What it does |
| --- | --- |
| **Export WeChat mini-game** | Writes the importable project under `export/wechat/<slug>/`; pass the real AppID here |
| **Launch wizard** | The 15–17 step checklist with owners, blockers and the next action |
| **Write release materials** | Writes `RELEASE.md` (copy-paste texts) next to the export |
| **Pre-review check** | Writes `REVIEW.md` (the 12 rejection reasons and this project's risks) |
| **Check environment** | Reports CLI, service port and AppID blockers without opening the IDE |
| **Preview QR** | Shows the device QR the IDE generated |
| **Upload version** | Uploads the typed version through the IDE CLI |
| **Monetization** | Ad unit IDs, IAP gate and analytics switch |

## 1. Build and test

```sh
npm ci
npm run build
npm test            # 260 tests; 49 fail on a Windows box without gh/cloudflared/Codex
npm run acceptance  # 39 checks; browser checks skip when no Chrome is installed
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
| Sidebar export button, wizard, monetization panel (bundle loads, tabs register) | `test/client.test.mjs`, `test/client-runtime.test.mjs` | — |
| Materials match the exported game (ad units, rating, round, events) | `test/consistency.test.mjs` | ✅ (`materials match the export`) |
| Demo purchase runs without a signing endpoint | `test/wechat.test.mjs` | ✅ (`demo purchase returns dryRun`) |

向导步骤数随变现方式变化：不变现 15 步，广告或内购 16 步，两者 17 步；`wechat-release status` 的 `total` 始终是当前计划的步数，已完成的旧步骤在切换回来时仍保留。

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

Then verify with the installed build, not the source tree: `npm run installed` boots the
installed plugin

`npm run bench` records frame rate, boot time and memory warnings for the 2D and 3D
exports (`BENCH_TIER=low` for the low-end profile; headless WebGL is software, so
treat the 3D number as a lower bound)., creates a game, exports it, runs the wizard/materials/review and boots
the exported game in the mock-wx harness (10 checks; `--path` for another install).

## 5. Upstream

```sh
npm run upstream   # is upstream still at the base commit, and does the series still apply?
npm run upstream -- --build   # also apply the series in a worktree, build it and run the WeChat tests there
npm run upstream -- --json --no-apply   # fast: fork vs upstream only, no worktree (used by the contract test)

A failure drill checks the acceptance report itself: run `ACCEPTANCE_FORCE_FAIL=1 npm run acceptance`
(it must finish every check, write REPORT.md with the failing row, and exit 1).

Expected output when the fork is healthy:

```text
upstream origin/main: up-to-date
  series    applies cleanly
  build     ok
  tests     90 pass, 0 fail, 0 skipped
  pack      ok (468 KB, 40 files)   # sources/tests/docs never enter the tarball

`--no-apply` skips the worktree and reports only the fork/upstream relationship
(fast, used by the contract test). `--build` exits non-zero when the series does not apply, the build fails, the
WeChat tests fail, or the packed artifact is unclean.    # the count grows as tests are added; 0 fail is the check
```

CI runs the same command nightly (`.github/workflows/upstream-drift.yml`); in a GitHub fork origin
is the fork, so the workflow adds the original repository as `upstream` and passes `--remote upstream`.
The job keeps `artifacts/upstream-drift/report.json` (status, seriesBytes, applied, build, test
counts) as an `upstream-drift` artefact even when it fails.

When the series conflicts, the check prints a copy-pasteable recovery line and records it as
`recovery` in the report:

```
next  git rebase --onto <upstream-12> <base-12> main  # then resolve src/index.ts and rerun npm run upstream -- --build
```
git format-patch 93459aa..HEAD -o ../artifacts/upstream-pr --no-signature
```

Apply the series in a clean worktree at the base commit and compare tree hashes
before opening the PR; `docs/upstream/wechat-minigame.md` is the PR body.

## Upgrade notes

See `docs/CHANGELOG.md` → "Upgrading from the plain Game Studio build" before rebuilding an
export made by an earlier build: the purchase API, the `subpackages` schema, the age
badge, the ten analytics events and the subpackage-aware package budget all changed.

## 6. Error codes on the WeChat path

Every failure the WeChat tools raise carries a code, and each code names the fix in
its message. This table is checked against the sources (`test/codes.test.mjs`): a
code that exists but is not listed fails the suite, and so does a listed code that
no longer exists.

| Code | When it appears | What the user does |
| --- | --- | --- |
| `APPID_INVALID` | The AppID passed to the export is not `wx…` and not `touristappid` | Copy the AppID from 后台「设置 → 基本设置」 |
| `NO_BROWSER` | The export needs Chrome or Edge to rasterise SVG art | Install one, or use PNG art |
| `NO_WECHAT_EXPORT` | A WeChat step ran before the export | Run the WeChat export first |
| `DEVTOOLS_PORT_CLOSED` | The IDE's service port is off | 工具 → 设置 → 安全设置 → 服务端口 → 开启 |

If DevTools is installed somewhere unusual, pass its CLI path with the `cli` parameter (tools and
`/game-studio wechat-devtools` both accept it). Before the first preview, run `wechat-devtools` with `op: "doctor"`: it reports whether the CLI is found, the service port answers and the project carries a real AppID, each with the fix. It never changes the IDE setting.
| `DEVTOOLS_BAD_APPID` | The project still uses `touristappid` | Re-export with the real AppID, then upload |
| `DEVTOOLS_NOT_LOGGED_IN` | The IDE is not signed in | Open it once and scan the QR code |
| `NO_DEVTOOLS` | The IDE or its CLI cannot be found | Install WeChat DevTools |
| `DEVTOOLS_FAILED` | The IDE returned another error | Read the IDE output included in the message |
| `CI_NEEDS_APPID` | CI files were requested for a tourist AppID | Re-export with the real AppID |
| `BAD_AD_UNIT` | An ad unit ID is not `adunit-…` | Copy it from 流量主 → 广告位管理 |
| `BAD_RELEASE_STEP` | A wizard step id does not exist | Use the ids from `wechat-release status` |
| `BAD_RELEASE_STATUS` | A step status is not todo/done/skipped | Use todo, done or skipped |
| `BAD_RELEASE_STATE` | .studio/wechat-release.json cannot be parsed or is not a release state | It was moved aside as *.corrupt-<time>.json; fix or delete it, then retry |
| `EMPTY_REJECTION` | action=rejection was called with no reason | Paste the console rejection text, then record the step again |
| `EXPORT_DIR_BUSY` | The export folder is still open in WeChat DevTools | Close the project in the IDE (or quit DevTools), then export again |
| `BAD_COMMERCE_STATE` | .studio/wechat-commerce.json cannot be parsed or is not a commerce state | It was moved aside as *.corrupt-<time>.json; recreate the ad unit config |
| `BAD_ACTION` | The command action is not one of the known ones | Run `/game-studio` with no action for the list |

## 7. What a release must not claim

- That a game passed WeChat review, filing or licensing — only the console decides.
- That ads or in-app purchases earn anything; the plugin proves they are wired.
- That 3D runs at 60 fps on every phone; the tier caps the render scale, nothing more.
