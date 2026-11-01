import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const queues = new Map<string, Promise<void>>();

/** Locks live in machine-local state, never in the cloud-synchronized event tree. */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  const canonical = path.join(await realpath(path.dirname(file)), path.basename(file));
  const previous = queues.get(canonical) || Promise.resolve();
  let releaseQueue!: () => void;
  const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = previous.then(() => gate);
  queues.set(canonical, queued);
  await previous;
  try {
    const release = await lockfile.lock(canonical, {
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: { retries: 160, minTimeout: 10, maxTimeout: 250, factor: 1.3, randomize: true }
    });
    try { return await action(); }
    finally { await release(); }
  } finally {
    releaseQueue();
    if (queues.get(canonical) === queued) queues.delete(canonical);
  }
}
