# Memory Ferry · 记忆摆渡

一个低成本、local-first 的跨 Agent 长期记忆与 Skill 复用工具。把 Vault 放在 iCloud Drive、OneDrive、Dropbox、Syncthing 或 NAS 同步目录中，Codex、Claude Code、Cursor、OpenCode、DeepSeek Harness、Gemini CLI、GitHub Copilot CLI 和 MiniMax Code 就能读写同一份记忆。

当前版本：`0.7.0-beta.1`。**暂不提供加密，请勿保存密码、Token、私钥或其他机密。**

[English README](README.md) · [English user guide](docs/User-Guide.md)

第一次使用建议先阅读：[《Memory Ferry · 记忆摆渡 用户说明与使用手册》](docs/用户使用手册.md)。手册包含完整安装、跨电脑部署、各 Agent 接入、Skill 复用、命令参考、数据安全和故障排查。

## 它解决什么

- 跨电脑：同步普通文件，不运行中心服务器，不需要数据库服务。
- 跨 Agent：提供同一套 MCP 工具和 CLI，Agent 不绑定某一家模型。
- 离线可写：每次操作写入独立、不可变的 JSON 事件；恢复联网后由网盘同步。
- 冲突可合并：不同设备新增不会互相覆盖；同一记忆的并发修改用混合逻辑时钟确定性收敛。
- Skill 复用：校验一份公共源文件，按需渲染 Agent 覆盖层，再按目标内容哈希分发，兼容 macOS 和 Windows。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install -g memory-ferry@beta
memory-ferry ui
```

当前为 Beta 版，请明确使用 `@beta` 标签。安装完成后会得到全局命令 `memory-ferry`，运行 `memory-ferry ui` 即可打开本机可视化控制台。

升级或卸载：

```bash
npm install -g memory-ferry@beta
npm uninstall -g memory-ferry
```

如果只想在 Windows 上双击运行、不想安装 Node.js，请使用下方的单文件 EXE。

### Windows 单文件 EXE

Windows x64 用户可以直接使用 `release/MemoryFerry.exe`，目标电脑不需要安装 Node.js 或 npm。

建议先把 EXE 放到不会移动的固定位置，例如：

```powershell
$folder = "$env:LOCALAPPDATA\MemoryFerry"
New-Item -ItemType Directory -Force $folder
Copy-Item .\MemoryFerry.exe "$folder\MemoryFerry.exe"
Set-Location $folder
.\MemoryFerry-CLI.cmd --version
```

双击 `MemoryFerry.exe` 会在后台启动本机可视化控制台，不再显示命令行窗口。关闭浏览器不会停止服务；需要完全退出时，请点击控制台右上角“退出程序”。程序已经运行时再次双击，只会重新打开控制台页面。

命令行调用请使用同目录的 `MemoryFerry-CLI.cmd`，它会等待程序结束并显示输出；Agent 的 MCP 配置仍可直接调用 `MemoryFerry.exe`。接入 Agent 后不要随意移动或删除这些文件；如果移动过，重新点击界面中的“刷新”。

当前 EXE 是 Windows x64、未使用商业代码签名证书。Windows 可能显示“未知发布者”，请先核对项目提供的 SHA-256，不要关闭系统级安全防护。

## 从 Agent Vault Sync 升级

Memory Ferry 会兼容并保守迁移旧版本：识别 `agent-vault.json` 并生成新的 `memory-ferry.json`；首次启动时把旧 `~/.agent-vault-sync` 本机状态迁移到 `~/.memory-ferry`；旧 `AGENT_VAULT_*` 环境变量继续作为后备；重新接入 Agent 时会移除旧 `agent-vault` 托管节点并写入 `memory-ferry`。Beta 迁移期仍保留 `agent-vault` 命令别名。

## 5 分钟开始

macOS + iCloud Drive：

```bash
memory-ferry init "$HOME/Library/Mobile Documents/com~apple~CloudDocs/MemoryFerryVault"
memory-ferry agents install codex claude cursor opencode deepseek-harness gemini copilot minimax-code
memory-ferry remember "用户偏好简洁的中文回答" --kind preference --scope global --tag language
memory-ferry recall "中文偏好"
```

Windows PowerShell + OneDrive：

```powershell
memory-ferry init "$env:UserProfile\OneDrive\MemoryFerryVault"
memory-ferry agents install all
memory-ferry remember "This project uses pnpm" --kind decision --scope project --scope-id my-project
memory-ferry recall "package manager"
```

NAS 只需换成已挂载目录，例如 `/Volumes/HomeNAS/MemoryFerryVault` 或 `Z:\MemoryFerryVault`。每台电脑安装一次 CLI，然后运行 `memory-ferry use <同一个同步目录>` 和 `memory-ferry agents install ...`。

安装配置后重启对应 Agent。程序修改已有配置文件前会在同目录生成带时间戳的备份；卸载只删除 `memory-ferry` 自己的节点或标记块：

```bash
memory-ferry agents uninstall codex
```

## 常用命令

```bash
memory-ferry status
memory-ferry agents detect
memory-ferry list --limit 20
memory-ferry context "当前项目的技术约束"
memory-ferry recall "仅用文本检索" --no-semantic
memory-ferry context "仅用文本生成上下文" --no-semantic
memory-ferry update <id> --content "新的内容"
memory-ferry forget <id>
memory-ferry skills list
memory-ferry skills sync all
memory-ferry vaults list
memory-ferry vault migrate "/source/MemoryFerryVault" "/target/MemoryFerryVault"
```

## 可视化控制台

运行下面的命令，会在默认浏览器打开仅限本机访问的控制台：

```bash
memory-ferry ui
```

控制台可以：

- 显示当前 iCloud、OneDrive、Dropbox、Syncthing、NAS 或本地 Vault 路径。
- 检查 Vault 是否有效、是否可读写，以及记忆、事件和 Skill 数量。
- 显示 Codex、Claude Code、Cursor、OpenCode、DeepSeek Harness、Gemini CLI、Copilot CLI、MiniMax Code 的检测与连接状态。
- 通过按钮接入、刷新或断开单个 Agent。
- 使用 macOS/Windows 原生目录选择器连接现有 Vault，或初始化新 Vault。
- 保存多个 Vault，并在 iCloud、OneDrive、NAS 等独立 Vault 之间切换。
- 手动把源 Vault 的记忆事件和 Skill 安全合并到目标 Vault，不删除源数据或覆盖冲突。
- 切换或接入时立即刷新 Agent 与共享 Skill，并在控制台运行时每 5 分钟进行一次兜底同步。
- 显示每个 Skill 的公共规范校验、Agent 适配、不支持和阻止同步状态。

控制台只监听 `127.0.0.1`，API 使用随机会话令牌，不会把管理界面暴露到局域网。使用指定端口或不自动打开浏览器：

```bash
memory-ferry ui --port 47831 --no-open
```

所有命令都可以用 `--vault <目录>` 临时指定 Vault；也可以设置 `MEMORY_FERRY_PATH`。本机状态默认位于 `~/.memory-ferry/state.json`，可用 `MEMORY_FERRY_HOME` 修改。

## MCP 工具

适配器会把下面的 stdio MCP Server 写入 Agent 配置：

- `memory_remember`
- `memory_recall`（可选 `semantic`）
- `memory_list`
- `memory_get`
- `memory_update`
- `memory_forget`
- `memory_context`（可选 `semantic`）
- `vault_status`
- `skill_list`

也可以直接运行：

```bash
memory-ferry mcp --vault "/path/to/MemoryFerryVault"
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
| MiniMax Code | `$MINIMAX_DATA_DIR/plugins/memory-ferry/mcp.json`，默认 `~/.minimax/plugins/memory-ferry/mcp.json` | 同一 Agent Plugin 的 `skills/` |

DeepSeek Harness 的 MCP 适配使用官方 `@deepseek-ai/dsh-mcp-client` Cordis 插件；由于 DSH 仍在快速演进，若插件不可用，内置 Skill 会回退调用 `memory-ferry` CLI。

MiniMax Code 适配使用官方公开的 Agent Plugins 1.0 本地 marketplace。接入时生成同时包含 MCP 与共享 Skill 的 `memory-ferry` Plugin；不再依赖旧版 `~/.mavis` 配置。

## 语义检索（可选）

`recall` 和 `context` 可通过本机 Ollama 进行语义召回，并与现有 Unicode/CJK 文本分数混合。Ollama 地址由 `OLLAMA_HOST` 指定，默认为 `http://127.0.0.1:11434`；Embedding 模型由 `MEMORY_FERRY_EMBED_MODEL` 指定，默认为 `nomic-embed-text`；混合权重由 `MEMORY_FERRY_SEMANTIC_WEIGHT` 指定，默认为 `1.5`。

设置 `MEMORY_FERRY_EMBED=off` 可关闭 Embedding，也可在单次命令上使用 `--no-semantic`：

```bash
memory-ferry recall "部署方案" --no-semantic
memory-ferry context "当前项目约束" --no-semantic
```

Embedding 索引位于不同步的本机状态目录，不会写入 append-only Vault。检索会在返回结果前分批刷新本机写入、网盘同步和手动迁移等任何数据来源带来的索引变化；同一运行进程对同一本机索引的并发刷新会自动合并。Ollama 不可用时会自动回退到 Unicode/CJK 文本检索。

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

先检查兼容性，再执行分发：

```bash
memory-ferry skills inspect
memory-ferry skills sync all
```

基础 Skill 使用开放 Agent Skills 公共格式。如果需要 Codex、Claude、Gemini、MiniMax 等专属能力，可以增加可选的 `memory-ferry.yaml` 和小型 `adapters/<agent>/` 覆盖层。覆盖层可以合并 `frontmatter.yaml`、追加 `APPEND.md`，或提供 Codex 的 `agents/openai.yaml` 等额外文件，但不能替换公共 `SKILL.md`。

Memory Ferry 会按“渲染内容 + Agent 目标组合 + 操作系统 + 渲染器版本”分别计算哈希；共享同一发现目录的 Agent 会合并非冲突覆盖，冲突则停止该 Skill 的分发并在界面显示错误。复制而不是符号链接是有意设计：Windows、OneDrive 和部分 NAS 对链接的支持并不一致。完整格式参见[《Skill 兼容与适配手册》](docs/Skill-兼容与适配.md)。

初始化时自动创建 `memory-ferry-memory` Skill，引导 Agent 在合适的时候召回和保存长期信息，并明确禁止保存凭据。

不同网盘目录中的不同 `vaultId` 代表独立 Vault。网盘客户端负责同一 Vault 的跨电脑文件同步；若要把两个独立 Vault 的内容合并，请使用控制台中的“手动迁移”或 `memory-ferry vault migrate`，不要让两个网盘目录持续互相镜像。

## 同步与冲突模型

同步目录只包含：

```text
MemoryFerryVault/
├── memory-ferry.json
├── memory/events/<device-id>/<date>/<event-id>.json
└── skills/<skill-name>/...
```

本机设备 ID、逻辑时钟、事件缓存和 Embedding 索引都放在同步目录之外。程序使用“临时文件 + 原子改名”提交事件，并忽略未完成文件。详见 [架构说明](docs/architecture.md)。

## 安全边界

- 0.7.0-beta.1 没有端到端加密；安全性取决于电脑、网盘账号和 NAS 权限。
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
