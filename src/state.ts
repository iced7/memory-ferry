import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { HybridLogicalClock, LocalState } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { pathExists, readJson, stableId, writeJsonAtomic } from "./utils.js";

export function stateHome(env = process.env, homeDir = homedir()): string {
  return path.resolve(env.AGENT_VAULT_HOME || path.join(homeDir, ".agent-vault-sync"));
}

export class StateStore {
  readonly home: string;
  readonly file: string;

  constructor(home = stateHome()) {
    this.home = path.resolve(home);
    this.file = path.join(this.home, "state.json");
  }

  async load(): Promise<LocalState> {
    if (!(await pathExists(this.file))) {
      return { schemaVersion: SCHEMA_VERSION, devices: {} };
    }
    const state = await readJson<LocalState>(this.file);
    if (state.schemaVersion !== SCHEMA_VERSION || !state.devices) {
      throw new Error(`Unsupported local state format: ${this.file}`);
    }
    return state;
  }

  async save(state: LocalState): Promise<void> {
    await writeJsonAtomic(this.file, state);
  }

  async setDefaultVault(vaultPath: string): Promise<void> {
    const state = await this.load();
    const resolved = path.resolve(vaultPath);
    state.defaultVault = resolved;
    state.vaults = [...new Set([...(state.vaults || []), resolved])];
    await this.save(state);
  }

  async clearDefaultVault(): Promise<void> {
    const state = await this.load();
    delete state.defaultVault;
    await this.save(state);
  }

  async removeVault(vaultPath: string): Promise<void> {
    const state = await this.load();
    const resolved = path.resolve(vaultPath);
    state.vaults = (state.vaults || []).filter((candidate) => path.resolve(candidate) !== resolved);
    if (state.defaultVault && path.resolve(state.defaultVault) === resolved) delete state.defaultVault;
    await this.save(state);
  }

  async setAutoManage(enabled: boolean): Promise<void> {
    const state = await this.load();
    state.autoManage = enabled;
    await this.save(state);
  }

  async resolveVault(explicit?: string, env = process.env): Promise<string> {
    const candidate = explicit || env.AGENT_VAULT_PATH || (await this.load()).defaultVault;
    if (!candidate) {
      throw new Error("No vault selected. Run `agent-vault init <synced-folder>` or pass --vault.");
    }
    return path.resolve(candidate);
  }

  async deviceFor(vaultPath: string): Promise<{ deviceId: string; lastClock?: HybridLogicalClock }> {
    const state = await this.load();
    const key = stableId(path.resolve(vaultPath), 24);
    if (!state.devices[key]) {
      state.devices[key] = { deviceId: randomUUID() };
      await this.save(state);
    }
    return state.devices[key];
  }

  async nextClock(vaultPath: string, observed: HybridLogicalClock[] = []): Promise<HybridLogicalClock> {
    const state = await this.load();
    const key = stableId(path.resolve(vaultPath), 24);
    const device = state.devices[key] || { deviceId: randomUUID() };
    const now = Date.now();
    const clocks = [device.lastClock, ...observed].filter(Boolean) as HybridLogicalClock[];
    const maxWall = Math.max(now, ...clocks.map((clock) => clock.wallTime));
    const maxCounter = Math.max(-1, ...clocks.filter((clock) => clock.wallTime === maxWall).map((clock) => clock.counter));
    const next = { wallTime: maxWall, counter: maxWall === now && maxCounter < 0 ? 0 : maxCounter + 1, node: device.deviceId };
    state.devices[key] = { deviceId: device.deviceId, lastClock: next };
    await this.save(state);
    return next;
  }
}
