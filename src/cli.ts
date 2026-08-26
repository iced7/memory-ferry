#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MemoryKind, ScopeType } from "./types.js";
import { StateStore } from "./state.js";
import { Vault } from "./vault.js";
import { listSkills, syncSkills } from "./skills.js";
import { adapterContext, detectAgents, installAgents, skillDestinations, uninstallAgents } from "./adapters.js";
import { runMcp } from "./mcp.js";
import { runUi } from "./ui.js";
import { migrateVault } from "./migration.js";

const VERSION = "0.4.0";
const HELP = `Agent Vault Sync ${VERSION}

Local-first long-term memory shared through iCloud, OneDrive, NAS, or any synced folder.

Usage:
  agent-vault init <folder> [--name <name>]
  agent-vault use <folder>
  agent-vault vaults list
  agent-vault vaults remove <folder>
  agent-vault vault migrate <source-folder> <target-folder>
  agent-vault status [--json]
  agent-vault remember <text> [--title <title>] [--kind <kind>] [--scope <scope>] [--scope-id <id>] [--tag <tag> ...]
  agent-vault recall <query> [--limit <n>] [--json]
  agent-vault list [--limit <n>] [--json]
  agent-vault get <memory-id> [--json]
  agent-vault update <memory-id> [--content <text>] [--title <title>] [--tag <tag> ...]
  agent-vault forget <memory-id>
  agent-vault context <query> [--limit <n>]
  agent-vault skills list
  agent-vault skills sync [all|codex|claude|cursor|opencode|deepseek-harness|gemini|copilot|minimax-code]
  agent-vault agents detect [--json]
  agent-vault agents install [all|codex|claude|cursor|opencode|deepseek-harness|gemini|copilot|minimax-code ...]
  agent-vault agents uninstall [all|codex|claude|cursor|opencode|deepseek-harness|gemini|copilot|minimax-code ...]
  agent-vault ui [--port <n>] [--no-open]
  agent-vault mcp

Global options:
  --vault <folder>        Override the selected vault
  --json                  Machine-readable output
  -h, --help              Show help
`;

interface Parsed { positionals: string[]; flags: Map<string, string[]>; }

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set(["json", "help", "h", "version", "no-open"]);
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
  if (parsed.flags.has("version")) { console.log(VERSION); return; }
  if (!command || parsed.flags.has("help") || parsed.flags.has("h")) { console.log(HELP); return; }
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
    throw new Error("Use `agent-vault vaults list|remove <folder>`. ");
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
    const results = await vault.search(requireArg(query, "search query"), numberFlag(parsed, "limit", 10), { kind: flag(parsed, "kind") as MemoryKind | undefined, scope: flag(parsed, "scope") as ScopeType | undefined, scopeId: flag(parsed, "scope-id"), tags: flags(parsed, "tag") });
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
  if (command === "context") { print(await vault.context(requireArg([subcommand, ...rest].filter(Boolean).join(" "), "context query"), numberFlag(parsed, "limit", 8))); return; }

  const cliPath = fileURLToPath(import.meta.url);
  const context = adapterContext(vault.root, cliPath);
  if (command === "skills") {
    if (subcommand === "list") { print(await listSkills(vault.root), wantsJson); return; }
    if (subcommand === "sync") {
      const ids = rest.length ? rest : ["all"];
      const results = [];
      for (const destination of skillDestinations(context, ids)) results.push(...await syncSkills(vault.root, destination));
      print(results, wantsJson); return;
    }
    throw new Error("Use `agent-vault skills list` or `agent-vault skills sync [agents...]`.");
  }
  if (command === "agents") {
    if (subcommand === "detect") { print(await detectAgents(context), wantsJson); return; }
    const ids = rest.length ? rest : ["all"];
    if (subcommand === "install") {
      const installed = await installAgents(context, ids);
      const skills = [];
      for (const destination of skillDestinations(context, ids)) skills.push(...await syncSkills(vault.root, destination));
      print({ installed, skills }, wantsJson); return;
    }
    if (subcommand === "uninstall") { print(await uninstallAgents(context, ids), wantsJson); return; }
    throw new Error("Use `agent-vault agents detect|install|uninstall`.");
  }
  throw new Error(`Unknown command: ${command}. Run agent-vault --help.`);
}

function sameExecutable(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return path.resolve(left) === path.resolve(right); }
}

const isMain = process.env.AGENT_VAULT_EXE !== "1" && process.argv[1] && sameExecutable(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { console.error(`agent-vault: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
