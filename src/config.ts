import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isoDate, pathExists, readJson, writeJsonAtomic } from "./utils.js";

export async function backupFile(file: string): Promise<string | undefined> {
  if (!(await pathExists(file))) return undefined;
  const suffix = isoDate().replace(/[:.]/g, "-");
  const backup = `${file}.agent-vault-backup-${suffix}`;
  await copyFile(file, backup);
  return backup;
}

export async function updateJsonFile(file: string, mutate: (value: Record<string, unknown>) => void): Promise<{ changed: boolean; backup?: string }> {
  let value: Record<string, unknown> = {};
  if (await pathExists(file)) {
    value = await readJson<Record<string, unknown>>(file);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`Expected a JSON object: ${file}`);
  }
  const before = JSON.stringify(value);
  mutate(value);
  if (JSON.stringify(value) === before) return { changed: false };
  const backup = await backupFile(file);
  await writeJsonAtomic(file, value);
  return { changed: true, ...(backup ? { backup } : {}) };
}

export async function updateMarkedText(file: string, marker: string, block?: string): Promise<{ changed: boolean; backup?: string }> {
  const start = `# >>> agent-vault:${marker} >>>`;
  const end = `# <<< agent-vault:${marker} <<<`;
  const old = (await pathExists(file)) ? await readFile(file, "utf8") : "";
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const without = old.replace(new RegExp(`(?:^|\\n)${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\n|$)`, "g"), "\n").trimEnd();
  const next = block ? `${without}${without ? "\n\n" : ""}${start}\n${block.trim()}\n${end}\n` : `${without}${without ? "\n" : ""}`;
  if (next === old) return { changed: false };
  const backup = await backupFile(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, "utf8");
  return { changed: true, ...(backup ? { backup } : {}) };
}

export function setNested(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let cursor = root;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || Array.isArray(cursor[key]) || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys.at(-1)!] = value;
}

export function getNested(root: Record<string, unknown>, keys: string[]): unknown {
  let cursor: unknown = root;
  for (const key of keys) {
    if (!cursor || Array.isArray(cursor) || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

export function deleteNested(root: Record<string, unknown>, keys: string[]): void {
  let cursor = root;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!next || Array.isArray(next) || typeof next !== "object") return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[keys.at(-1)!];
}
