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
  parentEventId?: string | null;
  restoredFrom?: string;
  resolvedEventIds?: string[];
}

export interface VaultIssue { code: string; path: string; message: string; }
export interface VaultHealth {
  status: "healthy" | "warning";
  sync: "unknown";
  events: number;
  pendingFiles: number;
  invalidEvents: number;
  duplicateClocks: number;
  concurrentMemories: number;
  issues: VaultIssue[];
}

export interface VaultManifest {
  schemaVersion: 1 | 2;
  vaultId: string;
  name: string;
  createdAt: string;
  format: "memory-ferry-events" | "agent-vault-events" | "memory-ferry-encrypted-events";
  encryption?: import('./encryption.js').EncryptionManifest;
}

export interface LocalState {
  schemaVersion: typeof SCHEMA_VERSION;
  defaultVault?: string;
  vaults?: string[];
  autoManage?: boolean;
  encryptionKeys?: Record<string, string>;
  encryptedVaults?: Record<string, string>;
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
  semantic?: boolean;
  projectId?: string;
  allScopes?: boolean;
  minSimilarity?: number;
}
