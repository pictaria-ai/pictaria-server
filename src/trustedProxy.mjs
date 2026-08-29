import { BlockList, isIP } from 'node:net';

const MAX_FORWARDED_HOPS = 16;

/**
 * Resolve the originating client address without trusting caller-controlled
 * forwarding headers by default. Forwarded addresses are considered only
 * when the direct TCP peer is in the explicit trusted-proxy allowlist.
 */
export function createClientAddressResolver(trustedProxySpec = '') {
  const trustedProxies = parseTrustedProxies(trustedProxySpec);

  return function resolveClientAddress(request) {
    const peer = normalizeIp(request.socket?.remoteAddress);
    if (!peer || !trustedProxies.hasEntries || !trustedProxies.check(peer)) {
      return peer || 'unknown';
    }

    const forwarded = parseForwardedFor(request.headers?.['x-forwarded-for']);
    if (!forwarded) {
      return peer;
    }

    // Walk from the server outward. Trusted proxies are stripped from the
    // right; the first untrusted hop is the client. This prevents a caller
    // from choosing its key by prepending an address to X-Forwarded-For.
    const hops = [peer, ...forwarded.toReversed()];
    for (let index = 0; index < hops.length; index += 1) {
      const address = hops[index];
      if (index === hops.length - 1 || !trustedProxies.check(address)) {
        return address;
      }
    }
    return peer;
  };
}

function parseTrustedProxies(spec) {
  const blockList = new BlockList();
  const entries = String(spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    if (slash === -1) {
      const address = normalizeIp(entry);
      if (!address) {
        throw new Error(`TRUSTED_PROXY_IPS contains an invalid IP address: ${entry}`);
      }
      blockList.addAddress(address, ipFamily(address));
      continue;
    }

    const address = normalizeIp(entry.slice(0, slash));
    const prefixText = entry.slice(slash + 1);
    if (!address || !/^\d+$/.test(prefixText)) {
      throw new Error(`TRUSTED_PROXY_IPS contains an invalid CIDR: ${entry}`);
    }
    const prefix = Number(prefixText);
    const maxPrefix = isIP(address) === 4 ? 32 : 128;
    if (prefix === 0 || prefix > maxPrefix) {
      throw new Error(`TRUSTED_PROXY_IPS contains an invalid CIDR: ${entry}`);
    }
    blockList.addSubnet(address, prefix, ipFamily(address));
  }

  return {
    hasEntries: entries.length > 0,
    check(address) {
      return blockList.check(address, ipFamily(address));
    },
  };
}

function parseForwardedFor(value) {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  const entries = values.flatMap((header) => String(header).split(',')).map((entry) => normalizeIp(entry));
  if (entries.length === 0 || entries.length > MAX_FORWARDED_HOPS || entries.some((entry) => !entry)) {
    return null;
  }
  return entries;
}

function normalizeIp(value) {
  let address = String(value ?? '').trim();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  const zone = address.indexOf('%');
  if (zone !== -1) {
    address = address.slice(0, zone);
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) {
    address = mapped[1];
  }
  const family = isIP(address);
  if (family === 4) {
    return address;
  }
  if (family !== 6) {
    return '';
  }

  // One IPv6 address has many valid spellings; the limiter key must not be
  // bypassable by rotating equivalent compressed/expanded representations.
  const hostname = new URL(`http://[${address}]/`).hostname;
  const canonical = hostname.slice(1, -1).toLowerCase();
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mappedHex) {
    const value = (Number.parseInt(mappedHex[1], 16) * 65536) + Number.parseInt(mappedHex[2], 16);
    return [24, 16, 8, 0].map((shift) => Math.floor(value / (2 ** shift)) % 256).join('.');
  }
  return canonical;
}

function ipFamily(address) {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}
