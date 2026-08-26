import { build } from "esbuild";
import { exec } from "@yao-pkg/pkg";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildDir = path.join(root, "build-exe");
const releaseDir = path.join(root, "release");
const bundle = path.join(buildDir, "agent-vault-exe.mjs");
const output = path.join(releaseDir, "AgentVault.exe");

await mkdir(buildDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });
await rm(output, { force: true });

await build({
  entryPoints: [path.join(root, "src", "exe.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  loader: { ".html": "text" },
  sourcemap: false,
  minify: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { "process.env.AGENT_VAULT_EXE": '"1"' }
});

await exec([bundle, "--sea", "--targets", "node22-win-x64", "--output", output]);
const checksum = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${checksum}  AgentVault.exe\n`, "utf8");
console.log(output);
console.log(`SHA-256 ${checksum}`);
