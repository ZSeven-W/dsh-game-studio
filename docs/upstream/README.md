# Upstream patch series

`wechat-minigame.md` is the pull-request description for the WeChat mini-game
target. The patch series itself is generated from the fork's history and applies
on top of upstream `main` at `93459aa` (the commit this fork started from, which
was still `main` when the series was produced):

```sh
git checkout -b wechat-minigame 93459aa
git am /path/to/artifacts/upstream-pr/*.patch
npm ci
npm run build
npm test
```

The regenerated series lives next to this repository, in
`artifacts/upstream-pr/`, because patches are build output and do not belong in
the source tree.

If upstream has moved, rebase instead of applying:

```sh
git checkout -b wechat-minigame origin/main
git cherry-pick 6c30d43^..2e89ca7   # or: git rebase --onto origin/main 93459aa main
```

The areas upstream is most likely to touch independently are
`src/client/index.tsx` (the sidebar keeps growing) and `README*.md`. Both are
touched by this series only additively (one button, one panel, new rows in the
feature and tool tables), so a conflict there should be a small textual merge.

## What is intentionally not in the series

- No new npm dependencies.
- No changes to the existing HTML export, playtests, game wall, share or publish
  paths.
- No version bump beyond the fork's own `0.1.0-rc.14`; upstream should pick the
  release number.
