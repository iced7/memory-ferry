import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { MemoryKind, ScopeType } from "./types.js";
import { Vault } from "./vault.js";
import { listSkills } from "./skills.js";

const kind = z.enum(["fact", "preference", "decision", "lesson", "note", "task"]);
const scope = z.enum(["global", "project", "agent"]);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createsData = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updatesData = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const deletesData = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

export function createMcpServer(vault: Vault): McpServer {
  const server = new McpServer({ name: "agent-vault-sync", version: "0.4.0" });

  server.registerTool("memory_remember", {
    description: "Save a durable fact, preference, decision, lesson, note, or task to shared long-term memory.",
    annotations: createsData,
    inputSchema: {
      content: z.string().min(1), title: z.string().optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(),
      tags: z.array(z.string()).optional(), sourceAgent: z.string().optional(), sourceSession: z.string().optional(), sourceUri: z.string().optional()
    }
  }, async (input) => {
    try {
      return response(await vault.remember({ content: input.content, title: input.title, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags, source: { agent: input.sourceAgent, session: input.sourceSession, uri: input.sourceUri } }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("memory_recall", {
    description: "Search shared long-term memory for information relevant to a task or question.",
    annotations: readOnly,
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string()).optional() }
  }, async (input) => {
    try { return response(await vault.search(input.query, input.limit || 10, { kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_list", {
    description: "List recent shared memories, optionally filtered by kind, scope, or tags.",
    annotations: readOnly,
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string()).optional() }
  }, async (input) => {
    try { return response(await vault.list({ limit: input.limit, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_get", {
    description: "Read one shared memory by its ID.", annotations: readOnly, inputSchema: { id: z.string().uuid() }
  }, async ({ id }) => {
    try { return response((await vault.get(id)) || { found: false, id }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_update", {
    description: "Update an existing shared memory while preserving its stable ID.",
    annotations: updatesData,
    inputSchema: { id: z.string().uuid(), content: z.string().min(1).optional(), title: z.string().optional(), kind: kind.optional(), scope: scope.optional(), scopeId: z.string().optional(), tags: z.array(z.string()).optional() }
  }, async (input) => {
    try { return response(await vault.update(input.id, { content: input.content, title: input.title, kind: input.kind as MemoryKind | undefined, scope: input.scope as ScopeType | undefined, scopeId: input.scopeId, tags: input.tags })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_forget", {
    description: "Delete a shared memory by writing a synchronized tombstone.", annotations: deletesData, inputSchema: { id: z.string().uuid() }
  }, async ({ id }) => {
    try { return response({ id, forgotten: await vault.forget(id) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("memory_context", {
    description: "Return a compact text block of relevant shared memory suitable for an agent context.",
    annotations: readOnly,
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(30).optional() }
  }, async ({ query, limit }) => {
    try { return response(await vault.context(query, limit || 8)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("vault_status", {
    description: "Show the active shared vault and its current memory/event counts.", annotations: readOnly, inputSchema: {}
  }, async () => {
    try { return response({ path: vault.root, manifest: await vault.manifest(), memories: (await vault.current()).size, events: (await vault.events()).length }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("skill_list", {
    description: "List reusable skills stored in the shared vault.", annotations: readOnly, inputSchema: {}
  }, async () => {
    try { return response(await listSkills(vault.root)); }
    catch (error) { return failure(error); }
  });

  return server;
}

export async function runMcp(vault: Vault): Promise<void> {
  const server = createMcpServer(vault);
  await server.connect(new StdioServerTransport());
}
