# Agent Vault Sync

一个低成本、local-first 的跨 Agent 长期记忆与 Skill 复用工具。把 Vault 放在 iCloud Drive、OneDrive、Dropbox、Syncthing 或 NAS 同步目录中，Codex、Claude Code、Cursor、OpenCode、DeepSeek Harness、Gemini CLI、GitHub Copilot CLI 和 MiniMax Code 就能读写同一份记忆。

当前版本：`0.4.0`。**暂不提供加密，请勿保存密码、Token、私钥或其他机密。**

第一次使用建议先阅读：[《Agent Vault Sync 用户说明与使用手册》](docs/用户使用手册.md)。手册包含完整安装、跨电脑部署、各 Agent 接入、Skill 复用、命令参考、数据安全和故障排查。

## 它解决什么

- 跨电脑：同步普通文件，不运行中心服务器，不需要数据库服务。
- 跨 Agent：提供同一套 MCP 工具和 CLI，Agent 不绑定某一家模型。
- 离线可写：每次操作写入独立、不可变的 JSON 事件；恢复联网后由网盘同步。
- 冲突可合并：不同设备新增不会互相覆盖；同一记忆的并发修改用混合逻辑时钟确定性收敛。
- Skill 复用：Vault 中的 `skills/` 是唯一来源，按内容哈希复制到各 Agent 的 Skill 目录，兼容 macOS 和 Windows。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install
npm run build
npm link
```

`npm link` 后会得到全局命令 `agent-vault`。开发时也可以使用 `node dist/cli.js`。

### Windows 单文件 EXE

Windows x64 用户可以直接使用 `release/AgentVault.exe`，目标电脑不需要安装 Node.js 或 npm。

建议先把 EXE 放到不会移动的固定位置，例如：

```powershell
$folder = "$env:LOCALAPPDATA\AgentVault"
New-Item -ItemType Directory -Force $folder
Copy-Item .\AgentVault.exe "$folder\AgentVault.exe"
Set-Location $folder
.\AgentVault.exe --version
```

双击 `AgentVault.exe` 会启动本机可视化控制台；命令行参数与 `agent-vault` 相同。Agent MCP 配置会保存这个 EXE 的绝对路径，因此接入 Agent 后不要随意移动或删除它；如果移动过，重新点击界面中的“刷新”。

当前 EXE 是 Windows x64、未使用商业代码签名证书。Windows 可能显示“未知发布者”，请先核对项目提供的 SHA-256，不要关闭系统级安全防护。

## 5 分钟开始

macOS + iCloud Drive：

```bash
agent-vault init "$HOME/Library/Mobile Documents/com~apple~CloudDocs/AgentVault"
agent-vault agents install codex claude cursor opencode deepseek-harness gemini copilot minimax-code
agent-vault remember "用户偏好简洁的中文回答" --kind preference --scope global --tag language
agent-vault recall "中文偏好"
```

Windows PowerShell + OneDrive：

```powershell
agent-vault init "$env:UserProfile\OneDrive\AgentVault"
agent-vault agents install all
agent-vault remember "This project uses pnpm" --kind decision --scope project --scope-id my-project
agent-vault recall "package manager"
```

NAS 只需换成已挂载目录，例如 `/Volumes/HomeNAS/AgentVault` 或 `Z:\AgentVault`。每台电脑安装一次 CLI，然后运行 `agent-vault use <同一个同步目录>` 和 `agent-vault agents install ...`。

安装配置后重启对应 Agent。程序修改已有配置文件前会在同目录生成带时间戳的备份；卸载只删除 `agent-vault` 自己的节点或标记块：

```bash
agent-vault agents uninstall codex
```

## 常用命令

```bash
agent-vault status
agent-vault agents detect
agent-vault list --limit 20
agent-vault context "当前项目的技术约束"
agent-vault update <id> --content "新的内容"
agent-vault forget <id>
agent-vault skills list
agent-vault skills sync all
agent-vault vaults list
agent-vault vault migrate "/source/AgentVault" "/target/AgentVault"
```

## 可视化控制台

运行下面的命令，会在默认浏览器打开仅限本机访问的控制台：

```bash
agent-vault ui
```

控制台可以：

- 显示当前 iCloud、OneDrive、Dropbox、Syncthing、NAS 或本地 Vault 路径。
- 检查 Vault 是否有效、是否可读写，以及记忆、事件和 Skill 数量。
- 显示 Codex、Claude Code、Cursor、OpenCode、DeepSeek Harness、Gemini CLI、Copilot CLI、MiniMax Code 的检测与连接状态。
- 通过按钮接入、刷新或断开单个 Agent。
- 使用 macOS/Windows 原生目录选择器连接现有 Vault，或初始化新 Vault。
- 保存多个 Vault，并在 iCloud、OneDrive、NAS 等独立 Vault 之间切换。
- 手动把源 Vault 的记忆事件和 Skill 安全合并到目标 Vault，不删除源数据或覆盖冲突。
- 切换时自动刷新已接入 Agent，并在控制台运行时每 15 秒同步共享 Skill。

控制台只监听 `127.0.0.1`，API 使用随机会话令牌，不会把管理界面暴露到局域网。使用指定端口或不自动打开浏览器：

```bash
agent-vault ui --port 47831 --no-open
```

所有命令都可以用 `--vault <目录>` 临时指定 Vault；也可以设置 `AGENT_VAULT_PATH`。本机状态默认位于 `~/.agent-vault-sync/state.json`，可用 `AGENT_VAULT_HOME` 修改。

## MCP 工具

适配器会把下面的 stdio MCP Server 写入 Agent 配置：

- `memory_remember`
- `memory_recall`
- `memory_list`
- `memory_get`
- `memory_update`
- `memory_forget`
- `memory_context`
- `vault_status`
- `skill_list`

也可以直接运行：

```bash
agent-vault mcp --vault "/path/to/AgentVault"
```

## Agent 适配

| Agent | MCP 配置 | Skill 目录 |
|---|---|---|
| OpenAI Codex | `~/.codex/config.toml` | `~/.agents/skills` |
| Claude Code | `~/.claude.json` | `~/.claude/skills` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills` |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.agents/skills` |
| DeepSeek Harness | `$DSH_HOME/cordis.patch.yml`，默认 `~/.dsh/cordis.patch.yml` | `~/.agents/skills` 与 DSH Skill 目录 |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/skills` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `~/.copilot/skills` |
| MiniMax Code | `$MINIMAX_DATA_DIR/plugins/agent-vault/mcp.json`，默认 `~/.minimax/plugins/agent-vault/mcp.json` | 同一 Agent Plugin 的 `skills/` |

DeepSeek Harness 的 MCP 适配使用官方 `@deepseek-ai/dsh-mcp-client` Cordis 插件；由于 DSH 仍在快速演进，若插件不可用，内置 Skill 会回退调用 `agent-vault` CLI。

MiniMax Code 适配使用官方公开的 Agent Plugins 1.0 本地 marketplace。接入时生成同时包含 MCP 与共享 Skill 的 `agent-vault` Plugin；不再依赖旧版 `~/.mavis` 配置。

## Skill 复用

在 `<Vault>/skills/<skill-name>/SKILL.md` 中创建 Skill。格式遵循开放的 Agent Skills 约定：

```markdown
---
name: my-shared-skill
description: Describe when an agent should use this skill.
---

# Instructions

Put the reusable workflow here.
```

运行 `agent-vault skills sync all`。复制而不是符号链接是有意设计：Windows、OneDrive 和部分 NAS 对链接的支持并不一致。

初始化时自动创建 `agent-vault-memory` Skill，引导 Agent 在合适的时候召回和保存长期信息，并明确禁止保存凭据。

不同网盘目录中的不同 `vaultId` 代表独立 Vault。网盘客户端负责同一 Vault 的跨电脑文件同步；若要把两个独立 Vault 的内容合并，请使用控制台中的“手动迁移”或 `agent-vault vault migrate`，不要让两个网盘目录持续互相镜像。

## 同步与冲突模型

同步目录只包含：

```text
AgentVault/
├── agent-vault.json
├── memory/events/<device-id>/<date>/<event-id>.json
└── skills/<skill-name>/...
```

本机设备 ID、逻辑时钟和将来的检索缓存都放在同步目录之外。程序使用“临时文件 + 原子改名”提交事件，并忽略未完成文件。详见 [架构说明](docs/architecture.md)。

## 安全边界

- 0.4.0 没有端到端加密；安全性取决于电脑、网盘账号和 NAS 权限。
- MCP/CLI 不会主动读取其他聊天记录；只处理明确写入 Vault 的内容。
- 召回内容是上下文，不是高优先级指令；当前用户指令始终优先。
- 建议对网盘开启多因素认证，并避免把 Vault 放进公开共享目录。

## 开发与测试

```bash
npm run test:all
npm run build:exe:win
```

本机测试覆盖中文检索、CRUD、删除墓碑、并发写入、Skill 同步、八种 Agent 的隔离配置安装/卸载，以及 MCP 客户端端到端调用。Windows CI 还会运行生成的 EXE，验证版本、记忆读写和控制台健康检查。

## License

MIT
