import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adapterContext, detectAgents, installAgents, uninstallAgents, type AdapterContext } from "../src/adapters.js";
import { testEnv } from "./helpers.js";

test("installs and removes all agent configurations in an isolated home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-adapters-"));
  const homeDir = path.join(root, "home");
  const env = testEnv({ PATH: "" });
  const context = adapterContext(path.join(root, "vault"), path.join(root, "dist", "cli.js"), { homeDir, env, platform: "darwin" });
  const installed = await installAgents(context, ["all"]);
  assert.equal(installed.length, 8);
  assert.ok(installed.every((result) => result.changed));

  const codex = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.memory-ferry\]/);
  const claude = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers["memory-ferry"].command, process.execPath);
  const cursor = JSON.parse(await readFile(path.join(homeDir, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers["memory-ferry"].args.includes("mcp"));
  const opencode = JSON.parse(await readFile(path.join(homeDir, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.servers["memory-ferry"].type, "local");
  const dsh = await readFile(path.join(homeDir, ".dsh", "cordis.patch.yml"), "utf8");
  assert.match(dsh, /@deepseek-ai\/dsh-mcp-client/);
  const gemini = JSON.parse(await readFile(path.join(homeDir, ".gemini", "settings.json"), "utf8"));
  assert.ok(gemini.mcpServers["memory-ferry"]);
  const copilot = JSON.parse(await readFile(path.join(homeDir, ".copilot", "mcp-config.json"), "utf8"));
  assert.ok(copilot.mcpServers["memory-ferry"]);
  const minimax = JSON.parse(await readFile(path.join(homeDir, ".minimax", "plugins", "memory-ferry", "mcp.json"), "utf8"));
  assert.equal(minimax.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.equal(minimax.mcpServers["memory-ferry"].type, "stdio");
  assert.equal(minimax.mcpServers["memory-ferry"].command, "./memory-ferry-mcp");
  assert.match(await readFile(path.join(homeDir, ".minimax", "plugins", "memory-ferry", "memory-ferry-mcp"), "utf8"), /exec/);

  const detection = await detectAgents(context);
  assert.ok(detection.every((agent) => agent.detected));
  assert.ok(detection.every((agent) => !agent.binaryPresent));
  assert.ok(detection.every((agent) => agent.configPresent));
  assert.ok(detection.every((agent) => agent.connected));
  assert.ok(detection.every((agent) => agent.current));
  const removed = await uninstallAgents(context, ["all"]);
  assert.ok(removed.every((result) => result.changed));
  assert.doesNotMatch(await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8"), /mcp_servers\.(?:agent-vault|memory-ferry)/);
  assert.equal(await readFile(path.join(homeDir, ".dsh", "cordis.patch.yml"), "utf8"), "[]\n");
  assert.ok((await detectAgents(context)).every((agent) => !agent.connected));
  const deepseek = (await detectAgents(context)).find((agent) => agent.id === "deepseek-harness");
  assert.equal(deepseek?.binaryPresent, false);
  assert.equal(deepseek?.configPresent, true);
  assert.equal(deepseek?.npxAvailable, false);

  await installAgents(context, ["deepseek-harness"]);
  const reinstalledDsh = await readFile(path.join(homeDir, ".dsh", "cordis.patch.yml"), "utf8");
  assert.match(reinstalledDsh, /^# >>> memory-ferry:deepseek-harness-mcp >>>\n- insert:/);
  assert.doesNotMatch(reinstalledDsh, /^\[\]/);
});

test("distinguishes an npx-cached DeepSeek Harness from a global dsh command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-dsh-npx-"));
  const homeDir = path.join(root, "home");
  const cache = path.join(homeDir, ".npm");
  const manifest = path.join(cache, "_npx", "cached-run", "node_modules", "@deepseek-ai", "dsh", "package.json");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, "{}\n", "utf8");
  const context = adapterContext(path.join(root, "vault"), path.join(root, "cli.js"), {
    homeDir,
    env: testEnv({ PATH: "", npm_config_cache: cache }),
    platform: "darwin"
  });

  const deepseek = (await detectAgents(context)).find((agent) => agent.id === "deepseek-harness");
  assert.equal(deepseek?.binaryPresent, false);
  assert.equal(deepseek?.npxAvailable, true);
  assert.ok(deepseek?.evidence.includes("npx-cache:@deepseek-ai/dsh"));
});

test("recognizes the current Vault in Windows JSON paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-win-adapter-"));
  const context: AdapterContext = {
    homeDir: path.join(root, "home"), env: testEnv({ PATH: "", APPDATA: path.join(root, "appdata") }), platform: "win32",
    vaultPath: "C:\\Users\\Test\\OneDrive\\AgentVault",
    launch: { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\AgentVault\\cli.js", "mcp", "--vault", "C:\\Users\\Test\\OneDrive\\AgentVault"] }
  };
  await installAgents(context, ["cursor", "gemini", "copilot", "opencode", "minimax-code"]);
  const selected = (await detectAgents(context)).filter((agent) => ["cursor", "gemini", "copilot", "opencode", "minimax-code"].includes(agent.id));
  assert.ok(selected.every((agent) => agent.connected && agent.current && agent.launchCurrent));
  const minimax = JSON.parse(await readFile(path.join(context.homeDir, ".minimax", "plugins", "memory-ferry", "mcp.json"), "utf8"));
  assert.equal(minimax.mcpServers["memory-ferry"].command, "./memory-ferry-mcp.cmd");
  assert.match(await readFile(path.join(context.homeDir, ".minimax", "plugins", "memory-ferry", "memory-ferry-mcp.cmd"), "utf8"), /node\.exe/);
});

test("uses the executable itself as the MCP command in self-contained builds", () => {
  const context = adapterContext("C:\\Users\\Test\\OneDrive\\AgentVault", "C:\\snapshot\\cli.js", {
    homeDir: "C:\\Users\\Test", env: testEnv({ PATH: "" }), platform: "win32", selfContained: true
  });
  assert.equal(context.launch.command, process.execPath);
  assert.deepEqual(context.launch.args.slice(0, 2), ["mcp", "--vault"]);
  assert.ok(!context.launch.args.includes("C:\\snapshot\\cli.js"));
});

test("reconnect migrates legacy managed agent configuration to Memory Ferry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-legacy-adapter-"));
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, ".claude.json"), `${JSON.stringify({ mcpServers: { "agent-vault": { command: "old", args: [] } } })}\n`, "utf8");
  await mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await writeFile(path.join(homeDir, ".codex", "config.toml"), "# >>> agent-vault:codex-mcp >>>\n[mcp_servers.agent-vault]\ncommand = \"old\"\nargs = []\n# <<< agent-vault:codex-mcp <<<\n", "utf8");
  const context = adapterContext(path.join(root, "vault"), path.join(root, "cli.js"), { homeDir, env: testEnv({ PATH: "" }), platform: "darwin" });
  const before = await detectAgents(context);
  assert.equal(before.find((agent) => agent.id === "claude")?.connected, true);
  assert.equal(before.find((agent) => agent.id === "claude")?.launchCurrent, false);
  await installAgents(context, ["claude", "codex"]);
  const claude = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers["agent-vault"], undefined);
  assert.equal(claude.mcpServers["memory-ferry"].command, process.execPath);
  const codex = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codex, /agent-vault:codex-mcp|mcp_servers\.agent-vault/);
  assert.match(codex, /memory-ferry:codex-mcp|mcp_servers\.memory-ferry/);
});

test("uses the supplied scrubbed environment for packaged-mode detection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-vault-adapter-env-"));
  const previous = process.env.AGENT_VAULT_EXE;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_VAULT_EXE;
    else process.env.AGENT_VAULT_EXE = previous;
  });
  process.env.AGENT_VAULT_EXE = "1";
  const cliPath = path.join(root, "cli.js");
  const context = adapterContext(path.join(root, "vault"), cliPath, {
    homeDir: path.join(root, "home"), env: testEnv({ PATH: "", AGENT_VAULT_EXE: "1" }), platform: "darwin"
  });
  assert.equal(context.launch.args[0], path.resolve(cliPath));
});
