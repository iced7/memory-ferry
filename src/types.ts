export const SCHEMA_VERSION = 1 as const;

export type MemoryKind = "fact" | "preference" | "decision" | "lesson" | "note" | "task";
export type ScopeType = "global" | "project" | "agent";

export interface HybridLogicalClock {
  wallTime: number;
  counter: number;
  node: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  title?: string;
  kind: MemoryKind;
  scope: { type: ScopeType; id?: string };
  tags: string[];
  source?: { agent?: string; session?: string; uri?: string };
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  eventId: string;
  memoryId: string;
  op: "put" | "delete";
  clock: HybridLogicalClock;
  createdAt: string;
  deviceId: string;
  record?: MemoryRecord;
}

export interface VaultManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  vaultId: string;
  name: string;
  createdAt: string;
  format: "agent-vault-events";
}

export interface LocalState {
  schemaVersion: typeof SCHEMA_VERSION;
  defaultVault?: string;
  vaults?: string[];
  autoManage?: boolean;
  devices: Record<string, { deviceId: string; lastClock?: HybridLogicalClock }>;
}

export interface SearchResult {
  memory: MemoryRecord;
  score: number;
}

export interface RememberInput {
  content: string;
  title?: string;
  kind?: MemoryKind;
  scope?: ScopeType;
  scopeId?: string;
  tags?: string[];
  source?: MemoryRecord["source"];
}

export interface ListFilter {
  kind?: MemoryKind;
  scope?: ScopeType;
  scopeId?: string;
  tags?: string[];
  limit?: number;
}

export interface SearchOptions extends ListFilter {
  semantic?: boolean
}
