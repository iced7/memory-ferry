import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state.js";
import { Vault } from "../src/vault.js";
import { listSkills, syncSkills } from "../src/skills.js";

test("creates and hash-syncs the reusable memory skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-skills-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const destination = path.join(root, "agent-home", "skills");
  assert.deepEqual((await listSkills(vault.root)).map((skill) => skill.name), ["memory-ferry-memory"]);
  const first = await syncSkills(vault.root, destination);
  assert.equal(first[0].changed, true);
  assert.match(await readFile(path.join(destination, "memory-ferry-memory", "SKILL.md"), "utf8"), /memory_recall/);
  const marker = JSON.parse(await readFile(path.join(destination, "memory-ferry-memory", ".memory-ferry-sync.json"), "utf8"));
  assert.equal(marker.skill, "memory-ferry-memory");
  assert.equal(marker.vault, vault.root);
  assert.match(marker.hash, /^[a-f0-9]{64}$/);
  assert.equal((await syncSkills(vault.root, destination))[0].changed, false);
  const markerPath = path.join(destination, "memory-ferry-memory", ".memory-ferry-sync.json");
  await writeFile(markerPath, `${JSON.stringify({ skill: "memory-ferry-memory", vault: "stale", hash: "stale" })}\n`, "utf8");
  assert.equal((await syncSkills(vault.root, destination))[0].changed, false);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), marker);

  await writeFile(path.join(vault.root, "skills", "memory-ferry-memory", "notes.txt"), "new shared content\n");
  assert.equal((await syncSkills(vault.root, destination))[0].changed, true);
  assert.equal(await readFile(path.join(destination, "memory-ferry-memory", "notes.txt"), "utf8"), "new shared content\n");
});

test("prunes stale owned skills without deleting user-owned directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-skill-prune-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "temporary-skill");
  const collisionSource = path.join(vault.root, "skills", "user-owned");
  const destination = path.join(root, "agent-home", "skills");
  const userOwned = path.join(destination, "user-owned");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "# Temporary\n", "utf8");
  await mkdir(collisionSource, { recursive: true });
  await writeFile(path.join(collisionSource, "SKILL.md"), "# Vault version\n", "utf8");
  await mkdir(userOwned, { recursive: true });
  await writeFile(path.join(userOwned, "SKILL.md"), "# Keep me\n", "utf8");

  await syncSkills(vault.root, destination);
  assert.equal(await readFile(path.join(destination, "temporary-skill", "SKILL.md"), "utf8"), "# Temporary\n");
  assert.equal(await readFile(path.join(userOwned, "SKILL.md"), "utf8"), "# Keep me\n");
  await rm(source, { recursive: true });
  await syncSkills(vault.root, destination);

  await assert.rejects(() => readFile(path.join(destination, "temporary-skill", "SKILL.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(userOwned, "SKILL.md"), "utf8"), "# Keep me\n");
});

test("adopts pre-marker copies that match vault content (upgrade path) and still updates them later", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-skill-adopt-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "legacy-skill");
  const destination = path.join(root, "agent-home", "skills");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "# Legacy\n", "utf8");

  // Simulate a 0.4.0-era install: identical copy, no marker file.
  const legacy = path.join(destination, "legacy-skill");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "# Legacy\n", "utf8");

  // First sync adopts the copy (no rewrite, no clobber) and writes the marker.
  const first = await syncSkills(vault.root, destination);
  const adopted = first.find((entry) => entry.name === "legacy-skill");
  assert.equal(adopted?.changed, false);
  const marker = JSON.parse(await readFile(path.join(legacy, ".memory-ferry-sync.json"), "utf8"));
  assert.equal(marker.skill, "legacy-skill");
  assert.equal(marker.vault, vault.root);

  // Content change in the vault now propagates because ownership was adopted.
  await writeFile(path.join(source, "SKILL.md"), "# Legacy v2\n", "utf8");
  const second = await syncSkills(vault.root, destination);
  assert.equal(second.find((entry) => entry.name === "legacy-skill")?.changed, true);
  assert.equal(await readFile(path.join(legacy, "SKILL.md"), "utf8"), "# Legacy v2\n");

  // A user-modified unowned copy is still never clobbered.
  const userDir = path.join(destination, "user-custom");
  await mkdir(userDir, { recursive: true });
  await writeFile(path.join(userDir, "SKILL.md"), "# Custom\n", "utf8");
  const third = await syncSkills(vault.root, destination);
  assert.equal(third.find((entry) => entry.name === "user-custom"), undefined);
  assert.equal(await readFile(path.join(userDir, "SKILL.md"), "utf8"), "# Custom\n");
});
