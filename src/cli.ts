#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MemoryKind, ScopeType } from "./types.js";
import { StateStore } from "./state.js";
import { Vault } from "./vault.js";
import { inspectSkills, listSkills, syncSkills } from "./skills.js";
import { adapterContext, detectAgents, installAgents, skillSyncTargets, uninstallAgents } from "./adapters.js";
import { runMcp } from "./mcp.js";
import { runUi } from "./ui.js";
import { migrateVault } from "./migration.js";
import { CLI_NAME, PRODUCT_NAME, PRODUCT_NAME_ZH, VERSION } from "./brand.js";

const COMMANDS = `  ${CLI_NAME} init <folder> [--name <name>]
  ${CLI_NAME} use <folder>
  ${CLI_NAME} vaults list|remove <folder>
  ${CLI_NAME} vault migrate <source-folder> <target-folder>
  ${CLI_NAME} status [--json]
  ${CLI_NAME} remember <text> [--title <title>] [--kind <kind>] [--scope <scope>] [--scope-id <id>] [--tag <tag> ...]
  ${CLI_NAME} recall <query> [--limit <n>] [--no-semantic] [--json]
  ${CLI_NAME} list|get|update|forget ...
  ${CLI_NAME} context <query> [--limit <n>] [--no-semantic]
  ${CLI_NAME} skills list|inspect|sync [all|agent ...]
  ${CLI_NAME} agents detect|install|uninstall [all|agent ...]
  ${CLI_NAME} ui [--port <n>] [--no-open]
  ${CLI_NAME} mcp`;

const HELP_EN = `${PRODUCT_NAME} ${VERSION}

Local-first long-term memory shared through iCloud, OneDrive, NAS, or any synced folder.

Usage:
${COMMANDS}

Global options:
  --vault <folder>        Override the selected vault
  --lang <en|zh-CN>       Help language
  --json                  Machine-readable output
  -h, --help              Show help
`;

const HELP_ZH = `${PRODUCT_NAME} · ${PRODUCT_NAME_ZH} ${VERSION}

通过 iCloud、OneDrive、NAS 或任意同步文件夹，在跨设备、跨 AI Agent 场景中共享本地优先的长期记忆。

用法：
${COMMANDS}

全局选项：
  --vault <folder>        临时指定 Vault
  --lang <en|zh-CN>       帮助语言
  --json                  输出机器可读 JSON
  -h, --help              显示帮助
`;

interface Parsed { positionals: string[]; flags: Map<string, string[]>; }

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set(["json", "help", "h", "version", "no-open", "no-semantic"]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--") && token !== "-h") { positionals.push(token); continue; }
    const raw = token === "-h" ? "h" : token.slice(2);
    const equal = raw.indexOf("=");
    const key = equal >= 0 ? raw.slice(0, equal) : raw;
    let value = equal >= 0 ? raw.slice(equal + 1) : "true";
    if (equal < 0 && !booleans.has(key) && argv[index + 1] !== undefined && !argv[index + 1].startsWith("-")) value = argv[++index];
    flags.set(key, [...(flags.get(key) || []), value]);
  }
  return { positionals, flags };
}

function flag(parsed: Parsed, key: string): string | undefined { return parsed.flags.get(key)?.at(-1); }
function flags(parsed: Parsed, key: string): string[] | undefined { return parsed.flags.get(key); }
function numberFlag(parsed: Parsed, key: string, fallback: number): number {
  const value = flag(parsed, key);
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`--${key} must be a positive integer.`);
  return number;
}
function print(value: unknown, json = false): void {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}
function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

async function selectedVault(parsed: Parsed, state: StateStore): Promise<Vault> {
  return new Vault(await state.resolveVault(flag(parsed, "vault")), state);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parse(argv);
  const [command, subcommand, ...rest] = parsed.positionals;
  const locale = flag(parsed, "lang") || process.env.MEMORY_FERRY_LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  const help = locale.toLowerCase().startsWith("zh") ? HELP_ZH : HELP_EN;
  if (parsed.flags.has("version")) { console.log(VERSION); return; }
  if (!command || parsed.flags.has("help") || parsed.flags.has("h")) { console.log(help); return; }
  if (command === "version") { console.log(VERSION); return; }
  const state = new StateStore();
  const wantsJson = parsed.flags.has("json");

  if (command === "init") {
    const folder = requireArg(subcommand, "vault folder");
    const vault = await Vault.init(folder, flag(parsed, "name") || path.basename(path.resolve(folder)), state);
    print({ initialized: true, path: vault.root, manifest: await vault.manifest() }, wantsJson);
    return;
  }
  if (command === "use") {
    const folder = path.resolve(requireArg(subcommand, "vault folder"));
    await new Vault(folder, state).manifest(); await state.setDefaultVault(folder);
    print({ selected: true, path: folder }, wantsJson); return;
  }
  if (command === "vaults") {
    if (subcommand === "list") {
      const local = await state.load();
      const paths = [...new Set([...(local.vaults || []), ...(local.defaultVault ? [local.defaultVault] : [])])];
      const values = await Promise.all(paths.map(async (vaultPath) => {
        try { return { path: vaultPath, current: vaultPath === local.defaultVault, available: true, manifest: await new Vault(vaultPath, state).manifest() }; }
        catch (error) { return { path: vaultPath, current: vaultPath === local.defaultVault, available: false, error: error instanceof Error ? error.message : String(error) }; }
      }));
      print(values, wantsJson); return;
    }
    if (subcommand === "remove") {
      const folder = path.resolve(requireArg(rest[0], "vault folder"));
      await state.removeVault(folder); print({ removed: true, path: folder }, wantsJson); return;
    }
    throw new Error(`Use \`${CLI_NAME} vaults list|remove <folder>\`.`);
  }
  if (command === "vault" && subcommand === "migrate") {
    print(await migrateVault(requireArg(rest[0], "source Vault folder"), requireArg(rest[1], "target Vault folder")), wantsJson); return;
  }
  if (command === "ui") {
    await runUi({ state, cliPath: fileURLToPath(import.meta.url), port: numberFlag(parsed, "port", 47831), open: !parsed.flags.has("no-open"), initialVault: flag(parsed, "vault") });
    return;
  }

  const vault = await selectedVault(parsed, state);
  if (command === "mcp") { await runMcp(vault); return; }
  if (command === "status") {
    print({ path: vault.root, manifest: await vault.manifest(), memories: (await vault.current()).size, events: (await vault.events()).length, skills: await listSkills(vault.root) }, wantsJson); return;
  }
  if (command === "remember") {
    const content = [subcommand, ...rest].filter(Boolean).join(" ");
    const memory = await vault.remember({ content: requireArg(content, "memory text"), title: flag(parsed, "title"), kind: flag(parsed, "kind") as MemoryKind | undefined, scope: flag(parsed, "scope") as ScopeType | undefined, scopeId: flag(parsed, "scope-id"), tags: flags(parsed, "tag"), source: { agent: flag(parsed, "source-agent"), session: flag(parsed, "source-session"), uri: flag(parsed, "source-uri") } });
    print(memory, wantsJson); return;
  }
  if (command === "recall") {
    const query = [subcommand, ...rest].filter(Boolean).join(" ");
    const results = await vault.search(requireArg(query, "search query"), numberFlag(parsed, "limit", 10), { kind: flag(parsed, "kind") as MemoryKind | undefined, scope: flag(parsed, "scope") as ScopeType | undefined, scopeId: flag(parsed, "scope-id"), tags: flags(parsed, "tag"), semantic: !parsed.flags.has("no-semantic") });
    if (wantsJson) print(results, true); else print(results.length ? results.map(({ memory, score }) => `${score.toFixed(2)}  ${memory.id}  [${memory.kind}] ${memory.title ? `${memory.title}: ` : ""}${memory.content}`).join("\n") : "No matching memory.");
    return;
  }
  if (command === "list") {
    const values = await vault.list({ limit: numberFlag(parsed, "limit", 100), kind: flag(parsed, "kind") as MemoryKind | undefined, scope: flag(parsed, "scope") as ScopeType | undefined, scopeId: flag(parsed, "scope-id"), tags: flags(parsed, "tag") });
    if (wantsJson) print(values, true); else print(values.length ? values.map((memory) => `${memory.id}  [${memory.kind}] ${memory.title ? `${memory.title}: ` : ""}${memory.content}`).join("\n") : "No memory saved.");
    return;
  }
  if (command === "get") { print((await vault.get(requireArg(subcommand, "memory ID"))) || { found: false }, wantsJson); return; }
  if (command === "update") {
    const memory = await vault.update(requireArg(subcommand, "memory ID"), { content: flag(parsed, "content"), title: flag(parsed, "title"), kind: flag(parsed, "kind") as MemoryKind | undefined, scope: flag(parsed, "scope") as ScopeType | undefined, scopeId: flag(parsed, "scope-id"), tags: flags(parsed, "tag") });
    print(memory, wantsJson); return;
  }
  if (command === "forget") { print({ id: requireArg(subcommand, "memory ID"), forgotten: await vault.forget(subcommand!) }, wantsJson); return; }
  if (command === "context") { print(await vault.context(requireArg([subcommand, ...rest].filter(Boolean).join(" "), "context query"), numberFlag(parsed, "limit", 8), { semantic: !parsed.flags.has("no-semantic") })); return; }

  const cliPath = fileURLToPath(import.meta.url);
  const context = adapterContext(vault.root, cliPath);
  if (command === "skills") {
    if (subcommand === "list") { print(await listSkills(vault.root), wantsJson); return; }
    if (subcommand === "inspect") { print(await inspectSkills(vault.root), wantsJson); return; }
    if (subcommand === "sync") {
      const ids = rest.length ? rest : ["all"];
      const results = [];
      for (const target of skillSyncTargets(context, ids)) results.push(...await syncSkills(vault.root, target.destination, { agentIds: target.agentIds, platform: context.platform }));
      print(results, wantsJson); return;
    }
    throw new Error(`Use \`${CLI_NAME} skills list|inspect\` or \`${CLI_NAME} skills sync [agents...]\`.`);
  }
  if (command === "agents") {
    if (subcommand === "detect") { print(await detectAgents(context), wantsJson); return; }
    const ids = rest.length ? rest : ["all"];
    if (subcommand === "install") {
      const installed = await installAgents(context, ids);
      const skills = [];
      for (const target of skillSyncTargets(context, ids)) skills.push(...await syncSkills(vault.root, target.destination, { agentIds: target.agentIds, platform: context.platform }));
      print({ installed, skills }, wantsJson); return;
    }
    if (subcommand === "uninstall") { print(await uninstallAgents(context, ids), wantsJson); return; }
    throw new Error(`Use \`${CLI_NAME} agents detect|install|uninstall\`.`);
  }
  throw new Error(`Unknown command: ${command}. Run ${CLI_NAME} --help.`);
}

function sameExecutable(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return path.resolve(left) === path.resolve(right); }
}

const isMain = process.env.MEMORY_FERRY_EXE !== "1" && process.env.AGENT_VAULT_EXE !== "1" && process.argv[1] && sameExecutable(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { console.error(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
