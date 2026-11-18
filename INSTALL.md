# Install and Start DSH Game Studio (`@zseven-w/dsh-game-studio`)

Give Codex, Claude Code, or Antigravity this prompt:

> Install and set up https://github.com/ZSeven-W/dsh-game-studio following its INSTALL.md, and verify the Game Studio MCP tools.

中文：

> 按照 https://github.com/ZSeven-W/dsh-game-studio 的 INSTALL.md 帮我安装并验证 DSH 游戏工坊插件。

---

## 1. DeepSeek Harness (DSH — includes Live Right-Sidebar UI)

```bash
dsh plugin add @zseven-w/dsh-game-studio
```

In DeepSeek Harness, DSH Game Studio provides both the 15 agent tools and the interactive right-sidebar preview, candidate art picker, QR sharing modal, and Game Wall shelf.

---

## 2. Codex (`codex plugin`)

### Instructions for the installing agent

1. Require **Node.js 22+**, **Git**, **Google Chrome or Microsoft Edge** (for headless `game_studio_playtest` & WeChat SVG rasterization), and a recent **Codex CLI** with `codex plugin marketplace` and `codex plugin add`.
2. Clone the repository to a persistent location, install dependencies (`playwright-core`), and run `npm run setup`:

   ```bash
   git clone https://github.com/ZSeven-W/dsh-game-studio.git
   cd dsh-game-studio
   npm install
   npm run setup
   ```

3. `npm run setup` (alias for `node scripts/install-hosts.mjs codex`) performs four verified steps:
   - Records the current Node executable and checkout path in `~/.dsh-game-studio/` so the Codex Desktop GUI app can launch the stdio MCP server and locate `playwright-core` even when GUI `PATH` differs from the terminal.
   - Registers this checkout as the `zseven-game-studio` local marketplace (`codex plugin marketplace add`).
   - Installs `dsh-game-studio@zseven-game-studio` (`codex plugin add dsh-game-studio@zseven-game-studio`).
   - Exercises Codex's real `codex app-server` plugin loader (`mcpServerStatus/list`) to verify `dsh_game_studio` loads all 15 tools (`game_studio_create`, `game_studio_build`, `game_studio_playtest`, `game_studio_generate_asset`, `game_studio_apply_asset`, `game_studio_revert_asset`, `game_studio_list`, `game_studio_export_wall`, `game_studio_export`, `game_studio_export_wechat`, `game_studio_upload_wechat`, `game_studio_versions`, `game_studio_restore_version`, `game_studio_share`, `game_studio_publish`) with zero `toolsError`.

---

## 3. Claude Code / Antigravity / Grok CLI

From the cloned `dsh-game-studio` repository, run the one-click host installer for your preferred coding agent:

```bash
node scripts/install-hosts.mjs claude   # Register .claude-plugin marketplace + install dsh-game-studio@dsh-game-studio + permissions
node scripts/install-hosts.mjs agy      # Register MCP server + game-studio skill in ~/.gemini/config/
node scripts/install-hosts.mjs grok     # Register [mcp_servers.dsh-game-studio] in ~/.grok/config.toml
node scripts/install-hosts.mjs all      # Install across Codex, Claude Code, Antigravity, and Grok
```

Run a health check on browsers, AI art providers, GitHub CLI, and WeChat DevTools CLI at any time:

```bash
npm run doctor
```

To uninstall cleanly:

```bash
node scripts/install-hosts.mjs uninstall-codex
node scripts/install-hosts.mjs uninstall-claude
node scripts/install-hosts.mjs uninstall-agy
node scripts/install-hosts.mjs uninstall-grok
```

---

## 4. Optional External Tools

- **AI Art Generation (`game_studio_generate_asset`)**: Either set `OPENAI_API_KEY` or sign in to the local `codex` CLI.
- **WeChat Mini Game Upload (`game_studio_upload_wechat`)**: Install [WeChat DevTools](https://developers.weixin.qq.com/minigame/dev/devtools/download.html) (enable **Settings → Security → Service Port**) or `@tencent/wechatide-cli`. Note: `game_studio_export_wechat` requires **no** WeChat CLI — it generates the complete `< 4 MB` `wx-minigame/` directory locally.
- **GitHub Pages Publishing (`game_studio_publish`)**: Install and sign in to GitHub CLI (`gh auth login`).
