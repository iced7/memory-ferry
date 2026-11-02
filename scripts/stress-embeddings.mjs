// Uses synthetic records and an in-memory embedder; never opens the user's Vault or Ollama.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { loadEmbeddingIndex, StateStore, Vault } from '../dist/index.js';

const rounds = Number(process.env.MEMORY_FERRY_STRESS_ROUNDS || 25);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) throw new Error('Stress rounds must be 1–1000.');
const root = await mkdtemp(path.join(os.tmpdir(), 'memory-ferry-stress-'));
const model = 'synthetic-stress';
const started = performance.now();
const deadline = setTimeout(() => { console.error('Embedding stress exceeded 120 seconds.'); process.exit(1); }, 120_000);
let reads = 0;
try {
  for (let round = 0; round < rounds; round++) {
    const vault = await Vault.init(path.join(root, String(round), 'vault'), 'Synthetic stress', new StateStore(path.join(root, String(round), 'state')), {
      env: { MEMORY_FERRY_EMBED_MODEL: model },
      embedder: { available: async () => true, embed: async text => { await yieldIO(); return text.includes('updated') ? [0, 1] : [1, 0]; } },
    });
    let reading = true;
    const reader = (async () => {
      while (reading) { await loadEmbeddingIndex(vault.embeddingsPath, model); reads++; await yieldIO(); }
    })();
    try {
      const records = await Promise.all(Array.from({ length: 8 }, (_, i) => vault.remember({ content: `initial ${round}-${i}` })));
      await vault.flushEmbeddings();
      let index = await loadEmbeddingIndex(vault.embeddingsPath, model);
      assert.equal(Object.keys(index.vectors).length, records.length);
      for (const record of records) assert.deepEqual(index.vectors[record.id], { v: [1, 0], updatedAt: record.updatedAt });
      const updated = await Promise.all(records.map(record => vault.update(record.id, { content: `updated ${record.id}` })));
      await vault.flushEmbeddings();
      index = await loadEmbeddingIndex(vault.embeddingsPath, model);
      for (const record of updated) assert.deepEqual(index.vectors[record.id], { v: [0, 1], updatedAt: record.updatedAt });
      await Promise.all(records.map(record => vault.forget(record.id)));
      await vault.flushEmbeddings();
      assert.deepEqual((await loadEmbeddingIndex(vault.embeddingsPath, model)).vectors, {});
      assert.deepEqual(await vault.list(), []);
    } finally {
      reading = false;
      await reader;
      await vault.flushEmbeddings();
    }
  }
  console.log(JSON.stringify({ platform: process.platform, node: process.version, rounds, memories: rounds * 8, mutations: rounds * 24, concurrentReads: reads, elapsedMs: Math.round(performance.now() - started) }));
} finally {
  clearTimeout(deadline);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
