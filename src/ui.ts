import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { adapterContext, detectAgents, installAgents, skillDestinations, uninstallAgents, type AgentId } from "./adapters.js";
import { migrateVault } from "./migration.js";
import { StateStore } from "./state.js";
import { listSkills, syncSkills } from "./skills.js";
import { expandPath, pathExists } from "./utils.js";
import { Vault } from "./vault.js";

const execFileAsync = promisify(execFile);
const UI_FILE = fileURLToPath(new URL("../assets/ui.html", import.meta.url));
let embeddedUiTemplate: string | undefined;

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
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body is too large.");
  }
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
    const { stdout } = await execFileAsync("osascript", ["-e", "POSIX path of (choose folder with prompt \"选择 Agent Vault 文件夹\")"]);
    return stdout.trim().replace(/\/$/, "") || undefined;
  }
  if (platform === "win32") {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择 Agent Vault 文件夹'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true });
    return stdout.trim() || undefined;
  }
  const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=选择 Agent Vault 文件夹"]);
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
      const [manifest, events, status, skills] = await Promise.all([instance.manifest(), instance.events(), instance.status(), listSkills(vaultPath)]);
      let writable = true;
      try { await access(vaultPath, constants.R_OK | constants.W_OK); } catch { writable = false; }
      const latest = events.at(-1);
      vault = {
        path: vaultPath, manifest, provider: providerFor(vaultPath, options.platform), writable,
        memories: status.memories, events: status.events, encrypted: status.encrypted, unlocked: status.unlocked, skills: skills.length,
        latestEventAt: latest?.createdAt, latestDeviceId: latest?.deviceId
      };
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error);
    }
  }
  const context = adapterContext(vaultPath || process.cwd(), options.cliPath, { homeDir: options.homeDir, env: options.env, platform: options.platform });
  const agents = await detectAgents(context);
  return { version: "0.4.0", vault, vaults, vaultPath: vaultPath || null, vaultError, agents, autoManage: localState.autoManage !== false, statePath: options.state.file, platform: options.platform };
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
  for (const destination of skillDestinations(context, ids)) await syncSkills(vaultPath, destination);
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
  const page = template.replaceAll("__AGENT_VAULT_TOKEN__", token).replaceAll("__CSP_NONCE__", nonce);
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
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
      if (request.headers["x-agent-vault-token"] !== token) { json(response, 403, { error: "Invalid local UI token." }); return; }
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin && suppliedOrigin !== origin) { json(response, 403, { error: "Invalid origin." }); return; }

      const shared = { state, cliPath: options.cliPath, homeDir, env, platform };
      if (request.method === "GET" && requestUrl.pathname === "/api/status") { json(response, 200, await dashboardStatus(shared)); return; }
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
        const manifest = path.join(selected, "agent-vault.json");
        if (await pathExists(manifest)) {
          await applyActiveVault(selected, ids, shared);
        } else if (input.create === true) {
          await Vault.init(selected, typeof input.name === "string" && input.name.trim() ? input.name.trim() : path.basename(selected), state);
          await applyActiveVault(selected, ids, shared);
        } else {
          throw new Error("This folder is not an Agent Vault. Enable ‘create’ to initialize it.");
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
          for (const destination of skillDestinations(context, [id])) skills.push(...await syncSkills(vaultPath, destination));
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
        for (const destination of skillDestinations(context, ["all"])) results.push(...await syncSkills(vaultPath, destination));
        json(response, 200, { ok: true, results }); return;
      }
      json(response, 404, { error: "API route not found." });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  origin = `http://${host === "::1" ? `[${host}]` : host}:${actualPort}`;
  let autoSyncRunning = false;
  const autoSync = setInterval(async () => {
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try {
      const local = await state.load();
      if (local.autoManage === false || !local.defaultVault) return;
      const context = adapterContext(local.defaultVault, options.cliPath, { homeDir, env, platform });
      const ids = (await detectAgents(context)).filter((agent) => agent.connected && agent.current).map((agent) => agent.id as AgentId);
      if (!ids.length) return;
      for (const destination of skillDestinations(context, ids)) await syncSkills(local.defaultVault, destination);
    } catch {
      // A temporarily unavailable cloud folder is retried on the next interval.
    } finally {
      autoSyncRunning = false;
    }
  }, 15_000);
  autoSync.unref();
  if (options.open !== false) openBrowser(origin, platform);
  return { server, url: origin, token, close: () => new Promise<void>((resolve, reject) => {
    clearInterval(autoSync);
    server.close((error) => error ? reject(error) : resolve());
  }) };
}

export async function runUi(options: UiOptions): Promise<void> {
  const handle = await startUiServer(options);
  console.log(`Agent Vault UI: ${handle.url}`);
  console.log("Press Ctrl+C to stop the local dashboard.");
}
