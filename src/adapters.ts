import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import path from "node:path";
import { isSea } from "node:sea";
import { backupFile, deleteNested, getNested, setNested, updateJsonFile, updateMarkedText } from "./config.js";
import { pathExists, readJson } from "./utils.js";

export type AgentId = "codex" | "claude" | "cursor" | "opencode" | "deepseek-harness" | "gemini" | "copilot" | "minimax-code";

export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AdapterContext {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  vaultPath: string;
  launch: McpLaunch;
}

export interface AdapterContextOptions extends Partial<Pick<AdapterContext, "homeDir" | "env" | "platform">> {
  selfContained?: boolean;
}

export interface InstallResult {
  id: AgentId;
  label: string;
  configPath: string;
  changed: boolean;
  backup?: string;
  note?: string;
}

interface Adapter {
  id: AgentId;
  label: string;
  binaries: string[];
  configPath(context: AdapterContext): string;
  skillDirs(context: AdapterContext): string[];
  detect(context: AdapterContext): Promise<{ detected: boolean; evidence: string[] }>;
  connection(context: AdapterContext): Promise<{ connected: boolean; current: boolean; launchCurrent: boolean }>;
  install(context: AdapterContext): Promise<InstallResult>;
  uninstall(context: AdapterContext): Promise<InstallResult>;
}

async function executableOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  const extensions = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try { await access(join(dir, `${name}${extension}`)); return true; } catch { /* continue */ }
    }
  }
  return false;
}

function npmCacheDir(context: AdapterContext): string {
  if (context.env.npm_config_cache) return context.env.npm_config_cache;
  if (context.platform === "win32" && context.env.LOCALAPPDATA) return path.join(context.env.LOCALAPPDATA, "npm-cache");
  return path.join(context.homeDir, ".npm");
}

async function packageInNpxCache(packageName: string, context: AdapterContext): Promise<boolean> {
  const npxRoot = path.join(npmCacheDir(context), "_npx");
  try {
    const entries = await readdir(npxRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(npxRoot, entry.name, "node_modules", ...packageName.split("/"), "package.json");
      if (await pathExists(manifest)) return true;
    }
  } catch {
    // A missing or unreadable npm cache simply means there is no cache evidence.
  }
  return false;
}

function containsString(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target || value.includes(target);
  if (Array.isArray(value)) return value.some((item) => containsString(item, target));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsString(item, target));
  return false;
}

function minimaxPluginRoot(context: AdapterContext): string {
  return path.join(context.env.MINIMAX_DATA_DIR || path.join(context.homeDir, ".minimax"), "plugins", "agent-vault");
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function minimaxLaunch(context: AdapterContext): { file: string; content: string; spec: Record<string, unknown> } {
  const mcpIndex = context.launch.args.indexOf("mcp");
  if (mcpIndex < 0) throw new Error("Agent Vault MCP launch arguments are incomplete.");
  const prefix = [context.launch.command, ...context.launch.args.slice(0, mcpIndex)];
  const windows = context.platform === "win32";
  const filename = windows ? "agent-vault-mcp.cmd" : "agent-vault-mcp";
  const command = windows ? prefix.map(quoteCmd).join(" ") : prefix.map(quoteShell).join(" ");
  const content = windows ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`;
  return {
    file: path.join(minimaxPluginRoot(context), filename),
    content,
    spec: {
      type: "stdio",
      command: `./${filename}`,
      args: context.launch.args.slice(mcpIndex),
      ...(context.launch.env ? { env: context.launch.env } : {})
    }
  };
}

async function writeGeneratedFile(file: string, content: string, executable = false): Promise<{ changed: boolean; backup?: string }> {
  const old = await pathExists(file) ? await readFile(file, "utf8") : undefined;
  if (old === content) {
    if (executable) await chmod(file, 0o755);
    return { changed: false };
  }
  const backup = await backupFile(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  if (executable) await chmod(file, 0o755);
  return { changed: true, ...(backup ? { backup } : {}) };
}

async function updateDshPatch(file: string, block?: string): Promise<{ changed: boolean; backup?: string }> {
  const start = "# >>> agent-vault:deepseek-harness-mcp >>>";
  const end = "# <<< agent-vault:deepseek-harness-mcp <<<";
  const old = await pathExists(file) ? await readFile(file, "utf8") : "";
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = old.replace(new RegExp(`(?:^|\\n)${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\n|$)`, "g"), "\n").trim();
  const base = stripped === "[]" ? "" : stripped;
  const next = block
    ? `${base}${base ? "\n\n" : ""}${start}\n${block.trim()}\n${end}\n`
    : base ? `${base}\n` : "[]\n";
  if (next === old) return { changed: false };
  const backup = await backupFile(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, "utf8");
  return { changed: true, ...(backup ? { backup } : {}) };
}

function jsonAdapter(options: {
  id: AgentId;
  label: string;
  binaries: string[];
  config: (context: AdapterContext) => string;
  keys: string[];
  spec: (launch: McpLaunch) => unknown;
  skills: (context: AdapterContext) => string[];
}): Adapter {
  return {
    id: options.id, label: options.label, binaries: options.binaries,
    configPath: options.config, skillDirs: options.skills,
    async detect(context) {
      const evidence: string[] = [];
      for (const binary of options.binaries) if (await executableOnPath(binary, context.env, context.platform)) evidence.push(`binary:${binary}`);
      if (await pathExists(options.config(context))) evidence.push(`config:${options.config(context)}`);
      return { detected: evidence.length > 0, evidence };
    },
    async connection(context) {
      const configPath = options.config(context);
      if (!(await pathExists(configPath))) return { connected: false, current: false, launchCurrent: false };
      try {
        const value = await readJson<Record<string, unknown>>(configPath);
        const configured = getNested(value, options.keys);
        const serialized = JSON.stringify(configured);
        return { connected: configured !== undefined, current: containsString(configured, context.vaultPath), launchCurrent: serialized === JSON.stringify(options.spec(context.launch)) };
      } catch {
        return { connected: false, current: false, launchCurrent: false };
      }
    },
    async install(context) {
      const configPath = options.config(context);
      const result = await updateJsonFile(configPath, (value) => setNested(value, options.keys, options.spec(context.launch)));
      return { id: options.id, label: options.label, configPath, ...result };
    },
    async uninstall(context) {
      const configPath = options.config(context);
      if (!(await pathExists(configPath))) return { id: options.id, label: options.label, configPath, changed: false };
      const result = await updateJsonFile(configPath, (value) => deleteNested(value, options.keys));
      return { id: options.id, label: options.label, configPath, ...result };
    }
  };
}

const stdioSpec = (launch: McpLaunch) => ({ command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) });
const localSpec = (launch: McpLaunch) => ({ type: "local", command: [launch.command, ...launch.args], enabled: true, ...(launch.env ? { environment: launch.env } : {}) });

const adapters: Adapter[] = [
  {
    id: "codex", label: "OpenAI Codex", binaries: ["codex"],
    configPath: ({ homeDir }) => path.join(homeDir, ".codex", "config.toml"),
    skillDirs: ({ homeDir }) => [path.join(homeDir, ".agents", "skills")],
    async detect(context) {
      const evidence: string[] = [];
      if (await executableOnPath("codex", context.env, context.platform)) evidence.push("binary:codex");
      if (await pathExists(this.configPath(context))) evidence.push(`config:${this.configPath(context)}`);
      return { detected: evidence.length > 0, evidence };
    },
    async connection(context) {
      const configPath = this.configPath(context);
      if (!(await pathExists(configPath))) return { connected: false, current: false, launchCurrent: false };
      const text = await readFile(configPath, "utf8");
      const connected = text.includes("# >>> agent-vault:codex-mcp >>>");
      return { connected, current: connected && text.includes(JSON.stringify(context.vaultPath)), launchCurrent: connected && text.includes(JSON.stringify(context.vaultPath)) && text.includes(JSON.stringify(context.launch.args[0])) };
    },
    async install(context) {
      const configPath = this.configPath(context);
      const block = `[mcp_servers.agent-vault]\ncommand = ${JSON.stringify(context.launch.command)}\nargs = ${JSON.stringify(context.launch.args)}`;
      const result = await updateMarkedText(configPath, "codex-mcp", block);
      return { id: this.id, label: this.label, configPath, ...result };
    },
    async uninstall(context) {
      const configPath = this.configPath(context);
      const result = await updateMarkedText(configPath, "codex-mcp");
      return { id: this.id, label: this.label, configPath, ...result };
    }
  },
  jsonAdapter({
    id: "claude", label: "Claude Code", binaries: ["claude"],
    config: ({ homeDir }) => path.join(homeDir, ".claude.json"), keys: ["mcpServers", "agent-vault"], spec: stdioSpec,
    skills: ({ homeDir }) => [path.join(homeDir, ".claude", "skills")]
  }),
  jsonAdapter({
    id: "cursor", label: "Cursor", binaries: ["cursor"],
    config: ({ homeDir }) => path.join(homeDir, ".cursor", "mcp.json"), keys: ["mcpServers", "agent-vault"], spec: stdioSpec,
    skills: ({ homeDir }) => [path.join(homeDir, ".cursor", "skills")]
  }),
  jsonAdapter({
    id: "opencode", label: "OpenCode", binaries: ["opencode"],
    config: ({ homeDir, env, platform }) => platform === "win32" && env.APPDATA ? path.join(env.APPDATA, "opencode", "opencode.json") : path.join(homeDir, ".config", "opencode", "opencode.json"),
    keys: ["mcp", "servers", "agent-vault"], spec: localSpec,
    skills: ({ homeDir }) => [path.join(homeDir, ".agents", "skills")]
  }),
  {
    id: "deepseek-harness", label: "DeepSeek Harness", binaries: ["dsh"],
    configPath: ({ homeDir, env }) => path.join(env.DSH_HOME || path.join(homeDir, ".dsh"), "cordis.patch.yml"),
    skillDirs: ({ homeDir, env }) => [path.join(homeDir, ".agents", "skills"), path.join(env.DSH_HOME || path.join(homeDir, ".dsh"), "skills")],
    async detect(context) {
      const evidence: string[] = [];
      if (await executableOnPath("dsh", context.env, context.platform)) evidence.push("binary:dsh");
      if (await packageInNpxCache("@deepseek-ai/dsh", context)) evidence.push("npx-cache:@deepseek-ai/dsh");
      if (await pathExists(this.configPath(context))) evidence.push(`config:${this.configPath(context)}`);
      return { detected: evidence.length > 0, evidence };
    },
    async connection(context) {
      const configPath = this.configPath(context);
      if (!(await pathExists(configPath))) return { connected: false, current: false, launchCurrent: false };
      const text = await readFile(configPath, "utf8");
      const connected = text.includes("# >>> agent-vault:deepseek-harness-mcp >>>");
      return { connected, current: connected && text.includes(JSON.stringify(context.vaultPath)), launchCurrent: connected && text.includes(JSON.stringify(context.vaultPath)) && text.includes(JSON.stringify(context.launch.args[0])) };
    },
    async install(context) {
      const configPath = this.configPath(context);
      const args = context.launch.args.map((arg) => `          - ${JSON.stringify(arg)}`).join("\n");
      const block = `- insert:\n    - id: agent-vault-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agent-vault\n        transport: stdio\n        command: ${JSON.stringify(context.launch.command)}\n        args:\n${args}`;
      const result = await updateDshPatch(configPath, block);
      return { id: this.id, label: this.label, configPath, ...result, note: "Requires the official @deepseek-ai/dsh-mcp-client Cordis plugin supported by DSH." };
    },
    async uninstall(context) {
      const configPath = this.configPath(context);
      const result = await updateDshPatch(configPath);
      return { id: this.id, label: this.label, configPath, ...result };
    }
  },
  jsonAdapter({
    id: "gemini", label: "Gemini CLI", binaries: ["gemini"],
    config: ({ homeDir }) => path.join(homeDir, ".gemini", "settings.json"), keys: ["mcpServers", "agent-vault"], spec: stdioSpec,
    skills: ({ homeDir }) => [path.join(homeDir, ".gemini", "skills")]
  }),
  jsonAdapter({
    id: "copilot", label: "GitHub Copilot CLI", binaries: ["copilot"],
    config: ({ homeDir }) => path.join(homeDir, ".copilot", "mcp-config.json"), keys: ["mcpServers", "agent-vault"], spec: stdioSpec,
    skills: ({ homeDir }) => [path.join(homeDir, ".copilot", "skills")]
  }),
  {
    id: "minimax-code", label: "MiniMax Code", binaries: ["mcode"],
    configPath: (context) => path.join(minimaxPluginRoot(context), "mcp.json"),
    skillDirs: (context) => [path.join(minimaxPluginRoot(context), "skills")],
    async detect(context) {
      const evidence: string[] = [];
      if (await executableOnPath("mcode", context.env, context.platform)) evidence.push("binary:mcode");
      if (await pathExists(this.configPath(context))) evidence.push(`config:${this.configPath(context)}`);
      return { detected: evidence.length > 0, evidence };
    },
    async connection(context) {
      const configPath = this.configPath(context);
      if (!(await pathExists(configPath))) return { connected: false, current: false, launchCurrent: false };
      try {
        const value = await readJson<Record<string, unknown>>(configPath);
        const configured = getNested(value, ["mcpServers", "agent-vault"]);
        const launch = minimaxLaunch(context);
        const launcherCurrent = await pathExists(launch.file) && await readFile(launch.file, "utf8") === launch.content;
        return {
          connected: configured !== undefined,
          current: configured !== undefined && containsString(configured, context.vaultPath),
          launchCurrent: launcherCurrent && JSON.stringify(configured) === JSON.stringify(launch.spec)
        };
      } catch {
        return { connected: false, current: false, launchCurrent: false };
      }
    },
    async install(context) {
      const root = minimaxPluginRoot(context);
      const manifest = await updateJsonFile(path.join(root, "plugin.json"), (value) => {
        value.$schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
        value.name = "agent-vault";
        value.version = '0.5.0'
        value.description = "Shared local-first long-term memory and reusable Skills for MiniMax Code.";
        value.author = { name: "Agent Vault Sync" };
        value.license = "MIT";
        value.keywords = ["memory", "mcp", "skills", "local-first"];
      });
      const launch = minimaxLaunch(context);
      const launcher = await writeGeneratedFile(launch.file, launch.content, context.platform !== "win32");
      const configPath = this.configPath(context);
      const config = await updateJsonFile(configPath, (value) => {
        value.$schema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
        setNested(value, ["mcpServers", "agent-vault"], launch.spec);
      });
      return {
        id: this.id,
        label: this.label,
        configPath,
        changed: manifest.changed || launcher.changed || config.changed,
        backup: config.backup || launcher.backup || manifest.backup,
        note: "MiniMax Code loads this Agent Plugins 1.0 package from its local marketplace. Restart MiniMax Code after connecting."
      };
    },
    async uninstall(context) {
      const configPath = this.configPath(context);
      if (!(await pathExists(configPath))) return { id: this.id, label: this.label, configPath, changed: false };
      const result = await updateJsonFile(configPath, (value) => deleteNested(value, ["mcpServers", "agent-vault"]));
      return { id: this.id, label: this.label, configPath, ...result };
    }
  }
];

export function adapterContext(vaultPath: string, cliPath: string, options: AdapterContextOptions = {}): AdapterContext {
  const env = options.env || process.env;
  const packaged = options.selfContained ?? (env.AGENT_VAULT_EXE === "1" || isSea() || Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg));
  return {
    homeDir: options.homeDir || homedir(), env, platform: options.platform || process.platform,
    vaultPath: path.resolve(vaultPath), launch: { command: process.execPath, args: [...(packaged ? [] : [path.resolve(cliPath)]), "mcp", "--vault", path.resolve(vaultPath)] }
  };
}

export function getAdapters(ids?: string[]): Adapter[] {
  if (!ids?.length || ids.includes("all")) return adapters;
  const selected = adapters.filter((adapter) => ids.includes(adapter.id));
  const unknown = ids.filter((id) => !selected.some((adapter) => adapter.id === id));
  if (unknown.length) throw new Error(`Unknown agent adapter(s): ${unknown.join(", ")}`);
  return selected;
}

export async function detectAgents(context: AdapterContext) {
  return Promise.all(adapters.map(async (adapter) => {
    const detection = await adapter.detect(context);
    return {
      id: adapter.id,
      label: adapter.label,
      ...detection,
      binaryPresent: detection.evidence.some((item) => item.startsWith("binary:")),
      npxAvailable: detection.evidence.some((item) => item.startsWith("npx-cache:")),
      configPresent: detection.evidence.some((item) => item.startsWith("config:")),
      ...(await adapter.connection(context)),
      configPath: adapter.configPath(context),
      skillDirs: adapter.skillDirs(context)
    };
  }));
}

export async function installAgents(context: AdapterContext, ids?: string[]): Promise<InstallResult[]> {
  return Promise.all(getAdapters(ids).map((adapter) => adapter.install(context)));
}

export async function uninstallAgents(context: AdapterContext, ids?: string[]): Promise<InstallResult[]> {
  return Promise.all(getAdapters(ids).map((adapter) => adapter.uninstall(context)));
}

export function skillDestinations(context: AdapterContext, ids?: string[]): string[] {
  return [...new Set(getAdapters(ids).flatMap((adapter) => adapter.skillDirs(context)))];
}
