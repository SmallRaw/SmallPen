import { compareStrings } from "./internal.mjs";

const encoder = new TextEncoder();

// Node (and Electron) give a synchronous SHA-256 without importing a
// Node module, so Core stays browser-safe; browsers use Web Crypto.
const nodeCrypto = globalThis.process?.getBuiltinModule?.("node:crypto");

async function sha256(value) {
  if (nodeCrypto) {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
      throw new TypeError("SmallPen SHA-256 input must be a string or Uint8Array");
    }
    return new Uint8Array(nodeCrypto.createHash("sha256").update(value).digest());
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SmallPen Core requires the Web Crypto SHA-256 API");
  }
  const bytes =
    typeof value === "string"
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : null;
  if (!bytes) {
    throw new TypeError("SmallPen SHA-256 input must be a string or Uint8Array");
  }
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

function hex(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += HEX[bytes[index]];
  return text;
}

function normalizeCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entryValue]) => [key, normalizeCanonicalValue(entryValue)]),
    );
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(normalizeCanonicalValue(value), null, 2) + "\n";
}

export async function sha256Hex(value) {
  return hex(await sha256(value));
}

export async function hashCanonicalFiles(files) {
  let source = "";
  for (const [path, contents] of [...files.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    source += `${path}\0${contents}\0`;
  }
  return hex(await sha256(source));
}

// Runtime ids repeat on every load of the same package; remember the
// recent ones (bounded) instead of hashing them again.
const runtimeUuidMemo = new Map();
const RUNTIME_UUID_MEMO_LIMIT = 200000;

export async function stableRuntimeUuid(packageId, kind, stableId) {
  const key = `${packageId}\0${kind}\0${stableId}`;
  const known = runtimeUuidMemo.get(key);
  if (known) return known;
  const value = await computeRuntimeUuid(packageId, kind, stableId);
  if (runtimeUuidMemo.size >= RUNTIME_UUID_MEMO_LIMIT) runtimeUuidMemo.clear();
  runtimeUuidMemo.set(key, value);
  return value;
}

async function computeRuntimeUuid(packageId, kind, stableId) {
  const bytes = (await sha256(`${packageId}\0${kind}\0${stableId}`)).slice(
    0,
    16,
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
