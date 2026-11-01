import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state.js";
import { SKILL_SYNC_INTERVAL_MS, WINDOWS_FOLDER_PICKER_SCRIPT, startUiServer } from "../src/ui.js";
import { Vault } from "../src/vault.js";
import { testEnv } from "./helpers.js";
import { unavailableEmbedding } from './helpers.js'

test("serves a token-protected dashboard and manages vault/agent connections", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-ui-"));
  const homeDir = path.join(root, "home");
  const sentinelDir = path.join(root, "sentinel-dsh");
  const sentinelConfig = path.join(sentinelDir, "cordis.patch.yml");
  const sentinelContent = "# >>> agent-vault:deepseek-harness-mcp >>>\n- sentinel: true\n# <<< agent-vault:deepseek-harness-mcp <<<\n";
  await mkdir(sentinelDir, { recursive: true });
  await writeFile(sentinelConfig, sentinelContent, "utf8");
  const state = new StateStore(path.join(root, "state"));
  const handle = await startUiServer({
    state, cliPath: path.join(root, "dist", "cli.js"), homeDir,
    env: testEnv({ PATH: "", DSH_HOME: sentinelDir }), platform: "darwin", host: "127.0.0.1", port: 0, open: false
  });
  t.after(() => handle.close());

  const page = await fetch(handle.url);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Memory Ferry · 记忆摆渡/);
  assert.match(pageHtml, /value="en">English/);
  assert.match(pageHtml, /自动同步 Agent 配置与 Skill/);
  assert.match(pageHtml, /Skill 兼容性/);
  assert.doesNotMatch(pageHtml, /页面每 60 秒静默检查状态|Status is checked quietly|后台每 5 分钟补充检查|verify in the background/);
  assert.match(pageHtml, /id="add-vault-dialog"/);
  assert.match(pageHtml, /id="migrate-vault-dialog"/);
  assert.match(pageHtml, /id="shutdown"/);
  assert.match(pageHtml, /Codex 配置可用/);
  assert.match(pageHtml, /setInterval\(\(\)=>\{if\(!document\.hidden\)load\(\{quiet:true\}\);\},60000\)/);
  assert.doesNotMatch(pageHtml, /setInterval\(.*15000/);
  assert.match(page.headers.get("content-security-policy") || "", /default-src 'self'/);

  const denied = await fetch(`${handle.url}/api/status`);
  assert.equal(denied.status, 403);

  async function api(route: string, options: RequestInit = {}) {
    const response = await fetch(`${handle.url}${route}`, { ...options, headers: { "content-type": "application/json", "x-agent-vault-token": handle.token, ...(options.headers || {}) } });
    return { response, value: await response.json() as Record<string, any> };
  }

  assert.equal((await api("/api/status")).value.vault, null);
  const vaultPath = path.join(root, "synced", "AgentVault");
  const connected = await api("/api/vault/connect", { method: "POST", body: JSON.stringify({ path: vaultPath, create: true, name: "UI Test Vault" }) });
  assert.equal(connected.response.status, 200);
  assert.equal(await readFile(sentinelConfig, "utf8"), sentinelContent);
  const status = (await api("/api/status")).value;
  assert.equal(status.vault.manifest.name, "UI Test Vault");
  assert.equal(status.vault.provider.id, "local");
  assert.equal(status.vault.writable, true);
  assert.equal(status.vaults.length, 1);
  assert.equal(status.skillCompatibility.length, 1);
  assert.equal(status.skillCompatibility[0].name, "memory-ferry-memory");
  assert.equal(status.skillCompatibility[0].valid, true);

  const agentConnected = await api("/api/agents/codex/connect", { method: "POST" });
  assert.equal(agentConnected.response.status, 200);
  const codex = (await api("/api/status")).value.agents.find((agent: any) => agent.id === "codex");
  assert.equal(codex.connected, true);
  assert.equal(codex.current, true);
  assert.match(await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8"), /memory-ferry/);
  assert.match(await readFile(path.join(homeDir, ".agents", "skills", "memory-ferry-memory", "SKILL.md"), "utf8"), /memory_recall/);

  await new Vault(vaultPath, state, unavailableEmbedding).remember({ content: "migrate this memory" });
  const secondVault = path.join(root, "synced", "SecondVault");
  assert.equal((await api("/api/vault/connect", { method: "POST", body: JSON.stringify({ path: secondVault, create: true, name: "Second Vault" }) })).response.status, 200);
  const multiStatus = (await api("/api/status")).value;
  assert.equal(multiStatus.vaults.length, 2);
  assert.equal(multiStatus.vaultPath, secondVault);
  assert.equal(multiStatus.autoManage, true);
  const switchedCodex = multiStatus.agents.find((agent: any) => agent.id === "codex");
  assert.equal(switchedCodex.current, true);
  const codexConfig = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.ok(codexConfig.includes(secondVault.replaceAll("\\", "\\\\")));

  const migrated = await api("/api/vault/migrate", { method: "POST", body: JSON.stringify({ source: vaultPath, target: secondVault }) });
  assert.equal(migrated.response.status, 200);
  assert.equal(migrated.value.result.events.copied, 1);
  assert.equal((await new Vault(secondVault, state).current()).size, 1);
  const repeated = await api("/api/vault/migrate", { method: "POST", body: JSON.stringify({ source: vaultPath, target: secondVault }) });
  assert.equal(repeated.value.result.events.copied, 0);
  assert.equal(repeated.value.result.events.unchanged, 1);

  assert.equal((await api("/api/vault/switch", { method: "POST", body: JSON.stringify({ path: vaultPath }) })).response.status, 200);
  assert.equal((await api("/api/vault/remove", { method: "POST", body: JSON.stringify({ path: secondVault }) })).response.status, 200);
  assert.equal((await api("/api/status")).value.vaults.length, 1);

  assert.equal((await api("/api/agents/codex/disconnect", { method: "POST" })).response.status, 200);
  assert.equal((await api("/api/vault/disconnect", { method: "POST" })).response.status, 200);
  assert.equal((await api("/api/status")).value.vault, null);

  assert.equal((await api("/api/shutdown", { method: "POST" })).response.status, 200);
  await new Promise<void>((resolve) => {
    if (!handle.server.listening) resolve();
    else handle.server.once("close", resolve);
  });
  assert.equal(handle.server.listening, false);
});

test("refuses to expose the dashboard beyond loopback", async () => {
  await assert.rejects(() => startUiServer({ cliPath: "/tmp/cli.js", host: "0.0.0.0", port: 0, open: false }), /only listen on the local machine/);
});

test("uses a topmost Windows folder-picker owner and a low-frequency Skill fallback", () => {
  assert.match(WINDOWS_FOLDER_PICKER_SCRIPT, /TopMost=\$true/);
  assert.match(WINDOWS_FOLDER_PICKER_SCRIPT, /ShowDialog\(\$owner\)/);
  assert.equal(SKILL_SYNC_INTERVAL_MS, 5 * 60_000);
});

test('memory manager enforces revision and Vault identity, supports history and restoration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(),'memory-ferry-ui-memory-'));
  const state = new StateStore(path.join(root,'state'));
  const vault = await Vault.init(path.join(root,'vault'),'UI memories',state,unavailableEmbedding);
  const handle = await startUiServer({state,cliPath:path.join(root,'cli.js'),homeDir:path.join(root,'home'),env:{MEMORY_FERRY_EMBED:'off'},port:0,open:false});
  t.after(()=>handle.close());
  async function api(route:string, data?:unknown, headers:Record<string,string>={}) {
    const response = await fetch(handle.url+route,{method:data?'POST':'GET',headers:{'x-memory-ferry-token':handle.token,'content-type':'application/json',...headers},body:data?JSON.stringify(data):undefined});
    return {status:response.status,value:await response.json() as any};
  }
  assert.equal((await api('/api/status',undefined, {origin:'https://untrusted.example'})).status,403);
  const { request } = await import('node:http');
  const rebinding = await new Promise<number|undefined>((resolve,reject)=>{
    const req = request(handle.url,{headers:{host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
  });
  assert.equal(rebinding,403);
  const identity={vaultId:(await vault.manifest()).vaultId,vaultPath:vault.root};
  const created = await api('/api/memories',{...identity,content:'Initial <script>alert(1)</script>',scope:'project',scopeId:'sample'});
  assert.equal(created.status,200);
  const id = created.value.record.id;
  const history = (await api('/api/memories/'+id)).value.history;
  const first = history[0].eventId;
  assert.equal((await api('/api/memories/'+id,{...identity,expectedRevision:first,content:'Edited'})).status,200);
  assert.equal((await api('/api/memories/'+id,{...identity,expectedRevision:first,content:'Stale'})).status,409);
  const second = (await vault.history(id))[0].eventId;
  assert.equal((await api('/api/memories/'+id,{...identity,expectedRevision:second,vaultId:'wrong',content:'Wrong vault'})).status,409);
  assert.equal((await api('/api/memories/'+id,{...identity,expectedRevision:second,vaultPath:'wrong',content:'Wrong folder'})).status,409);
  assert.equal((await api('/api/memories/'+id+'/forget',{...identity,expectedRevision:second})).status,200);
  assert.equal((await api('/api/memories')).value.items.length,0);
  assert.equal((await api('/api/memories?deleted=true')).value.items.length,1);
  const deleted = (await vault.history(id))[0].eventId;
  assert.equal((await api('/api/memories/'+id+'/restore',{...identity,expectedRevision:deleted,eventId:first})).status,200);
  assert.match((await vault.get(id))!.content,/Initial/);
  assert.equal((await api('/api/status')).value.vault.health.sync,'unknown');
  assert.equal((await api('/api/memories',{...identity,content:''})).status,400);
  assert.equal((await api('/api/memories',{...identity,content:'x'.repeat(64_001)})).status,400);
});
