// INPUT:  identities made of names (page path, element path, Token name)
// OUTPUT: stable internal ids with the prefixes the package model expects
// POS:    Files store no ids; every read derives the same id from the same
//         names, synchronously, without Web Crypto.

// cyrb53: a fast 53-bit string hash with good spread for short keys.
function cyrb53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashKey(text) {
  return cyrb53(text).toString(36).padStart(11, "0");
}

function slug(text, max = 24) {
  return String(text)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
}

// prefix_<readable slug>_<hash>; the slug only helps people reading logs.
export function derivedId(prefix, key, label = key) {
  const readable = slug(label);
  return readable ? `${prefix}_${readable}_${hashKey(key)}` : `${prefix}_${hashKey(key)}`;
}

// Ids from a remembered identity map (identity key -> id) when known, so a
// package written and read again keeps every id; derived ids otherwise.
// scope groups ids that must be unique together (one tree, the Tokens, …).
export function createIdResolver(identity) {
  const scopes = new Map();
  return function idFor(prefix, key, label, scope = prefix) {
    let used = scopes.get(scope);
    if (!used) scopes.set(scope, (used = new Set()));
    const known = identity?.get(`${prefix}\0${key}`);
    const base = derivedId(prefix, key, label);
    let id = typeof known === "string" && known.startsWith(`${prefix}_`) && !used.has(known) ? known : base;
    for (let counter = 2; used.has(id); counter += 1) id = `${base}_${counter}`;
    used.add(id);
    return id;
  };
}

// Deterministic UUID text from a key (flow ids).
export function uuidFromKey(key) {
  const hex = [hashKey(`a\0${key}`), hashKey(`b\0${key}`), hashKey(`c\0${key}`)]
    .map((part) => Number.parseInt(part, 36).toString(16).padStart(14, "0"))
    .join("")
    .slice(0, 32);
  const chars = hex.split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const text = chars.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

