#!/usr/bin/env node
import uiTemplate from "../assets/ui.html";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { main } from "./cli.js";
import { stateHome } from "./state.js";
import { setEmbeddedUiTemplate } from "./ui.js";
import { PRODUCT_NAME } from "./brand.js";

setEmbeddedUiTemplate(uiTemplate);

const args = process.argv.slice(2);
main(args.length ? args : ["ui"]).catch(async (error) => {
  const message = `${PRODUCT_NAME}: ${error instanceof Error ? error.stack || error.message : String(error)}`;
  console.error(message);
  if (!args.length && (process.env.MEMORY_FERRY_EXE === "1" || process.env.AGENT_VAULT_EXE === "1")) {
    try {
      const folder = stateHome();
      await mkdir(folder, { recursive: true });
      await appendFile(path.join(folder, "memory-ferry.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
    } catch {
      // A hidden Windows launch must still exit even when its diagnostic log cannot be written.
    }
  }
  process.exitCode = 1;
});
