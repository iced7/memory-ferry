# Architecture

## Design goals

Memory Ferry · 记忆摆渡 optimizes for the lowest operational cost: one install per machine, an ordinary synchronized directory, no hosted control plane, and no database daemon. It deliberately does not synchronize a live SQLite database because cloud-drive clients cannot safely merge database pages, WAL files, or locks.

## Event model

Every mutation creates a new JSON event under a device-specific directory. An event includes a unique event ID, stable memory ID, operation, device ID, timestamp, and hybrid logical clock (HLC). Files are first written with a `.pending-*` suffix and atomically renamed when complete.

Readers recursively discover completed event files and choose the latest event for each memory ID. HLC order is `(wallTime, counter, node)` with `eventId` as a final deterministic tie-breaker. A delete is a tombstone event, so it synchronizes like any other mutation.

This gives the following behavior:

- Two devices creating different memories retain both.
- Offline events can arrive in any order and converge to the same state.
- Concurrent updates of the same memory use deterministic last-writer-wins semantics.
- A damaged or invalid event is excluded from results with explicit diagnostics. Incomplete writes remain untouched and appear in doctor warnings.
- Machine-local state and per-memory patches use cross-process locks. Optional expected revisions prevent stale edits. New events record parent lineage; unresolved concurrent device branches are reported and can be acknowledged through an explicit restore.

Readers scan event metadata and reuse a disposable local parsed-event cache. Doctor bypasses the cache to verify file contents. Optional semantic indexes also remain outside the synchronized directory. Metadata scans still scale with event count.

## Separation of state

Synchronized state:

- Vault manifest
- immutable memory events
- canonical reusable skills

Machine-local state:

- selected Vault path
- per-Vault device ID
- last generated HLC
- event cache, optional semantic index, and cross-process locks

## Integration boundary

All agents receive the same stdio MCP server. The core memory format has no dependency on MCP, a model vendor, or an Agent SDK, so CLI-only and future adapters can use the same Vault.

Skills use a portable source plus a target renderer. `SKILL.md` follows the open Agent Skills subset; optional `memory-ferry.yaml` metadata and `adapters/<agent>/` overlays describe only product differences. Adapters provide configuration locations and Skill discovery directories. Destinations shared by multiple Agents are grouped before rendering, and conflicting overlay fields or files fail closed. The rendered hash includes output bytes, target Agent set, platform, and renderer version. Managed directories are replaced through a temporary sibling and recoverable rename swap; unrelated unowned directories are preserved.

## Current limitations

- No encryption or key management.
- Filesystem scan search is intended for personal-scale Vaults, not millions of events.
- LWW preserves convergence but does not semantically merge two edits to the same memory.
- Cloud-drive availability, account access, and retention are outside the tool's control.
- DSH MCP depends on its official Cordis MCP client plugin, whose packaging can change while DSH is in developer preview.
