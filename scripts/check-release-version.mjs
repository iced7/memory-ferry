import { readFile } from "node:fs/promises";

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (tag !== `v${packageJson.version}`) {
  throw new Error(`Tag ${JSON.stringify(tag)} does not match package version v${packageJson.version}.`);
}
