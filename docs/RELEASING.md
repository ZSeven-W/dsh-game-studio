# Releasing @zseven-w/dsh-game-studio

How to ship a new build of this fork, in order. The order matters: nothing is
packed until the checks pass, and nothing is installed until the tarball exists.

## 0. Evidence index

`node artifacts/evidence-index.mjs` lists every evidence class (acceptance,
sidebar shots, rehearsal, clean clone, package, upstream drill, upgrade drill,
bench, GUI mount, patch series, snapshot) with its file, freshness and status. It
fails when one is missing, so run it before touching the version. The workspace also
has `node artifacts/entry-check.mjs`, which checks that every sidebar control is
mentioned in the user documents (it fails when a button is renamed but the docs are not).

## 1. Decide the version

`0.1.0-rc.N` — one increment per shipped change. Documentation-only changes need
no bump; anything that changes `lib/` does.

```sh
cd dsh-game-studio-fork
npm version 0.1.0-rc.73 --no-git-tag-version   # the next increment
```

## 2. Build and run the local gates

```sh
npm run build
npm test                            # baseline: 49 environment failures on Windows
npm run acceptance                  # 39 checks, must be 0 failed
npm run shots                       # sidebar screenshots, 0 page errors
npm run trace                       # requirement → test references
```

A red `npm test` means stop: the 49 known failures (no `gh`, no `cloudflared`,
no Codex CLI, Windows paths) are the only acceptable ones. A new name in the
failure list is a regression.

## 3. Pack and inspect the artefact

```sh
npm pack --pack-destination ../artifacts
node ../artifacts/package-check.mjs   # unpack, install runtime deps, smoke test
node ../artifacts/repro-check.mjs     # clean clone: build + tests + acceptance + shots
```

The package check must show 10/10 on the unpacked tarball; the clean-clone check
must report the same test counts as this checkout.

## 4. Install into the DSH profile

Use the plugin manager tool (not a hand-edited profile):

```
plugin_manager install_bundle file:<absolute path to the .tgz>
```

Then verify what DSH actually loads:

```sh
npm run installed
```

It must be 10/10, including "the exported game boots on a mocked wx".

## 5. Regenerate the upstream series

```sh
git format-patch 93459aa..HEAD -o ../artifacts/upstream-pr --no-signature
git diff 93459aa..HEAD > ../artifacts/upstream-pr/wechat-minigame.diff
npm run upstream -- --build
```

The series must apply cleanly, build, and pass the WeChat tests in the applied
worktree (61 on the current series; it grows as tests are added). `--build` creates its own worktree; a clean
`git status` afterwards is part of the check.

## 6. Update the documents that quote numbers

- `docs/TRACEABILITY.md` — new tests must appear as evidence.
- `docs/CHANGELOG.md` — new user-visible changes, with the commit hash.
- `docs/upstream/wechat-minigame.md` — the PR body: refresh the test counts and the
  commit count when they change.
- workspace `artifacts/交付说明.md`, `V4.0-progress.md`, `验收对照.md`,
  `下一步待办.md` — version, patch count, test count, acceptance count, trace count.
- `node ../artifacts/status-check.mjs` and `node ../artifacts/audit-docs.mjs`
  must both pass; they compare the documents with the repository.
- `node ../artifacts/audit-cross.mjs` must pass: every "部分/未证" acceptance item
  has a residual-risk row.

## 7. Commit

One commit per logical change, message states what broke and what now guards it.

```sh
git add -A
git commit            # no tag: the branch is a patch series, not a release tag
```

## Failure drill

Before trusting the release, break it on purpose once:

```sh
ACCEPTANCE_FORCE_FAIL=1 npm run acceptance   # must exit 1, still write REPORT.md
```

If the report is missing or the exit code is 0, the evidence chain is broken and
the release must not go out.
