# Changelog

## 0.4.0 - 2026-08-26

- Added a persistent multi-Vault registry with graphical switch and remove controls.
- Added safe manual migration between different Vaults: immutable memory events and missing Skill files are merged without deleting the source or overwriting conflicts.
- Added automatic Agent configuration refresh when switching Vaults and hash-based Skill synchronization every 15 seconds while the dashboard is running.
- Added CLI commands for listing/removing known Vaults and manually migrating between Vaults.

## 0.3.2 - 2026-08-26

- Distinguished a globally installed DeepSeek Harness command from a package downloaded and run through `npx`.
- Added npm/npx cache detection on macOS, Linux, and Windows.
- Replaced the misleading “程序未安装” badge with explicit “全局命令可用”, “npx 方式可用”, or “未检测到全局命令” states.

## 0.3.1 - 2026-08-26

- Fixed DeepSeek Harness startup after disconnect by preserving `cordis.patch.yml` as a valid top-level YAML array (`[]`).
- Fixed reconnect from an empty-array patch file so Agent Vault writes a single valid loader patch list instead of appending after `[]`.
- Added regression coverage for the DeepSeek Harness connect, disconnect, and reconnect lifecycle.

## 0.3.0 - 2026-08-26

- Added MiniMax Code detection, connect/disconnect, and shared Skill support.
- Added a generated Agent Plugins 1.0 package in MiniMax Code's local marketplace instead of relying on legacy `~/.mavis` configuration.
- Added portable macOS/Linux and Windows launchers so the plugin can invoke either the npm CLI build or the self-contained Windows EXE.
- Added MiniMax Code adapter coverage for JSON schema, current Vault detection, launch refresh, and Windows `.cmd` generation.

## 0.2.1 - 2026-08-26

- Fixed false-positive Agent availability when only a configuration file exists.
- Added separate executable and configuration presence states to the dashboard API.
- The dashboard now shows “预配置成功 / 程序未安装” instead of “本机可用” for preconfigured Agents without an installed executable.

## 0.2.0 - 2026-08-26

- Added a cross-platform local Web dashboard through `agent-vault ui`.
- Added Vault/provider health, writable state, counters, and latest-event status.
- Added per-Agent detected, connected, current-Vault, and launch-path status.
- Added graphical Vault initialization/selection and Agent connect/disconnect controls.
- Added native macOS and Windows directory pickers, Skill sync, loopback-only binding, session-token API protection, and CSP.
- Added HTTP API and browser-based visual acceptance tests.
- Added a self-contained Windows x64 `AgentVault.exe` build based on Node SEA; double-click launches the dashboard and CLI/MCP modes remain available.
- Added embedded UI assets, self-contained MCP launch configuration, Windows executable CI smoke tests, and release artifact upload.

## 0.1.0 - 2026-08-25

- Initial local-first immutable event Vault.
- Unicode/CJK-aware recall and compact context output.
- CLI and nine MCP tools for memory and Vault operations.
- Reusable Skill source and cross-agent hash synchronization.
- Adapters for Codex, Claude Code, Cursor, OpenCode, DeepSeek Harness, Gemini CLI, and GitHub Copilot CLI.
- macOS and Windows path/config support.
