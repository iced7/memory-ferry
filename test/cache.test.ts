import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/state.js'
import type { MemoryRecord } from '../src/types.js'
import { pathExists, stableId } from '../src/utils.js'
import { Vault } from '../src/vault.js'
import { unavailableEmbedding } from './helpers.js'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-cache-test-'))
  const state = new StateStore(path.join(root, 'local-state'))
  const vault = await Vault.init(path.join(root, 'synced'), 'Cache Test', state, unavailableEmbedding)
  return { root, state, vault }
}

async function filesWithin(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.push(full)
    }
  }

  await visit(root)
  return files.sort()
}

async function readCache(vault: Vault): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(vault.eventsCachePath, 'utf8')) as Record<string, unknown>
}

function memoryShape(memory: MemoryRecord | undefined) {
  if (!memory) return undefined
  return {
    content: memory.content,
    title: memory.title,
    kind: memory.kind,
    scope: memory.scope,
    tags: memory.tags,
    source: memory.source,
  }
}

test('builds an event cache on a miss and reuses it on the next read', async () => {
  const { vault } = await fixture()
  const created = await vault.remember({ content: 'Cached memory', kind: 'fact' })

  const first = await vault.events()
  assert.equal(first.length, 1)
  assert.equal(first[0].memoryId, created.id)

  const cache = await readCache(vault)
  assert.equal(typeof cache.fingerprint, 'string')
  assert.equal((cache.events as unknown[]).length, 1)
  cache.hitMarker = true
  await writeFile(vault.eventsCachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')

  const second = await vault.events()
  assert.deepEqual(second, first)
  assert.equal((await readCache(vault)).hitMarker, true)
})

test('invalidates the event cache when event files are added or deleted', async () => {
  const { vault } = await fixture()
  await vault.remember({ content: 'First memory' })
  assert.equal((await vault.events()).length, 1)
  const firstFingerprint = (await readCache(vault)).fingerprint

  await vault.remember({ content: 'Second memory' })
  const added = await vault.events()
  assert.equal(added.length, 2)
  const secondFingerprint = (await readCache(vault)).fingerprint
  assert.notEqual(secondFingerprint, firstFingerprint)

  const eventFiles = await filesWithin(vault.eventsPath)
  assert.equal(eventFiles.length, 2)
  await rm(eventFiles[0])

  const afterDelete = await vault.events()
  assert.equal(afterDelete.length, 1)
  assert.notEqual((await readCache(vault)).fingerprint, secondFingerprint)
})

test('silently rebuilds a corrupt event cache', async () => {
  const { vault } = await fixture()
  const created = await vault.remember({ content: 'Source of truth' })
  await vault.events()
  await writeFile(vault.eventsCachePath, '{broken cache', 'utf8')

  const events = await vault.events()
  assert.equal(events.length, 1)
  assert.equal(events[0].memoryId, created.id)
  assert.equal(typeof (await readCache(vault)).fingerprint, 'string')
})

test('keeps CRUD behavior identical with a prepopulated event cache', async () => {
  async function runCrud(vault: Vault) {
    const created = await vault.remember({
      content: 'Use the shared cache',
      title: 'Cache policy',
      kind: 'decision',
      scope: 'project',
      scopeId: 'atlas',
      tags: ['performance', 'performance'],
    })
    const afterCreate = memoryShape(await vault.get(created.id))
    const updated = await vault.update(created.id, { content: 'Use the local event cache', tags: ['performance', 'local'] })
    const afterUpdate = memoryShape(await vault.get(created.id))
    const forgotten = await vault.forget(created.id)
    const forgottenAgain = await vault.forget(created.id)
    return {
      created: memoryShape(created),
      afterCreate,
      updated: memoryShape(updated),
      afterUpdate,
      forgotten,
      forgottenAgain,
      currentSize: (await vault.current()).size,
      operations: (await vault.events()).map((event) => event.op),
    }
  }

  const cold = await fixture()
  const warm = await fixture()
  await warm.vault.events()

  assert.deepEqual(await runCrud(warm.vault), await runCrud(cold.vault))
})

test('stores event caches only in local state, never in the synced vault', async () => {
  const { state, vault } = await fixture()
  const created = await vault.remember({ content: 'Keep sync append-only' })
  await vault.update(created.id, { title: 'Local caches only' })
  await vault.events()

  assert.equal(vault.eventsCachePath, path.join(state.home, 'cache', `${stableId(vault.root)}-events.json`))
  assert.equal(path.relative(vault.root, vault.eventsCachePath).startsWith('..'), true)
  assert.equal(typeof (await readCache(vault)).fingerprint, 'string')

  const relativeFiles = (await filesWithin(vault.root)).map((file) => path.relative(vault.root, file).split(path.sep).join('/'))
  assert.ok(relativeFiles.every((file) =>
    file === 'agent-vault.json'
    || file.startsWith('skills/')
    || file.startsWith('memory/events/') && file.endsWith('.json')
  ))
  assert.equal(relativeFiles.some((file) => file.includes('cache')), false)

  const nestedState = new StateStore(path.join(vault.root, 'local-state'))
  const nestedStateVault = new Vault(vault.root, nestedState)
  await nestedStateVault.events()
  assert.equal(await pathExists(nestedStateVault.eventsCachePath), false)
})
