import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const sections = ["Memory Ferry bundles the following production dependencies. License texts are reproduced below.\n"];

for (const [location, metadata] of Object.entries(lock.packages || {})) {
  if (!location.startsWith("node_modules/") || metadata.dev) continue;
  const directory = path.join(root, location);
  const packageJson = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^(license|licence|copying|notice)(\.|$)/i.test(file));
  const licenseText = licenseFile
    ? await readFile(path.join(directory, licenseFile), "utf8")
    : `License declared by package: ${JSON.stringify(packageJson.license || "unknown")}`;
  sections.push(`${"=".repeat(72)}\n${packageJson.name}@${packageJson.version}\n${"-".repeat(72)}\n${licenseText.trim()}\n`);
}

await writeFile(path.join(root, "release", "THIRD_PARTY_NOTICES.txt"), `${sections.join("\n")}\n`, "utf8");
