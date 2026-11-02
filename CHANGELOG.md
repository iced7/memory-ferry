# Changelog

## 1.0.1 - 2026-11-02

- Retry transient Windows atomic-replacement errors with bounded backoff, preserving the previous file and cleaning only the failed writer's temporary file.
- Report background embedding failures on stderr and expose `Vault.flushEmbeddings()` to await queued work and inspect original failure causes.
- Replace timing-based embedding assertions with completion-based assertions; add real Windows file-handle contention and recovery regression tests.
- Run concurrent embedding lifecycle stress checks on Windows Node 20/22/24 and before release; keep all CI matrix jobs running after a failure for complete diagnostics.
- See [verification evidence and limits](docs/verification-1.0.1.md). The original intermittent CI timeout was not reproduced in 80 unmodified lifecycle runs; file contention is a demonstrated failure mode, not a proven attribution for that historical run.

## 1.0.0 - 2026-11-01

- Serialize machine-local state and per-memory updates across processes with crash-recoverable locks.
- Reject stale edits when an expected revision is supplied; preserve parent lineage and expose concurrent-device branches.
- Add doctor diagnostics, history, restore, and non-destructive duplicate discovery through CLI/MCP.
- Add bilingual dashboard memory management with revision and Vault identity checks; reject unexpected Host headers.
- Reduce Chinese single-character false matches, add project-scoped context, and suppress exact duplicates in context.
- Upgrade dependencies and clear known npm audit findings.
- Preserve v1 event compatibility and plaintext storage; deletion retains history. End-to-end encryption remains deferred.
- Stable tags now produce normal GitHub releases, including the npm tarball.


## 0.7.0-beta.1 - 2026-08-28

- Added open Agent Skills validation for required frontmatter, portable names, directory matching, platform constraints, and symbolic-link safety.
- Added optional `memory-ferry.yaml` manifests with per-Agent enablement, overlays, command/network requirements, and macOS/Windows/Linux compatibility.
- Added per-Agent rendering from one portable source, including `frontmatter.yaml`, `APPEND.md`, and extra adapter files such as Codex `agents/openai.yaml`.
- Grouped Agents that share a Skill directory and reject conflicting overlays instead of silently producing an ambiguous package.
- Changed synchronization hashes to include rendered content, the Agent target set, platform, and renderer version.
- Replaced managed Skill directories through a temporary rendered directory and recoverable directory swap.
- Added CLI inspection through `memory-ferry skills inspect` and a bilingual dashboard compatibility panel.

## 0.6.0-beta.1 - 2026-08-27

- Renamed the product, npm package, CLI, manifest, local state, managed Agent configuration, built-in Skill, MiniMax plugin, and Windows executable to Memory Ferry.
- Added conservative migration for legacy manifests, local state, environment variables, managed Agent entries, and Skills; retained the legacy CLI alias during beta.
- Added a Chinese/English dashboard switch, English and Chinese documentation, community/security files, release automation, and bundled license notices.
- Changed the standalone Windows executable to the GUI subsystem so double-click startup no longer opens a console window.
- Added a dashboard exit control and made repeat double-clicks reopen the already-running dashboard instead of failing silently.
- Added a Windows command-line wrapper plus CI checks for the GUI subsystem, captured CLI output, recall, and dashboard startup.
- Added a persistent startup-error log at `%USERPROFILE%\\.memory-ferry\\memory-ferry.log` for failures that would otherwise be hidden.

## 0.5.2 - 2026-08-27

- Reworked the dashboard's top area into balanced Vault panels with on-demand add and migration dialogs.
- Replaced the misleading Codex “global command missing” badge with configuration-aware status text.
- Kept the Windows folder chooser above the browser by assigning it a topmost owner window.
- Reduced background Skill reconciliation from 15 seconds to 5 minutes and changed page status polling to a non-flickering 60-second diff refresh.

## 0.5.1 - 2026-08-27

- Fixed the Windows self-contained executable by emitting a CommonJS SEA entry point instead of an incompatible ES module.
- Added a build-time execution check for the bundled entry point before creating the Windows executable.

## 0.5.0 - 2026-08-27

- Optional semantic recall via local Ollama embeddings (`MEMORY_FERRY_EMBED_MODEL`, `MEMORY_FERRY_EMBED=off` to disable), hybrid scoring with text fallback.
- Semantic indexes now repair synced and migrated memories before the first search returns, batch index writes, and deduplicate concurrent in-process refreshes.
- append() no longer rescans the full event log (recent-clock window from file names), sequential writes are no longer quadratic.
- Added a fingerprint-based local event cache (no full re-parse per operation).
- Fixed memory scope updates so changing a scope type preserves its ID and changing an ID preserves its type.
- Made the test environment hermetic so real user Agent configuration cannot be detected or rewritten.
- Added ownership markers to synced Skills and pruning for stale Agent Vault-managed copies while preserving user-owned directories.

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

- Added a cross-platform local Web dashboard through `memory-ferry ui`.
- Added Vault/provider health, writable state, counters, and latest-event status.
- Added per-Agent detected, connected, current-Vault, and launch-path status.
- Added graphical Vault initialization/selection and Agent connect/disconnect controls.
- Added native macOS and Windows directory pickers, Skill sync, loopback-only binding, session-token API protection, and CSP.
- Added HTTP API and browser-based visual acceptance tests.
- Added a self-contained Windows x64 `MemoryFerry.exe` build based on Node SEA; double-click launches the dashboard and CLI/MCP modes remain available.
- Added embedded UI assets, self-contained MCP launch configuration, Windows executable CI smoke tests, and release artifact upload.

## 0.1.0 - 2026-08-25

- Initial local-first immutable event Vault.
- Unicode/CJK-aware recall and compact context output.
- CLI and nine MCP tools for memory and Vault operations.
- Reusable Skill source and cross-agent hash synchronization.
- Adapters for Codex, Claude Code, Cursor, OpenCode, DeepSeek Harness, Gemini CLI, and GitHub Copilot CLI.
- macOS and Windows path/config support.
