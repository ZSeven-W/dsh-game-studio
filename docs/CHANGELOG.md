# Changelog — WeChat mini-game publish target

Everything this branch adds on top of upstream Game Studio, newest first. Each entry
names the commit it came from (`git show <hash>`); the branch is 64 commits on
`93459aa`.

## Release materials and docs

- Chinese/English release materials: the same RELEASE.md carries an English summary
  that repeats the title, rating, round length, monetization mode and ad unit IDs (8e4d4ac).
- A fresh export embeds the same draft rating (8+) the materials use, so the title
  badge cannot disagree with the release document (follow-up to 47621d6).
- The data section lists all ten reported events instead of the eight we remembered;
  an unregistered event is dropped silently by WeChat (9c0057b).
- The pre-launch section tells the user to self-check `__wechatRuntime.summary()` in
  the console before submitting (1ba4e95).
- The monetization section mirrors the real configuration and says where the numbers
  come from after launch (b6763fa, 6490e58).
- The review notes describe this game, not the template (20f5e33).
- The privacy section answers the self-check instead of leaving it to the reader (eab5a23).
- The materials list the analytics events the user must register first (2b18f34).
- Requirement → implementation → test map, checked in CI (`npm run trace`) (687e34e).
- The README points at the release checklist and the requirement map (fe39876).

## Verification and checks

- Clean-clone, published-package and installed-build checks: `npm run installed`,
  the tarball unpack check and the clean-clone drill are documented in the workspace
  (72267e8).
- Nightly upstream drift job applies, builds and tests the series on current upstream
  (d353dc1, 49e1850).
- Acceptance is a regression gate: one failing game no longer hides the report, and
  `ACCEPTANCE_FORCE_FAIL=1` rehearses the failure path (8083402, 43d88b9).
- Acceptance proves the demo purchase and that materials match the export (6c17dc5, 00a233e).
- Sidebar guards: copy and panels (fce0cd3), panel JSON contract (6c24fe6), action/op
  contract with the host (78cdc77), the built bundle loading and registering tabs (13d64f2).
- Cold start and wrong order: a brand-new game exports; upload/preview/CI before an
  export explain the missing step (153845e, df99687).
- The launch wizard is walked step by step, with no dead ends (e5f967e).
- The error-code table and the codes in the sources are checked both ways (8d440d5).
- Chinese copy is checked for half-width punctuation and broken characters (5dba7af).
- The materials sections are checked for numbering gaps, empty bodies and stale
  "第 N 节" references (42890b2).
- Performance: `npm run bench` records fps, boot time and memory warnings per device
  tier (75c9b9d).
- Sidebar screenshots are rendered from the real client source (bfaf566).

## Monetization

- Ads are never forced and carry the data that proves it (63324ee).
- In-app purchases sit behind the licence gate, with an honest dry-run (47db738).
- Every ad failure gets a code and a fix a non-coder can act on: 1000–1008 (33f3f40).
- The sidebar has a monetization panel (3f1117c).
- Pre-submission risk check with the usual rejection reasons (235d1a8).

## Publish flow

- The launch wizard and materials (544b6ff, f3b399f).
- The mini-program (ICP) filing is its own step (effea79).
- DevTools CLI automation: open, preview, upload, with `--info-output` reading the
  compiled package sizes back (edc3738, 42ee89d).
- A WeChat upload CI workflow generated into the export (0228c40).
- `/game-studio` explains itself instead of answering a typo with one line (8957262).

## Runtime and quality

- Device-aware render scale, package budget, fps/boot metrics and realtime error
  logging (9a60781, 2e89ca7).
- Memory warnings are handled instead of ignored (1d98987).
- Realtime log folding keeps the first entry during an error storm (6d6701f).
- Landscape safe-area side inset is respected (81da7d1).
- The age-rating notice is shown inside the game (47621d6).
- Sound effects play through InnerAudioContext (f9e295a).
- Large slot art goes into an assets subpackage (e3c084c), and the 4 MB main-package
  check no longer counts that art (40ce4cb).
- Session ledger makes the event plumbing observable before launch (8d3276c).

## Export

- WeChat mini-game export as a publish target (6c30d43).
- 3D three.js games export with the engine inlined (520a2a3); WebGL frames are
  composited and the DOM HUD is redrawn on canvas (81106d3).
- A malformed AppID and misspelt actions are refused instead of guessed (4c61dc7).

## Upgrading from the plain Game Studio build

Behaviour changes worth knowing when you rebuild an existing export:

- Mini-game purchases now call `wx.requestMidasPaymentGameItem`; the mini-program
  `wx.requestVirtualPayment` is only a fallback (d1d3894).
- `game.json` uses `subpackages` with a `root` that ends in a slash, per the official
  schema (4d56fec).
- The materials and the game now carry the age rating (47621d6); re-export and rebuild
  to see the badge on the title screen.
- The event list grew to ten (9c0057b): register `game_ad_error` and
  `game_memory_warning` as well, or those dashboards stay empty.
- The package report no longer counts subpackage art as main package (40ce4cb), so a
  previously "over the 4 MB limit" 3D export may now pass.
