import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cp, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { seal, unseal } from '../src/encryption.js'
import { createMcpServer } from '../src/mcp.js'
import { migrateVault } from '../src/migration.js'
import { StateStore } from '../src/state.js'
import { startUiServer } from '../src/ui.js'
import { Vault } from '../src/vault.js'
import { testEnv, unavailableEmbedding } from './helpers.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-ferry-encryption-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const state = new StateStore(path.join(root, 'state'))
  return { root, state }
}
async function files(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(file))
    else if (entry.isFile()) result.push(file)
  }
  return result
}

test('authenticated encryption rejects wrong keys, changed purposes, tampering and short tags', () => {
  const key = randomBytes(32)
  const first = seal({ secret: 'payload' }, key, 'purpose-one')
  const second = seal({ secret: 'payload' }, key, 'purpose-one')
  assert.notEqual(first.iv, second.iv)
  assert.deepEqual(unseal(first, key, 'purpose-one'), { secret: 'payload' })
  assert.throws(() => unseal(first, randomBytes(32), 'purpose-one'), /authentication failed/)
  assert.throws(() => unseal(first, key, 'purpose-two'), /authentication failed/)
  assert.throws(() => unseal({ ...first, tag: first.tag.slice(0, 8) }, key, 'purpose-one'), /authentication failed/)
  assert.throws(() => unseal({ ...first, data: Buffer.from('tampered').toString('base64') }, key, 'purpose-one'), /authentication failed/)
})

test('encrypted events, history cache and semantic index contain no plaintext memory or key', async t => {
  const { root, state } = await fixture(t)
  const sentinel = 'PRIVATE-memory-秘密-641926'
  const vault = await Vault.init(path.join(root, 'vault'), 'Encrypted', state, {
    env: { MEMORY_FERRY_EMBED_MODEL: 'synthetic' }, embedder: { available: async () => true, embed: async () => [1, 0] },
  }, { encrypted: true })
  const saved = await vault.remember({ content: sentinel, title: sentinel, tags: [sentinel], source: { uri: sentinel } })
  await vault.flushEmbeddings()
  assert.equal((await vault.search('unrelated semantic query'))[0].memory.id, saved.id)
  await vault.update(saved.id, { content: `${sentinel}-edited` })
  await vault.flushEmbeddings()
  await vault.forget(saved.id)
  await vault.flushEmbeddings()
  await vault.restore(saved.id, (await vault.history(saved.id)).at(-1)!.eventId)
  await vault.flushEmbeddings()
  assert.equal((await vault.list())[0].content, sentinel)
  const status = await vault.privacyStatus()
  const key = JSON.parse(await readFile(status.keyFile!, 'utf8')).key
  for (const file of [...await files(vault.root), ...await files(state.home)]) {
    if (file === status.keyFile) continue
    const content = await readFile(file, 'utf8')
    assert.ok(!content.includes(sentinel), `plaintext leak in ${file}`)
    assert.ok(!content.includes(key), `key leak in ${file}`)
  }
  for (const file of [vault.eventsCachePath, vault.embeddingsPath]) assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'memory-ferry-aes-256-gcm')
  assert.equal((await vault.manifest()).schemaVersion, 2)
  const plain = await Vault.init(path.join(root, 'plain'), 'Default', state, unavailableEmbedding)
  await plain.remember({ content: sentinel })
  assert.equal((await plain.manifest()).schemaVersion, 1)
  assert.ok((await readFile((await files(plain.eventsPath))[0], 'utf8')).includes(sentinel))
})

test('a separate device needs the matching key and locking blocks cached reads and new writes', async t => {
  const { root, state } = await fixture(t)
  const source = await Vault.init(path.join(root, 'source'), 'Encrypted', state, unavailableEmbedding, { encrypted: true })
  const memory = await source.remember({ content: 'portable secret' })
  const replicaRoot = path.join(root, 'replica')
  await cp(source.root, replicaRoot, { recursive: true })
  const replicaState = new StateStore(path.join(root, 'device-b'))
  const replica = new Vault(replicaRoot, replicaState, unavailableEmbedding)
  await assert.rejects(replica.list(), /locked/)
  await assert.rejects(replica.remember({ content: 'must not save' }), /locked/)
  const wrong = await Vault.init(path.join(root, 'wrong'), 'Wrong', state, unavailableEmbedding, { encrypted: true })
  await assert.rejects(replica.unlock((await wrong.privacyStatus()).keyFile!), /another Vault/)
  const importedKey = path.join(root, 'device-b.key')
  await cp((await source.privacyStatus()).keyFile!, importedKey)
  await chmod(importedKey, 0o600)
  await replica.unlock(importedKey)
  assert.equal((await replica.list())[0].id, memory.id)
  await replica.update(memory.id, { content: 'edited on device b' })
  await cp(replica.root, source.root, { recursive: true })
  assert.equal((await source.list())[0].content, 'edited on device b')
  await replica.lock()
  await assert.rejects(replica.list(), /locked/)
  await assert.rejects(replica.update(memory.id, { content: 'blocked' }), /locked/)
  await replica.unlock(importedKey)
  assert.equal((await replica.list())[0].content, 'edited on device b')
  const keyValue = JSON.parse(await readFile(importedKey, 'utf8'))
  keyValue.key = randomBytes(32).toString('base64')
  await writeFile(importedKey, JSON.stringify(keyValue))
  await assert.rejects(replica.list(), /authentication failed/)
})

test('event tampering cannot hide behind cache metadata; pinned encryption refuses downgrade', async t => {
  const { root, state } = await fixture(t)
  const vault = await Vault.init(path.join(root, 'vault'), 'Encrypted', state, unavailableEmbedding, { encrypted: true })
  await vault.remember({ content: 'integrity matters' })
  await vault.list()
  const file = (await files(vault.eventsPath))[0]
  const metadata = await stat(file)
  const original = await readFile(file, 'utf8')
  const envelope = JSON.parse(original)
  envelope.data = (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1)
  await writeFile(file, JSON.stringify(envelope, null, 2) + '\n')
  await utimes(file, metadata.atime, metadata.mtime)
  await assert.rejects(vault.list(), /could not be authenticated/)
  await writeFile(file, original)
  const manifest = await vault.manifest()
  await writeFile(vault.currentManifestPath, JSON.stringify({ ...manifest, schemaVersion: 1, format: 'memory-ferry-events', encryption: undefined }))
  await assert.rejects(vault.remember({ content: 'never downgrade to plaintext' }), /Refusing a downgrade/)
})

test('migration preserves all history and tombstones, re-encrypts per Vault, and requires explicit plaintext export', async t => {
  const { root, state } = await fixture(t)
  const plain = await Vault.init(path.join(root, 'plain'), 'Plain', state, unavailableEmbedding)
  const saved = await plain.remember({ content: 'migration original' })
  await plain.update(saved.id, { content: 'migration edited' })
  await plain.forget(saved.id)
  await plain.flushEmbeddings()
  const encrypted = await Vault.init(path.join(root, 'encrypted'), 'Encrypted', state, unavailableEmbedding, { encrypted: true })
  assert.equal((await migrateVault(plain.root, encrypted.root, { state })).events.copied, 3)
  assert.deepEqual(await encrypted.events(), await plain.events())
  assert.equal((await migrateVault(plain.root, encrypted.root, { state })).events.unchanged, 3)
  const other = await Vault.init(path.join(root, 'other'), 'Other', state, unavailableEmbedding, { encrypted: true })
  await migrateVault(encrypted.root, other.root, { state })
  assert.deepEqual(await other.events(), await plain.events())
  const output = await Vault.init(path.join(root, 'export'), 'Plain output', state, unavailableEmbedding)
  await assert.rejects(migrateVault(encrypted.root, output.root, { state }), /--allow-plaintext/)
  assert.equal((await output.events()).length, 0)
  await migrateVault(encrypted.root, output.root, { state, allowPlaintext: true })
  assert.deepEqual(await output.events(), await plain.events())
  await encrypted.restore(saved.id, (await encrypted.history(saved.id)).at(-1)!.eventId)
  await encrypted.flushEmbeddings()
  assert.equal((await encrypted.list())[0].content, 'migration original')
  assert.equal((await plain.list()).length, 0)
})

test('encryption refuses in-place initialization, synced keys, unsafe key permissions and damaged migration input', async t => {
  const { root, state } = await fixture(t)
  const plain = await Vault.init(path.join(root, 'plain'), 'Plain', state, unavailableEmbedding)
  await assert.rejects(Vault.init(plain.root, 'No overwrite', state, unavailableEmbedding, { encrypted: true }), /empty new folder/)
  await assert.rejects(Vault.init(path.join(root, 'bad-key'), 'Unsafe', state, unavailableEmbedding, { encrypted: true, keyFile: path.join(root, 'bad-key', 'secret.key') }), /outside/)
  await assert.rejects(Vault.init(path.join(root, 'bad-state'), 'Unsafe', new StateStore(path.join(root, 'bad-state', 'state')), unavailableEmbedding, { encrypted: true }), /outside/)
  const encrypted = await Vault.init(path.join(root, 'encrypted'), 'Encrypted', state, unavailableEmbedding, { encrypted: true })
  if (process.platform !== 'win32') {
    const keyFile = (await encrypted.privacyStatus()).keyFile!
    await chmod(keyFile, 0o644)
    await assert.rejects(encrypted.list(), /chmod 600/)
    await chmod(keyFile, 0o600)
    const link = path.join(root, 'linked-vault')
    await symlink(encrypted.root, link, 'dir')
    await assert.rejects(encrypted.unlock(path.join(link, 'key.json')), /outside/)
  }
  await writeFile(path.join(plain.eventsPath, 'damaged.json'), '{')
  await assert.rejects(migrateVault(plain.root, encrypted.root, { state }), /unreadable/)
  assert.equal((await encrypted.events()).length, 0)
})

test('encrypted MCP remembers and recalls across requests, and reports locked state without data', async t => {
  const { root, state } = await fixture(t)
  const vault = await Vault.init(path.join(root, 'vault'), 'MCP encrypted', state, unavailableEmbedding, { encrypted: true })
  const server = createMcpServer(vault)
  const client = new Client({ name: 'encrypted-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  t.after(() => client.close())
  const saved = await client.callTool({ name: 'memory_remember', arguments: { content: 'encrypted MCP sentinel' } })
  assert.ok(!saved.isError)
  assert.match(JSON.stringify((await client.callTool({ name: 'memory_recall', arguments: { query: 'sentinel', semantic: false } })).content), /encrypted MCP sentinel/)
  await vault.lock()
  const blocked = await client.callTool({ name: 'memory_list', arguments: {} })
  assert.equal(blocked.isError, true)
  assert.ok(!JSON.stringify(blocked).includes('encrypted MCP sentinel'))
})

test('dashboard creates optional encrypted Vaults and handles local key removal and import', async t => {
  const { root, state } = await fixture(t)
  await state.setAutoManage(false)
  const handle = await startUiServer({ state, cliPath: path.join(root, 'cli.js'), homeDir: path.join(root, 'home'), env: testEnv({ PATH: '' }), port: 0, open: false })
  t.after(() => handle.close())
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(handle.url + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-memory-ferry-token': handle.token }, body: body ? JSON.stringify(body) : undefined })
    return { response, data: await response.json() as any }
  }
  const created = await api('/api/vault/connect', { path: path.join(root, 'vault'), create: true, encrypted: true })
  assert.equal(created.response.status, 200)
  const selected = (await api('/api/status')).data.vault
  assert.equal(selected.privacy.encrypted, true)
  const keyFile = selected.privacy.keyFile
  const identity = { vaultId: selected.manifest.vaultId }
  assert.equal((await api('/api/vault/lock', identity)).response.status, 200)
  assert.equal((await api('/api/status')).data.vault.privacy.locked, true)
  assert.notEqual((await api('/api/memories')).response.status, 200)
  assert.equal((await api('/api/vault/unlock', { ...identity, keyFile })).response.status, 200)
  assert.equal((await api('/api/status')).data.vault.privacy.locked, false)
})
