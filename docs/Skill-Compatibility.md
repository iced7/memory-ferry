# Skill compatibility and Agent adapters

Memory Ferry 0.7 keeps one portable Skill source in the Vault and renders the smallest necessary differences for each Agent destination. This avoids maintaining complete Codex, Claude, Gemini, and MiniMax copies by hand.

## Portable source

Every recognized Skill is a directory containing `SKILL.md`:

```text
<Vault>/skills/project-review/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` must begin with YAML frontmatter. `name` must match its directory, use 1–64 lowercase letters, numbers, or single hyphens, and `description` must be non-empty and at most 1024 characters.

```markdown
---
name: project-review
description: Review a project for correctness and maintainability. Use when the user requests a code or architecture review.
---

# Project review

Follow the portable review workflow.
```

The standard optional fields are `license`, `compatibility`, `metadata`, and experimental `allowed-tools`. Memory Ferry warns about non-standard frontmatter and the varying support for `allowed-tools`. Symbolic links are rejected because their targets and behavior are not portable across Windows, cloud drives, and NAS mounts.

## Optional Memory Ferry manifest

Add `memory-ferry.yaml` only when the Skill has platform requirements or Agent-specific behavior:

```yaml
schemaVersion: 1
platforms:
  - darwin
  - win32
requires:
  commands:
    - git
  network: false
targets:
  codex:
    enabled: true
  claude:
    overlay: adapters/claude
  minimax-code:
    enabled: false
```

Supported target IDs are `codex`, `claude`, `cursor`, `opencode`, `deepseek-harness`, `gemini`, `copilot`, and `minimax-code`.

- `platforms` limits distribution to `darwin`, `win32`, or `linux`.
- `requires` is reported to the user; it does not install software or grant network access.
- `enabled: false` prevents installation to a dedicated target. If enabled and disabled Agents share the same discovery directory, Memory Ferry reports that the enabled copy can remain visible to both.
- `overlay` must be a relative path inside the Skill. Without it, Memory Ferry looks for `adapters/<agent>`.

## Overlay format

An Agent overlay contains only the differences from the portable source:

```text
project-review/
├── SKILL.md
├── memory-ferry.yaml
└── adapters/
    ├── codex/
    │   ├── APPEND.md
    │   └── agents/openai.yaml
    └── claude/
        └── frontmatter.yaml
```

- `frontmatter.yaml` merges fields into the rendered `SKILL.md`.
- `APPEND.md` appends Agent-specific instructions to the common body.
- Every other overlay file is copied at the same relative path in the rendered package.
- An overlay may not provide `SKILL.md`; the common source remains authoritative.
- If Agents sharing a destination provide different values for the same frontmatter field or different bytes for the same file, the Skill is blocked instead of producing an ambiguous package.

Example Codex metadata:

```yaml
# adapters/codex/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

Example Claude-only frontmatter:

```yaml
# adapters/claude/frontmatter.yaml
allowed-tools: Read Grep
```

Keep overlays small. Prefer the shared Memory Ferry MCP tool names in common instructions and use a CLI fallback only when an Agent cannot load MCP.

## Inspect and synchronize

```bash
memory-ferry skills list
memory-ferry skills inspect
memory-ferry skills sync all
memory-ferry skills sync codex claude
```

`inspect` reports whether each source is valid and whether each Agent is `native`, `adapted`, `unsupported`, or `invalid`. The dashboard shows the same compatibility state.

During synchronization Memory Ferry:

1. Validates the portable source and optional manifest.
2. Groups Agents that share the same destination.
3. Renders the portable source plus enabled overlays into a temporary directory.
4. Hashes rendered content together with the Agent target set, operating system, and renderer version.
5. Leaves an identical destination unchanged.
6. Replaces a changed managed destination through a recoverable directory swap.
7. Writes `.memory-ferry-sync.json` with ownership and rendered-hash metadata.

A different unowned Skill at the same destination is never overwritten. A managed Skill removed from the Vault, disabled for the target, or unsupported on the current platform is removed on the next synchronization. Invalid new source content does not erase the last installed copy.

## Cross-computer behavior

iCloud, OneDrive, Syncthing, or the NAS client transfers the portable source and overlays between computers. Each computer renders its own platform and Agent targets. The dashboard performs an immediate render when an Agent or Vault is connected and a five-minute fallback check while it remains running.

Cloud providers still decide how simultaneous edits to the same source file conflict. Edit the Vault source, not rendered Agent copies.
