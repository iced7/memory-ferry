# Memory Ferry User Guide

This guide applies to `0.6.0-beta.1`. For Chinese, see [用户使用手册](用户使用手册.md).

## 1. What Memory Ferry does

Memory Ferry lets different AI agents on different computers use one durable set of memories and reusable Skills. It stores ordinary files in a folder you choose. iCloud Drive, OneDrive, Dropbox, Syncthing, or your NAS client transfers those files; Memory Ferry neither signs into nor controls the sync provider.

It is not a chat-history backup, an AI model, a cloud memory service, a password manager, or a strongly consistent collaborative database.

## 2. Choose a Vault location

Use a private, fully synchronized folder. Typical paths are:

- macOS iCloud: `~/Library/Mobile Documents/com~apple~CloudDocs/MemoryFerryVault`
- Windows OneDrive: `$env:OneDrive\MemoryFerryVault`
- macOS NAS: `/Volumes/HomeNAS/MemoryFerryVault`
- Windows NAS: `Z:\MemoryFerryVault`

Do not configure two sync providers to mirror the same Vault continuously. Use the built-in migration tool to merge separate Vaults.

## 3. Install

### Portable Windows x64

Copy the release folder to a permanent location and double-click `MemoryFerry.exe`. It needs no installer or separate Node.js runtime. The dashboard opens in your browser and the process remains in the background until you select **Exit**. Use `MemoryFerry-CLI.cmd` for terminal commands.

### Node.js installation on macOS, Windows, or Linux

```bash
npm install -g memory-ferry
memory-ferry --version
```

For a source checkout:

```bash
npm ci
npm run build
npm link
```

## 4. Create or select a Vault

Dashboard: choose **Add Vault**, select a folder, and enable initialization if it is new.

CLI:

```bash
memory-ferry init "/synced/path/MemoryFerryVault" --name "Personal memory"
memory-ferry use "/synced/path/MemoryFerryVault"
memory-ferry status
```

The new manifest is `memory-ferry.json`. Existing `agent-vault.json` folders are accepted and upgraded conservatively.

## 5. Connect agents

Use the dashboard's Connect button or run:

```bash
memory-ferry agents detect
memory-ferry agents install codex claude cursor
memory-ferry agents install all
```

Restart the agent or begin a new session afterward. Disconnecting only removes Memory Ferry-managed MCP configuration; it does not delete the Vault or memories:

```bash
memory-ferry agents uninstall codex
```

Configuration is backed up before modification. A configuration file alone is shown as **Preconfigured**, not as proof that a global CLI exists.

## 6. Save and recall memory

```bash
memory-ferry remember "Prefer concise English answers" --kind preference --scope global
memory-ferry remember "This project uses npm" --kind decision --scope project --scope-id my-project --tag tooling
memory-ferry recall "package manager"
memory-ferry context "project constraints" --limit 8
memory-ferry list --limit 20
memory-ferry update <memory-id> --content "Updated text"
memory-ferry forget <memory-id>
```

For deterministic text-only retrieval:

```bash
memory-ferry recall "deployment" --no-semantic
```

## 7. Reuse Skills

Put each Skill at `<Vault>/skills/<skill-name>/SKILL.md`, then run:

```bash
memory-ferry skills list
memory-ferry skills sync all
```

Memory Ferry copies by content hash instead of using symlinks, which is more reliable across Windows, cloud drives, and NAS mounts. It creates a built-in `memory-ferry-memory` Skill that teaches compatible agents when to recall or save durable context.

## 8. Multiple Vaults and migration

The dashboard keeps a local list of Vaults. Switching a Vault refreshes connected agent configuration and Skills when automatic management is enabled. The page checks status quietly every 60 seconds; Skill reconciliation runs every five minutes, not every 15 seconds.

To merge separate Vaults without deleting the source or overwriting conflicts:

```bash
memory-ferry vault migrate "/source/Vault" "/target/Vault"
```

## 9. Cross-computer setup

On computer A, create the Vault, add a test memory, and wait for the sync provider to finish. On computer B, install Memory Ferry, select the same synchronized folder, connect its local agents, then recall the test memory. Each computer has its own `~/.memory-ferry/state.json`; do not synchronize that state directory.

## 10. Environment variables

| Variable | Purpose |
|---|---|
| `MEMORY_FERRY_PATH` | Override the selected Vault |
| `MEMORY_FERRY_HOME` | Override local state directory |
| `MEMORY_FERRY_LANG` | CLI help language (`en` or `zh-CN`) |
| `MEMORY_FERRY_EMBED` | Set `off` to disable embeddings |
| `MEMORY_FERRY_EMBED_MODEL` | Ollama embedding model |
| `MEMORY_FERRY_SEMANTIC_WEIGHT` | Semantic score weight |
| `OLLAMA_HOST` | Local Ollama endpoint |

Legacy `AGENT_VAULT_*` names remain fallback aliases during the beta transition.

## 11. Security and backup

Memory Ferry currently stores plain JSON and Markdown. Anyone who can read the Vault folder can read its contents. Never store credentials or recovery secrets. Protect your device and cloud account, enable MFA, avoid public shares, and keep recoverable backups or provider version history.

`forget` writes a synchronized tombstone; it does not securely erase old events, cloud history, caches, or backups.

## 12. Troubleshooting

- **Double-click does nothing:** check `%USERPROFILE%\.memory-ferry\memory-ferry.log`; verify the checksum and that another instance did not simply reopen the dashboard.
- **Agent does not see MCP:** refresh its connection, then restart the agent or open a new session.
- **Memory is missing on another computer:** verify `status` on the writer, wait for the sync client, then verify both devices use the same Vault ID.
- **Vault rejected:** wait for `memory-ferry.json` or legacy `agent-vault.json` to finish downloading.
- **Semantic recall unavailable:** start Ollama and install the configured model, or use `--no-semantic`.
- **DeepSeek Harness YAML error:** reconnect it so Memory Ferry regenerates a valid top-level patch array.
- **Moved the EXE:** refresh all connected agents so their MCP launch paths point to the new location.

When reporting a bug, include OS, Memory Ferry version, agent version, sanitized `status --json`, and reproduction steps. Never attach a private Vault or credentials.
