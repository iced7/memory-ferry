#!/usr/bin/env node
import uiTemplate from "../assets/ui.html";
import { main } from "./cli.js";
import { setEmbeddedUiTemplate } from "./ui.js";

setEmbeddedUiTemplate(uiTemplate);

const args = process.argv.slice(2);
main(args.length ? args : ["ui"]).catch((error) => {
  console.error(`AgentVault: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
