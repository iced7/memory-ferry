import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { HybridLogicalClock, ListFilter, MemoryEvent, MemoryKind, MemoryRecord, RememberInput, SearchOptions, VaultManifest, VaultIssue, VaultHealth } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { StateStore } from "./state.js";
import { withFileLock } from "./locking.js";
import { searchMemories } from "./search.js";
import { ensureBuiltinSkill } from "./skills.js";
import { isoDate, pathExists, readJson, safeSegment, stableId, uniqueStrings, writeJsonAtomic } from "./utils.js";
import {
  cosineSimilarity,
  emptyEmbeddingIndex,
  embeddingIndexPath,
  embeddingModel,
  loadEmbeddingIndex,
  memoryEmbeddingText,
  ollamaEmbedder,
  planEmbeddingRefresh,
  removeEmbedding,
  semanticWeight,
  sweepEmbeddingRefresh,
  upsertEmbedding,
  type Embedder,
} from './embed.js'
import { LEGACY_MANIFEST_FILE, LEGACY_MEMORY_SKILL_NAME, LEGACY_VAULT_FORMAT, MANIFEST_FILE, MEMORY_SKILL_NAME, PRODUCT_NAME, VAULT_FORMAT } from "./brand.js";

const KINDS: MemoryKind[] = ["fact", "preference", "decision", "lesson", "note", "task"];
const SCOPES = ["global", "project", "agent"] as const;
const RECENT_CLOCK_FILE_LIMIT = 30

function compareClock(a: HybridLogicalClock, b: HybridLogicalClock): number {
  return a.wallTime - b.wallTime || a.counter - b.counter || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
}

function cleanSource(source?: MemoryRecord["source"]): MemoryRecord["source"] | undefined {
  if (!source) return undefined;
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === "string" && value.trim())) as NonNullable<MemoryRecord["source"]>;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function filterMemories(values: MemoryRecord[], filter: ListFilter = {}): MemoryRecord[] {
  let filtered = values
  if (filter.kind) filtered = filtered.filter((memory) => memory.kind === filter.kind)
  if (filter.scope) filtered = filtered.filter((memory) => memory.scope.type === filter.scope)
  if (filter.scopeId) filtered = filtered.filter((memory) => memory.scope.id === filter.scopeId)
  if (filter.tags?.length) filtered = filtered.filter((memory) => filter.tags!.every((tag) => memory.tags.includes(tag)))
  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return filtered.slice(0, filter.limit || 100)
}

function validateEvent(value: MemoryEvent, file: string): MemoryEvent {
  const clock = value?.clock;
  if (value?.schemaVersion !== SCHEMA_VERSION || typeof value.eventId !== 'string' || !value.eventId || typeof value.memoryId !== 'string' || !value.memoryId || !clock || !Number.isSafeInteger(clock.wallTime) || clock.wallTime < 0 || !Number.isSafeInteger(clock.counter) || clock.counter < 0 || typeof clock.node !== 'string' || !clock.node || !["put", "delete"].includes(value.op) || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.deviceId !== 'string') {
    throw new Error(`Invalid memory event: ${file}`);
  }
  if (value.op === "put") {
    const r = value.record;
    if (!r || r.id !== value.memoryId || typeof r.content !== 'string' || !r.content.trim() || !KINDS.includes(r.kind) || !SCOPES.includes(r.scope?.type) || (r.scope.id !== undefined && typeof r.scope.id !== 'string') || !Array.isArray(r.tags) || !r.tags.every(t => typeof t === 'string') || (r.title !== undefined && typeof r.title !== 'string') || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt))) throw new Error(`Invalid memory record: ${file}`);
  }
  if (value.parentEventId !== undefined && value.parentEventId !== null && typeof value.parentEventId !== 'string') throw new Error(`Invalid event parent: ${file}`);
  if (value.resolvedEventIds !== undefined && (!Array.isArray(value.resolvedEventIds) || !value.resolvedEventIds.every(id=>typeof id==='string'))) throw new Error(`Invalid event resolution: ${file}`);
  return value;
}

interface EventTree {
  files: string[];
  fingerprint: string;
  pending: string[];
}

interface EventCache {
  version: 2;
  fingerprint: string;
  events: MemoryEvent[];
  issues: VaultIssue[];
}

export interface VaultEmbeddingOptions {
  env?: NodeJS.ProcessEnv
  embedder?: Embedder
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function eventTree(root: string): Promise<EventTree> {
  const found: string[] = [];
  const pending: string[] = [];
  if (await pathExists(root)) await visit(root);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.includes('.pending-')) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
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
  return { files, fingerprint, pending };
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
  readonly embedding: Required<VaultEmbeddingOptions>
  private readonly embeddingVersions = new Map<string, number>()
  private readonly embeddingTasks = new Set<Promise<void>>()
  private readonly embeddingErrors: Error[] = []
  private readIssues: VaultIssue[] = [];

  constructor(root: string, state = new StateStore(), embedding: VaultEmbeddingOptions = {}) {
    this.root = path.resolve(root);
    this.state = state;
    this.embedding = {
      env: embedding.env || process.env,
      embedder: embedding.embedder || ollamaEmbedder,
    }
  }

  get currentManifestPath(): string { return path.join(this.root, MANIFEST_FILE); }
  get legacyManifestPath(): string { return path.join(this.root, LEGACY_MANIFEST_FILE); }
  get manifestPath(): string {
    if (existsSync(this.currentManifestPath)) return this.currentManifestPath;
    if (existsSync(this.legacyManifestPath)) return this.legacyManifestPath;
    return this.currentManifestPath;
  }
  get eventsPath(): string { return path.join(this.root, "memory", "events"); }
  get eventsCachePath(): string { return path.join(this.state.home, 'cache', `${stableId(this.root)}-events.json`); }
  get embeddingsPath(): string { return embeddingIndexPath(this.state.home, this.root) }

  static async init(root: string, name = PRODUCT_NAME, state = new StateStore(), embedding: VaultEmbeddingOptions = {}): Promise<Vault> {
    const vault = new Vault(root, state, embedding);
    await mkdir(vault.eventsPath, { recursive: true });
    await mkdir(path.join(vault.root, "skills"), { recursive: true });
    if (!(await pathExists(vault.manifestPath))) {
      const manifest: VaultManifest = { schemaVersion: SCHEMA_VERSION, vaultId: randomUUID(), name, createdAt: isoDate(), format: VAULT_FORMAT };
      await writeJsonAtomic(vault.currentManifestPath, manifest);
    } else {
      await vault.manifest();
    }
    await ensureBuiltinSkill(vault.root);
    await state.setDefaultVault(vault.root);
    await state.deviceFor(vault.root);
    return vault;
  }

  async manifest(): Promise<VaultManifest> {
    const manifestPath = this.manifestPath;
    if (!(await pathExists(manifestPath))) throw new Error(`Not a Memory Ferry vault: ${this.root}`);
    const value = await readJson<VaultManifest>(manifestPath);
    if (value.schemaVersion !== SCHEMA_VERSION || ![VAULT_FORMAT, LEGACY_VAULT_FORMAT].includes(value.format)) throw new Error(`Unsupported vault format: ${this.root}`);
    if (manifestPath === this.legacyManifestPath) {
      const migrated = { ...value, format: VAULT_FORMAT } satisfies VaultManifest;
      await writeJsonAtomic(this.currentManifestPath, migrated);
      await ensureBuiltinSkill(this.root);
      return migrated;
    }
    if (existsSync(path.join(this.root, "skills", LEGACY_MEMORY_SKILL_NAME)) && !existsSync(path.join(this.root, "skills", MEMORY_SKILL_NAME))) {
      await ensureBuiltinSkill(this.root);
    }
    return value;
  }

  async events(verify = false): Promise<MemoryEvent[]> {
    await this.manifest();
    const tree = await eventTree(this.eventsPath);
    const cacheIsExternal = !pathIsWithin(this.root, this.eventsCachePath);
    if (cacheIsExternal && !verify) {
      try {
        const cached = await readJson<EventCache>(this.eventsCachePath);
        if (cached.version === 2 && cached.fingerprint === tree.fingerprint && Array.isArray(cached.events) && Array.isArray(cached.issues)) {
          this.readIssues = cached.issues;
          return cached.events.map((event, index) => validateEvent(event, `${this.eventsCachePath}#${index}`));
        }
      } catch {
        // A local cache is disposable and must never make Vault reads fail.
      }
    }
    const events: MemoryEvent[] = [];
    const issues: VaultIssue[] = [];
    for (const file of tree.files) {
      try {
        events.push(validateEvent(await readJson<MemoryEvent>(file), file));
      } catch (error) {
        issues.push({ code: error instanceof SyntaxError ? 'invalid-json' : 'invalid-event', path: path.relative(this.root, file), message: error instanceof SyntaxError ? 'Incomplete or damaged JSON; check cloud sync and backups.' : 'Event could not be read or validated; inspect this file before modifying affected memories.' });
      }
    }
    this.readIssues = issues;
    events.sort((a, b) => compareClock(a.clock, b.clock) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    if (cacheIsExternal) {
      try {
        await writeJsonAtomic(this.eventsCachePath, { version: 2, fingerprint: tree.fingerprint, events, issues } satisfies EventCache);
      } catch {
        // Cache writes are best-effort and stay outside the synchronized Vault.
      }
    }
    return events;
  }

  async health(): Promise<VaultHealth> {
    const events = await this.events(true);
    const tree = await eventTree(this.eventsPath);
    const clocks = new Set(events.map(e => JSON.stringify([e.clock.wallTime, e.clock.counter, e.clock.node])));
    const duplicateClocks = events.length - clocks.size;
    const issues = [...this.readIssues, ...tree.pending.map(file => ({ code: 'pending-file', path: path.relative(this.root, file), message: 'An unfinished write or sync is present; do not delete it automatically.' }))];
    if (duplicateClocks) issues.push({ code: 'duplicate-clock', path: 'memory/events', message: `${duplicateClocks} historical event clock collisions; all events are preserved.` });
    const superseded = new Set(events.flatMap(e=>[...(e.parentEventId ? [e.parentEventId] : []),...(e.resolvedEventIds || [])]));
    const heads = new Map<string, number>();
    for (const event of events) if (event.parentEventId !== undefined && !superseded.has(event.eventId)) heads.set(event.memoryId,(heads.get(event.memoryId)||0)+1);
    const conflicts = [...heads].filter(([,count])=>count>1);
    for (const [id] of conflicts) issues.push({code:'concurrent-edits',path:`memory:${id}`,message:'Concurrent device versions are retained. Compare memory history and restore the desired version to acknowledge these branches.'});
    return { status: issues.length ? 'warning' : 'healthy', sync: 'unknown', events: events.length, pendingFiles: tree.pending.length, invalidEvents: this.readIssues.length, duplicateClocks, concurrentMemories:conflicts.length, issues };
  }

  get diagnostics(): readonly VaultIssue[] { return this.readIssues; }

  async history(id: string): Promise<Array<MemoryEvent & { current: boolean }>> {
    return (await this.events()).filter(event => event.memoryId === id).reverse().map((event, index) => ({ ...event, current: index === 0 }));
  }

  private memoryLock(id: string): string { return path.join(this.state.home, 'locks', `${stableId(realpathSync(this.root), 24)}-${stableId(id, 24)}`); }

  private async revision(id: string, expectedRevision?: string): Promise<MemoryEvent | undefined> {
    const latest = (await this.history(id))[0];
    if (this.readIssues.length) throw new Error('Vault contains unreadable events. Run doctor and resolve them before changing existing memories.');
    if (expectedRevision !== undefined && latest?.eventId !== expectedRevision) throw new Error('Memory changed since it was opened. Reload and compare its history before saving.');
    return latest;
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

  private async append(op: 'put' | 'delete', memoryId: string, record?: MemoryRecord, parentEventId?: string, restoredFrom?: string, resolvedEventIds?: string[]): Promise<MemoryEvent> {
    await this.manifest()
    const device = await this.state.deviceFor(this.root)
    const recentClocks = await recentEventClocks(this.eventsPath, device.deviceId)
    const clock = await this.state.nextClock(this.root, recentClocks.slice(-20))
    const event: MemoryEvent = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), memoryId, op, clock, createdAt: isoDate(), deviceId: device.deviceId, parentEventId: parentEventId || null, ...(restoredFrom ? { restoredFrom } : {}), ...(resolvedEventIds ? { resolvedEventIds } : {}), ...(record ? { record } : {}) };
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
    this.queueEmbedding(record)
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> { return (await this.current()).get(id); }

  async update(id: string, input: Partial<RememberInput>, expectedRevision?: string): Promise<MemoryRecord> {
    return withFileLock(this.memoryLock(id), async () => {
    const latest = await this.revision(id, expectedRevision);
    const existing = latest?.op === 'put' ? latest.record : undefined;
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
    await this.append("put", id, record, latest?.eventId);
    this.queueEmbedding(record)
    return record;
    });
  }

  async forget(id: string, expectedRevision?: string): Promise<boolean> {
    return withFileLock(this.memoryLock(id), async () => {
    const latest = await this.revision(id, expectedRevision);
    if (!latest || latest.op === 'delete') return false;
    await this.append("delete", id, undefined, latest.eventId);
    this.queueEmbeddingRemoval(id)
    return true;
    });
  }

  async restore(id: string, eventId: string, expectedRevision?: string): Promise<MemoryRecord> {
    return withFileLock(this.memoryLock(id), async () => {
      const latest = await this.revision(id, expectedRevision);
      const history = await this.history(id);
      const historical = history.find(event => event.eventId === eventId && event.op === 'put');
      if (!historical?.record) throw new Error('Restorable memory version not found.');
      const record = { ...historical.record, updatedAt: isoDate() };
      await this.append('put', id, record, latest?.eventId, eventId, history.map(e=>e.eventId));
      this.queueEmbedding(record);
      return record;
    });
  }

  async duplicates(): Promise<Array<{ ids: string[]; title?: string; scope: MemoryRecord['scope'] }>> {
    const groups = new Map<string, MemoryRecord[]>();
    for (const memory of await this.list({ limit: Number.MAX_SAFE_INTEGER })) {
      const key = JSON.stringify([memory.scope.type, memory.scope.id || "", memory.kind, memory.content.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()]);
      groups.set(key, [...(groups.get(key) || []), memory]);
    }
    return [...groups.values()].filter(group => group.length > 1).map(group => ({ ids: group.map(m => m.id), title: group[0].title, scope: group[0].scope }));
  }

  async list(filter: ListFilter = {}): Promise<MemoryRecord[]> {
    return filterMemories([...(await this.current()).values()], filter)
  }

  private queueEmbedding(record: MemoryRecord): void {
    const { embedder, env } = this.embedding
    if ((env.MEMORY_FERRY_EMBED || env.AGENT_VAULT_EMBED) === 'off') return
    const model = embeddingModel(env)
    const version = (this.embeddingVersions.get(record.id) || 0) + 1
    this.embeddingVersions.set(record.id, version)
    this.trackEmbedding(record.id, 'upsert', (async () => {
      if (!(await embedder.available(env))) return
      const vector = await embedder.embed(memoryEmbeddingText(record), model, env)
      if (this.embeddingVersions.get(record.id) !== version) return
      await upsertEmbedding(this.embeddingsPath, model, record.id, vector, record.updatedAt)
    })())
  }

  private queueEmbeddingRemoval(memoryId: string): void {
    this.embeddingVersions.set(memoryId, (this.embeddingVersions.get(memoryId) || 0) + 1)
    const model = embeddingModel(this.embedding.env)
    this.trackEmbedding(memoryId, 'remove', removeEmbedding(this.embeddingsPath, model, memoryId))
  }

  private trackEmbedding(memoryId: string, operation: string, task: Promise<void>): void {
    const tracked = task.catch((cause: unknown) => {
      const error = new Error(`Background embedding ${operation} failed for ${memoryId}`, { cause })
      this.embeddingErrors.push(error)
      if (this.embeddingErrors.length > 20) this.embeddingErrors.shift()
      const code = (cause as NodeJS.ErrnoException | null)?.code || 'UNKNOWN'
      // stderr preserves MCP stdout framing and excludes memory text/vectors.
      console.error(`[Memory Ferry] ${error.message} (${code}); semantic search can rebuild the index.`)
    }).finally(() => this.embeddingTasks.delete(tracked))
    this.embeddingTasks.add(tracked)
  }

  /** Drain this instance's queued index work; report up to 20 failures since the last drain. */
  async flushEmbeddings(): Promise<void> {
    while (this.embeddingTasks.size) await Promise.all([...this.embeddingTasks])
    const errors = this.embeddingErrors.splice(0)
    if (errors.length) throw new AggregateError(errors, 'Background embedding updates failed (see causes).')
  }

  async search(query: string, limit = 10, options: SearchOptions = {}) {
    const allMemories = filterMemories([...(await this.current()).values()], { limit: Number.MAX_SAFE_INTEGER })
    const projectId = options.projectId || this.embedding.env.MEMORY_FERRY_PROJECT;
    const candidates = projectId && !options.allScopes && !options.scope && !options.scopeId ? allMemories.filter(m => m.scope.type === 'global' || m.scope.type === 'project' && m.scope.id === projectId) : allMemories;
    const memories = filterMemories(candidates, { ...options, limit: Number.MAX_SAFE_INTEGER })
    const textResults = searchMemories(memories, query, Number.MAX_SAFE_INTEGER)
    if (options.semantic === false || !query.trim()) return textResults.slice(0, limit)

    const { embedder, env } = this.embedding
    const model = embeddingModel(env)
    const index = await loadEmbeddingIndex(this.embeddingsPath, model)
    const initialIndex = index.model === model ? index : emptyEmbeddingIndex(model)
    const plan = planEmbeddingRefresh(allMemories, initialIndex)
    if (index.model !== model) {
      plan.orphan = planEmbeddingRefresh(allMemories, index).orphan
    }
    const sweep = await sweepEmbeddingRefresh({
      file: this.embeddingsPath,
      model,
      memories: allMemories,
      plan,
      embedder,
      env,
    }).catch(() => ({ index: initialIndex, available: false }))

    const refreshIndex = sweep.index.model === model ? sweep.index : emptyEmbeddingIndex(model)
    const refreshedPlan = planEmbeddingRefresh(allMemories, refreshIndex)
    for (const memoryId of [...refreshedPlan.orphan, ...refreshedPlan.stale]) delete refreshIndex.vectors[memoryId]

    if (!Object.keys(refreshIndex.vectors).length) {
      return textResults.slice(0, limit)
    }

    try {
      const available = sweep.available ?? await embedder.available(env)
      if (!available) return textResults.slice(0, limit)
      const queryVector = await embedder.embed(query, model, env)
      const textScores = new Map(textResults.map((result) => [result.memory.id, result.score]))
      const weight = semanticWeight(env)
      return memories
        .map((memory) => {
          const textScore = textScores.get(memory.id) || 0
          const vector = refreshIndex.vectors[memory.id]?.v
          const cosine = vector ? cosineSimilarity(queryVector, vector) : 0
          return { memory, score: textScore + weight * cosine, textScore, cosine }
        })
        .filter((result) => result.textScore > 0 || result.cosine >= (options.minSimilarity ?? 0.35))
        .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
        .slice(0, limit)
        .map(({ memory, score }) => ({ memory, score }))
    } catch {
      return textResults.slice(0, limit)
    }
  }

  async context(query: string, limit = 8, options: SearchOptions = {}): Promise<string> {
    const seen = new Set<string>();
    const results = (await this.search(query, limit * 4, options)).filter(({memory}) => {
      const key = JSON.stringify([memory.scope.type, memory.scope.id || '', memory.kind, memory.content.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase()]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0,limit);
    if (!results.length) return "No relevant shared memory found.";
    return results.map(({ memory }) => `- [${memory.kind}/${memory.scope.type}${memory.scope.id ? `:${memory.scope.id}` : ""}] ${memory.title ? `${memory.title}: ` : ""}${memory.content} (id: ${memory.id})`).join("\n");
  }
}
