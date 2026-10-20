/**
 * Signed entitlements (Ed25519) – byte-compatible with the desktop verifier (`desktop/src/entitlement/entitlement.ts`).
 *
 *  • Keys are RAW 32-byte values written as HEX (same format as `desktop/tools/dev-entitlement.mjs`):
 *      backend env  ENTITLEMENT_PRIVATE_KEY  = hex seed (secret)
 *      desktop env  VITE_ENTITLEMENT_PUBLIC_KEY = hex public key (public)
 *  • Token = base64url(JSON payload) + "." + base64url(signature over those exact JSON bytes).
 *  • Payload = { v:1, userId, deviceId, plan:'PREMIUM', features[], startedAt, expiresAt, issuedAt }.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'crypto';

export interface EntitlementPayload {
  v: 1;
  userId: string;
  deviceId: string;
  plan: 'PREMIUM';
  features: string[];
  startedAt: string; // ISO-8601 UTC
  expiresAt: string;
  issuedAt: string;
}

export type EntitlementCheck =
  | { valid: true; payload: EntitlementPayload }
  | { valid: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'WRONG_DEVICE' | 'CLOCK_ROLLBACK' };

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const b64u = (b: Buffer) => b.toString('base64url');

export function generateEntitlementKeyPair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = der.subarray(der.length - 32);
  return { privateKeyHex: seed.toString('hex'), publicKeyHex: publicKeyHexFromPrivate(seed.toString('hex')) };
}

function privateKeyObject(hex: string): KeyObject {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENTITLEMENT_PRIVATE_KEY must be 64 hex characters (32-byte Ed25519 seed)');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' });
}
function publicKeyObject(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}
export function publicKeyHexFromPrivate(privateKeyHex: string): string {
  const der = createPublicKey(privateKeyObject(privateKeyHex)).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('hex');
}

export function signEntitlement(input: Omit<EntitlementPayload, 'v' | 'plan' | 'issuedAt'> & { issuedAt?: string }, privateKeyHex: string): string {
  const payload: EntitlementPayload = {
    v: 1, userId: input.userId, deviceId: input.deviceId, plan: 'PREMIUM',
    features: [...input.features], startedAt: input.startedAt, expiresAt: input.expiresAt, issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${b64u(body)}.${b64u(sign(null, body, privateKeyObject(privateKeyHex)))}`;
}

/** Reference verifier (the desktop implements the same steps with @noble/curves). */
export function verifyEntitlement(
  token: string, publicKeyHex: string, opts: { now?: Date; deviceId?: string; lastSeenAt?: Date } = {},
): EntitlementCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 2) return { valid: false, reason: 'MALFORMED' };
  let body: Buffer, sig: Buffer, payload: EntitlementPayload;
  try {
    body = Buffer.from(parts[0], 'base64url');
    sig = Buffer.from(parts[1], 'base64url');
    payload = JSON.parse(body.toString('utf8'));
  } catch { return { valid: false, reason: 'MALFORMED' }; }
  let ok = false;
  try { ok = verify(null, body, publicKeyObject(publicKeyHex), sig); } catch { ok = false; }
  if (!ok) return { valid: false, reason: 'BAD_SIGNATURE' };

  const now = opts.now ?? new Date();
  if (opts.deviceId && payload.deviceId !== opts.deviceId) return { valid: false, reason: 'WRONG_DEVICE' };
  if (now < new Date(payload.issuedAt) || (opts.lastSeenAt && now < opts.lastSeenAt)) return { valid: false, reason: 'CLOCK_ROLLBACK' };
  if (now >= new Date(payload.expiresAt)) return { valid: false, reason: 'EXPIRED' };
  return { valid: true, payload };
}

export function hasFeature(check: EntitlementCheck, feature: string): boolean {
  return check.valid && check.payload.plan === 'PREMIUM' && check.payload.features.includes(feature);
}
