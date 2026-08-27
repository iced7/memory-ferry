# Memory Ferry

**Memory Ferry · 记忆摆渡** is a local-first, cross-device long-term memory and reusable-Skill layer for AI agents. Put an ordinary Vault folder in iCloud Drive, OneDrive, Dropbox, Syncthing, or a mounted NAS, then connect Codex, Claude Code, Cursor, OpenCode, DeepSeek Harness, Gemini CLI, GitHub Copilot CLI, and MiniMax Code to the same memory.

[中文说明](README.zh-CN.md) · [English user guide](docs/User-Guide.md) · [中文使用手册](docs/用户使用手册.md)

> Version `0.6.0-beta.1` does not provide end-to-end encryption. Never store passwords, API keys, tokens, private keys, recovery codes, or other secrets.

## Why it exists

- Cross-computer: sync ordinary files without a hosted control plane or database daemon.
- Cross-agent: expose one MCP and CLI contract instead of locking memory to a model vendor.
- Offline-friendly: each write is an independent immutable JSON event that syncs later.
- Conflict-tolerant: concurrent additions never overwrite one another; updates converge deterministically.
- Reusable Skills: copy a single Vault source to agent-specific Skill directories by content hash on macOS and Windows.
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
npm install
npm run build
npm link

memory-ferry init "/path/to/your/synced/MemoryFerryVault"
memory-ferry agents install all
memory-ferry remember "Prefer concise answers" --kind preference --scope global
memory-ferry recall "answer style"
memory-ferry ui
```

The dashboard is loopback-only, opens in your browser, supports English and Chinese, manages multiple Vaults, connects or disconnects agents, migrates Vault contents safely, and reconciles Skills every five minutes while running.

## Windows portable app

The Windows x64 release is a portable `MemoryFerry.exe`: no installer and no separate Node.js installation are required. Put the EXE in a permanent folder and double-click it. It starts without a console window and opens the local dashboard. Use the bundled `MemoryFerry-CLI.cmd` when you need command-line output.

The beta is not commercially code-signed, so Windows may show an unknown-publisher warning. Verify the included SHA-256 file and keep SmartScreen enabled.

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
- The legacy `agent-vault` CLI alias remains available during the beta migration period.

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
