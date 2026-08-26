import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { HybridLogicalClock, ListFilter, MemoryEvent, MemoryKind, MemoryRecord, RememberInput, VaultManifest } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { StateStore } from "./state.js";
import { searchMemories } from "./search.js";
import { ensureBuiltinSkill } from "./skills.js";
import { isoDate, pathExists, readJson, safeSegment, stableId, uniqueStrings, writeJsonAtomic } from "./utils.js";

const KINDS: MemoryKind[] = ["fact", "preference", "decision", "lesson", "note", "task"];
const SCOPES = ["global", "project", "agent"] as const;
const RECENT_CLOCK_FILE_LIMIT = 30

function compareClock(a: HybridLogicalClock, b: HybridLogicalClock): number {
  return a.wallTime - b.wallTime || a.counter - b.counter || a.node.localeCompare(b.node);
}

function cleanSource(source?: MemoryRecord["source"]): MemoryRecord["source"] | undefined {
  if (!source) return undefined;
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === "string" && value.trim())) as NonNullable<MemoryRecord["source"]>;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function validateEvent(value: MemoryEvent, file: string): MemoryEvent {
  if (value.schemaVersion !== SCHEMA_VERSION || !value.eventId || !value.memoryId || !value.clock || !["put", "delete"].includes(value.op)) {
    throw new Error(`Invalid memory event: ${file}`);
  }
  if (value.op === "put" && !value.record) throw new Error(`Put event is missing record: ${file}`);
  return value;
}

interface EventTree {
  files: string[];
  fingerprint: string;
}

interface EventCache {
  fingerprint: string;
  events: MemoryEvent[];
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function eventTree(root: string): Promise<EventTree> {
  const found: string[] = [];
  if (await pathExists(root)) await visit(root);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.pending-')) found.push(full);
    }
  }

  const files = found.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  const entries = await Promise.all(files.map(async (file) => {
    const metadata = await stat(file);
    return [path.relative(root, file).split(path.sep).join('/'), metadata.size, metadata.mtimeMs] as const;
  }));
  // Fingerprinting metadata avoids reading every event. A same-size file restored to the
  // same mtime would be missed, which is acceptable for cloud-drive sync; newest-file
  // content is intentionally not hashed.
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { files, fingerprint };
}

async function recentEventClocks(root: string, node: string): Promise<HybridLogicalClock[]> {
  const clocks: HybridLogicalClock[] = []
  if (await pathExists(root)) await visit(root)

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || entry.name.includes('.pending-')) continue
      const match = /^(\d+)-(\d+)-.+\.json$/.exec(entry.name)
      if (!match) continue
      const clock = {
        wallTime: Number.parseInt(match[1], 10),
        counter: Number.parseInt(match[2], 10),
        node,
      }
      const insertAt = clocks.findIndex((candidate) =>
        clock.wallTime > candidate.wallTime
        || clock.wallTime === candidate.wallTime && clock.counter > candidate.counter
      )
      if (insertAt >= 0) clocks.splice(insertAt, 0, clock)
      else if (clocks.length < RECENT_CLOCK_FILE_LIMIT) clocks.push(clock)
      if (clocks.length > RECENT_CLOCK_FILE_LIMIT) clocks.pop()
    }
  }

  // The bounded window is selected newest-first, then restored to the ascending
  // order used by events() so slice(-20) observes the same newest clocks.
  return clocks.reverse()
}

export class Vault {
  readonly root: string;
  readonly state: StateStore;

  constructor(root: string, state = new StateStore()) {
    this.root = path.resolve(root);
    this.state = state;
  }

  get manifestPath(): string { return path.join(this.root, "agent-vault.json"); }
  get eventsPath(): string { return path.join(this.root, "memory", "events"); }
  get eventsCachePath(): string { return path.join(this.state.home, 'cache', `${stableId(this.root)}-events.json`); }

  static async init(root: string, name = "Agent Vault", state = new StateStore()): Promise<Vault> {
    const vault = new Vault(root, state);
    await mkdir(vault.eventsPath, { recursive: true });
    await mkdir(path.join(vault.root, "skills"), { recursive: true });
    if (!(await pathExists(vault.manifestPath))) {
      const manifest: VaultManifest = { schemaVersion: SCHEMA_VERSION, vaultId: randomUUID(), name, createdAt: isoDate(), format: "agent-vault-events" };
      await writeJsonAtomic(vault.manifestPath, manifest);
    } else {
      await vault.manifest();
    }
    await ensureBuiltinSkill(vault.root);
    await state.setDefaultVault(vault.root);
    await state.deviceFor(vault.root);
    return vault;
  }

  async manifest(): Promise<VaultManifest> {
    if (!(await pathExists(this.manifestPath))) throw new Error(`Not an Agent Vault: ${this.root}`);
    const value = await readJson<VaultManifest>(this.manifestPath);
    if (value.schemaVersion !== SCHEMA_VERSION || value.format !== "agent-vault-events") throw new Error(`Unsupported vault format: ${this.root}`);
    return value;
  }

  async events(): Promise<MemoryEvent[]> {
    await this.manifest();
    const tree = await eventTree(this.eventsPath);
    const cacheIsExternal = !pathIsWithin(this.root, this.eventsCachePath);
    if (cacheIsExternal) {
      try {
        const cached = await readJson<EventCache>(this.eventsCachePath);
        if (cached.fingerprint === tree.fingerprint && Array.isArray(cached.events)) {
          return cached.events.map((event, index) => validateEvent(event, `${this.eventsCachePath}#${index}`));
        }
      } catch {
        // A local cache is disposable and must never make Vault reads fail.
      }
    }
    const events: MemoryEvent[] = [];
    for (const file of tree.files) {
      try {
        events.push(validateEvent(await readJson<MemoryEvent>(file), file));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    events.sort((a, b) => compareClock(a.clock, b.clock) || a.eventId.localeCompare(b.eventId));
    if (cacheIsExternal) {
      try {
        await writeJsonAtomic(this.eventsCachePath, { fingerprint: tree.fingerprint, events } satisfies EventCache);
      } catch {
        // Cache writes are best-effort and stay outside the synchronized Vault.
      }
    }
    return events;
  }

  async current(): Promise<Map<string, MemoryRecord>> {
    const latest = new Map<string, MemoryEvent>();
    for (const event of await this.events()) {
      const previous = latest.get(event.memoryId);
      if (!previous || compareClock(event.clock, previous.clock) > 0 || (compareClock(event.clock, previous.clock) === 0 && event.eventId > previous.eventId)) latest.set(event.memoryId, event);
    }
    const current = new Map<string, MemoryRecord>();
    for (const [id, event] of latest) if (event.op === "put" && event.record) current.set(id, event.record);
    return current;
  }

  private async append(op: 'put' | 'delete', memoryId: string, record?: MemoryRecord): Promise<MemoryEvent> {
    await this.manifest()
    const device = await this.state.deviceFor(this.root)
    const recentClocks = await recentEventClocks(this.eventsPath, device.deviceId)
    const clock = await this.state.nextClock(this.root, recentClocks.slice(-20))
    const event: MemoryEvent = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), memoryId, op, clock, createdAt: isoDate(), deviceId: device.deviceId, ...(record ? { record } : {}) };
    const date = event.createdAt.slice(0, 10);
    const file = path.join(this.eventsPath, safeSegment(device.deviceId), date, `${clock.wallTime}-${clock.counter}-${safeSegment(event.eventId)}.json`);
    await writeJsonAtomic(file, event);
    return event;
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const content = input.content.trim();
    if (!content) throw new Error("Memory content cannot be empty.");
    const kind = input.kind || "note";
    if (!KINDS.includes(kind)) throw new Error(`Unsupported memory kind: ${kind}`);
    const scope = input.scope || "global";
    if (!SCOPES.includes(scope)) throw new Error(`Unsupported memory scope: ${scope}`);
    const now = isoDate();
    const record: MemoryRecord = {
      id: randomUUID(), content, ...(input.title?.trim() ? { title: input.title.trim() } : {}), kind,
      scope: { type: scope, ...(input.scopeId?.trim() ? { id: input.scopeId.trim() } : {}) },
      tags: uniqueStrings(input.tags || []), ...(cleanSource(input.source) ? { source: cleanSource(input.source) } : {}), createdAt: now, updatedAt: now
    };
    await this.append("put", record.id, record);
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> { return (await this.current()).get(id); }

  async update(id: string, input: Partial<RememberInput>): Promise<MemoryRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    if (input.kind && !KINDS.includes(input.kind)) throw new Error(`Unsupported memory kind: ${input.kind}`);
    if (input.scope && !SCOPES.includes(input.scope)) throw new Error(`Unsupported memory scope: ${input.scope}`);
    const scopeId = input.scopeId !== undefined ? input.scopeId.trim() : existing.scope.id;
    const record: MemoryRecord = {
      ...existing,
      ...(input.content !== undefined ? { content: input.content.trim() } : {}),
      ...(input.title !== undefined ? (input.title.trim() ? { title: input.title.trim() } : { title: undefined }) : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.tags ? { tags: uniqueStrings(input.tags) } : {}),
      ...(input.source ? (cleanSource({ ...existing.source, ...input.source }) ? { source: cleanSource({ ...existing.source, ...input.source }) } : { source: undefined }) : {}),
      scope: input.scope !== undefined || input.scopeId !== undefined ? { type: input.scope || existing.scope.type, ...(scopeId ? { id: scopeId } : {}) } : existing.scope,
      updatedAt: isoDate()
    };
    if (!record.content) throw new Error("Memory content cannot be empty.");
    await this.append("put", id, record);
    return record;
  }

  async forget(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.append("delete", id);
    return true;
  }

  async list(filter: ListFilter = {}): Promise<MemoryRecord[]> {
    let values = [...(await this.current()).values()];
    if (filter.kind) values = values.filter((memory) => memory.kind === filter.kind);
    if (filter.scope) values = values.filter((memory) => memory.scope.type === filter.scope);
    if (filter.scopeId) values = values.filter((memory) => memory.scope.id === filter.scopeId);
    if (filter.tags?.length) values = values.filter((memory) => filter.tags!.every((tag) => memory.tags.includes(tag)));
    values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return values.slice(0, filter.limit || 100);
  }

  async search(query: string, limit = 10, filter: ListFilter = {}) {
    return searchMemories(await this.list({ ...filter, limit: Number.MAX_SAFE_INTEGER }), query, limit);
  }

  async context(query: string, limit = 8): Promise<string> {
    const results = await this.search(query, limit);
    if (!results.length) return "No relevant shared memory found.";
    return results.map(({ memory }) => `- [${memory.kind}/${memory.scope.type}${memory.scope.id ? `:${memory.scope.id}` : ""}] ${memory.title ? `${memory.title}: ` : ""}${memory.content} (id: ${memory.id})`).join("\n");
  }
}
