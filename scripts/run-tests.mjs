import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const files = (await readdir(testDir))
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => path.join(testDir, file));

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
