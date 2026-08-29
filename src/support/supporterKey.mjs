import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Supporter keys are a thank-you badge, not a license — they gate nothing.
// Format:
//
//   PICTARIA.<base64url(payload)>.<base64url(ed25519 signature)>
//
// payload = {"v":1,"tier":"supporter"|"patron","id":"<key id>","iat":"YYYY-MM-DD"}
// The signature covers the ASCII bytes of the ENCODED payload segment, so
// there is no JSON canonicalization to disagree on between minter and
// verifier. Verification is fully offline against the pinned public key
// below — no phone-home, ever; keys keep working air-gapped and if
// pictaria.ai retires. The private signing key is never distributed with
// Pictaria Server.
export const SUPPORTER_TIERS = Object.freeze(['supporter', 'patron']);

export const SUPPORT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAs+Tc+mLRXxQgSkzYXAhCFyvk91ZxBwcRvs48juXBncQ=
-----END PUBLIC KEY-----`;

// PICTARIA_SUPPORT_PUBLIC_KEY overrides the pinned key. Two uses: tests
// mint with throwaway keypairs (the production private key never goes near
// CI), and it is the rotation escape hatch — a leaked signing key can be
// swapped without waiting for a release.
let warnedBadOverride = false;

// Returns { tier, id, iat } for a valid key, null for anything else.
// Forgiving about what email clients do to long strings (line wraps,
// surrounding whitespace, a lowercased prefix) and strict about the rest.
export function parseSupporterKey(text, { publicKeyPem } = {}) {
  const cleaned = String(text ?? '').replace(/\s+/g, '');
  const match = /^PICTARIA\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(cleaned);
  if (!match) {
    return null;
  }
  const [, payloadText, signatureText] = match;
  // Resolve the public key OUTSIDE the verification catch: a broken env
  // override (a multi-line PEM rarely survives .env quoting) is OUR
  // configuration problem, and folding it into the same null as a forged
  // key would tell every supporter their valid key is mangled — with
  // nothing in the log pointing at the real cause. Still fails closed.
  let publicKey;
  const envOverride = process.env.PICTARIA_SUPPORT_PUBLIC_KEY;
  try {
    publicKey = createPublicKey(publicKeyPem ?? envOverride ?? SUPPORT_PUBLIC_KEY_PEM);
  } catch (error) {
    if (!publicKeyPem && envOverride && !warnedBadOverride) {
      warnedBadOverride = true;
      console.warn(
        `[Pictaria] PICTARIA_SUPPORT_PUBLIC_KEY is set but is not a parseable PEM public key — every supporter key will read as invalid until it is fixed or unset. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
  try {
    if (!cryptoVerify(null, Buffer.from(payloadText, 'ascii'), publicKey, Buffer.from(signatureText, 'base64url'))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
    if (payload?.v !== 1 || !SUPPORTER_TIERS.includes(payload.tier)) {
      return null;
    }
    const id = typeof payload.id === 'string' && /^[A-Z0-9]{4,16}$/.test(payload.id) ? payload.id : null;
    const iat = typeof payload.iat === 'string' && !Number.isNaN(Date.parse(payload.iat)) ? payload.iat : null;
    if (!id || !iat) {
      return null;
    }
    return { tier: payload.tier, id, iat };
  } catch {
    return null;
  }
}
