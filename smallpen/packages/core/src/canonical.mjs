const encoder = new TextEncoder();

async function sha256(value) {
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

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
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
    left.localeCompare(right),
  )) {
    source += `${path}\0${contents}\0`;
  }
  return hex(await sha256(source));
}

export async function stableRuntimeUuid(packageId, kind, stableId) {
  const bytes = (await sha256(`${packageId}\0${kind}\0${stableId}`)).slice(
    0,
    16,
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
