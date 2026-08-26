import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HybridLogicalClock, ListFilter, MemoryEvent, MemoryKind, MemoryRecord, RememberInput, SearchOptions, VaultEncryption, VaultManifest } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { StateStore } from "./state.js";
import { searchMemories } from "./search.js";
import { ensureBuiltinSkill } from "./skills.js";
import { isoDate, pathExists, readJson, safeSegment, stableId, uniqueStrings, writeJsonAtomic } from "./utils.js";
import {
  createEncryptionConfig,
  decryptRecord,
  deriveEncryptionKey,
  encryptRecord,
  keyringPath,
  readKey,
  removeKey,
  validateEncryptionConfig,
  writeKey,
} from './encryption.js'
import {
  cosineSimilarity,
  embeddingIndexPath,
  embeddingModel,
  loadEmbeddingIndex,
  memoryEmbeddingText,
  ollamaEmbedder,
  removeEmbedding,
  semanticWeight,
  upsertEmbedding,
  type Embedder,
} from './embed.js'

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

function validateEvent(value: MemoryEvent, file: string, manifest: VaultManifest): MemoryEvent {
  if (value.schemaVersion !== SCHEMA_VERSION || !value.eventId || !value.memoryId || !value.clock || !["put", "delete"].includes(value.op)) {
    throw new Error(`Invalid memory event: ${file}`);
  }
  if (value.op === 'put' && manifest.encryption) {
    if (typeof value.ciphertext !== 'string' || !value.ciphertext) throw new Error(`Encrypted put event is missing ciphertext: ${file}`)
    if (Object.prototype.hasOwnProperty.call(value, 'record')) throw new Error(`Encrypted put event contains a plaintext record: ${file}`)
  } else if (value.op === "put" && !value.record) {
    throw new Error(`Put event is missing record: ${file}`);
  }
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

export interface VaultEncryptionInitOptions {
  passphrase: string
  algo?: VaultEncryption['algo']
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

  get manifestPath(): string { return path.join(this.root, "agent-vault.json"); }
  get eventsPath(): string { return path.join(this.root, "memory", "events"); }
  get eventsCachePath(): string { return path.join(this.state.home, 'cache', `${stableId(this.root)}-events.json`); }
  get embeddingsPath(): string { return embeddingIndexPath(this.state.home, this.root) }
  get keyPath(): string { return keyringPath(this.state.home, this.root) }

  static async init(
    root: string,
    name = "Agent Vault",
    state = new StateStore(),
    embedding: VaultEmbeddingOptions = {},
    encryption?: VaultEncryptionInitOptions,
  ): Promise<Vault> {
    const vault = new Vault(root, state, embedding);
    const exists = await pathExists(vault.manifestPath)
    if (exists && encryption) throw new Error('Encrypted initialization requires a new vault. Use `agent-vault encrypt <path> --passphrase ...` for an existing plaintext vault.')
    await mkdir(vault.eventsPath, { recursive: true });
    await mkdir(path.join(vault.root, "skills"), { recursive: true });
    if (!exists) {
      const encryptionConfig = encryption ? createEncryptionConfig(encryption.algo) : undefined
      const manifest: VaultManifest = {
        schemaVersion: SCHEMA_VERSION,
        vaultId: randomUUID(),
        name,
        createdAt: isoDate(),
        format: "agent-vault-events",
        ...(encryptionConfig ? { encryption: encryptionConfig } : {}),
      };
      if (encryptionConfig) {
        vault.assertExternalKeyring()
        const key = await deriveEncryptionKey(encryption!.passphrase, encryptionConfig)
        await writeKey(vault.keyPath, key)
        try {
          await writeJsonAtomic(vault.manifestPath, manifest)
        } catch (error) {
          await removeKey(vault.keyPath).catch(() => undefined)
          throw error
        }
      } else {
        await writeJsonAtomic(vault.manifestPath, manifest);
      }
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
    if (value.encryption) validateEncryptionConfig(value.encryption)
    return value;
  }

  async events(): Promise<MemoryEvent[]> {
    const manifest = await this.manifest();
    const tree = await eventTree(this.eventsPath);
    const cacheIsExternal = !pathIsWithin(this.root, this.eventsCachePath);
    if (cacheIsExternal) {
      try {
        const cached = await readJson<EventCache>(this.eventsCachePath);
        if (cached.fingerprint === tree.fingerprint && Array.isArray(cached.events)) {
          return cached.events.map((event, index) => validateEvent(event, `${this.eventsCachePath}#${index}`, manifest));
        }
      } catch {
        // A local cache is disposable and must never make Vault reads fail.
      }
    }
    const events: MemoryEvent[] = [];
    for (const file of tree.files) {
      try {
        events.push(validateEvent(await readJson<MemoryEvent>(file), file, manifest));
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
    const manifest = await this.manifest()
    const key = manifest.encryption ? await this.requireKey() : undefined
    const latest = this.latestEvents(await this.events())
    const current = new Map<string, MemoryRecord>();
    for (const [id, event] of latest) {
      if (event.op !== 'put') continue
      if (manifest.encryption) {
        current.set(id, decryptRecord(event.ciphertext!, key!, manifest.encryption.algo))
      } else if (event.record) {
        current.set(id, event.record)
      }
    }
    return current;
  }

  async status(): Promise<{ encrypted: boolean; unlocked: boolean; memories: number; events: number }> {
    const manifest = await this.manifest()
    const events = await this.events()
    const latest = this.latestEvents(events)
    return {
      encrypted: Boolean(manifest.encryption),
      unlocked: !manifest.encryption || await this.isUnlocked(events, manifest.encryption),
      memories: [...latest.values()].filter((event) => event.op === 'put').length,
      events: events.length,
    }
  }

  private async append(op: 'put' | 'delete', memoryId: string, record?: MemoryRecord): Promise<MemoryEvent> {
    const manifest = await this.manifest()
    const key = manifest.encryption ? await this.requireKey() : undefined
    const device = await this.state.deviceFor(this.root)
    const recentClocks = await recentEventClocks(this.eventsPath, device.deviceId)
    const clock = await this.state.nextClock(this.root, recentClocks.slice(-20))
    const event: MemoryEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      memoryId,
      op,
      clock,
      createdAt: isoDate(),
      deviceId: device.deviceId,
      ...(record && manifest.encryption ? { ciphertext: encryptRecord(record, key!, manifest.encryption.algo) } : {}),
      ...(record && !manifest.encryption ? { record } : {}),
    };
    const date = event.createdAt.slice(0, 10);
    const file = path.join(this.eventsPath, safeSegment(device.deviceId), date, `${clock.wallTime}-${clock.counter}-${safeSegment(event.eventId)}.json`);
    await writeJsonAtomic(file, event);
    return event;
  }

  async unlock(passphrase: string): Promise<void> {
    const manifest = await this.manifest()
    if (!manifest.encryption) throw new Error('Vault is not encrypted.')
    this.assertExternalKeyring()
    const key = await deriveEncryptionKey(passphrase, manifest.encryption)
    const put = (await this.events()).find((event) => event.op === 'put')
    if (put) {
      try {
        decryptRecord(put.ciphertext!, key, manifest.encryption.algo)
      } catch {
        throw new Error('Incorrect passphrase for encrypted vault.')
      }
    }
    await writeKey(this.keyPath, key)
  }

  async lock(): Promise<boolean> {
    const manifest = await this.manifest()
    if (!manifest.encryption) throw new Error('Vault is not encrypted.')
    this.assertExternalKeyring()
    return await removeKey(this.keyPath)
  }

  async encrypt(passphrase: string, algo: VaultEncryption['algo'] = 'chacha20-poly1305'): Promise<VaultEncryption> {
    const manifest = await this.manifest()
    if (manifest.encryption) throw new Error('Vault is already encrypted.')
    this.assertExternalKeyring()

    const encryption = createEncryptionConfig(algo)
    const encryptedManifest: VaultManifest = { ...manifest, encryption }
    const key = await deriveEncryptionKey(passphrase, encryption)
    const tree = await eventTree(this.eventsPath)
    const staged: Array<{ file: string; pending: string; original: Buffer; mode: number }> = []

    try {
      for (const file of tree.files) {
        const original = await readFile(file)
        const event = validateEvent(JSON.parse(original.toString('utf8')) as MemoryEvent, file, manifest)
        if (event.op !== 'put') continue
        const metadata = await stat(file)
        if ((metadata.mode & 0o222) === 0) throw new Error(`Cannot convert read-only event file: ${file}`)
        const { record, ...envelope } = event
        const converted: MemoryEvent = {
          ...envelope,
          ciphertext: encryptRecord(record!, key, encryption.algo),
        }
        const pending = `${file}.enc-pending-${process.pid}-${randomUUID()}`
        staged.push({ file, pending, original, mode: metadata.mode & 0o777 })
        await writeFile(pending, `${JSON.stringify(converted, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
        await chmod(pending, metadata.mode & 0o777)
        const verified = validateEvent(await readJson<MemoryEvent>(pending), pending, encryptedManifest)
        if (JSON.stringify(decryptRecord(verified.ciphertext!, key, encryption.algo)) !== JSON.stringify(record)) {
          throw new Error(`Failed to verify converted event: ${file}`)
        }
      }
    } catch (error) {
      await Promise.all(staged.map(({ pending }) => rm(pending, { force: true }).catch(() => undefined)))
      throw error
    }

    const committed: typeof staged = []
    const previousKey = await pathExists(this.keyPath) ? await readFile(this.keyPath) : undefined
    let keyWritten = false
    try {
      for (const item of staged) {
        await rename(item.pending, item.file)
        committed.push(item)
      }
      await writeKey(this.keyPath, key)
      keyWritten = true
      await writeJsonAtomic(this.manifestPath, encryptedManifest)
    } catch (error) {
      await Promise.all(committed.map(async ({ file, original, mode }) => {
        const pending = `${file}.rollback-pending-${process.pid}-${randomUUID()}`
        await writeFile(pending, original)
        await chmod(pending, mode)
        await rename(pending, file)
      }))
      await Promise.all(staged.map(({ pending }) => rm(pending, { force: true }).catch(() => undefined)))
      if (keyWritten) {
        if (previousKey) {
          await writeFile(this.keyPath, previousKey, { mode: 0o600 })
        } else {
          await removeKey(this.keyPath).catch(() => undefined)
        }
      }
      throw error
    }
    await rm(this.eventsCachePath, { force: true }).catch(() => undefined)
    return encryption
  }

  private latestEvents(events: MemoryEvent[]): Map<string, MemoryEvent> {
    const latest = new Map<string, MemoryEvent>()
    for (const event of events) {
      const previous = latest.get(event.memoryId)
      if (!previous || compareClock(event.clock, previous.clock) > 0 || (compareClock(event.clock, previous.clock) === 0 && event.eventId > previous.eventId)) {
        latest.set(event.memoryId, event)
      }
    }
    return latest
  }

  private assertExternalKeyring(): void {
    if (pathIsWithin(this.root, this.keyPath)) {
      throw new Error('The local keyring must be outside the synchronized vault folder.')
    }
  }

  private async requireKey(): Promise<Buffer> {
    this.assertExternalKeyring()
    return await readKey(this.keyPath)
  }

  private async isUnlocked(events: MemoryEvent[], encryption: VaultEncryption): Promise<boolean> {
    this.assertExternalKeyring()
    try {
      const key = await readKey(this.keyPath)
      const put = events.find((event) => event.op === 'put')
      if (put) decryptRecord(put.ciphertext!, key, encryption.algo)
      return true
    } catch {
      return false
    }
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
    let values = [...(await this.current()).values()];
    if (filter.kind) values = values.filter((memory) => memory.kind === filter.kind);
    if (filter.scope) values = values.filter((memory) => memory.scope.type === filter.scope);
    if (filter.scopeId) values = values.filter((memory) => memory.scope.id === filter.scopeId);
    if (filter.tags?.length) values = values.filter((memory) => filter.tags!.every((tag) => memory.tags.includes(tag)));
    values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return values.slice(0, filter.limit || 100);
  }

  private queueEmbedding(record: MemoryRecord): void {
    const { embedder, env } = this.embedding
    if (env.AGENT_VAULT_EMBED === 'off') return
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
    const memories = await this.list({ ...options, limit: Number.MAX_SAFE_INTEGER })
    const textResults = searchMemories(memories, query, Number.MAX_SAFE_INTEGER)
    if (options.semantic === false || !query.trim()) return textResults.slice(0, limit)

    const { embedder, env } = this.embedding
    const model = embeddingModel(env)
    const index = await loadEmbeddingIndex(this.embeddingsPath, model)
    if (index.model !== model || !Object.keys(index.vectors).length) {
      return textResults.slice(0, limit)
    }

    try {
      if (!(await embedder.available(env))) return textResults.slice(0, limit)
      const queryVector = await embedder.embed(query, model, env)
      const textScores = new Map(textResults.map((result) => [result.memory.id, result.score]))
      const weight = semanticWeight(env)
      return memories
        .map((memory) => {
          const textScore = textScores.get(memory.id) || 0
          const vector = index.vectors[memory.id]?.v
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
