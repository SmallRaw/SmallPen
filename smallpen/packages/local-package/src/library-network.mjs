import { lookup as dnsLookup } from "node:dns";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

import { SmallPenError } from "@smallpen/core";

// A Package can declare any Library URL, so by default the Background and CLI
// only fetch Libraries from public addresses: a Package must not be able to
// make them probe loopback services, cloud metadata endpoints or the LAN.
// Local development servers opt in with this variable (or the
// `allowPrivateNetwork` option).
export const ALLOW_PRIVATE_LIBRARY_HOSTS_ENV = "SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS";

export function privateLibraryHostsAllowed() {
  return process.env[ALLOW_PRIVATE_LIBRARY_HOSTS_ENV] === "1";
}

// 198.18.0.0/15 stays allowed: proxy tools in fake-IP mode (Clash, Surge)
// answer every public name with an address from that range.
const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  nonPublic.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  nonPublic.addSubnet(network, prefix, "ipv6");
}

function ipv6Groups(address) {
  let text = address.replace(/%.*$/, "").toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16));
}

// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses carry an IPv4 address
// that the network routes to; check that address too.
function embeddedIPv4(address) {
  const groups = ipv6Groups(address);
  const hi = (value) => value >> 8;
  const lo = (value) => value & 0xff;
  let pair;
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    pair = [groups[6], groups[7]];
  } else if (groups[0] === 0x2002) {
    pair = [groups[1], groups[2]];
  }
  return pair && `${hi(pair[0])}.${lo(pair[0])}.${hi(pair[1])}.${lo(pair[1])}`;
}

export function isPublicAddress(address) {
  const family = isIP(address.replace(/%.*$/, ""));
  if (family === 4) return !nonPublic.check(address, "ipv4");
  if (family !== 6) return false;
  if (nonPublic.check(address, "ipv6")) return false;
  const embedded = embeddedIPv4(address);
  return embedded === undefined || !nonPublic.check(embedded, "ipv4");
}

function privateAddressError(url) {
  return new SmallPenError(
    "remote_library_private_address",
    "Remote Library host is not on a public network address",
    { env: ALLOW_PRIVATE_LIBRARY_HOSTS_ENV, url: String(url) },
  );
}

// Every resolved address must be public, and the socket connects to the
// address checked here: there is no second resolution a rebinding DNS server
// could answer differently.
function publicLookup(url, allowPrivateNetwork) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      if (
        !allowPrivateNetwork &&
        (addresses.length === 0 ||
          !addresses.every(({ address }) => isPublicAddress(address)))
      ) {
        callback(privateAddressError(url));
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Dedicated agents per policy: a pooled socket opened without the address
// check (by another request in this process, or under the private-network
// opt-in) is never reused for a checked Library fetch.
const agentPools = new Map(
  [false, true].map((allowPrivateNetwork) => [
    allowPrivateNetwork,
    {
      "http:": new HttpAgent({ keepAlive: true }),
      "https:": new HttpsAgent({ keepAlive: true }),
    },
  ]),
);

// A minimal fetch() over node:http(s) that refuses non-public destinations
// unless `allowPrivateNetwork` is set. It supports what remote Library reads
// use: GET, manual redirects and an abort signal.
export function createLibraryFetch({
  allowPrivateNetwork = privateLibraryHostsAllowed(),
} = {}) {
  return (input, init) =>
    libraryFetch(input, init, allowPrivateNetwork === true);
}

function libraryFetch(input, { signal } = {}, allowPrivateNetwork) {
  const url = new URL(input);
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivateNetwork && isIP(literal) && !isPublicAddress(literal)) {
    return Promise.reject(privateAddressError(url));
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: agentPools.get(allowPrivateNetwork)[url.protocol],
        headers: { accept: "application/json, */*" },
        lookup: publicLookup(url, allowPrivateNetwork),
        method: "GET",
        signal,
      },
      (message) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(message.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              headers.append(name, item);
            }
          }
          const nullBody = NULL_BODY_STATUSES.has(message.statusCode);
          if (nullBody) message.resume();
          resolve(
            new Response(nullBody ? null : Readable.toWeb(message), {
              headers,
              status: message.statusCode,
            }),
          );
        } catch (error) {
          message.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end();
  });
}
