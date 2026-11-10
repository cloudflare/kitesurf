// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Private Network Access: a document may not reach an address space more private than its own.
// Only hostnames and IP literals are classified; a public name that resolves to a private
// address is not caught here.

export type AddressSpace = "loopback" | "private" | "public";

const RANK: Record<AddressSpace, number> = { loopback: 0, private: 1, public: 2 };

function ipv4Space(host: string): AddressSpace | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const [a = 0, b = 0] = parts.map(Number);
  if (a === 127 || a === 0) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  // Link-local, shared address space (RFC 6598), multicast and reserved.
  if ((a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return "private";
  return "public";
}

function ipv6Space(host: string): AddressSpace {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return "loopback";
  // The URL parser writes an IPv4-mapped address as ::ffff:xxxx:xxxx.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped) {
    const hi = Number.parseInt(mapped[1] ?? "0", 16);
    const lo = Number.parseInt(mapped[2] ?? "0", 16);
    return ipv4Space(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`) ?? "public";
  }
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return "private";
  }
  return "public";
}

/** The address space a URL's host names, from the parsed (normalised) hostname. */
export function addressSpaceOf(url: URL): AddressSpace {
  // `url.hostname` keeps a trailing dot, and `localhost.` still resolves to loopback.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return ipv6Space(host.slice(1, -1));
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  return ipv4Space(host) ?? "public";
}

/** Why a request from `initiatorOrigin` may not reach `target`, or null when it may.
 *  An opaque or unknown initiator counts as public. */
export function privateNetworkRefusal(target: URL, initiatorOrigin: string): string | null {
  const targetSpace = addressSpaceOf(target);
  if (targetSpace === "public") return null;
  let initiatorSpace: AddressSpace = "public";
  try {
    if (initiatorOrigin) initiatorSpace = addressSpaceOf(new URL(initiatorOrigin));
  } catch {}
  if (RANK[targetSpace] >= RANK[initiatorSpace]) return null;
  return (
    `kitesurf: a ${initiatorSpace} document may not reach the ${targetSpace} address ` +
    `${target.host} (set KITESURF_ALLOW_PRIVATE_NETWORK=1 to allow it)`
  );
}
