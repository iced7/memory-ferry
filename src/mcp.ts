import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { MemoryKind, ScopeType } from "./types.js";
import { Vault } from "./vault.js";
import { listSkills } from "./skills.js";
import { MCP_SERVER_NAME, VERSION } from "./brand.js";

const kind = z.enum(["fact", "preference", "decision", "lesson", "note", "task"]);
const scope = z.enum(["global", "project", "agent"]);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createsData = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updatesData = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const deletesData = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

function response(value: unknown, warnings: readonly unknown[] = []) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }, ...(warnings.length ? [{ type: 'text' as const, text: `Vault warning: results may be incomplete. ${JSON.stringify(warnings)}` }] : [])] };
}

function failure(error: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

export function createMcpServer(vault: Vault): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION });
  const respond = (value: unknown) => response(value, vault.diagnostics);

  server.registerTool("memory_remember", {
    description: "Save a durable fact, preference, decision, lesson, note, or task to shared long-term memory.",
    annotations: createsData,
    inputSchema: {
      content: z.string().min(1).max(64000), title: z.string().optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(),
      tags: z.array(z.string().max(100)).max(64).optional(), sourceAgent: z.string().optional(), sourceSession: z.string().optional(), sourceUri: z.string().optional()
    }
  }, async (input) => {
    try {
      return respond(await vault.remember({ content: input.content, title: input.title, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags, source: { agent: input.sourceAgent, session: input.sourceSession, uri: input.sourceUri } }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("memory_recall", {
    description: "Search shared long-term memory for information relevant to a task or question.",
    annotations: readOnly,
    inputSchema: { query: z.string().max(4000), projectId: z.string().optional(), allScopes: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string().max(100)).max(64).optional(), semantic: z.boolean().optional() }
  }, async (input) => {
    try { return respond(await vault.search(input.query, input.limit || 10, { kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags, semantic: input.semantic, projectId: input.projectId, allScopes: input.allScopes })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_list", {
    description: "List recent shared memories, optionally filtered by kind, scope, or tags.",
    annotations: readOnly,
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string().max(100)).max(64).optional() }
  }, async (input) => {
    try { return respond(await vault.list({ limit: input.limit, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_get", {
    description: "Read one shared memory by its ID.", annotations: readOnly, inputSchema: { id: z.string().uuid() }
  }, async ({ id }) => {
    try { return respond((await vault.get(id)) || { found: false, id }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_update", {
    description: "Update an existing shared memory while preserving its stable ID.",
    annotations: updatesData,
    inputSchema: { id: z.string().uuid(), expectedRevision: z.string().uuid().optional(), content: z.string().min(1).max(64000).optional(), title: z.string().optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string().max(100)).max(64).optional() }
  }, async (input) => {
    try { return respond(await vault.update(input.id, { content: input.content, title: input.title, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags }, input.expectedRevision)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_forget", {
    description: "Forget a shared memory. Historical plaintext remains in event files; this is not secure erasure.", annotations: deletesData, inputSchema: { id: z.string().uuid(), expectedRevision: z.string().uuid().optional() }
  }, async ({ id, expectedRevision }) => {
    try { return respond({ id, forgotten: await vault.forget(id, expectedRevision) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_context", {
    description: "Return a compact text block of relevant shared memory suitable for an agent context.",
    annotations: readOnly,
    inputSchema: { query: z.string().max(4000), limit: z.number().int().min(1).max(30).optional(), semantic: z.boolean().optional(), scope: scope.optional(), scopeId: z.string().optional(), projectId: z.string().optional(), allScopes: z.boolean().optional(), tags: z.array(z.string().max(100)).max(64).optional(), kind: kind.optional() }
  }, async ({ query, limit, ...options }) => {
    try { return respond(await vault.context(query, limit || 8, options)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("vault_status", {
    description: "Show the active shared vault and its current memory/event counts.", annotations: readOnly, inputSchema: {}
  }, async () => {
    try { return respond({ path: vault.root, manifest: await vault.manifest(), memories: (await vault.current()).size, health: await vault.health(), events: (await vault.events()).length }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("skill_list", {
    description: "List reusable skills stored in the shared vault.", annotations: readOnly, inputSchema: {}
  }, async () => {
    try { return respond(await listSkills(vault.root)); }
    catch (error) { return failure(error); }
  });

  server.registerTool('memory_history', { description: 'Inspect historical versions, deletion and current revision before updating or restoring a memory.', annotations: readOnly, inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    try { return respond(await vault.history(id)); } catch (error) { return failure(error); }
  });
  server.registerTool('memory_restore', { description: 'Restore a chosen historical version by appending a new event. Existing history is preserved.', annotations: createsData, inputSchema: { id: z.string().uuid(), eventId: z.string().uuid(), expectedRevision: z.string().uuid() } }, async ({ id, eventId, expectedRevision }) => {
    try { return respond(await vault.restore(id, eventId, expectedRevision)); } catch (error) { return failure(error); }
  });
  server.registerTool('memory_duplicates', { description: 'Find same-content memories in the same scope without changing or deleting them.', annotations: readOnly, inputSchema: {} }, async () => {
    try { return respond(await vault.duplicates()); } catch (error) { return failure(error); }
  });
  return server;
}

export async function runMcp(vault: Vault): Promise<void> {
  const server = createMcpServer(vault);
  await server.connect(new StdioServerTransport());
}
