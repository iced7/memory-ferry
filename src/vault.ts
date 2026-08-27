import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { HybridLogicalClock, ListFilter, MemoryEvent, MemoryKind, MemoryRecord, RememberInput, SearchOptions, VaultManifest } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { StateStore } from "./state.js";
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
  return a.wallTime - b.wallTime || a.counter - b.counter || a.node.localeCompare(b.node);
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
  readonly embedding: Required<VaultEmbeddingOptions>
  private readonly embeddingVersions = new Map<string, number>()

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
    this.queueEmbedding(record)
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
    this.queueEmbedding(record)
    return record;
  }

  async forget(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.append("delete", id);
    this.queueEmbeddingRemoval(id)
    return true;
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
    void (async () => {
      if (!(await embedder.available(env))) return
      const vector = await embedder.embed(memoryEmbeddingText(record), model, env)
      if (this.embeddingVersions.get(record.id) !== version) return
      await upsertEmbedding(this.embeddingsPath, model, record.id, vector, record.updatedAt)
    })().catch(() => undefined)
  }

  private queueEmbeddingRemoval(memoryId: string): void {
    this.embeddingVersions.set(memoryId, (this.embeddingVersions.get(memoryId) || 0) + 1)
    const model = embeddingModel(this.embedding.env)
    void removeEmbedding(this.embeddingsPath, model, memoryId).catch(() => undefined)
  }

  async search(query: string, limit = 10, options: SearchOptions = {}) {
    const allMemories = filterMemories([...(await this.current()).values()], { limit: Number.MAX_SAFE_INTEGER })
    const memories = filterMemories(allMemories, { ...options, limit: Number.MAX_SAFE_INTEGER })
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
        .filter((result) => result.textScore > 0 || result.cosine > 0)
        .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
        .slice(0, limit)
        .map(({ memory, score }) => ({ memory, score }))
    } catch {
      return textResults.slice(0, limit)
    }
  }

  async context(query: string, limit = 8, options: Pick<SearchOptions, 'semantic'> = {}): Promise<string> {
    const results = await this.search(query, limit, options);
    if (!results.length) return "No relevant shared memory found.";
    return results.map(({ memory }) => `- [${memory.kind}/${memory.scope.type}${memory.scope.id ? `:${memory.scope.id}` : ""}] ${memory.title ? `${memory.title}: ` : ""}${memory.content} (id: ${memory.id})`).join("\n");
  }
}
