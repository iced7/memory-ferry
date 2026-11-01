import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { adapterContext, detectAgents, installAgents, skillSyncTargets, uninstallAgents, type AgentId } from "./adapters.js";
import { migrateVault } from "./migration.js";
import { StateStore } from "./state.js";
import { inspectSkills, listSkills, syncSkills } from "./skills.js";
import { expandPath, pathExists } from "./utils.js";
import { Vault } from "./vault.js";
import { LEGACY_MANIFEST_FILE, MANIFEST_FILE, PRODUCT_NAME, VERSION } from "./brand.js";

const execFileAsync = promisify(execFile);
const UI_FILE = fileURLToPath(new URL("../assets/ui.html", import.meta.url));
let embeddedUiTemplate: string | undefined;

const memoryInput = z.object({
  content: z.string().trim().min(1).max(64_000),
  title: z.string().max(300).optional(),
  kind: z.enum(['fact','preference','decision','lesson','note','task']).optional(),
  scope: z.enum(['global','project','agent']).optional(),
  scopeId: z.string().max(300).optional(),
  tags: z.array(z.string().max(100)).max(64).optional(),
});

export const SKILL_SYNC_INTERVAL_MS = 5 * 60_000;
export const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner=New-Object System.Windows.Forms.Form",
  "$owner.TopMost=$true",
  "$owner.ShowInTaskbar=$false",
  "$owner.Opacity=0.01",
  "$owner.Width=1",
  "$owner.Height=1",
  "$owner.StartPosition='CenterScreen'",
  "$d=New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description='选择 Memory Ferry Vault 文件夹 / Choose a Memory Ferry Vault folder'",
  "try{$owner.Show();$owner.Activate();if($d.ShowDialog($owner)-eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}}finally{$d.Dispose();$owner.Dispose()}",
].join(";");

export function setEmbeddedUiTemplate(template: string): void {
  embeddedUiTemplate = template;
}

export interface UiOptions {
  state?: StateStore;
  cliPath: string;
  host?: string;
  port?: number;
  open?: boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  initialVault?: string;
}

export interface UiHandle {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function providerFor(folder: string, platform: NodeJS.Platform): { id: string; label: string; detail: string } {
  const normalized = folder.replaceAll("\\", "/").toLocaleLowerCase();
  if (normalized.includes("mobile documents/com~apple~clouddocs")) return { id: "icloud", label: "iCloud Drive", detail: "由 iCloud Drive 同步文件" };
  if (normalized.includes("onedrive")) return { id: "onedrive", label: "OneDrive", detail: "由 OneDrive 客户端同步文件" };
  if (normalized.includes("dropbox")) return { id: "dropbox", label: "Dropbox", detail: "由 Dropbox 客户端同步文件" };
  if (normalized.includes("syncthing")) return { id: "syncthing", label: "Syncthing", detail: "由 Syncthing 同步文件" };
  if (normalized.startsWith("//") || normalized.startsWith("/volumes/") || (platform === "win32" && /^[a-z]:\//.test(normalized))) {
    return { id: "network", label: "NAS / 挂载磁盘", detail: "通过文件系统读写；请确认挂载与同步状态" };
  }
  return { id: "local", label: "本地文件夹", detail: "未识别到网盘路径；可配合任意同步软件" };
}

async function chooseFolder(platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform === "darwin") {
    const { stdout } = await execFileAsync("osascript", ["-e", "POSIX path of (choose folder with prompt \"选择 Memory Ferry Vault 文件夹 / Choose a Vault folder\")"]);
    return stdout.trim().replace(/\/$/, "") || undefined;
  }
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", WINDOWS_FOLDER_PICKER_SCRIPT], { windowsHide: true });
    return stdout.trim() || undefined;
  }
  const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Memory Ferry · 选择 Vault 文件夹"]);
  return stdout.trim() || undefined;
}

function openBrowser(url: string, platform: NodeJS.Platform): void {
  const child = platform === "darwin"
    ? spawn("open", [url], { detached: true, stdio: "ignore" })
    : platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function dashboardStatus(options: Required<Pick<UiOptions, "state" | "cliPath" | "homeDir" | "env" | "platform">>) {
  const localState = await options.state.load();
  const vaultPath = localState.defaultVault;
  const knownPaths = [...new Set([...(localState.vaults || []), ...(vaultPath ? [vaultPath] : [])])];
  const vaults = await Promise.all(knownPaths.map(async (knownPath) => {
    try {
      const manifest = await new Vault(knownPath, options.state).manifest();
      let writable = true;
      try { await access(knownPath, constants.R_OK | constants.W_OK); } catch { writable = false; }
      return { path: knownPath, manifest, provider: providerFor(knownPath, options.platform), writable, available: true, current: knownPath === vaultPath };
    } catch (error) {
      return { path: knownPath, provider: providerFor(knownPath, options.platform), writable: false, available: false, current: knownPath === vaultPath, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  let vault: null | Record<string, unknown> = null;
  let vaultError: string | undefined;
  if (vaultPath) {
    try {
      const instance = new Vault(vaultPath, options.state);
      const [manifest, events, current, skills] = await Promise.all([instance.manifest(), instance.events(), instance.current(), listSkills(vaultPath)]);
      let writable = true;
      try { await access(vaultPath, constants.R_OK | constants.W_OK); } catch { writable = false; }
      const latest = events.at(-1);
      const health = await instance.health();
      vault = {
        path: vaultPath, manifest, provider: providerFor(vaultPath, options.platform), writable,
        memories: current.size, events: events.length, skills: skills.length,
        latestEventAt: latest?.createdAt, latestDeviceId: latest?.deviceId, health,
        privacy: { encrypted: false, deletion: 'tombstone', historyRetained: true }
      };
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error);
    }
  }
  const context = adapterContext(vaultPath || process.cwd(), options.cliPath, { homeDir: options.homeDir, env: options.env, platform: options.platform });
  const agents = await detectAgents(context);
  const skillCompatibility = vaultPath ? await inspectSkills(vaultPath, options.platform) : [];
  return { version: VERSION, vault, vaults, vaultPath: vaultPath || null, vaultError, agents, skillCompatibility, autoManage: localState.autoManage !== false, statePath: options.state.file, platform: options.platform };
}

async function connectedAgentIds(vaultPath: string, options: Required<Pick<UiOptions, "cliPath" | "homeDir" | "env" | "platform">>): Promise<AgentId[]> {
  const context = adapterContext(vaultPath, options.cliPath, { homeDir: options.homeDir, env: options.env, platform: options.platform });
  return (await detectAgents(context)).filter((agent) => agent.connected).map((agent) => agent.id as AgentId);
}

async function applyActiveVault(vaultPath: string, ids: AgentId[], options: Required<Pick<UiOptions, "state" | "cliPath" | "homeDir" | "env" | "platform">>): Promise<void> {
  await new Vault(vaultPath, options.state).manifest();
  await options.state.setDefaultVault(vaultPath);
  if ((await options.state.load()).autoManage === false) return;
  if (!ids.length) return;
  const context = adapterContext(vaultPath, options.cliPath, { homeDir: options.homeDir, env: options.env, platform: options.platform });
  await installAgents(context, ids);
  for (const target of skillSyncTargets(context, ids)) await syncSkills(vaultPath, target.destination, { agentIds: target.agentIds, platform: context.platform });
}

export async function startUiServer(options: UiOptions): Promise<UiHandle> {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("The UI may only listen on the local machine.");
  const port = options.port ?? 47831;
  const state = options.state || new StateStore();
  const homeDir = options.homeDir || homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (options.initialVault) {
    const initial = expandPath(options.initialVault, homeDir);
    await new Vault(initial, state).manifest();
    await state.setDefaultVault(initial);
  }
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const template = embeddedUiTemplate ?? await readFile(UI_FILE, "utf8");
  const page = template.replaceAll("__MEMORY_FERRY_TOKEN__", token).replaceAll("__AGENT_VAULT_TOKEN__", token).replaceAll("__CSP_NONCE__", nonce);
  let origin = "";
  let autoSync: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) { json(response, 403, { error: 'Invalid host.' }); return; }
      const requestUrl = new URL(request.url || "/", origin || `http://${host}:${port}`);
      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer"
        });
        response.end(page); return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      if (request.method === "GET" && requestUrl.pathname === "/api/health") { json(response, 200, { ok: true }); return; }
      if (!requestUrl.pathname.startsWith("/api/")) { json(response, 404, { error: "Not found" }); return; }
      if (request.headers["x-memory-ferry-token"] !== token && request.headers["x-agent-vault-token"] !== token) { json(response, 403, { error: "Invalid local UI token." }); return; }
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin && suppliedOrigin !== origin) { json(response, 403, { error: "Invalid origin." }); return; }

      const shared = { state, cliPath: options.cliPath, homeDir, env, platform };
      if (request.method === "GET" && requestUrl.pathname === "/api/status") { json(response, 200, await dashboardStatus(shared)); return; }
      if (requestUrl.pathname === '/api/memories' || requestUrl.pathname.startsWith('/api/memories/')) {
        const vault = new Vault(await state.resolveVault(), state, {env});
        const manifest = await vault.manifest();
        const parts = requestUrl.pathname.split('/').filter(Boolean);
        const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
        if (request.method === 'GET' && !id) {
          const query = requestUrl.searchParams.get('query') || '';
          if (query.length > 4000) throw new Error('Search query is too long.');
          const projectId = requestUrl.searchParams.get('project') || undefined;
          const all = await vault.events();
          const latest = new Map<string, typeof all[number]>();
          for (const event of all) latest.set(event.memoryId, event);
          const deleted = requestUrl.searchParams.get('deleted') === 'true';
          const records = deleted
            ? [...latest.values()].filter(e=>e.op==='delete').map(e=>{
                const prior = [...all].reverse().find(p=>p.memoryId===e.memoryId && p.op==='put');
                return prior?.record;
              }).filter(r=>r!==undefined).filter(r=>(!projectId || r.scope.type==='global' || r.scope.type==='project' && r.scope.id===projectId) && (!query || `${r.title || ''} ${r.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
            : (await vault.search(query, Number.MAX_SAFE_INTEGER, {semantic:false, projectId})).map(r=>r.memory);
          const items = records.slice(0,200).map(record=>({record, revision:latest.get(record.id)?.eventId, deleted}));
          json(response, 200, {vaultId:manifest.vaultId, vaultPath:vault.root, items, total:records.length, duplicates:await vault.duplicates(), warnings:vault.diagnostics}); return;
        }
        if (request.method === 'GET' && id) {
          const history = await vault.history(id);
          if (!history.length) { json(response,404,{error:'Memory not found.'}); return; }
          json(response,200,{vaultId:manifest.vaultId, vaultPath:vault.root, history, warnings:vault.diagnostics}); return;
        }
        if (request.method === 'POST') {
          const input = await body(request);
          if (input.vaultId !== manifest.vaultId || input.vaultPath !== vault.root) throw new Error('The active Vault changed. Reload before saving.');
          if (!id) { json(response,200,{record:await vault.remember(memoryInput.parse(input))}); return; }
          const revision = z.string().uuid().parse(input.expectedRevision);
          if (parts[3] === 'forget') { json(response,200,{deleted:await vault.forget(id, revision), historicalContentRetained:true}); return; }
          if (parts[3] === 'restore') { json(response,200,{record:await vault.restore(id,z.string().uuid().parse(input.eventId),revision)}); return; }
          if (parts.length === 3) { json(response,200,{record:await vault.update(id,memoryInput.partial().parse(input),revision)}); return; }
        }
        json(response,404,{error:'Memory route not found.'}); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/shutdown") {
        json(response, 200, { ok: true });
        const timer = setTimeout(() => { void close(); }, 75);
        timer.unref();
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/pick-folder") {
        try { json(response, 200, { path: await chooseFolder(platform) }); }
        catch (error) { json(response, 200, { path: null, cancelled: true, detail: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/vault/connect") {
        const input = await body(request);
        if (typeof input.path !== "string" || !input.path.trim()) throw new Error("Vault path is required.");
        const selected = expandPath(input.path.trim(), homeDir);
        const previous = (await state.load()).defaultVault || selected;
        const ids = await connectedAgentIds(previous, shared);
        const hasManifest = await pathExists(path.join(selected, MANIFEST_FILE)) || await pathExists(path.join(selected, LEGACY_MANIFEST_FILE));
        if (hasManifest) {
          await applyActiveVault(selected, ids, shared);
        } else if (input.create === true) {
          await Vault.init(selected, typeof input.name === "string" && input.name.trim() ? input.name.trim() : path.basename(selected), state);
          await applyActiveVault(selected, ids, shared);
        } else {
          throw new Error("This folder is not a Memory Ferry Vault. Enable ‘create’ to initialize it.");
        }
        json(response, 200, { ok: true, path: selected }); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/vault/switch") {
        const input = await body(request);
        if (typeof input.path !== "string" || !input.path.trim()) throw new Error("Vault path is required.");
        const selected = expandPath(input.path.trim(), homeDir);
        const previous = (await state.load()).defaultVault || selected;
        await applyActiveVault(selected, await connectedAgentIds(previous, shared), shared);
        json(response, 200, { ok: true, path: selected }); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/vault/remove") {
        const input = await body(request);
        if (typeof input.path !== "string" || !input.path.trim()) throw new Error("Vault path is required.");
        await state.removeVault(expandPath(input.path.trim(), homeDir));
        json(response, 200, { ok: true }); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/vault/migrate") {
        const input = await body(request);
        if (typeof input.source !== "string" || typeof input.target !== "string" || !input.source.trim() || !input.target.trim()) throw new Error("Source and target Vault are required.");
        const source = expandPath(input.source.trim(), homeDir);
        const target = expandPath(input.target.trim(), homeDir);
        json(response, 200, { ok: true, result: await migrateVault(source, target) }); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/vault/disconnect") {
        await state.clearDefaultVault(); json(response, 200, { ok: true }); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/settings/auto-manage") {
        const input = await body(request);
        if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean.");
        await state.setAutoManage(input.enabled);
        json(response, 200, { ok: true, enabled: input.enabled }); return;
      }
      const agentMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/(connect|disconnect)$/);
      if (request.method === "POST" && agentMatch) {
        const id = decodeURIComponent(agentMatch[1]) as AgentId;
        const vaultPath = await state.resolveVault();
        const context = adapterContext(vaultPath, options.cliPath, { homeDir, env, platform });
        if (agentMatch[2] === "connect") {
          const installed = await installAgents(context, [id]);
          const skills = [];
          for (const target of skillSyncTargets(context, [id])) skills.push(...await syncSkills(vaultPath, target.destination, { agentIds: target.agentIds, platform: context.platform }));
          json(response, 200, { ok: true, installed, skills });
        } else {
          json(response, 200, { ok: true, removed: await uninstallAgents(context, [id]) });
        }
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/skills/sync") {
        const vaultPath = await state.resolveVault();
        const context = adapterContext(vaultPath, options.cliPath, { homeDir, env, platform });
        const results = [];
        for (const target of skillSyncTargets(context, ["all"])) results.push(...await syncSkills(vaultPath, target.destination, { agentIds: target.agentIds, platform: context.platform }));
        json(response, 200, { ok: true, results }); return;
      }
      json(response, 404, { error: "API route not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, /changed since|active Vault changed/.test(message) ? 409 : 400, { error: message });
    }
  });

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (autoSync) clearInterval(autoSync);
    closePromise = new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    });
    return closePromise;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  origin = `http://${host === "::1" ? `[${host}]` : host}:${actualPort}`;
  let autoSyncRunning = false;
  autoSync = setInterval(async () => {
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try {
      const local = await state.load();
      if (local.autoManage === false || !local.defaultVault) return;
      const context = adapterContext(local.defaultVault, options.cliPath, { homeDir, env, platform });
      const ids = (await detectAgents(context)).filter((agent) => agent.connected && agent.current).map((agent) => agent.id as AgentId);
      if (!ids.length) return;
      for (const target of skillSyncTargets(context, ids)) await syncSkills(local.defaultVault, target.destination, { agentIds: target.agentIds, platform: context.platform });
    } catch {
      // A temporarily unavailable cloud folder is retried on the next interval.
    } finally {
      autoSyncRunning = false;
    }
  }, SKILL_SYNC_INTERVAL_MS);
  autoSync.unref();
  if (options.open !== false) openBrowser(origin, platform);
  return { server, url: origin, token, close };
}

export async function runUi(options: UiOptions): Promise<void> {
  try {
    const handle = await startUiServer(options);
    console.log(`${PRODUCT_NAME} UI: ${handle.url}`);
    console.log(`Use the dashboard's exit button to stop ${PRODUCT_NAME}.`);
  } catch (error) {
    if (options.open !== false && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const host = options.host || "127.0.0.1";
      const port = options.port ?? 47831;
      openBrowser(`http://${host === "::1" ? `[${host}]` : host}:${port}`, options.platform || process.platform);
      return;
    }
    throw error;
  }
}
