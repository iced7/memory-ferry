# Memory Ferry 1.0.0

Memory Ferry 1.0 focuses on reliable shared memory and a complete local management workflow.

## What changed / 本次变化

- Local state uses a cross-process lock. Updates to the same memory are serialized so independent agents' partial patches retain each other's fields.
- `expectedRevision` rejects stale edits, deletions, and restores. The UI always supplies it; older CLI/MCP callers remain compatible without it. Use `memory_history` or `history <id>` to obtain the current event ID.
- Events record parent versions. Concurrent changes made on disconnected devices remain separate immutable events. `doctor` and the dashboard flag multiple known branches. History shows all versions; explicitly restoring the desired version acknowledges the branches currently visible on this device.
- `doctor` reports invalid JSON, invalid event records, unfinished writes, clock collisions, and concurrent branches. Good events remain readable with an incomplete-results warning. Updates/deletes/restores are blocked when unreadable events prevent a complete view.
- The bilingual dashboard can create, search, edit, delete, inspect history, and restore memories. It rejects stale edits and saves against a different active Vault. Deleted memories are available through the Deleted filter. Up to 200 matching entries are shown; refine the query for larger sets.
- Chinese matching uses meaningful adjacent terms instead of isolated characters. `projectId` includes one project plus global memories; `allScopes` explicitly widens recall. Exact normalized duplicates within the same scope/kind are collapsed in context and identified for manual review in the dashboard.
- Dependencies were upgraded, and the lockfile passed a zero-finding npm audit at release preparation. This is not a guarantee against unknown vulnerabilities.

## Upgrade / 升级

1. Stop the local dashboard and other Memory Ferry writers. Allow your folder-sync client to finish. Copy the Vault and local state to a backup outside the active sync tree.
2. Install the release tarball with `npm install -g ./memory-ferry-1.0.0.tgz`, or install the pinned registry version after it has been published: `npm install -g memory-ferry@1.0.0`. Windows users may replace the existing EXE at its established path after stopping it.
3. Run `memory-ferry --version`, then `memory-ferry doctor --vault <folder>`. Exit code 0 means no detected issues; 2 means review the reported warnings. Never automatically delete a pending or damaged file.
4. Restart the dashboard and agent MCP processes to load the new tools. New Vaults include the revised memory skill. Existing customized Skills are preserved; update them deliberately if you want the new tool guidance.

The v1 manifest and immutable event format are preserved. New fields are optional; legacy manifests, environment aliases, and existing memories remain readable. No in-place encryption or destructive migration is performed.

## CLI examples

```sh
memory-ferry doctor
memory-ferry recall "build conventions" --project my-project --no-semantic
memory-ferry context "build conventions" --project my-project --no-semantic
memory-ferry history <memory-id>
memory-ferry update <memory-id> --content "Updated fact" --expected-revision <current-event-id>
memory-ferry restore <memory-id> <historical-event-id> --expected-revision <current-event-id>
memory-ferry duplicates
```

MCP adds `memory_history`, `memory_restore`, and `memory_duplicates`; `memory_context` now accepts the same scope, project, tag, and kind filters as recall. The restore tool requires `expectedRevision`.

## Boundaries / 使用边界

- **Plaintext storage.** JSON events, Markdown Skills, and local caches are not end-to-end encrypted. `forget` writes a tombstone; historical content, backups, and cloud versions remain. Never promise secure erasure. Encryption and secure compaction require a separate format, key-recovery, and migration design.
- **Cloud sync is not verified.** Writable files on this machine do not prove another device has received them. Check the cloud client's status. Automated tests simulate folder exchange; they do not certify every provider or a real multi-device network.
- **Offline conflicts remain possible.** Devices converge deterministically by hybrid clock and event ID. The selected current record does not automatically combine arbitrary conflicting fields. Review history and restore the desired record after both devices finish syncing. Legacy events lack parent links, so pre-1.0 branches cannot always be identified automatically.
- **One local state directory per installation.** Keep `MEMORY_FERRY_HOME` on a local disk, outside the synced Vault. Independent state directories behave like different devices. Do not mix old and new writer versions during an upgrade: old versions do not honor the new locks.
- **Semantic retrieval is optional.** Text search and all release checks work without a local model. No model is installed or started by this upgrade. Semantic scores are heuristic; no universal accuracy claim is made.
- **Windows builds are unsigned.** Verify checksums and retain OS security protections. CI smoke tests are separate from manual Windows desktop testing.

## Rollback / 回退

Stop all writers and reinstall the previous package or EXE. New events still use schema v1, so older versions can read records, but they lack revision checks, branch diagnostics, and the concurrency fixes. Prefer restoring a full backup to a separate folder for investigation instead of replacing live synchronized files. Do not delete new events to roll back the application.

中文摘要：正式版补齐可靠写入、异常可见、项目检索和记忆管理。数据继续使用明文；删除可恢复；同步完成由网盘客户端确认。不同设备离线编辑保留各版本并提醒人工选择。旧数据无需转换，现有自定义 Skill 不自动覆盖。
