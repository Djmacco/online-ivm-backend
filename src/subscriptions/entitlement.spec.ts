import { ed25519 } from '@noble/curves/ed25519';
import { generateEntitlementKeyPair, hasFeature, publicKeyHexFromPrivate, signEntitlement, verifyEntitlement } from './entitlement';

const { privateKeyHex, publicKeyHex } = generateEntitlementKeyPair();
const base = {
  userId: 'u1', deviceId: 'dev-1', features: ['CLOUD_SYNC', 'AI_STORE_SCAN'],
  startedAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-11-07T10:00:00.000Z', issuedAt: '2026-10-08T10:00:05.000Z',
};

// ---- the desktop's verifier (copied from desktop/src/entitlement/entitlement.ts) ----
const b64u = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'));
const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g)?.map((x) => parseInt(x, 16)) ?? []);
function desktopParseAndVerify(token: string, pub: string) {
  try {
    const [p, s] = token.trim().split('.');
    if (!p || !s || !pub) return null;
    const bytes = b64u(p);
    if (!ed25519.verify(b64u(s), bytes, hex(pub))) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload.v !== 1 || payload.plan !== 'PREMIUM' || !Array.isArray(payload.features)) return null;
    return payload;
  } catch { return null; }
}

describe('signed entitlement – interoperable with the desktop app', () => {
  const token = signEntitlement(base, privateKeyHex);

  it('keys are raw 32-byte hex, exactly like `dev-entitlement.mjs keygen`', () => {
    expect(privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyHexFromPrivate(privateKeyHex)).toBe(publicKeyHex);
    expect(Buffer.from(ed25519.getPublicKey(hex(privateKeyHex))).toString('hex')).toBe(publicKeyHex); // same maths as noble
  });

  it("a token signed by the BACKEND is accepted by the DESKTOP's verifier", () => {
    const p = desktopParseAndVerify(token, publicKeyHex);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({ v: 1, plan: 'PREMIUM', deviceId: 'dev-1', features: ['CLOUD_SYNC', 'AI_STORE_SCAN'] });
    expect(Object.keys(p).sort()).toEqual(['deviceId', 'expiresAt', 'features', 'issuedAt', 'plan', 'startedAt', 'userId', 'v']);
  });

  it("a token signed the DESKTOP-tool way is accepted by the BACKEND's verifier", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, plan: 'PREMIUM', ...base }));
    const t = `${Buffer.from(bytes).toString('base64url')}.${Buffer.from(ed25519.sign(bytes, hex(privateKeyHex))).toString('base64url')}`;
    expect(verifyEntitlement(t, publicKeyHex, { now: new Date('2026-10-20T00:00:00Z'), deviceId: 'dev-1' }).valid).toBe(true);
  });

  it('works offline until expiry and stops after (Oct 8 → Nov 7)', () => {
    expect(verifyEntitlement(token, publicKeyHex, { now: new Date('2026-11-01T12:00:00Z') }).valid).toBe(true);
    const after = verifyEntitlement(token, publicKeyHex, { now: new Date('2026-11-08T00:00:00Z') });
    expect(after).toEqual({ valid: false, reason: 'EXPIRED' });
    expect(hasFeature(after, 'CLOUD_SYNC')).toBe(false);
  });

  it('a tampered payload (extended expiry) fails on BOTH verifiers', () => {
    const [body, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.expiresAt = '2099-01-01T00:00:00.000Z';
    const t = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect(verifyEntitlement(t, publicKeyHex, { now: new Date('2026-11-09T00:00:00Z') })).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    expect(desktopParseAndVerify(t, publicKeyHex)).toBeNull();
  });

  it('another key cannot forge a token; the token is bound to its device', () => {
    const other = generateEntitlementKeyPair();
    expect(verifyEntitlement(signEntitlement(base, other.privateKeyHex), publicKeyHex, { now: new Date('2026-10-10T00:00:00Z') }).valid).toBe(false);
    expect(verifyEntitlement(token, publicKeyHex, { now: new Date('2026-10-10T00:00:00Z'), deviceId: 'other' })).toEqual({ valid: false, reason: 'WRONG_DEVICE' });
  });

  it('detects clock rollback and rejects garbage / bad key config', () => {
    expect(verifyEntitlement(token, publicKeyHex, { now: new Date('2026-09-01T00:00:00Z') })).toEqual({ valid: false, reason: 'CLOCK_ROLLBACK' });
    expect(verifyEntitlement('garbage', publicKeyHex)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(() => signEntitlement(base, 'not-hex')).toThrow(/64 hex/);
  });
});
