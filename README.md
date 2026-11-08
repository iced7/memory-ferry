# Memory Ferry

**Memory Ferry · 记忆摆渡** is a local-first, cross-device long-term memory and reusable-Skill layer for AI agents. Put an ordinary Vault folder in iCloud Drive, OneDrive, Dropbox, Syncthing, or a mounted NAS, then connect Codex, Claude Code, Cursor, OpenCode, DeepSeek Harness, Gemini CLI, GitHub Copilot CLI, and MiniMax Code to the same memory.

[中文说明](README.zh-CN.md) · [English user guide](docs/User-Guide.md) · [中文使用手册](docs/用户使用手册.md)

Need help setting up two agents and checking the result? See the [fixed-scope deployment service](docs/DEPLOYMENT-SERVICE.md) (USD 150). The software itself remains free under the MIT license.

> Version `1.1.0` offers optional memory encryption; existing plaintext behavior remains the default. Keys require separate backup. Skills and metadata remain visible. See [encryption setup and limits](docs/ENCRYPTION.md).

## Stable 1.1

- Process-safe local writes, revision checks, and visible concurrent-device branches.
- Dashboard memory search, editing, deletion, version history, and restore.
- `doctor` reports invalid events and unfinished files; cloud sync status stays explicitly unknown.
- Project-aware recall/context and exact-duplicate suppression in context.
- Optional authenticated memory/history/cache encryption; default JSON Vaults remain compatible. Deletion retains history.

Read the [1.0 release notes](docs/RELEASE-1.0.md) for upgrade, rollback, and limitations. For optional encryption and key management, read the [1.1 encryption guide](docs/ENCRYPTION.md).

## Why it exists

- Cross-computer: sync ordinary files without a hosted control plane or database daemon.
- Cross-agent: expose one MCP and CLI contract instead of locking memory to a model vendor.
- Offline-friendly: each write is an independent immutable JSON event that syncs later.
- Conflict-tolerant: concurrent additions never overwrite one another; updates converge deterministically.
- Reusable Skills: validate one portable source, render optional Agent overlays, and distribute target-specific packages by content hash on macOS and Windows.
- Low cost: reuse storage and sync software you already operate.

## Supported agents

| Agent | MCP | Shared Skills |
|---|---:|---:|
| OpenAI Codex | ✓ | ✓ |
| Claude Code | ✓ | ✓ |
| Cursor | ✓ | ✓ |
| OpenCode | ✓ | ✓ |
| DeepSeek Harness | ✓ | ✓ |
| Gemini CLI | ✓ | ✓ |
| GitHub Copilot CLI | ✓ | ✓ |
| MiniMax Code | ✓ | ✓ |

## Quick start

Requires Node.js 20 or newer:

```bash
npm install -g memory-ferry@latest

memory-ferry init "/path/to/your/synced/MemoryFerryVault"
memory-ferry agents install all
memory-ferry remember "Prefer concise answers" --kind preference --scope global
memory-ferry recall "answer style"
memory-ferry ui
```

Install from the public [npm registry](https://www.npmjs.com/package/memory-ferry); no npm login is required to install or update. Run the same command on each device to upgrade, including devices previously installed from a tarball:

```bash
npm install -g memory-ferry@latest
memory-ferry --version
```

To uninstall the program:

```bash
npm uninstall -g memory-ferry
```

Restart any running dashboard and Agent MCP connections after updating. Existing Vaults and local configuration are retained; do not initialize a new Vault just to upgrade. Use `memory-ferry@1.1.0` to pin this release. If a registry mirror is stale, append `--registry=https://registry.npmjs.org/` to the install command. The [GitHub release tarball](https://github.com/iced7/memory-ferry/releases/download/v1.1.0/memory-ferry-1.1.0.tgz) remains an alternative.

The standalone Windows EXE is updated by replacing it with the file from the new GitHub release; npm updates only the Node.js installation.

The dashboard is loopback-only, opens in your browser, supports English and Chinese, manages multiple Vaults, connects or disconnects agents, reports Skill compatibility, migrates Vault contents safely, and reconciles Skills every five minutes while running.

## Portable and Agent-adapted Skills

Every Skill starts with one portable source at `<Vault>/skills/<skill-name>/SKILL.md`. Memory Ferry validates the open Agent Skills frontmatter before distribution. Run:

```bash
memory-ferry skills inspect
memory-ferry skills sync all
```

For product-specific behavior, add an optional `memory-ferry.yaml` manifest and small `adapters/<agent>/` overlays. An overlay can merge `frontmatter.yaml`, append `APPEND.md`, and provide extra files such as Codex `agents/openai.yaml`; it may not replace the common `SKILL.md`. Memory Ferry renders and hashes each destination separately, groups Agents that share a discovery directory, blocks conflicting overlays, rejects non-portable symlinks, and preserves unrelated user-owned Skills. See the [Skill compatibility guide](docs/Skill-Compatibility.md).

## Windows portable app

The Windows x64 release is a portable `MemoryFerry.exe`: no installer and no separate Node.js installation are required. Put the EXE in a permanent folder and double-click it. It starts without a console window and opens the local dashboard. Use the bundled `MemoryFerry-CLI.cmd` when you need command-line output.

The Windows executable is not commercially code-signed, so Windows may show an unknown-publisher warning. Verify the included SHA-256 file and keep SmartScreen enabled.

## Storage model

```text
MemoryFerryVault/
├── memory-ferry.json
├── memory/events/<device-id>/<date>/<event-id>.json
└── skills/<skill-name>/...
```

Device identity, clocks, event caches, and optional Ollama embedding indexes stay outside the synchronized folder. The Vault contains no live SQLite database, WAL, or lock file.

## Upgrade compatibility

Memory Ferry recognizes existing Agent Vault Sync installations:

- `agent-vault.json` is accepted and a new `memory-ferry.json` companion manifest is created without deleting the old file.
- `~/.agent-vault-sync` state is migrated to `~/.memory-ferry` when the new state does not exist.
- `AGENT_VAULT_*` environment variables remain fallbacks for their `MEMORY_FERRY_*` replacements.
- Reconnecting an agent removes the old managed `agent-vault` entry and writes `memory-ferry`.
- The legacy `agent-vault` CLI alias remains available for backward compatibility.

Back up important Vaults before upgrading and allow your sync client to finish before opening the same Vault on another computer.

## Optional semantic recall

If local Ollama is available, `recall` and `context` blend semantic similarity with Unicode/CJK text scoring. Set `MEMORY_FERRY_EMBED=off` or pass `--no-semantic` to use text-only search. Embedding indexes remain local and are repaired before the first query returns after cloud sync or migration.

## Development

```bash
npm ci
npm run test:all
npm audit --omit=dev
npm pack --dry-run
```

Windows releases are built and smoke-tested in GitHub Actions. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [architecture.md](docs/architecture.md).

## License

MIT. Standalone releases also include Node.js and third-party license notices.
