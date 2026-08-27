import { build } from "esbuild";
import { exec } from "@yao-pkg/pkg";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readPeSubsystem, setPeSubsystem, WINDOWS_CUI_SUBSYSTEM, WINDOWS_GUI_SUBSYSTEM } from "./pe-subsystem.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildDir = path.join(root, "build-exe");
const releaseDir = path.join(root, "release");
const bundle = path.join(buildDir, "memory-ferry-exe.cjs");
const output = path.join(releaseDir, "MemoryFerry.exe");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const execFileAsync = promisify(execFile);

await mkdir(buildDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });
await rm(output, { force: true });

await build({
  entryPoints: [path.join(root, "src", "exe.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  loader: { ".html": "text" },
  sourcemap: false,
  minify: false,
  banner: { js: "const __memoryFerryImportMetaUrl = require('node:url').pathToFileURL(process.execPath).href;" },
  define: {
    "process.env.MEMORY_FERRY_EXE": '"1"',
    "import.meta.url": "__memoryFerryImportMetaUrl"
  }
});

const bundleCheck = await execFileAsync(process.execPath, [bundle, "--version"]);
if (bundleCheck.stdout.trim() !== version) {
  throw new Error(`Bundled entry point reported ${JSON.stringify(bundleCheck.stdout.trim())}; expected ${version}.`);
}

await exec([bundle, "--sea", "--targets", "node22-win-x64", "--output", output]);
const consoleImage = await readFile(output);
if (readPeSubsystem(consoleImage) !== WINDOWS_CUI_SUBSYSTEM) throw new Error("Expected pkg to emit a Windows console executable before patching.");
const guiImage = setPeSubsystem(consoleImage, WINDOWS_GUI_SUBSYSTEM);
if (readPeSubsystem(guiImage) !== WINDOWS_GUI_SUBSYSTEM) throw new Error("Failed to mark MemoryFerry.exe as a Windows GUI executable.");
await writeFile(output, guiImage);
const checksum = createHash("sha256").update(guiImage).digest("hex");
await writeFile(`${output}.sha256`, `${checksum}  MemoryFerry.exe\n`, "utf8");
await writeFile(path.join(releaseDir, "MemoryFerry-CLI.cmd"), `@echo off\r\nstart "" /wait /b "%~dp0MemoryFerry.exe" %*\r\n`, "utf8");
await copyFile(path.join(root, "LICENSE"), path.join(releaseDir, "LICENSE.txt"));
const nodeLicenseResponse = await fetch("https://raw.githubusercontent.com/nodejs/node/v22.23.2/LICENSE");
if (!nodeLicenseResponse.ok) throw new Error(`Unable to download the Node.js license: HTTP ${nodeLicenseResponse.status}`);
await writeFile(path.join(releaseDir, "NODE-LICENSE.txt"), await nodeLicenseResponse.text(), "utf8");
await execFileAsync(process.execPath, [path.join(root, "scripts", "generate-third-party-notices.mjs")]);
await writeFile(path.join(releaseDir, "README-Windows.txt"), `Memory Ferry · 记忆摆渡 ${version} - Windows x64
=========================================================

中文
----
1. 将 MemoryFerry.exe 放到固定目录，例如：
   C:\\Users\\你的用户名\\AppData\\Local\\MemoryFerry\\MemoryFerry.exe

2. 双击 MemoryFerry.exe。它会在后台启动并打开本机控制台，不显示命令行窗口，也无需安装 Node.js。

3. 选择已同步的 Vault 文件夹并接入本机 Agent。旧 Agent Vault 文件夹会被自动识别。

4. 请勿在接入 Agent 后移动或删除 EXE；如果移动过，请在新位置重新刷新 Agent 配置。

5. 要彻底停止后台程序，请点击网页右上角“退出程序”。关闭浏览器页面不会停止后台服务。

6. 如果程序已经运行，再次双击 MemoryFerry.exe 只会重新打开控制台页面。

命令行示例（请通过 MemoryFerry-CLI.cmd 调用）：
  MemoryFerry-CLI.cmd --version
  MemoryFerry-CLI.cmd status
  MemoryFerry-CLI.cmd recall "关键词"

安全说明：
- 当前 EXE 没有商业代码签名，Windows 可能显示“未知发布者”。
- 请使用 MemoryFerry.exe.sha256 核对 SHA-256。
- 不要关闭 Windows SmartScreen 或其他系统级安全防护。
- 当前 Vault 没有端到端加密，请勿保存密码、Token、私钥或恢复码。

English
-------
1. Keep MemoryFerry.exe in a permanent folder such as C:\\Users\\YourName\\AppData\\Local\\MemoryFerry.
2. Double-click it to open the local dashboard. No installer, console window, or separate Node.js installation is required.
3. Choose a synced Vault folder and connect this computer's agents. Legacy Agent Vault folders are recognized automatically.
4. If you move the EXE, refresh the agent connections from its new location.
5. Use “Exit” in the dashboard to stop the background process. Closing the browser tab alone does not stop it.
6. Use MemoryFerry-CLI.cmd when you need command-line output.

This unsigned beta may show an “Unknown publisher” warning. Verify MemoryFerry.exe.sha256 and do not disable SmartScreen. Vault contents are not end-to-end encrypted; never store credentials or recovery secrets.
`, "utf8");
console.log(output);
console.log(`SHA-256 ${checksum}`);
