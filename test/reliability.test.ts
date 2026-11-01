import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { StateStore } from '../src/state.js';
import { Vault } from '../src/vault.js';
import { unavailableEmbedding, testEnv } from './helpers.js';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-ferry-reliability-'));
  const state = new StateStore(path.join(root, 'state'));
  const vault = await Vault.init(path.join(root, 'vault'), 'Reliability', state, unavailableEmbedding);
  return { root, state, vault };
}

test('independent processes allocate unique clocks and preserve disjoint patches', { timeout: 60_000 }, async () => {
  const { vault, state } = await fixture();
  const memory = await vault.remember({ content: 'Original' });
  const worker = `
    import { Vault } from './src/vault.ts';
    import { StateStore } from './src/state.ts';
    const v = new Vault(process.argv[1], new StateStore(process.argv[2]), {env:{MEMORY_FERRY_EMBED:'off'}});
    const i = Number(process.argv[4]);
    for (let n=0;n<10;n++) await v.remember({content:'Worker '+i+' item '+n});
    await v.update(process.argv[3], i===0 ? {title:'Updated title'} : i===1 ? {content:'Updated content'} : i===2 ? {tags:['updated']} : {kind:'decision'});
  `;
  await Promise.all(Array.from({length: 8}, (_, i) => exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, vault.root, state.home, memory.id, String(i)], {env: testEnv()})));
  const events = await vault.events(true);
  assert.equal(events.length, 89);
  assert.equal(new Set(events.map(e => JSON.stringify([e.clock.node,e.clock.wallTime,e.clock.counter]))).size, events.length);
  const result = await vault.get(memory.id);
  assert.equal(result?.title, 'Updated title');
  assert.equal(result?.content, 'Updated content');
  assert.equal(result?.kind, 'decision');
  assert.deepEqual(result?.tags, ['updated']);
  const history = await vault.history(memory.id);
  assert.equal(history.length, 9);
  for (let i=0;i<history.length-1;i++) assert.equal(history[i].parentEventId, history[i+1].eventId);
});

test('stale edits are rejected and deleted memories can be restored without erasing history', async () => {
  const { vault } = await fixture();
  const memory = await vault.remember({content:'Version one'});
  const first = (await vault.history(memory.id))[0].eventId;
  await vault.update(memory.id, {content:'Version two'}, first);
  await assert.rejects(vault.update(memory.id, {content:'Stale'}, first), /changed since/);
  await assert.rejects(vault.forget(memory.id, first), /changed since/);
  await vault.forget(memory.id);
  const deleted = (await vault.history(memory.id))[0].eventId;
  await assert.rejects(vault.restore(memory.id, first, first), /changed since/);
  const restored = await vault.restore(memory.id, first, deleted);
  assert.equal(restored.content, 'Version one');
  const history = await vault.history(memory.id);
  assert.equal(history.length, 4);
  assert.equal(history[0].restoredFrom, first);
  assert.equal(history[0].parentEventId, deleted);
  assert.equal(history.filter(e=>e.current).length, 1);
});

test('doctor reports damaged, invalid and unfinished files while preserving valid reads', async () => {
  const { vault } = await fixture();
  const memory = await vault.remember({content:'Readable'});
  await writeFile(path.join(vault.eventsPath, 'broken.json'), '{"incomplete":');
  await writeFile(path.join(vault.eventsPath, 'invalid.json'), '{}');
  await writeFile(path.join(vault.eventsPath, 'event.json.pending-crash'), '{');
  const health = await vault.health();
  assert.equal(health.status, 'warning');
  assert.equal(health.sync, 'unknown');
  assert.equal(health.invalidEvents, 2);
  assert.equal(health.pendingFiles, 1);
  assert.equal((await vault.list()).length, 1);
  assert.equal(vault.diagnostics.length, 2);
  await assert.rejects(vault.update(memory.id, {content:'Unsafe partial view'}), /unreadable events/);
  await assert.rejects(vault.forget(memory.id), /unreadable events/);
  assert.equal(await readFile(path.join(vault.eventsPath, 'broken.json'), 'utf8'), '{"incomplete":');
});

test('offline device histories converge after folder synchronization and retain both versions', async () => {
  const { vault, root } = await fixture();
  const memory = await vault.remember({content:'Shared base'});
  const otherRoot = path.join(root, 'other-vault');
  await cp(vault.root, otherRoot, {recursive:true});
  const other = new Vault(otherRoot, new StateStore(path.join(root,'other-state')), unavailableEmbedding);
  await vault.update(memory.id, {content:'Device A'});
  await other.update(memory.id, {content:'Device B'});
  await cp(other.eventsPath, vault.eventsPath, {recursive:true});
  await cp(vault.eventsPath, other.eventsPath, {recursive:true});
  assert.deepEqual(await vault.get(memory.id), await other.get(memory.id));
  const history = await vault.history(memory.id);
  assert.equal(history.length, 3);
  assert.deepEqual(new Set(history.map(e=>e.record?.content)),new Set(['Shared base','Device A','Device B']));
  assert.equal((await vault.health()).duplicateClocks,0);
  assert.equal((await vault.health()).concurrentMemories,1);
  await vault.restore(memory.id,history[0].eventId,history[0].eventId);
  assert.equal((await vault.health()).concurrentMemories,0);
});

test('doctor verifies file contents even when a cache fingerprint is unchanged', async () => {
  const { vault } = await fixture();
  await vault.remember({content:'Cache check'});
  await vault.events();
  const cached = JSON.parse(await readFile(vault.eventsCachePath,'utf8'));
  cached.events[0].record.content = 'Poisoned local cache';
  await writeFile(vault.eventsCachePath,JSON.stringify(cached));
  await vault.health();
  assert.equal((await vault.list())[0].content, 'Cache check');
});
