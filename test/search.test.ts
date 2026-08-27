import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  embeddingIndexPath,
  loadEmbeddingIndex,
  planEmbeddingRefresh,
  sweepEmbeddingRefresh,
  type Embedder,
  type EmbeddingIndex,
  writeEmbeddingIndex,
} from '../src/embed.js'
import { searchMemories } from '../src/search.js'
import { StateStore } from '../src/state.js'
import type { MemoryRecord } from '../src/types.js'
import { stableId } from '../src/utils.js'
import { Vault } from '../src/vault.js'
import { unavailableEmbedding } from './helpers.js'

const MODEL = 'test-embed-model'

function memory(id: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content: `memory ${id}`,
    kind: 'note',
    scope: { type: 'global' },
    tags: [],
    createdAt: updatedAt,
    updatedAt,
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-search-test-'))
  const state = new StateStore(path.join(root, 'state'))
  const vault = await Vault.init(path.join(root, 'synced'), 'Semantic Test', state, unavailableEmbedding)
  return { root, state, vault }
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for background embedding update')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('hybrid ranking blends cosine similarity with the existing text score', async () => {
  const { state, vault } = await fixture()
  const blended = await vault.remember({ content: 'alpha linked' })
  const semantic = await vault.remember({ content: 'conceptual neighbor' })
  const textOnly = await vault.remember({ content: 'alpha unrelated' })
  const memories = await vault.list()
  const textReference = searchMemories(memories, 'alpha beta', Number.MAX_SAFE_INTEGER)
  const textScore = new Map(textReference.map((result) => [result.memory.id, result.score]))
  await writeEmbeddingIndex(vault.embeddingsPath, {
    model: MODEL,
    vectors: {
      [blended.id]: { v: [0.8, 0.6], updatedAt: blended.updatedAt },
      [semantic.id]: { v: [1, 0], updatedAt: semantic.updatedAt },
      [textOnly.id]: { v: [0, 1], updatedAt: textOnly.updatedAt },
    },
  })
  const embedder: Embedder = {
    available: async () => true,
    embed: async () => [1, 0],
  }
  const hybridVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL, AGENT_VAULT_SEMANTIC_WEIGHT: '1.5' },
    embedder,
  })

  const results = await hybridVault.search('alpha beta', 10)
  assert.deepEqual(results.map((result) => result.memory.id), [blended.id, semantic.id, textOnly.id])
  assert.ok(results.findIndex((result) => result.memory.id === semantic.id) < results.findIndex((result) => result.memory.id === textOnly.id))
  assert.ok(Math.abs(results[0].score - ((textScore.get(blended.id) || 0) + 1.5 * 0.8)) < 0.000001)
  assert.equal(results[1].score, 1.5)
})

test('unavailable embeddings return exactly the text-search results', async () => {
  const { state, vault } = await fixture()
  const matching = await vault.remember({ content: 'alpha release policy' })
  const unrelated = await vault.remember({ content: 'conceptual neighbor' })
  await writeEmbeddingIndex(vault.embeddingsPath, {
    model: MODEL,
    vectors: { [unrelated.id]: { v: [1, 0], updatedAt: unrelated.updatedAt } },
  })
  const originalNow = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    const expected = searchMemories(await vault.list(), 'alpha', 10)
    const unavailable: Embedder = {
      available: async () => false,
      embed: async () => {
        throw new Error('embed should not be called')
      },
    }
    const actual = await new Vault(vault.root, state, {
      env: { AGENT_VAULT_EMBED_MODEL: MODEL },
      embedder: unavailable,
    }).search('alpha', 10)
    assert.deepEqual(actual, expected)
    assert.equal(actual[0].memory.id, matching.id)
  } finally {
    Date.now = originalNow
  }
})

test('semantic false skips the embedder and preserves text-only search', async () => {
  const { state, vault } = await fixture()
  await vault.remember({ content: 'alpha text match' })
  await writeEmbeddingIndex(vault.embeddingsPath, { model: MODEL, vectors: {} })
  let availableCalls = 0
  const embedder: Embedder = {
    available: async () => {
      availableCalls += 1
      return true
    },
    embed: async () => [1, 0],
  }
  const semanticVault = new Vault(vault.root, state, { env: { AGENT_VAULT_EMBED_MODEL: MODEL }, embedder })
  const originalNow = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    assert.deepEqual(await semanticVault.search('alpha', 10, { semantic: false }), searchMemories(await vault.list(), 'alpha', 10))
  } finally {
    Date.now = originalNow
  }
  assert.equal(availableCalls, 0)
})

test('persists embedding indexes and ignores corrupt files during search', async () => {
  const { state, vault } = await fixture()
  const memory = await vault.remember({ content: 'durable alpha memory' })
  const file = embeddingIndexPath(state.home, vault.root)
  const index = { model: MODEL, vectors: { [memory.id]: { v: [0.2, 0.8], updatedAt: memory.updatedAt } } }
  await writeEmbeddingIndex(file, index)
  assert.deepEqual(await loadEmbeddingIndex(file, MODEL), index)
  assert.equal(file, path.join(state.home, 'embeddings', `${stableId(vault.root)}.json`))
  assert.equal(path.relative(vault.root, file).startsWith('..'), true)

  await writeFile(file, '{corrupt index', 'utf8')
  assert.deepEqual(await loadEmbeddingIndex(file, MODEL), { model: MODEL, vectors: {} })
  const results = await new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => false,
      embed: async () => [1, 0],
    },
  }).search('alpha')
  assert.equal(results[0].memory.id, memory.id)
})

test('remember, update, and forget maintain the local embedding index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-embedding-lifecycle-'))
  const state = new StateStore(path.join(root, 'state'))
  const embedder: Embedder = {
    available: async () => true,
    embed: async (text) => text.includes('updated') ? [0, 1] : [1, 0],
  }
  const vault = await Vault.init(path.join(root, 'synced'), 'Lifecycle Test', state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder,
  })

  const memory = await vault.remember({ content: 'initial value' })
  await waitFor(async () => (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[memory.id]?.v[0] === 1)
  const createdIndex = await loadEmbeddingIndex(vault.embeddingsPath, MODEL)
  assert.deepEqual(createdIndex.vectors[memory.id], { v: [1, 0], updatedAt: memory.updatedAt })

  const updated = await vault.update(memory.id, { content: 'updated value' })
  await waitFor(async () => (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[memory.id]?.v[1] === 1)
  assert.deepEqual((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[memory.id], { v: [0, 1], updatedAt: updated.updatedAt })

  assert.equal(await vault.forget(memory.id), true)
  await waitFor(async () => !(memory.id in (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors))
})

test('forget prevents an in-flight embedding from restoring a stale index entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-embedding-race-'))
  const state = new StateStore(path.join(root, 'state'))
  let releaseEmbedding: (() => void) | undefined
  let markEmbeddingStarted: (() => void) | undefined
  const embeddingBlocked = new Promise<void>((resolve) => {
    releaseEmbedding = resolve
  })
  const embeddingStarted = new Promise<void>((resolve) => {
    markEmbeddingStarted = resolve
  })
  const vault = await Vault.init(path.join(root, 'synced'), 'Race Test', state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => true,
      embed: async () => {
        markEmbeddingStarted?.()
        await embeddingBlocked
        return [1, 0]
      },
    },
  })

  const memory = await vault.remember({ content: 'soon forgotten' })
  await embeddingStarted
  assert.equal(await vault.forget(memory.id), true)
  releaseEmbedding?.()
  await waitFor(async () => !(memory.id in (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[memory.id], undefined)
})

test('empty queries keep the existing recent-memory behavior without embedding', async () => {
  const { state, vault } = await fixture()
  await vault.remember({ content: 'recent memory' })
  let called = false
  const results = await new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => {
        called = true
        return true
      },
      embed: async () => [1, 0],
    },
  }).search('')
  assert.equal(results.length, 1)
  assert.equal(called, false)
})

test('plans valid, stale, missing, and orphan embedding entries', () => {
  const memories = [
    memory('valid', '2026-01-01T00:00:00.000Z'),
    memory('stale', '2026-01-02T00:00:00.000Z'),
    memory('missing', '2026-01-03T00:00:00.000Z'),
  ]
  const index: EmbeddingIndex = {
    model: MODEL,
    vectors: {
      valid: { v: [1, 0], updatedAt: memories[0].updatedAt },
      stale: { v: [1, 0], updatedAt: '2026-01-01T00:00:00.000Z' },
      orphan: { v: [1, 0], updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  }

  assert.deepEqual(planEmbeddingRefresh(memories, index), {
    valid: ['valid'],
    stale: ['stale'],
    missing: ['missing'],
    orphan: ['orphan'],
  })
})

test('the first search backfills and recalls a memory that arrives from another device', async () => {
  const { root, state, vault } = await fixture()
  const remoteVault = await Vault.init(vault.root, 'Remote Device', new StateStore(path.join(root, 'remote-state')), unavailableEmbedding)
  const remote = await remoteVault.remember({ content: 'conceptual neighbor from sync' })
  const embedder: Embedder = {
    available: async () => true,
    embed: async () => [1, 0],
  }
  const searchVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder,
  })

  const results = await searchVault.search('alpha')

  assert.equal(results[0].memory.id, remote.id)
  assert.ok((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[remote.id])
})

test('search excludes a remotely-stale vector and re-embeds the update', async () => {
  const { root, state, vault } = await fixture()
  const remoteVault = await Vault.init(vault.root, 'Remote Device', new StateStore(path.join(root, 'remote-state')), unavailableEmbedding)
  const original = await remoteVault.remember({ content: 'old remote content' })
  await writeEmbeddingIndex(vault.embeddingsPath, {
    model: MODEL,
    vectors: { [original.id]: { v: [1, 0], updatedAt: original.updatedAt } },
  })
  await new Promise((resolve) => setTimeout(resolve, 2))
  const updated = await remoteVault.update(original.id, { content: 'new remote content' })
  const searchVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => true,
      embed: async (text) => text === 'alpha' ? [1, 0] : [0, 1],
    },
  })

  const results = await searchVault.search('alpha')
  assert.equal(results.some((result) => result.memory.id === updated.id), false)
  await waitFor(async () => (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[updated.id]?.updatedAt === updated.updatedAt)
  assert.deepEqual((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[updated.id], {
    v: [0, 1],
    updatedAt: updated.updatedAt,
  })
})

test('search drops an embedding after a remote tombstone', async () => {
  const { root, state, vault } = await fixture()
  const remoteVault = await Vault.init(vault.root, 'Remote Device', new StateStore(path.join(root, 'remote-state')), unavailableEmbedding)
  const deleted = await remoteVault.remember({ content: 'deleted remote concept' })
  const survivor = await remoteVault.remember({ content: 'alpha survivor' })
  await writeEmbeddingIndex(vault.embeddingsPath, {
    model: MODEL,
    vectors: { [deleted.id]: { v: [1, 0], updatedAt: deleted.updatedAt } },
  })
  assert.equal(await remoteVault.forget(deleted.id), true)
  const searchVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => false,
      embed: async () => {
        throw new Error('embedding must not run when unavailable')
      },
    },
  })

  const results = await searchVault.search('alpha')
  assert.equal(results[0].memory.id, survivor.id)
  assert.equal(results.some((result) => result.memory.id === deleted.id), false)
  await waitFor(async () => !(deleted.id in (await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors))
})

test('filtered search keeps embeddings for current memories outside the filter', async () => {
  const { state, vault } = await fixture()
  const note = await vault.remember({ content: 'alpha note', kind: 'note' })
  const preference = await vault.remember({ content: 'other preference', kind: 'preference' })
  await writeEmbeddingIndex(vault.embeddingsPath, {
    model: MODEL,
    vectors: {
      [note.id]: { v: [1, 0], updatedAt: note.updatedAt },
      [preference.id]: { v: [0, 1], updatedAt: preference.updatedAt },
    },
  })
  const searchVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => false,
      embed: async () => {
        throw new Error('embedding must not run when unavailable')
      },
    },
  })

  const results = await searchVault.search('alpha', 10, { kind: 'note' })
  assert.deepEqual(results.map((result) => result.memory.id), [note.id])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors[preference.id])
})

test('search backfills at most 25 missing embeddings per sweep', async () => {
  const { root, state, vault } = await fixture()
  const remoteVault = await Vault.init(vault.root, 'Remote Device', new StateStore(path.join(root, 'remote-state')), unavailableEmbedding)
  for (let index = 0; index < 100; index += 1) {
    await remoteVault.remember({ content: `remote missing ${index.toString().padStart(3, '0')}` })
  }
  let recordEmbeddings = 0
  const searchVault = new Vault(vault.root, state, {
    env: { AGENT_VAULT_EMBED_MODEL: MODEL },
    embedder: {
      available: async () => true,
      embed: async (text) => {
        if (text !== 'query') recordEmbeddings += 1
        return [1, 0]
      },
    },
  })

  await searchVault.search('query')
  await waitFor(async () => Object.keys((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors).length === 25)
  assert.equal(recordEmbeddings, 25)

  await searchVault.search('query')
  await waitFor(async () => Object.keys((await loadEmbeddingIndex(vault.embeddingsPath, MODEL)).vectors).length === 50)
  assert.equal(recordEmbeddings, 50)
})

test('deduplicates concurrent refresh sweeps for the same local index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-embedding-sweep-'))
  const file = path.join(root, 'index.json')
  const memories = [
    memory('first', '2026-01-01T00:00:00.000Z'),
    memory('second', '2026-01-02T00:00:00.000Z'),
  ]
  const plan = planEmbeddingRefresh(memories, { model: MODEL, vectors: {} })
  let availableCalls = 0
  let embeddingCalls = 0
  let releaseEmbedding: (() => void) | undefined
  let markEmbeddingStarted: (() => void) | undefined
  const embeddingBlocked = new Promise<void>((resolve) => {
    releaseEmbedding = resolve
  })
  const embeddingStarted = new Promise<void>((resolve) => {
    markEmbeddingStarted = resolve
  })
  const embedder: Embedder = {
    available: async () => {
      availableCalls += 1
      return true
    },
    embed: async () => {
      embeddingCalls += 1
      markEmbeddingStarted?.()
      await embeddingBlocked
      return [1, 0]
    },
  }
  const options = { file, model: MODEL, memories, plan, embedder, env: {} }

  const first = sweepEmbeddingRefresh(options)
  await embeddingStarted
  const second = sweepEmbeddingRefresh(options)
  releaseEmbedding?.()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(availableCalls, 1)
  assert.equal(embeddingCalls, 2)
  assert.deepEqual(firstResult.index, secondResult.index)
  assert.equal(Object.keys((await loadEmbeddingIndex(file, MODEL)).vectors).length, 2)
})
