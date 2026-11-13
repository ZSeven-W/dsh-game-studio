# When the materials, export and upload go stale

> For users: change something, then the sidebar says which step to redo. This page is
> the rule behind those lines.

## The rule

Four artefacts remember when they were produced and from what:

| Artefact | Made from | Becomes stale when | The sidebar says | Fix |
|---|---|---|---|---|
| `RELEASE.md` | wizard answers + monetization settings | an answer changes (AppID, name, category, age rating, monetization), or the ad units / licence / merchant / pay URL change | Materials are out of date — regenerate | Generate release materials |
| `REVIEW.md` | wizard answers | an answer changes | Review is out of date — regenerate | Run the self-review |
| `export/wechat/…` | `game.js`, `game.json`, answers, settings | the game or rules change, or an answer/setting changes | Export is out of date — export again | Export WeChat mini-game |
| the uploaded version | one export | a new export, or any of the changes above | The uploaded version predates your latest changes — upload again | Upload version |

Two states that are **not** stale: *never generated* (no stale badge, the button is
just available) and *file deleted* (材料文件已不在，请重新生成).

## What counts as a change

- **Answers**: AppID, name, category, age rating, monetization. Ticking a wizard step
  is **not** an answer change and never makes anything stale.
- **Files**: the monetization settings and the game sources are compared by
  modification time — newer than the artefact means stale.

## A typical sequence

```
change an ad unit
  -> materials stale + export stale
  -> Generate release materials: materials fresh, export still stale
  -> Export WeChat mini-game: export fresh, the uploaded version now stale
  -> Upload version: everything fresh again

edit game.js
  -> export stale (materials/review unaffected)
  -> re-export -> upload stale -> upload again

tick one wizard step
  -> nothing goes stale
```

## Where it shows up

- In the sidebar's launch-wizard header: 材料已过期 / 自查已过期 / 导出已过期 /
  已上传的版本早于当前改动;
- In `wechat-release status`: `materialsStale`, `reviewStale`, `exportStale`,
  `uploadStale` (plus `materialsPresent` / `reviewPresent` when a file was deleted);
- In `RELEASE.md` itself: the privacy and filing sections print their real status, so
  the document and the panel agree.

## What it does not decide

The plugin only keeps the documents consistent with your current configuration. It
does not judge whether the configuration will pass review, filing or make money —
that is WeChat's call.
