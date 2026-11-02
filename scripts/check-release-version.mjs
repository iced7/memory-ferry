import { readFile } from "node:fs/promises";

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const brand = await readFile(new URL("../src/brand.ts", import.meta.url), "utf8");
const brandVersion = /export const VERSION = "([^"]+)"/.exec(brand)?.[1];
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
if (brandVersion !== packageJson.version || lock.version !== packageJson.version || lock.packages[''].version !== packageJson.version) {
  throw new Error('package.json, package-lock.json, and src/brand.ts must have the same version.');
}
if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`Tag ${JSON.stringify(tag)} does not match package version v${packageJson.version}.`);
}
