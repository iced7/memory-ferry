import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore } from "../src/state.js";
import { Vault } from "../src/vault.js";
import { createMcpServer } from "../src/mcp.js";
import { unavailableEmbedding } from './helpers.js'

test("exposes working remember and recall tools over MCP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-mcp-"));
  const vault = await Vault.init(path.join(root, "vault"), "MCP Test", new StateStore(path.join(root, "state")), unavailableEmbedding);
  const server = createMcpServer(vault);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "memory_remember"));
  assert.ok(tools.tools.some((tool) => tool.name === "memory_recall"));
  const recallTool = tools.tools.find((tool) => tool.name === 'memory_recall')
  const contextTool = tools.tools.find((tool) => tool.name === 'memory_context')
  assert.ok((recallTool?.inputSchema.properties as Record<string, unknown>).semantic)
  assert.ok((contextTool?.inputSchema.properties as Record<string, unknown>).semantic)

  const saved = await client.callTool({ name: "memory_remember", arguments: { content: "跨 Agent 复用长期记忆", kind: "decision", tags: ["agent"] } });
  assert.equal(saved.isError, undefined);
  const recalled = await client.callTool({ name: "memory_recall", arguments: { query: "长期记忆", semantic: false } });
  assert.equal(recalled.isError, undefined);
  assert.match((recalled.content[0] as { type: string; text: string }).text, /跨 Agent/);
  await client.close();
});
