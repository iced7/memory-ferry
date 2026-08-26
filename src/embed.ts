import path from 'node:path'
import type { MemoryRecord } from './types.js'
import { isoDate, readJson, stableId, writeJsonAtomic } from './utils.js'

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface Embedder {
  available(env: NodeJS.ProcessEnv): Promise<boolean>
  embed(text: string, model: string, env: NodeJS.ProcessEnv): Promise<number[]>
}

export interface EmbeddingIndex {
  model: string
  vectors: Record<string, { v: number[]; updatedAt: string }>
}

export interface EmbeddingRefreshPlan {
  valid: string[]
  stale: string[]
  missing: string[]
  orphan: string[]
}

export interface EmbeddingSweepOptions {
  file: string
  model: string
  memories: MemoryRecord[]
  plan: EmbeddingRefreshPlan
  embedder: Embedder
  env: NodeJS.ProcessEnv
  limit?: number
}

const DEFAULT_MODEL = 'nomic-embed-text'
const DEFAULT_HOST = 'http://127.0.0.1:11434'
const indexMutations = new Map<string, Promise<void>>()

function hostFor(env: NodeJS.ProcessEnv): string {
  return (env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/+$/, '')
}

function vectorFrom(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined
  return value as number[]
}

export function embeddingModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_VAULT_EMBED_MODEL?.trim() || DEFAULT_MODEL
}

export function semanticWeight(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_VAULT_SEMANTIC_WEIGHT?.trim()
  const parsed = raw ? Number(raw) : 1.5
  return Number.isFinite(parsed) ? parsed : 1.5
}

export async function embedderAvailable(
  env: NodeJS.ProcessEnv = process.env,
  fetchFunction: FetchFunction = globalThis.fetch,
): Promise<boolean> {
  if (env.AGENT_VAULT_EMBED === 'off') return false
  try {
    const response = await fetchFunction(`${hostFor(env)}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function embedText(
  text: string,
  model?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFunction: FetchFunction = globalThis.fetch,
): Promise<number[]> {
  const resolvedModel = model?.trim() || embeddingModel(env)
  const request = async (endpoint: string, body: Record<string, string>) => fetchFunction(`${hostFor(env)}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  let response = await request('/api/embed', { model: resolvedModel, input: text })
  if (response.status === 404) response = await request('/api/embeddings', { model: resolvedModel, prompt: text })
  if (!response.ok) throw new Error(`Ollama embedding request failed (${response.status}).`)

  const body = await response.json() as { embeddings?: unknown[]; embedding?: unknown }
  const vector = vectorFrom(body.embedding) || vectorFrom(body.embeddings?.[0])
  if (!vector) throw new Error('Ollama returned an invalid embedding vector.')
  return vector
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let magnitudeA = 0
  let magnitudeB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    magnitudeA += a[index] ** 2
    magnitudeB += b[index] ** 2
  }
  if (!magnitudeA || !magnitudeB) return 0
  return Math.max(-1, Math.min(1, dot / Math.sqrt(magnitudeA * magnitudeB)))
}

export function embeddingIndexPath(stateHome: string, vaultRoot: string): string {
  return path.join(stateHome, 'embeddings', `${stableId(path.resolve(vaultRoot))}.json`)
}

export function emptyEmbeddingIndex(model: string): EmbeddingIndex {
  return { model, vectors: {} }
}

export async function loadEmbeddingIndex(file: string, fallbackModel: string): Promise<EmbeddingIndex> {
  try {
    const value = await readJson<EmbeddingIndex>(file)
    if (!value || typeof value.model !== 'string' || !value.vectors || Array.isArray(value.vectors) || typeof value.vectors !== 'object') {
      return emptyEmbeddingIndex(fallbackModel)
    }
    const vectors: EmbeddingIndex['vectors'] = {}
    for (const [memoryId, entry] of Object.entries(value.vectors)) {
      const vector = vectorFrom(entry?.v)
      if (vector && typeof entry.updatedAt === 'string') vectors[memoryId] = { v: vector, updatedAt: entry.updatedAt }
    }
    return { model: value.model, vectors }
  } catch {
    return emptyEmbeddingIndex(fallbackModel)
  }
}

export async function writeEmbeddingIndex(file: string, index: EmbeddingIndex): Promise<void> {
  await writeJsonAtomic(file, index)
}

async function mutateEmbeddingIndex(
  file: string,
  model: string,
  mutate: (index: EmbeddingIndex) => void,
): Promise<void> {
  const previous = indexMutations.get(file) || Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    let index = await loadEmbeddingIndex(file, model)
    if (index.model !== model) index = emptyEmbeddingIndex(model)
    mutate(index)
    await writeEmbeddingIndex(file, index)
  })
  indexMutations.set(file, next)
  try {
    await next
  } finally {
    if (indexMutations.get(file) === next) indexMutations.delete(file)
  }
}

export async function upsertEmbedding(
  file: string,
  model: string,
  memoryId: string,
  vector: number[],
  updatedAt = isoDate(),
): Promise<void> {
  await mutateEmbeddingIndex(file, model, (index) => {
    index.vectors[memoryId] = { v: vector, updatedAt }
  })
}

export async function removeEmbedding(file: string, model: string, memoryId: string): Promise<void> {
  await mutateEmbeddingIndex(file, model, (index) => {
    delete index.vectors[memoryId]
  })
}

export function planEmbeddingRefresh(memories: MemoryRecord[], index: EmbeddingIndex): EmbeddingRefreshPlan {
  const records = new Map(memories.map((memory) => [memory.id, memory]))
  const valid: string[] = []
  const stale: string[] = []
  const orphan: string[] = []

  for (const [memoryId, entry] of Object.entries(index.vectors)) {
    const memory = records.get(memoryId)
    if (!memory) orphan.push(memoryId)
    else if (entry.updatedAt !== memory.updatedAt) stale.push(memoryId)
    else valid.push(memoryId)
  }

  const missing = memories
    .filter((memory) => !index.vectors[memory.id])
    .map((memory) => memory.id)
  return { valid, stale, missing, orphan }
}

export async function sweepEmbeddingRefresh(options: EmbeddingSweepOptions): Promise<void> {
  const { file, model, memories, plan, embedder, env, limit = 25 } = options
  for (const memoryId of plan.orphan) {
    try {
      await removeEmbedding(file, model, memoryId)
    } catch {
      // The local index is disposable; retry cleanup on a later search.
    }
  }

  const records = new Map(memories.map((memory) => [memory.id, memory]))
  const pending = [...plan.stale, ...plan.missing]
    .slice(0, Math.max(0, limit))
    .map((memoryId) => records.get(memoryId))
    .filter((memory): memory is MemoryRecord => Boolean(memory))
  if (!pending.length || env.AGENT_VAULT_EMBED === 'off') return

  try {
    if (!(await embedder.available(env))) return
  } catch {
    return
  }

  for (const memory of pending) {
    try {
      const vector = await embedder.embed(memoryEmbeddingText(memory), model, env)
      await upsertEmbedding(file, model, memory.id, vector, memory.updatedAt)
    } catch {
      // A failed record must not prevent other missing vectors from healing.
    }
  }
}

export function memoryEmbeddingText(memory: MemoryRecord): string {
  return [memory.title, memory.content, ...memory.tags].filter(Boolean).join('\n')
}

export const ollamaEmbedder: Embedder = {
  available: (env) => embedderAvailable(env),
  embed: (text, model, env) => embedText(text, model, env),
}
