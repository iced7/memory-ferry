import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listSkills } from "./skills.js";
import { pathExists } from "./utils.js";
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

export async function migrateVault(sourcePath: string, targetPath: string): Promise<VaultMigrationResult> {
  const source = new Vault(sourcePath);
  const target = new Vault(targetPath);
  const [sourceManifest, targetManifest] = await Promise.all([source.manifest(), target.manifest()]);
  if (source.root === target.root) throw new Error("Source and target Vault must be different.");
  if (sourceManifest.vaultId === targetManifest.vaultId) throw new Error("Source and target have the same Vault ID; let the cloud provider synchronize this Vault instead of migrating it.");

  const events = await mergeFiles(source.eventsPath, target.eventsPath);
  const skills = { copied: 0, unchanged: 0, conflicts: [] as string[] };
  for (const skill of await listSkills(source.root)) {
    const merged = await mergeFiles(skill.path, path.join(target.root, "skills", skill.name));
    skills.copied += merged.copied;
    skills.unchanged += merged.unchanged;
    skills.conflicts.push(...merged.conflicts.map((file) => `${skill.name}/${file}`));
  }

  return { source: source.root, target: target.root, events, skills };
}
