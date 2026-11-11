# 需求 → 实现 → 证据对照（V4.0）

这份表把需求文档逐条映射到代码和可执行证据。`npm run trace` 会校验表里引用的文件与测试名真实存在，
所以这张表本身不会随重构悄悄失效。
约定：
- 测试引用写成 `test/<文件名>.mjs::<测试名前缀>`；
- 命令引用写成 `cmd:npm run <script>`；
- 实现/文档引用写成仓库内路径（反引号包裹）。

状态：✅ = 有实现且有可执行证据；⚠️ = 有实现，证据部分依赖外部环境；⛔ = 需要外部账号/资质。

## 一、定义

| 需求 | 实现 | 证据 |
| --- | --- | --- |
| 以能跟随上游更新的插件形态交付 | `docs/upstream/wechat-minigame.md`、`docs/upstream/README.md` | `cmd:npm run upstream` |
| 不做独立项目 | 全部能力在 `src/wechat.ts` 等插件模块内，导出产物写在游戏工程 `export/wechat/` 下 | `test/wechat.test.mjs::export writes an importable` |
| 优先上游可合并补丁 | 24 个独立提交，每个可单独构建 | `cmd:npm run upstream` |
| 原插件照常升级 | 只新增文件与工具，未改既有工具的签名 | `test/studio.test.mjs::create and build produce one self-contained HTML file` |

## 二、用户旅程

| 需求 | 实现 | 证据 |
| --- | --- | --- |
| 一句话生成/改造游戏，选 2D/3D 模板 | 插件原有能力（`game_studio_create`） | `test/host.test.mjs::/game-studio wechat-release` |
| 侧栏点「导出微信小游戏」；全新工程也能一次走通 | `src/client/index.tsx`、`src/index.ts` | `test/wechat.test.mjs::the exported 2D game boots`、`test/host.test.mjs::a brand-new game goes from create`、`test/host.test.mjs::WeChat actions called before the export` |
| 2D/3D 都支持 | `src/wechat.ts` 内联 three.js，按 runtime 决定顺序 | `test/wechat.test.mjs::the exported 3D game renders through WebGL` |
| 发布向导：注册、AppID、类目/名称、认证、适龄提示、资质（IAA/IAP）、版本审核、小游戏备案、小程序备案、发布 | `src/release.ts` 的 15 步清单 | `test/release.test.mjs::the plan is coherent and gates monetization steps` |
| 尽量自动调 DevTools CLI（打开/预览/上传） | `src/devtools.ts` | `test/devtools.test.mjs::devtoolsArgs builds the documented CLI calls` |
| 服务端口由用户授权 | 端口关闭时报 `DEVTOOLS_PORT_CLOSED` 并给出开启步骤 | `test/devtools.test.mjs::the IDE messages become coded errors with a fix` |
| 不能自动的标注「需在微信后台完成」 | 每步带 `owner`，侧栏以徽章显示 | `test/release.test.mjs::a fresh checklist starts at the console steps` |
| 上线后接广告 | `src/commerce.ts` + 运行时插屏/激励视频/埋点 | `test/wechat.test.mjs::a game with ads shows one interstitial` |
| 上线后接内购（合规前提） | 版号+商户号门禁、演示模式、签名服务调用 | `test/commerce.test.mjs::in-app purchases stay off until a licence` |
| 查看留存、收入、错误 | 埋点事件 + `wx.getRealtimeLogManager` 上报；侧栏给出后台入口说明 | `test/wechat.test.mjs::boot metrics are reported and runtime errors` |
| 插件给合规检查和常见驳回原因 | `src/review.ts` 的 12 条 + 本工程风险 | `test/review.test.mjs::the rejection list is complete` |

## 三、能力清单

| 需求 | 实现 | 证据 |
| --- | --- | --- |
| 导出：2D canvas + 3D three.js/voxel | `src/wechat.ts`、`src/wechat-runtime.js` | `test/wechat.test.mjs::a three.js project exports with its runtime inlined` |
| wx 适配（window/document/canvas/触摸） | 运行时适配层 | `test/wechat.test.mjs::the exported 2D game boots` |
| SVG→PNG | `src/wechat.ts` 用浏览器栅格化 | `test/wechat.test.mjs::SVG slot art is rasterised to PNG` |
| 纹理/包体 | `src/size.ts` 包体报告 | `test/size.test.mjs::an export over 4 MB is blocked` |
| 分包 | 素材 > 1.5 MB 自动 assets 分包 + 启动前预下载 | `test/wechat.test.mjs::large art goes into an assets subpackage` |
| AppID 可配 | 导出参数 `appid` 写入 project.config.json | `test/wechat.test.mjs::the AppID and the orientation reach project.config.json` |
| 安全区 | 运行时读取 `safeArea.top` 用于 HUD | `test/wechat.test.mjs::the exported 3D game renders through WebGL` |
| 触摸 | 触摸→pointer/touch 事件映射 | `test/wechat.test.mjs::the exported 2D game boots` |
| 音效 | WebAudio 子集→WAV→InnerAudioContext | `test/wechat.test.mjs::game sounds are synthesised` |
| 60fps / 低端机性能 | 设备档位限制渲染倍率与帧率上限 | `test/wechat.test.mjs::a weak device gets a capped render scale` |
| 启动/内存 | `metrics()` 给出 bootMs/frames/fps；内存告警记录、上报并触发 GC | `test/wechat.test.mjs::boot metrics are reported`、`test/wechat.test.mjs::a memory warning` |
| 隐私/适龄 | 向导步骤 + 材料模板 + 标题页适龄徽标（8+/12+/16+） | `test/release.test.mjs::materials are written next to the export`、`test/wechat.test.mjs::the age rating chosen` |
| 发布：向导、材料模板、状态记录 | `src/release.ts` | `test/release.test.mjs::marking steps moves progress and unblocks dependants` |
| 驳回原因 | `src/review.ts` | `test/review.test.mjs::the ICP filing is a warning` |
| DevTools CLI 自动化 | `src/devtools.ts` | `test/devtools.test.mjs::runDevtools captures the CLI output` |
| CI 上传 | `src/ci.ts` 生成 miniprogram-ci + Actions | `test/ci.test.mjs::the CI kit writes an upload script` |
| 商业化：广告、内购、埋点；材料与导出逐项一致 | `src/commerce.ts`、运行时、`src/release.ts` | `test/commerce.test.mjs::the exporter embeds the ad unit IDs`、`test/consistency.test.mjs::the release materials agree with what the exported game actually embeds` |
| 体验：小白按向导、失败有提示、步骤无死胡同 | 侧栏向导 + 编码错误（`DEVTOOLS_*`、`CI_NEEDS_APPID`、`BAD_AD_UNIT`） | `test/host.test.mjs::/game-studio wechat-commerce stores ad unit IDs`、`test/journey.test.mjs::a user can walk the whole wizard`、`test/host.test.mjs::/game-studio without an action explains itself`、`test/codes.test.mjs::every WeChat error code is documented` |
| 侧栏面板不静默消失、文案不缺 | `src/client/index.tsx`、`src/client/locales.ts` | `test/client.test.mjs::the WeChat export button`、`test/client.test.mjs::the sidebar only calls command actions` |

## 四、验收

| 需求 | 实现 | 证据 |
| --- | --- | --- |
| 至少 1 个真实 2D、1 个真实 3D 走完导出到上线 | 验收脚本从空目录建两个游戏并导出、启动、出材料 | `cmd:npm run acceptance` |
| 至少 1 个游戏合规接入广告或内购，能看到基础数据 | 模拟 wx 中实测插屏/激励视频/事件；真实数据需账号 | `test/wechat.test.mjs::a game with ads shows one interstitial` ⚠️ |
| 上游更新后微信能力不丢 | 补丁漂移检查 + 临时 worktree 应用验证 | `cmd:npm run upstream` |
| 原插件构建/试玩/HTML 导出/发布不受影响 | 既有测试全量保留 | `test/studio.test.mjs::create and build produce one self-contained HTML file` |
| 有文档和清单，小白不看代码能完成 | `docs/RELEASE.md`、`artifacts/需要你做的事.md`、每个工程的 RELEASE.md/REVIEW.md | `test/release.test.mjs::materials are written next to the export` |
| 关键步骤自动化，失败有可操作提示 | DevTools/CI/内购/广告的错误码与修复建议 | `test/devtools.test.mjs::a bogus CLI path is refused` |

## 五、边界

| 约定 | 实现 |
| --- | --- |
| 不替代审核/备案/法律合规 | 生成材料与 `REVIEW.md` 均写明「由微信决定」；`src/review.ts` |
| IAP 需要版号，IAA 需要备案 | 内购启用需版号+商户号，否则拒绝；向导与自查标注 |
| 3D 性能取决于机型 | 设备档位限制倍率，不承诺帧率；导出 README 说明 |
| 不承诺收入 | 文档与材料只声明「能接、能合规、能看数据」 |

## 需要外部条件的三项

| 项 | 卡点 |
| --- | --- |
| 真实上线（2D/3D 各一款可访问的小游戏） | 需要小游戏账号、真实 AppID、备案与资质 |
| 广告/内购的真实数据 | 需要流量主开通与真机运行 |
| 上游 PR 合入 | 需要 GitHub 凭据（补丁已就绪并验证） |
