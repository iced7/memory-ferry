const PE_SIGNATURE = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const OPTIONAL_HEADER_OFFSET_FROM_PE = 24;
const SUBSYSTEM_OFFSET_FROM_OPTIONAL_HEADER = 68;

export const WINDOWS_GUI_SUBSYSTEM = 2;
export const WINDOWS_CUI_SUBSYSTEM = 3;

function subsystemOffset(image) {
  if (!Buffer.isBuffer(image) || image.length < 0x40) throw new Error("Invalid PE image: DOS header is missing.");
  const peOffset = image.readUInt32LE(0x3c);
  const optionalOffset = peOffset + OPTIONAL_HEADER_OFFSET_FROM_PE;
  const offset = optionalOffset + SUBSYSTEM_OFFSET_FROM_OPTIONAL_HEADER;
  if (offset + 2 > image.length || image.readUInt32LE(peOffset) !== PE_SIGNATURE) throw new Error("Invalid PE image: PE header is missing.");
  const magic = image.readUInt16LE(optionalOffset);
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) throw new Error(`Unsupported PE optional header: 0x${magic.toString(16)}.`);
  return offset;
}

export function readPeSubsystem(image) {
  return image.readUInt16LE(subsystemOffset(image));
}

export function setPeSubsystem(image, subsystem) {
  const result = Buffer.from(image);
  result.writeUInt16LE(subsystem, subsystemOffset(result));
  return result;
}
