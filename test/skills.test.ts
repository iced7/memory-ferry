import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state.js";
import { Vault } from "../src/vault.js";
import { inspectSkills, listSkills, syncSkills } from "../src/skills.js";

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
  await writeFile(path.join(source, "SKILL.md"), "---\nname: temporary-skill\ndescription: Temporary test Skill.\n---\n\n# Temporary\n", "utf8");
  await mkdir(collisionSource, { recursive: true });
  await writeFile(path.join(collisionSource, "SKILL.md"), "---\nname: user-owned\ndescription: Vault collision test.\n---\n\n# Vault version\n", "utf8");
  await mkdir(userOwned, { recursive: true });
  await writeFile(path.join(userOwned, "SKILL.md"), "# Keep me\n", "utf8");

  await syncSkills(vault.root, destination);
  assert.match(await readFile(path.join(destination, "temporary-skill", "SKILL.md"), "utf8"), /# Temporary/);
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
  const legacyV1 = "---\nname: legacy-skill\ndescription: Legacy upgrade test.\n---\n\n# Legacy\n";
  await writeFile(path.join(source, "SKILL.md"), legacyV1, "utf8");

  // Simulate a 0.4.0-era install: identical copy, no marker file.
  const legacy = path.join(destination, "legacy-skill");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), legacyV1, "utf8");

  // First sync adopts the copy (no rewrite, no clobber) and writes the marker.
  const first = await syncSkills(vault.root, destination);
  const adopted = first.find((entry) => entry.name === "legacy-skill");
  assert.equal(adopted?.changed, false);
  const marker = JSON.parse(await readFile(path.join(legacy, ".memory-ferry-sync.json"), "utf8"));
  assert.equal(marker.skill, "legacy-skill");
  assert.equal(marker.vault, vault.root);

  // Content change in the vault now propagates because ownership was adopted.
  await writeFile(path.join(source, "SKILL.md"), "---\nname: legacy-skill\ndescription: Legacy upgrade test.\n---\n\n# Legacy v2\n", "utf8");
  const second = await syncSkills(vault.root, destination);
  assert.equal(second.find((entry) => entry.name === "legacy-skill")?.changed, true);
  assert.match(await readFile(path.join(legacy, "SKILL.md"), "utf8"), /# Legacy v2/);

  // A user-modified unowned copy is still never clobbered.
  const userDir = path.join(destination, "user-custom");
  await mkdir(userDir, { recursive: true });
  await writeFile(path.join(userDir, "SKILL.md"), "# Custom\n", "utf8");
  const third = await syncSkills(vault.root, destination);
  assert.equal(third.find((entry) => entry.name === "user-custom"), undefined);
  assert.equal(await readFile(path.join(userDir, "SKILL.md"), "utf8"), "# Custom\n");
});

test("validates portable Skills and renders an Agent-specific overlay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-render-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "portable-review");
  const overlay = path.join(source, "adapters", "codex");
  const destination = path.join(root, "agent-home", "skills");
  await mkdir(path.join(overlay, "agents"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: portable-review\ndescription: Review code when the user asks for a portable project review.\n---\n\n# Review\n\nFollow the common workflow.\n", "utf8");
  await writeFile(path.join(source, "memory-ferry.yaml"), "schemaVersion: 1\ntargets:\n  codex:\n    enabled: true\n  minimax-code:\n    enabled: false\n", "utf8");
  await writeFile(path.join(overlay, "APPEND.md"), "## Codex\n\nUse Codex review annotations when available.\n", "utf8");
  await writeFile(path.join(overlay, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n", "utf8");

  const inspected = (await inspectSkills(vault.root, "darwin")).find((skill) => skill.name === "portable-review")!;
  assert.equal(inspected.valid, true);
  assert.equal(inspected.agents.codex, "adapted");
  assert.equal(inspected.agents.claude, "native");
  assert.equal(inspected.agents["minimax-code"], "unsupported");

  const synced = (await syncSkills(vault.root, destination, { agentIds: ["codex"], platform: "darwin" })).find((skill) => skill.name === "portable-review")!;
  assert.equal(synced.status, "synced");
  assert.match(await readFile(path.join(destination, "portable-review", "SKILL.md"), "utf8"), /Codex review annotations/);
  assert.match(await readFile(path.join(destination, "portable-review", "agents", "openai.yaml"), "utf8"), /allow_implicit_invocation/);
  await assert.rejects(() => readFile(path.join(destination, "portable-review", "memory-ferry.yaml"), "utf8"), { code: "ENOENT" });
  await assert.rejects(() => readFile(path.join(destination, "portable-review", "adapters", "codex", "APPEND.md"), "utf8"), { code: "ENOENT" });
  const marker = JSON.parse(await readFile(path.join(destination, "portable-review", ".memory-ferry-sync.json"), "utf8"));
  assert.equal(marker.target, "codex:darwin");
  assert.equal(marker.rendererVersion, 1);
  assert.match(marker.hash, /^[a-f0-9]{64}$/);
});

test("reports conflicting shared-directory overlays instead of installing an ambiguous Skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-conflict-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "shared-conflict");
  await mkdir(path.join(source, "adapters", "codex"), { recursive: true });
  await mkdir(path.join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: shared-conflict\ndescription: Exercise shared Agent overlay conflict detection.\n---\n\n# Shared\n", "utf8");
  await writeFile(path.join(source, "adapters", "codex", "frontmatter.yaml"), "allowed-tools: Read\n", "utf8");
  await writeFile(path.join(source, "adapters", "opencode", "frontmatter.yaml"), "allowed-tools: Bash\n", "utf8");
  const destination = path.join(root, "agent-home", "skills");

  const result = (await syncSkills(vault.root, destination, { agentIds: ["codex", "opencode"], platform: "linux" })).find((skill) => skill.name === "shared-conflict")!;
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((issue) => issue.code === "overlay-frontmatter-conflict"));
  await assert.rejects(() => readFile(path.join(destination, "shared-conflict", "SKILL.md"), "utf8"), { code: "ENOENT" });
});

test("skips unsupported platforms and removes only its previously managed target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-platform-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "mac-only");
  const destination = path.join(root, "agent-home", "skills");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: mac-only\ndescription: Run a macOS-only workflow when explicitly requested.\n---\n\n# macOS only\n", "utf8");
  await writeFile(path.join(source, "memory-ferry.yaml"), "schemaVersion: 1\nplatforms: [darwin]\n", "utf8");

  const windows = (await syncSkills(vault.root, destination, { agentIds: ["codex"], platform: "win32" })).find((skill) => skill.name === "mac-only")!;
  assert.equal(windows.status, "unsupported");
  const mac = (await syncSkills(vault.root, destination, { agentIds: ["codex"], platform: "darwin" })).find((skill) => skill.name === "mac-only")!;
  assert.equal(mac.status, "synced");
  await writeFile(path.join(source, "memory-ferry.yaml"), "schemaVersion: 1\nplatforms: [darwin]\ntargets:\n  codex:\n    enabled: false\n", "utf8");
  const disabled = (await syncSkills(vault.root, destination, { agentIds: ["codex"], platform: "darwin" })).find((skill) => skill.name === "mac-only")!;
  assert.equal(disabled.status, "unsupported");
  assert.equal(disabled.changed, true);
  await assert.rejects(() => readFile(path.join(destination, "mac-only", "SKILL.md"), "utf8"), { code: "ENOENT" });
});

test("blocks invalid Agent Skills before distribution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-invalid-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "bad-name");
  const destination = path.join(root, "agent-home", "skills");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: Different_Name\ndescription: Invalid portable Skill.\n---\n\n# Invalid\n", "utf8");
  const inspection = (await inspectSkills(vault.root)).find((skill) => skill.name === "bad-name")!;
  assert.equal(inspection.valid, false);
  assert.ok(inspection.issues.some((issue) => issue.code === "name"));
  const result = (await syncSkills(vault.root, destination)).find((skill) => skill.name === "bad-name")!;
  assert.equal(result.status, "invalid");
});

test("rejects malformed compatibility manifests instead of silently ignoring them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-manifest-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "bad-manifest");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: bad-manifest\ndescription: Exercise manifest validation.\n---\n\n# Invalid manifest\n", "utf8");
  await writeFile(path.join(source, "memory-ferry.yaml"), "schemaVersion: 1\nrequires: online\ntargets: codex\n", "utf8");

  const inspection = (await inspectSkills(vault.root)).find((skill) => skill.name === "bad-manifest")!;
  assert.equal(inspection.valid, false);
  assert.ok(inspection.issues.some((issue) => issue.code === "manifest-requires"));
  assert.ok(inspection.issues.some((issue) => issue.code === "manifest-targets"));
});

test("revalidates rendered frontmatter and treats enabled-only targets as native", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-skill-render-validation-"));
  const vault = await Vault.init(path.join(root, "vault"), "Test", new StateStore(path.join(root, "state")));
  const source = path.join(vault.root, "skills", "render-check");
  const overlay = path.join(source, "adapters", "codex");
  const destination = path.join(root, "agent-home", "skills");
  await mkdir(overlay, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: render-check\ndescription: Exercise rendered frontmatter validation.\n---\n\n# Render check\n", "utf8");
  await writeFile(path.join(source, "memory-ferry.yaml"), "schemaVersion: 1\ntargets:\n  claude:\n    enabled: true\n", "utf8");
  await writeFile(path.join(overlay, "frontmatter.yaml"), "name: Not_Portable\n", "utf8");

  const inspection = (await inspectSkills(vault.root)).find((skill) => skill.name === "render-check")!;
  assert.equal(inspection.agents.claude, "native");
  assert.equal(inspection.agents.codex, "adapted");
  const result = (await syncSkills(vault.root, destination, { agentIds: ["codex"] })).find((skill) => skill.name === "render-check")!;
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((issue) => issue.code === "rendered-name"));
  await assert.rejects(() => readFile(path.join(destination, "render-check", "SKILL.md"), "utf8"), { code: "ENOENT" });
});
