# Memory Ferry setup and verification — USD 150

**A one-time, remote, asynchronous setup service for a developer who wants Codex and Claude Code to use the same local-first memory Vault.** Memory Ferry itself is free, open-source MIT software. This price is for guided installation, migration review, and a written verification record, not for a software license.

## Fixed scope

- One person, one computer, two supported agents (normally Codex and Claude Code), and one existing sync folder that the customer already controls.
- Review the current memory and agent setup, agree on what may be migrated, and record a backup and rollback point before changing configuration.
- Guide installation of the pinned [v1.1.0 release](https://github.com/iced7/memory-ferry/releases/tag/v1.1.0), connect the two agents, and perform a synthetic-memory write/recall test. Existing personal memories are never needed for the test.
- Provide a short handover with the commands used, redacted `doctor` output, test results, remaining limitations, and rollback steps.

The customer operates their own machine, sync account, credentials, and encryption key. Support is via written instructions and redacted diagnostic output; no password, token, private Vault contents, or remote-control access is required. The customer approves each local configuration change. If the existing setup needs more work, we agree on a separate scope before doing it.

## Acceptance checklist

1. The customer confirms a recoverable copy of their existing memory folder and the locations of any original agent configuration files.
2. `memory-ferry status` names the intended Vault, and `memory-ferry doctor` reports any invalid or unfinished files for review.
3. A synthetic test memory is written and recalled locally. After each agent restarts, both agents can use the configured Memory Ferry MCP tools against that Vault.
4. The handover identifies the installed version, configuration changes, test evidence, backup location, and steps to disconnect or restore the earlier setup.

For a second device, the customer must first let their chosen sync provider finish and verify the folder is present there. Cloud completion is **not** inferred from a local `doctor` result. A second-device setup, extra agents, custom integrations, encrypted-Vault migration, ongoing support, and recovery of damaged third-party data are outside this fixed scope.

## Before asking for a quote

Send only: your operating system, the two agents you use, whether you already have a synced folder, whether you have an existing memory Vault, and the setup problem you want solved. Do not send credentials or memory data. Open a [GitHub issue](https://github.com/iced7/memory-ferry/issues/new) with non-sensitive details, or use an appropriate freelance platform listing if you found this offer there. We will confirm fit and a delivery window before any work starts.

## Limits

The Vault is local-first; the sync provider is run by the customer. Concurrent additions are preserved, while conflicting edits can create visible branches that need review. Optional encryption protects memory/history/cache content when enabled on a new Vault, but Skills and metadata remain visible; it has not had an independent security audit. See [encryption limits](ENCRYPTION.md) and the [user guide](User-Guide.md). This service does not promise perfect recall, uninterrupted cloud sync, or secure erasure of old copies.
