import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function expandPath(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

// The injected operations keep transient Windows failures reproducible in tests.
interface AtomicWriteOperations {
  platform?: NodeJS.Platform;
  rename?: typeof rename;
  sleep?: (ms: number) => Promise<void>;
}

export async function writeJsonAtomic(file: string, value: unknown, operations: AtomicWriteOperations = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.pending-${process.pid}-${randomUUID()}`;
  const renameFile = operations.rename || rename;
  const sleep = operations.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows readers/scanners can briefly deny replacement. Keep the old
        // file intact; never unlink it to force a rename. Cap backoff below 5s.
        if ((operations.platform || process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt >= 50) throw error;
        await sleep(Math.min(100, 10 * 2 ** Math.min(attempt, 4)));
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function stableId(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function isoDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString();
}
