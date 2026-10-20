/**
 * Boots the REAL Nest application (all modules, guards, pipes) with only the database faked, and proves the security
 * chain the desktop depends on: account JWT / device token → RBAC → per-DEVICE Premium (402) → validation → webhook signature.
 */
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash, createHmac } from 'crypto';
import { generateEntitlementKeyPair, publicKeyHexFromPrivate, verifyEntitlement } from '../src/subscriptions/entitlement';

const keys = generateEntitlementKeyPair();
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(40), JWT_REFRESH_SECRET: 'r'.repeat(40),
  ENTITLEMENT_PRIVATE_KEY: keys.privateKeyHex, NOTCHPAY_PUBLIC_KEY: 'pk.t', NOTCHPAY_SECRET_KEY: 'sk.t', NOTCHPAY_HASH_KEY: 'hashkey',
  NOTCHPAY_API_URL: 'http://127.0.0.1:1', // unreachable on purpose: verification must fail closed
});

const DEV_PREMIUM = 'dev-premium-0001', DEV_FREE = 'dev-free-000002', DEV_TOKEN_DEVICE = 'dev-token-000003';
const TOKEN = 'x'.repeat(43); // a device token
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const premiumDevices = new Set([DEV_PREMIUM, DEV_TOKEN_DEVICE]);
const user = { id: 'u-admin', businessId: 'b1', email: 'a@x.io', fullName: 'A', role: 'ADMIN', permissions: [], isActive: true };
const cashier = { ...user, id: 'u-cash', role: 'STAFF' };

const fakePrisma: any = {
  $connect: async () => undefined, $disconnect: async () => undefined, $queryRaw: async () => [], $transaction: async (cb: any) => cb(fakePrisma),
  user: { findUnique: async ({ where }: any) => (where.email === 'taken@x.io' ? user : [user, cashier].find((u) => u.id === where.id) ?? null) },
  device: {
    findUnique: async ({ where }: any) => ({ id: where.id, businessId: 'b1', revokedAt: where.id === 'revoked-device' ? new Date() : null }),
    findFirst: async () => null,
  },
  premiumDevice: { findUnique: async ({ where }: any) => (where.tokenHash === sha(TOKEN) ? { deviceId: DEV_TOKEN_DEVICE } : null) },
  premiumShare: { findUnique: async () => null },
  businessTrial: { findUnique: async () => null },
  subscription: {
    updateMany: async () => ({ count: 0 }),
    findFirst: async ({ where }: any) => (premiumDevices.has(where.deviceId) ? { id: 's', userId: null, startedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 86_400_000) } : null),
  },
  payment: {
    findFirst: async ({ where }: any) => {
      const ref = where.reference ?? where.OR?.[0]?.reference;
      return ref === 'IMS-REF' && (where.deviceId === undefined || where.deviceId === DEV_FREE) ? { id: 'p', status: 'PENDING', reference: 'IMS-REF', deviceId: DEV_FREE, amount: 3900, currency: 'XAF' } : null;
    },
    count: async () => 0,
  },
  syncChange: { findMany: async () => [], findFirst: async () => null, create: async (a: any) => a.data },
  syncOperation: { findUnique: async () => null, create: async (a: any) => a.data },
  syncRecord: {
    findUnique: async () => null, upsert: async () => ({}),
    findFirst: async () => ({ entityId: 'c-1' }),
    findMany: async ({ where }: any) => (where.entityType === 'categories' ? [{ entityType: 'categories', entityId: 'c-1', version: 2, deletedAt: null, data: { id: 'c-1', name: 'Drinks' } }] : []),
  },
  restoreGrant: { findUnique: async () => null, count: async () => 0, create: async (a: any) => a.data, update: async (a: any) => a.data },
  auditLog: { create: async () => ({}) },
};

describe('HTTP security chain (real app, fake DB)', () => {
  let base: string, app: any, jwt: JwtService;
  const jwtFor = (who: any, device: string) => jwt.sign({ sub: who.id, bid: 'b1', did: device }, { secret: process.env.JWT_SECRET, expiresIn: '5m' });
  const call = (path: string, init: any = {}): Promise<any> => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const push = (token: string, deviceId: string, changes: any[] = [{ opId: 'o1', entityType: 'categories', entityId: 'c1', operation: 'CREATE', baseVersion: 0, data: { id: 'c1', name: 'Drinks' } }]) =>
    call('/sync/push', { method: 'POST', headers: as(token), body: JSON.stringify({ deviceId, changes }) });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(fakePrisma).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    jwt = new JwtService({});
  });
  afterAll(async () => { await app?.close(); });

  it('health and the entitlement PUBLIC key (hex, what the desktop embeds) are public – and match the private key', async () => {
    expect((await call('/health')).status).toBe(200);
    const pk = await (await call('/subscriptions/public-key')).json();
    expect(pk).toMatchObject({ algorithm: 'Ed25519', format: 'hex', publicKey: keys.publicKeyHex });
    expect(pk.publicKey).toBe(publicKeyHexFromPrivate(keys.privateKeyHex));
    expect(JSON.stringify(pk)).not.toContain(keys.privateKeyHex);
  });

  it('protected endpoints require credentials; garbage tokens are refused', async () => {
    for (const p of ['/sync/pull', '/users', '/audit', '/auth/me', '/ai/store-scan']) expect([401, 404, 405]).toContain((await call(p)).status);
    expect((await call('/sync/pull', { headers: as('garbage') })).status).toBe(401);
    expect((await call('/sync/pull', { headers: as(jwtFor(user, 'revoked-device')) })).status).toBe(401);
  });

  it('Cloud Sync is Premium PER DEVICE, enforced server-side (402), and reads/writes work once the device is premium', async () => {
    for (const run of [() => push(jwtFor(user, DEV_FREE), DEV_FREE), () => call('/sync/pull?since=0', { headers: as(jwtFor(user, DEV_FREE)) })]) {
      const res = await run();
      expect(res.status).toBe(402);
      expect((await res.json()).code).toBe('PREMIUM_REQUIRED');
    }
    const ok = await push(jwtFor(user, DEV_PREMIUM), DEV_PREMIUM);
    expect(ok.status).toBe(200);
    expect((await ok.json()).results[0]).toMatchObject({ opId: 'o1', entityId: 'c1', status: 'ACCEPTED', version: 1 });
    const pull = await call(`/sync/pull?since=0&deviceId=${DEV_PREMIUM}&limit=200`, { headers: as(jwtFor(user, DEV_PREMIUM)) });
    expect(pull.status).toBe(200);
    expect(await pull.json()).toEqual({ records: [], nextCursor: '0', hasMore: false });
  });

  it('FREE restore: a device WITHOUT Premium can download its business data, while push and pull stay Premium (402)', async () => {
    const free = jwtFor(user, DEV_FREE);
    expect((await call('/sync/pull?since=0', { headers: as(free) })).status).toBe(402);
    expect((await push(free, DEV_FREE)).status).toBe(402);
    const res = await call(`/sync/restore?deviceId=${DEV_FREE}&limit=100`, { headers: as(free) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ hasMore: false, next: null, snapshotCursor: '0' });
    expect(body.records).toEqual([{ entityType: 'categories', entityId: 'c-1', version: 2, deleted: false, data: { id: 'c-1', name: 'Drinks' }, cursor: '0' }]);
  });

  it('restore is bound to the signed-in device, needs an account login, and rejects forged tokens', async () => {
    const t = jwtFor(user, DEV_FREE);
    const mismatch = await call(`/sync/restore?deviceId=${DEV_PREMIUM}`, { headers: as(t) });
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).code).toBe('DEVICE_MISMATCH');
    expect((await call('/sync/restore')).status).toBe(401);
    expect((await call('/sync/restore', { headers: as(TOKEN) })).status).toBe(401); // a device token is not an account
    expect((await call('/sync/restore?after=garbage', { headers: as(t) })).status).toBe(400);
  });

  it('staff accounts are administrator-only on the wire too: a cashier login cannot upload users', async () => {
    const res = await push(jwtFor(cashier, DEV_PREMIUM), DEV_PREMIUM, [{ opId: 'u1', entityType: 'users', entityId: 'u-9', operation: 'CREATE', baseVersion: 0, data: { id: 'u-9', username: 'x', role_code: 'cashier', password_hash: 'a'.repeat(64), password_salt: 'b'.repeat(32), password_iterations: 150000 } }]);
    expect(res.status).toBe(200);
    expect((await res.json()).results[0]).toMatchObject({ opId: 'u1', status: 'REJECTED' });
  });

  it('the body deviceId must be the signed-in device (no impersonating a premium device)', async () => {
    const res = await push(jwtFor(user, DEV_FREE), DEV_PREMIUM);
    expect([402, 403]).toContain(res.status); // free device is refused before it can borrow a premium device's id
    const res2 = await push(jwtFor(user, DEV_PREMIUM), 'dev-someone-else');
    expect(res2.status).toBe(403);
    expect((await res2.json()).code).toBe('DEVICE_MISMATCH');
  });

  it('device tokens cannot be used for sync or account endpoints', async () => {
    expect((await call('/sync/pull?since=0', { headers: as(TOKEN) })).status).toBe(401);
    expect((await call('/users', { headers: as(TOKEN) })).status).toBe(401);
    expect((await call('/auth/me', { headers: as(TOKEN) })).status).toBe(401);
  });

  it('device token → /subscriptions/status returns ACTIVE + a desktop-verifiable entitlement (no account needed)', async () => {
    const res = await call(`/subscriptions/status?deviceId=${DEV_TOKEN_DEVICE}`, { headers: as(TOKEN) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ACTIVE');
    expect(verifyEntitlement(body.entitlement, keys.publicKeyHex, { deviceId: DEV_TOKEN_DEVICE }).valid).toBe(true);
    // a token cannot ask about another device
    expect((await call(`/subscriptions/status?deviceId=${DEV_FREE}`, { headers: as(TOKEN) })).status).toBe(403);
  });

  it('device token → AI store scan passes auth + per-device Premium (reaches the AI layer; no key configured → 503)', async () => {
    const res = await call('/ai/store-scan', { method: 'POST', headers: as(TOKEN), body: JSON.stringify({ image: 'AAAA', mime: 'image/png', lang: 'fr' }) });
    expect(res.status).toBe(503);
    // the old (pre-contract) body shape is refused by validation
    expect((await call('/ai/store-scan', { method: 'POST', headers: as(TOKEN), body: JSON.stringify({ imageBase64: 'AAAA', mediaType: 'image/png' }) })).status).toBe(400);
  });

  it('a free device gets 402 on the AI store scan', async () => {
    const res = await call('/ai/store-scan', { method: 'POST', headers: as(jwtFor(user, DEV_FREE)), body: JSON.stringify({ image: 'AAAA', mime: 'image/png', lang: 'en' }) });
    expect(res.status).toBe(402);
  });

  it('status by payment reference works without any token – but only for the device that owns it', async () => {
    const ok = await call(`/subscriptions/status?deviceId=${DEV_FREE}&reference=IMS-REF`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('PENDING'); // Notch Pay unreachable → stays pending, never granted
    expect((await call(`/subscriptions/status?deviceId=attacker-dev&reference=IMS-REF`)).status).toBe(401);
    expect((await call(`/subscriptions/status?deviceId=${DEV_FREE}&reference=IMS-GUESS`)).status).toBe(401);
    expect((await call(`/subscriptions/status?deviceId=${DEV_FREE}`)).status).toBe(401);
  });

  it('payment start is PUBLIC (no account) but strictly validated', async () => {
    const post = (b: any) => call('/payments/notchpay/create', { method: 'POST', body: JSON.stringify(b) });
    expect((await post({ plan: 'PREMIUM', provider: 'VISA', phone: '237677123456', deviceId: DEV_FREE })).status).toBe(400);
    expect((await post({ plan: 'GOLD', provider: 'MTN_MOMO', phone: '237677123456', deviceId: DEV_FREE })).status).toBe(400);
    expect((await post({ plan: 'PREMIUM', provider: 'MTN_MOMO', phone: '237677123456', deviceId: 'x' })).status).toBe(400);
    expect((await post({ plan: 'PREMIUM', provider: 'MTN_MOMO', phone: '237677123456', deviceId: DEV_FREE, amount: 1 })).status).toBe(400); // clients cannot send a price
    expect((await post({ plan: 'PREMIUM', provider: 'MTN_MOMO', phone: '123', deviceId: DEV_FREE })).status).toBe(400); // reaches the service → invalid phone
  });

  it('auth payloads match the desktop: register without businessName, uuid-v7 deviceId, refresh with deviceId', async () => {
    const uuid7 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    const reg = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: 'taken@x.io', password: 'Passw0rdX', fullName: 'Ada L', deviceId: uuid7, deviceName: 'PC' }) });
    expect(reg.status).toBe(409); // passed validation, stopped at "e-mail already exists"
    const ref = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: 'not-a-token', deviceId: uuid7 }) });
    expect(ref.status).toBe(401);
    expect((await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nope' }) })).status).toBe(400);
  });

  it('sync request validation: the pre-contract body shape and unknown fields are refused', async () => {
    const t = jwtFor(user, DEV_PREMIUM);
    expect((await call('/sync/push', { method: 'POST', headers: as(t), body: JSON.stringify({ operations: [] }) })).status).toBe(400);
    expect((await push(t, DEV_PREMIUM, [{ opId: 'o', entityType: 'products', entityId: 'p', operation: 'DROP TABLE', baseVersion: 0, data: {} }])).status).toBe(400);
    expect((await push(t, DEV_PREMIUM, [{ opId: 'o', entityType: 'products', entityId: 'p', operation: 'CREATE', baseVersion: -1, data: {} }])).status).toBe(400);
    expect((await call('/sync/pull?since=abc', { headers: as(t) })).status).toBe(400);
  });

  it('RBAC still applies to account endpoints', async () => {
    expect((await call('/users', { headers: as(jwtFor(cashier, DEV_FREE)) })).status).toBe(403);
    expect((await call('/audit', { headers: as(jwtFor(cashier, DEV_FREE)) })).status).toBe(403);
  });

  it('Notch Pay webhook: bad/missing signature → 401; valid signature → 200 (unknown payment is harmless)', async () => {
    const body = JSON.stringify({ event: 'payment.complete', data: { reference: 'trx.unknown' } });
    expect((await call('/payments/notchpay/webhook', { method: 'POST', body })).status).toBe(401);
    expect((await call('/payments/notchpay/webhook', { method: 'POST', body, headers: { 'x-notch-signature': 'forged' } })).status).toBe(401);
    const sig = createHmac('sha256', 'hashkey').update(body).digest('hex');
    expect((await call('/payments/notchpay/webhook', { method: 'POST', body, headers: { 'x-notch-signature': sig } })).status).toBe(200);
  });
});
