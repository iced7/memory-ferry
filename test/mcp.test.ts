import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  const memory = JSON.parse((saved.content[0] as {text:string}).text);
  const history = await client.callTool({name:'memory_history',arguments:{id:memory.id}});
  const first = JSON.parse((history.content[0] as {text:string}).text)[0].eventId;
  const changed = await client.callTool({name:'memory_update',arguments:{id:memory.id,content:'Updated MCP memory',expectedRevision:first}});
  assert.equal(changed.isError,undefined);
  const stale = await client.callTool({name:'memory_update',arguments:{id:memory.id,content:'Stale',expectedRevision:first}});
  assert.equal(stale.isError,true);
  const current = (await vault.history(memory.id))[0].eventId;
  const restore = await client.callTool({name:'memory_restore',arguments:{id:memory.id,eventId:first,expectedRevision:current}});
  assert.equal(restore.isError,undefined);
  await vault.remember({content:'Other project',scope:'project',scopeId:'other'});
  const scoped = await client.callTool({name:'memory_context',arguments:{query:'',projectId:'sample',semantic:false}});
  assert.doesNotMatch((scoped.content[0] as {text:string}).text,/Other project/);
  await writeFile(path.join(vault.eventsPath,'damaged.json'),'{');
  const partial = await client.callTool({name:'memory_list',arguments:{}});
  assert.equal(partial.content.length,2);
  assert.match((partial.content[1] as {text:string}).text,/results may be incomplete/);
  await client.close();
});
