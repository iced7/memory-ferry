import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";

test("build output keeps the CLI executable on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("Windows does not use POSIX executable bits");
  await access(new URL("../dist/cli.js", import.meta.url), constants.X_OK);
  assert.ok(true);
});
