import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  assert.deepEqual((await listSkills(vault.root)).map((skill) => skill.name), ["agent-vault-memory"]);
  const first = await syncSkills(vault.root, destination);
  assert.equal(first[0].changed, true);
  assert.match(await readFile(path.join(destination, "agent-vault-memory", "SKILL.md"), "utf8"), /memory_recall/);
  assert.equal((await syncSkills(vault.root, destination))[0].changed, false);

  await writeFile(path.join(vault.root, "skills", "agent-vault-memory", "notes.txt"), "new shared content\n");
  assert.equal((await syncSkills(vault.root, destination))[0].changed, true);
  assert.equal(await readFile(path.join(destination, "agent-vault-memory", "notes.txt"), "utf8"), "new shared content\n");
});
