import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPeSubsystem, WINDOWS_GUI_SUBSYSTEM } from "./pe-subsystem.mjs";
import { verifyEncryption } from './smoke-encryption.mjs';

if (process.platform !== "win32") throw new Error("This smoke test must run on Windows.");

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(root, "release", "MemoryFerry.exe");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const image = await readFile(executable);
if (readPeSubsystem(image) !== WINDOWS_GUI_SUBSYSTEM) throw new Error("MemoryFerry.exe is not marked as a Windows GUI executable.");

const temporary = await mkdtemp(path.join(os.tmpdir(), "memory-ferry-exe-"));
const env = {
  ...process.env, MEMORY_FERRY_HOME: path.join(temporary, "state"), MEMORY_FERRY_PATH: '', AGENT_VAULT_PATH: '', MEMORY_FERRY_EMBED: "off",
  HOME: temporary, USERPROFILE: temporary, APPDATA: path.join(temporary, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(temporary, 'AppData', 'Local'),
  CODEX_HOME: path.join(temporary, '.codex'), DSH_HOME: path.join(temporary, '.dsh'), MINIMAX_DATA_DIR: path.join(temporary, '.minimax'), XDG_CONFIG_HOME: path.join(temporary, '.config'),
};
const run = async (args) => (await execFileAsync(executable, args, { env, windowsHide: true, timeout: 30_000 })).stdout;

const version = (await run(["--version"])).trim();
if (version !== packageJson.version) throw new Error(`Unexpected version ${JSON.stringify(version)}.`);

const vault = path.join(temporary, "MemoryFerryVault");
await run(["init", vault, "--name", "Windows EXE Test", "--json"]);
await run(["remember", "Windows standalone executable works", "--kind", "lesson", "--json"]);
const recalled = await run(["recall", "standalone executable", "--no-semantic", "--json"]);
if (!recalled.includes("Windows standalone executable works")) throw new Error("Recall failed.");

const client = new Client({ name: "windows-exe-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: executable,
  args: ["mcp"],
  env: { ...getDefaultEnvironment(), MEMORY_FERRY_HOME: env.MEMORY_FERRY_HOME, MEMORY_FERRY_EMBED: "off" },
  stderr: "pipe",
});
await client.connect(transport);
try {
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "memory_recall")) throw new Error("The packaged MCP server did not expose memory_recall.");
  const result = await client.callTool({ name: "memory_recall", arguments: { query: "standalone executable", semantic: false } });
  if (result.isError || !JSON.stringify(result.content).includes("Windows standalone executable works")) throw new Error("Packaged MCP stdio recall failed.");
} finally {
  await client.close();
}

const port = 47839;
const dashboard = spawn(executable, ["ui", "--no-open", "--port", String(port)], { env, stdio: "ignore", windowsHide: true });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try { ready = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok === true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!ready) throw new Error("Dashboard health check failed.");
} finally {
  dashboard.kill();
}

console.log(`Verified hidden Windows GUI executable ${version}, CLI and MCP pipes, recall, and dashboard startup.`);
await verifyEncryption(executable);
