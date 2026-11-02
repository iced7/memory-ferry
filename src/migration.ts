import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from 'node:util';
import { StateStore } from './state.js';
import { withFileLock } from './locking.js';
import { listSkills } from "./skills.js";
import { pathExists, stableId } from "./utils.js";
import { Vault } from "./vault.js";

export interface VaultMigrationResult {
  source: string;
  target: string;
  events: { copied: number; unchanged: number; conflicts: string[] };
  skills: { copied: number; unchanged: number; conflicts: string[] };
}

async function mergeFiles(sourceRoot: string, targetRoot: string): Promise<{ copied: number; unchanged: number; conflicts: string[] }> {
  const result = { copied: 0, unchanged: 0, conflicts: [] as string[] };
  if (!(await pathExists(sourceRoot))) return result;

  async function visit(sourceDir: string): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const relative = path.relative(sourceRoot, source);
      const target = path.join(targetRoot, relative);
      if (entry.isDirectory()) {
        await visit(source);
      } else if (entry.isFile()) {
        if (!(await pathExists(target))) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(source, target);
          result.copied++;
        } else if ((await readFile(source)).equals(await readFile(target))) {
          result.unchanged++;
        } else {
          result.conflicts.push(relative.split(path.sep).join("/"));
        }
      }
    }
  }

  await visit(sourceRoot);
  return result;
}

export async function migrateVault(sourcePath: string, targetPath: string, options: { state?: StateStore; allowPlaintext?: boolean } = {}): Promise<VaultMigrationResult> {
  const state = options.state || new StateStore();
  const source = new Vault(sourcePath, state);
  const target = new Vault(targetPath, state);
  const [sourceManifest, targetManifest] = await Promise.all([source.manifest(), target.manifest()]);
  if (source.root === target.root) throw new Error("Source and target Vault must be different.");
  if (sourceManifest.vaultId === targetManifest.vaultId) throw new Error("Source and target have the same Vault ID; let the cloud provider synchronize this Vault instead of migrating it.");

  if (sourceManifest.encryption && !targetManifest.encryption && !options.allowPlaintext) throw new Error('Target is plaintext. Explicitly use --allow-plaintext to export encrypted memories without encryption.');
  let events: VaultMigrationResult['events'];
  if (!sourceManifest.encryption && !targetManifest.encryption) events = await mergeFiles(source.eventsPath, target.eventsPath);
  else {
    const [sourceCodec, targetCodec] = await Promise.all([source.encryptionCodec(sourceManifest), target.encryptionCodec(targetManifest)]);
    await source.events(true); await target.events(true);
    if (source.diagnostics.length || target.diagnostics.length) throw new Error('Resolve unreadable memory events before migration.');
    const prepared: Array<{ relative: string; event: Awaited<ReturnType<Vault['readEvent']>> }> = [];
    async function prepare(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await prepare(file);
        else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.pending-')) prepared.push({ relative: path.relative(source.eventsPath, file), event: await source.readEvent(file, sourceCodec) });
      }
    }
    await prepare(source.eventsPath);
    events = await withFileLock(path.join(state.home, 'locks', `${stableId(target.root)}-migration`), async () => {
      const result: VaultMigrationResult['events'] = { copied: 0, unchanged: 0, conflicts: [] };
      for (const { relative, event } of prepared) {
        const destination = path.join(target.eventsPath, relative);
        if (await pathExists(destination)) {
          if (isDeepStrictEqual(await target.readEvent(destination, targetCodec), event)) result.unchanged++;
          else result.conflicts.push(relative.split(path.sep).join('/'));
        } else {
          await target.writeEvent(destination, event, targetCodec);
          result.copied++;
        }
      }
      return result;
    });
  }
  const skills = { copied: 0, unchanged: 0, conflicts: [] as string[] };
  for (const skill of await listSkills(source.root)) {
    const merged = await mergeFiles(skill.path, path.join(target.root, "skills", skill.name));
    skills.copied += merged.copied;
    skills.unchanged += merged.unchanged;
    skills.conflicts.push(...merged.conflicts.map((file) => `${skill.name}/${file}`));
  }

  return { source: source.root, target: target.root, events, skills };
}
