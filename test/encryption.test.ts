import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { LOCKED_VAULT_MESSAGE } from '../src/encryption.js'
import { createMcpServer } from '../src/mcp.js'
import { StateStore } from '../src/state.js'
import type { MemoryEvent } from '../src/types.js'
import { startUiServer } from '../src/ui.js'
import { pathExists } from '../src/utils.js'
import { Vault } from '../src/vault.js'
import { testEnv, unavailableEmbedding } from './helpers.js'

const execFileAsync = promisify(execFile)
const cli = ['--import', 'tsx', 'src/cli.ts']

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-vault-encryption-${name}-`))
  const stateHome = path.join(root, 'state')
  const vaultRoot = path.join(root, 'vault')
  const state = new StateStore(stateHome)
  const env = {
    ...testEnv(),
    AGENT_VAULT_HOME: stateHome,
    AGENT_VAULT_EMBED: 'off',
  }
  return { root, stateHome, vaultRoot, state, env }
}

async function filesWithin(root: string): Promise<string[]> {
  const files: string[] = []
  if (!(await pathExists(root))) return files
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

async function eventFiles(vault: Vault): Promise<string[]> {
  return (await filesWithin(vault.eventsPath)).filter((file) => file.endsWith('.json'))
}

async function rawEvents(vault: Vault): Promise<string[]> {
  return await Promise.all((await eventFiles(vault)).map((file) => readFile(file, 'utf8')))
}

test('init --encrypt supports encrypted CRUD without plaintext event content', async () => {
  const { state, stateHome, vaultRoot, env } = await fixture('roundtrip')
  await execFileAsync(process.execPath, [...cli, 'init', vaultRoot, '--encrypt', '--passphrase', 'correct horse battery staple'], { env })
  const vault = new Vault(vaultRoot, state, unavailableEmbedding)

  const created = await vault.remember({ content: 'cloud secret alpha', kind: 'decision' })
  assert.equal((await vault.get(created.id))?.content, 'cloud secret alpha')
  assert.equal((await vault.search('secret', 10, { semantic: false }))[0].memory.id, created.id)
  const updated = await vault.update(created.id, { content: 'cloud secret beta' })
  assert.equal((await vault.get(created.id))?.content, updated.content)

  for (const raw of await rawEvents(vault)) {
    assert.doesNotMatch(raw, /cloud secret/)
    const event = JSON.parse(raw) as MemoryEvent
    assert.equal(event.record, undefined)
    assert.equal(typeof event.ciphertext, 'string')
  }

  assert.equal(await vault.forget(created.id), true)
  assert.equal(await vault.get(created.id), undefined)
  const events = await vault.events()
  assert.deepEqual(events.map((event) => event.op), ['put', 'put', 'delete'])
  assert.ok(events[1].clock.wallTime > events[0].clock.wallTime || events[1].clock.counter > events[0].clock.counter)
  assert.ok(events[2].clock.wallTime > events[1].clock.wallTime || events[2].clock.counter > events[1].clock.counter)

  assert.equal(path.relative(vault.root, vault.keyPath).startsWith('..'), true)
  assert.equal(vault.keyPath.startsWith(path.join(stateHome, 'keys')), true)
  assert.equal((await stat(vault.keyPath)).mode & 0o777, 0o600)
})

test('wrong unlock passphrase fails without creating a keyring entry', async () => {
  const { state, vaultRoot, env } = await fixture('wrong-passphrase')
  const vault = await Vault.init(vaultRoot, 'Encrypted', state, unavailableEmbedding, { passphrase: 'right passphrase' })
  await vault.remember({ content: 'authentication probe' })
  await execFileAsync(process.execPath, [...cli, 'lock', vaultRoot], { env })
  assert.equal(await pathExists(vault.keyPath), false)

  await assert.rejects(
    () => execFileAsync(process.execPath, [...cli, 'unlock', vaultRoot, '--passphrase', 'wrong passphrase'], { env }),
    /Incorrect passphrase/,
  )
  assert.equal(await pathExists(vault.keyPath), false)
  await execFileAsync(process.execPath, [...cli, 'unlock', vaultRoot, '--passphrase', 'right passphrase'], { env })
  assert.equal((await vault.list())[0].content, 'authentication probe')
})

test('locked vault rejects memory operations while status remains available', async (t) => {
  const { state, vaultRoot, env } = await fixture('locked')
  const vault = await Vault.init(vaultRoot, 'Encrypted', state, unavailableEmbedding, { passphrase: 'lock test passphrase' })
  const memory = await vault.remember({ content: 'locked content' })
  await vault.lock()

  await assert.rejects(() => vault.remember({ content: 'must fail' }), new RegExp(LOCKED_VAULT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await assert.rejects(() => vault.get(memory.id), /Vault is encrypted and not unlocked/)
  await assert.rejects(() => vault.update(memory.id, { content: 'must fail' }), /Vault is encrypted and not unlocked/)
  await assert.rejects(() => vault.forget(memory.id), /Vault is encrypted and not unlocked/)
  await assert.rejects(() => vault.search('locked'), /Vault is encrypted and not unlocked/)
  assert.deepEqual(await vault.status(), { encrypted: true, unlocked: false, memories: 1, events: 1 })
  const cliStatus = await execFileAsync(process.execPath, [...cli, 'status', '--vault', vaultRoot, '--json'], { env })
  assert.deepEqual(
    (({ encrypted, unlocked, memories, events }) => ({ encrypted, unlocked, memories, events }))(JSON.parse(cliStatus.stdout)),
    { encrypted: true, unlocked: false, memories: 1, events: 1 },
  )

  const server = createMcpServer(vault)
  const client = new Client({ name: 'encryption-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(() => client.close())

  const get = await client.callTool({ name: 'memory_get', arguments: { id: memory.id } })
  assert.equal(get.isError, true)
  assert.match((get.content[0] as { text: string }).text, /Vault is encrypted and not unlocked/)
  const remember = await client.callTool({ name: 'memory_remember', arguments: { content: 'must fail' } })
  assert.equal(remember.isError, true)
  assert.match((remember.content[0] as { text: string }).text, /Vault is encrypted and not unlocked/)
  const statusResult = await client.callTool({ name: 'vault_status', arguments: {} })
  assert.equal(statusResult.isError, undefined)
  assert.match((statusResult.content[0] as { text: string }).text, /"encrypted": true/)
  assert.match((statusResult.content[0] as { text: string }).text, /"unlocked": false/)
})

test('encrypt upgrades every plaintext put and rejects a second upgrade', async () => {
  const { state, vaultRoot, env } = await fixture('upgrade')
  const vault = await Vault.init(vaultRoot, 'Plaintext', state, unavailableEmbedding)
  const first = await vault.remember({ content: 'plaintext original one' })
  const second = await vault.remember({ content: 'plaintext original two' })

  const result = await execFileAsync(process.execPath, [...cli, 'encrypt', vaultRoot, '--passphrase', 'upgrade passphrase', '--json'], { env })
  assert.match(result.stderr, /Run this only when all other devices have finished syncing this vault/)
  const manifest = await vault.manifest()
  assert.equal(manifest.encryption?.algo, 'chacha20-poly1305')
  assert.equal(manifest.encryption?.kdf, 'scrypt')
  for (const raw of await rawEvents(vault)) {
    assert.doesNotMatch(raw, /plaintext original/)
    const event = JSON.parse(raw) as MemoryEvent
    assert.equal(event.record, undefined)
    assert.equal(typeof event.ciphertext, 'string')
  }
  assert.equal((await vault.get(first.id))?.content, 'plaintext original one')
  assert.equal((await vault.get(second.id))?.content, 'plaintext original two')

  await assert.rejects(
    () => execFileAsync(process.execPath, [...cli, 'encrypt', vaultRoot, '--passphrase', 'upgrade passphrase'], { env }),
    /Vault is already encrypted/,
  )
})

test('failed plaintext conversion leaves the manifest and all event files intact', async () => {
  const { state, vaultRoot } = await fixture('rollback')
  const vault = await Vault.init(vaultRoot, 'Plaintext', state, unavailableEmbedding)
  await vault.remember({ content: 'rollback first' })
  await vault.remember({ content: 'rollback second' })
  const files = await eventFiles(vault)
  const originals = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file)] as const)))
  const originalManifest = await readFile(vault.manifestPath)
  await chmod(files.at(-1)!, 0o444)

  await assert.rejects(() => vault.encrypt('rollback passphrase'), /read-only event file/)
  assert.deepEqual(await readFile(vault.manifestPath), originalManifest)
  for (const [file, original] of originals) assert.deepEqual(await readFile(file), original)
  assert.equal((await vault.manifest()).encryption, undefined)
  assert.equal((await vault.current()).size, 2)
  assert.equal(await pathExists(vault.keyPath), false)
  assert.equal((await filesWithin(vault.eventsPath)).some((file) => file.includes('pending-')), false)
  await chmod(files.at(-1)!, 0o600)
})

test('encrypted event envelopes preserve delete convergence while locked', async () => {
  const { state, vaultRoot } = await fixture('convergence')
  const vault = await Vault.init(vaultRoot, 'Encrypted', state, unavailableEmbedding, { passphrase: 'convergence passphrase' })
  const memory = await vault.remember({ content: 'event ordering secret' })
  const put = (await vault.events())[0]
  const deletion: MemoryEvent = {
    schemaVersion: put.schemaVersion,
    eventId: `${put.eventId}z`,
    memoryId: put.memoryId,
    op: 'delete',
    clock: put.clock,
    createdAt: put.createdAt,
    deviceId: put.deviceId,
  }
  await writeFile(path.join(vault.eventsPath, 'same-clock-delete.json'), `${JSON.stringify(deletion, null, 2)}\n`, 'utf8')
  await vault.lock()

  const events = await vault.events()
  assert.equal(events.length, 2)
  assert.equal(events[0].memoryId, events[1].memoryId)
  assert.equal(events[0].op, 'put')
  assert.equal(events[1].op, 'delete')
  assert.deepEqual(events[1].clock, events[0].clock)
  assert.ok(events[1].eventId > events[0].eventId)
  assert.equal(events[1].record, undefined)
  assert.equal(events[1].ciphertext, undefined)
  assert.deepEqual(await vault.status(), { encrypted: true, unlocked: false, memories: 0, events: 2 })
})

test('aes-256-gcm manifests round-trip records', async () => {
  const { state, vaultRoot } = await fixture('aes')
  const vault = await Vault.init(vaultRoot, 'AES', state, unavailableEmbedding, {
    passphrase: 'aes passphrase',
    algo: 'aes-256-gcm',
  })
  const memory = await vault.remember({ content: 'aes protected content' })
  assert.equal((await vault.get(memory.id))?.content, memory.content)
  assert.doesNotMatch((await rawEvents(vault))[0], /aes protected content/)
})

test('encrypted event validation forbids plaintext records on put events', async () => {
  const { state, vaultRoot } = await fixture('validation')
  const vault = await Vault.init(vaultRoot, 'Encrypted', state, unavailableEmbedding, { passphrase: 'validation passphrase' })
  const memory = await vault.remember({ content: 'validation secret' })
  const file = (await eventFiles(vault))[0]
  const event = JSON.parse(await readFile(file, 'utf8')) as MemoryEvent
  event.record = memory
  await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, 'utf8')

  await assert.rejects(() => vault.events(), /Encrypted put event contains a plaintext record/)
})

test('dashboard status reports locked encrypted vault counts', async (t) => {
  const { root, state, vaultRoot } = await fixture('ui-status')
  const vault = await Vault.init(vaultRoot, 'Encrypted', state, unavailableEmbedding, { passphrase: 'ui passphrase' })
  await vault.remember({ content: 'dashboard secret' })
  await vault.lock()
  const handle = await startUiServer({
    state,
    cliPath: path.join(root, 'dist', 'cli.js'),
    homeDir: path.join(root, 'home'),
    env: testEnv({ PATH: '' }),
    platform: 'darwin',
    host: '127.0.0.1',
    port: 0,
    open: false,
  })
  t.after(() => handle.close())

  const response = await fetch(`${handle.url}/api/status`, { headers: { 'x-agent-vault-token': handle.token } })
  const status = await response.json() as { vault: Record<string, unknown>; vaultError?: string }
  assert.equal(response.status, 200)
  assert.equal(status.vault.encrypted, true)
  assert.equal(status.vault.unlocked, false)
  assert.equal(status.vault.memories, 1)
  assert.equal(status.vaultError, undefined)
})
