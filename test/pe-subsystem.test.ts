import assert from "node:assert/strict";
import test from "node:test";
import { readPeSubsystem, setPeSubsystem, WINDOWS_CUI_SUBSYSTEM, WINDOWS_GUI_SUBSYSTEM } from "../scripts/pe-subsystem.mjs";

function samplePe(): Buffer {
  const image = Buffer.alloc(512);
  const peOffset = 0x80;
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x00004550, peOffset);
  image.writeUInt16LE(0x20b, peOffset + 24);
  image.writeUInt16LE(WINDOWS_CUI_SUBSYSTEM, peOffset + 24 + 68);
  return image;
}

test("patches a PE32+ executable from the console to the GUI subsystem", () => {
  const consoleImage = samplePe();
  const guiImage = setPeSubsystem(consoleImage, WINDOWS_GUI_SUBSYSTEM);
  assert.equal(readPeSubsystem(consoleImage), WINDOWS_CUI_SUBSYSTEM);
  assert.equal(readPeSubsystem(guiImage), WINDOWS_GUI_SUBSYSTEM);
  assert.notEqual(guiImage, consoleImage);
});

test("rejects data without a valid PE header", () => {
  assert.throws(() => readPeSubsystem(Buffer.alloc(128)), /PE header is missing/);
});
