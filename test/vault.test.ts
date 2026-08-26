import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state.js";
import { Vault } from "../src/vault.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-test-"));
  const state = new StateStore(path.join(root, "local-state"));
  const vault = await Vault.init(path.join(root, "synced"), "Test", state);
  return { root, state, vault };
}

test("initializes a folder-safe vault and performs CRUD", async () => {
  const { vault } = await fixture();
  const created = await vault.remember({ content: "Use pnpm for the phoenix project", title: "Package manager", kind: "decision", scope: "project", scopeId: "phoenix", tags: ["node", "node"] });
  assert.equal((await vault.get(created.id))?.content, created.content);
  assert.deepEqual((await vault.get(created.id))?.tags, ["node"]);

  const updated = await vault.update(created.id, { content: "Use npm for the phoenix project", tags: ["node", "tooling"] });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal((await vault.events()).length, 2);

  assert.equal(await vault.forget(created.id), true);
  assert.equal(await vault.get(created.id), undefined);
  assert.equal(await vault.forget(created.id), false);
  assert.equal((await vault.events()).length, 3);
});

test("recalls CJK concepts and excludes unrelated recent memory", async () => {
  const { vault } = await fixture();
  await vault.remember({ content: "用户偏好简洁的中文回答", kind: "preference", tags: ["语言"] });
  await vault.remember({ content: "The build server runs Linux", kind: "fact" });
  const results = await vault.search("中文偏好");
  assert.equal(results.length, 1);
  assert.match(results[0].memory.content, /中文/);
  assert.ok(results[0].score > 1);
});

test("keeps concurrent writes as independent immutable files", async () => {
  const { vault } = await fixture();
  const count = 40;
  await Promise.all(Array.from({ length: count }, (_, index) => vault.remember({ content: `Concurrent memory ${index}`, kind: "fact" })));
  assert.equal((await vault.current()).size, count);
  assert.equal((await vault.events()).length, count);
  const rawFiles = await Promise.all((await vault.events()).map(async (event) => {
    assert.ok(event.eventId); return event.memoryId;
  }));
  assert.equal(new Set(rawFiles).size, count);
});

test('keeps sequential writes independent of the full event log', { timeout: 70_000 }, async () => {
  const { vault } = await fixture()
  const count = 1200
  const startedAt = Date.now()

  for (let index = 0; index < count; index += 1) {
    await vault.remember({ content: `Sequential memory ${index}`, kind: 'fact' })
  }

  // Regression guard against O(n²) writes; this generous limit is not a benchmark.
  assert.ok(Date.now() - startedAt < 60_000)
  assert.equal((await vault.events()).length, count)
})

test("writes no mutable database into the synced folder", async () => {
  const { vault } = await fixture();
  await vault.remember({ content: "Folder synchronization should stay conflict-safe" });
  const manifest = JSON.parse(await readFile(vault.manifestPath, "utf8"));
  assert.equal(manifest.format, "agent-vault-events");
  assert.equal((await vault.events()).length, 1);
});

test("updates the scope type without dropping its id", async () => {
  const { vault } = await fixture();
  const created = await vault.remember({ content: "Scoped memory", scope: "project", scopeId: "phoenix" });
  const updated = await vault.update(created.id, { scope: "agent" });
  assert.deepEqual(updated.scope, { type: "agent", id: "phoenix" });
});

test("updates and clears the scope id without changing its type", async () => {
  const { vault } = await fixture();
  const created = await vault.remember({ content: "Scoped memory", scope: "project", scopeId: "phoenix" });
  const updated = await vault.update(created.id, { scopeId: "atlas" });
  assert.deepEqual(updated.scope, { type: "project", id: "atlas" });
  assert.deepEqual((await vault.update(created.id, { scopeId: "" })).scope, { type: "project" });
});

test("updates both scope fields together", async () => {
  const { vault } = await fixture();
  const created = await vault.remember({ content: "Scoped memory", scope: "project", scopeId: "phoenix" });
  const updated = await vault.update(created.id, { scope: "agent", scopeId: "atlas" });
  assert.deepEqual(updated.scope, { type: "agent", id: "atlas" });
});

test("keeps scope unchanged when neither scope field is provided", async () => {
  const { vault } = await fixture();
  const created = await vault.remember({ content: "Scoped memory", scope: "project", scopeId: "phoenix" });
  const updated = await vault.update(created.id, { title: "Still scoped" });
  assert.deepEqual(updated.scope, created.scope);
});
