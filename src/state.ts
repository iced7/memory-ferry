import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { LEGACY_STATE_DIRECTORY, STATE_DIRECTORY } from "./brand.js";
import type { HybridLogicalClock, LocalState } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { pathExists, readJson, stableId, writeJsonAtomic } from "./utils.js";

import { withFileLock } from "./locking.js";

export function stateHome(env = process.env, homeDir = homedir()): string {
  return path.resolve(env.MEMORY_FERRY_HOME || env.AGENT_VAULT_HOME || path.join(homeDir, STATE_DIRECTORY));
}

export class StateStore {
  readonly home: string;
  readonly file: string;
  private readonly legacyFile?: string;

  constructor(home?: string, legacyHome?: string) {
    this.home = path.resolve(home || stateHome());
    this.file = path.join(this.home, "state.json");
    if (legacyHome) {
      this.legacyFile = path.join(path.resolve(legacyHome), "state.json");
    } else if (home === undefined && !process.env.MEMORY_FERRY_HOME && !process.env.AGENT_VAULT_HOME) {
      this.legacyFile = path.join(homedir(), LEGACY_STATE_DIRECTORY, "state.json");
    }
  }

  async load(): Promise<LocalState> {
    return withFileLock(this.file, () => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<LocalState> {
    if (!(await pathExists(this.file))) {
      if (this.legacyFile && await pathExists(this.legacyFile)) {
        const legacy = await readJson<LocalState>(this.legacyFile);
        if (legacy.schemaVersion === SCHEMA_VERSION && legacy.devices) {
          await writeJsonAtomic(this.file, legacy);
          return legacy;
        }
      }
      return { schemaVersion: SCHEMA_VERSION, devices: {} };
    }
    const state = await readJson<LocalState>(this.file);
    if (state.schemaVersion !== SCHEMA_VERSION || !state.devices) {
      throw new Error(`Unsupported local state format: ${this.file}`);
    }
    return state;
  }

  async save(state: LocalState): Promise<void> {
    await withFileLock(this.file, () => writeJsonAtomic(this.file, state));
  }

  async setDefaultVault(vaultPath: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      const resolved = path.resolve(vaultPath);
      state.defaultVault = resolved;
      state.vaults = [...new Set([...(state.vaults || []), resolved])];
      await writeJsonAtomic(this.file, state);
    });
  }

  async clearDefaultVault(): Promise<void> {
    await withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      delete state.defaultVault;
      await writeJsonAtomic(this.file, state);
    });
  }

  async removeVault(vaultPath: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      const resolved = path.resolve(vaultPath);
      state.vaults = (state.vaults || []).filter((candidate) => path.resolve(candidate) !== resolved);
      if (state.defaultVault && path.resolve(state.defaultVault) === resolved) delete state.defaultVault;
      await writeJsonAtomic(this.file, state);
    });
  }

  async setAutoManage(enabled: boolean): Promise<void> {
    await withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      state.autoManage = enabled;
      await writeJsonAtomic(this.file, state);
    });
  }

  async resolveVault(explicit?: string, env = process.env): Promise<string> {
    const candidate = explicit || env.MEMORY_FERRY_PATH || env.AGENT_VAULT_PATH || (await this.load()).defaultVault;
    if (!candidate) {
      throw new Error("No vault selected. Run `memory-ferry init <synced-folder>` or pass --vault.");
    }
    return path.resolve(candidate);
  }

  async deviceFor(vaultPath: string): Promise<{ deviceId: string; lastClock?: HybridLogicalClock }> {
    return withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      const key = stableId(path.resolve(vaultPath), 24);
      if (!state.devices[key]) {
        state.devices[key] = { deviceId: randomUUID() };
        await writeJsonAtomic(this.file, state);
      }
      return state.devices[key];
    });
  }

  async nextClock(vaultPath: string, observed: HybridLogicalClock[] = []): Promise<HybridLogicalClock> {
    return withFileLock(this.file, async () => {
      const state = await this.loadUnlocked();
      const key = stableId(path.resolve(vaultPath), 24);
      const device = state.devices[key] || { deviceId: randomUUID() };
      const now = Date.now();
      const clocks = [device.lastClock, ...observed].filter(Boolean) as HybridLogicalClock[];
      const maxWall = Math.max(now, ...clocks.map((clock) => clock.wallTime));
      const maxCounter = Math.max(-1, ...clocks.filter((clock) => clock.wallTime === maxWall).map((clock) => clock.counter));
      const next = { wallTime: maxWall, counter: maxWall === now && maxCounter < 0 ? 0 : maxCounter + 1, node: device.deviceId };
      state.devices[key] = { deviceId: device.deviceId, lastClock: next };
      await writeJsonAtomic(this.file, state);
      return next;
    });
  }
}
