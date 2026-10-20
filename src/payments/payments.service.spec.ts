import { fakeAudit } from '../../test/fake-prisma';
import { generateEntitlementKeyPair, verifyEntitlement } from '../subscriptions/entitlement';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PaymentsService } from './payments.service';
import { PaymentsSettler } from './payments.settler';

class FakeDb {
  payments: any[] = []; subs: any[] = []; devices: any[] = [];
  private id = 0;
  private match(row: any, where: any): boolean {
    return Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((w: any) => this.match(row, w));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('gt' in v) return row[k] > v.gt;
        if ('lte' in v) return row[k] <= v.lte;
      }
      return row[k] === v;
    });
  }
  payment = {
    create: async ({ data }: any) => { const r = { id: `pay${++this.id}`, status: 'PENDING', notchReference: null, createdAt: new Date(), ...data }; this.payments.push(r); return r; },
    findFirst: async ({ where }: any) => this.payments.find((p) => this.match(p, where)) ?? null,
    count: async ({ where }: any) => this.payments.filter((p) => this.match(p, where)).length,
    update: async ({ where, data }: any) => Object.assign(this.payments.find((p) => p.id === where.id), data),
    updateMany: async ({ where, data }: any) => { const rows = this.payments.filter((p) => this.match(p, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  };
  subscription = {
    findUnique: async ({ where }: any) => this.subs.find((s) => s.transactionId === where.transactionId) ?? null,
    findFirst: async ({ where }: any) => this.subs.filter((s) => this.match(s, where)).sort((a, b) => +b.expiresAt - +a.expiresAt)[0] ?? null,
    create: async ({ data }: any) => { const r = { id: `sub${++this.id}`, userId: null, ...data }; this.subs.push(r); return r; },
    updateMany: async ({ where, data }: any) => { const rows = this.subs.filter((s) => this.match(s, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  };
  premiumDevice = {
    findUnique: async ({ where }: any) => this.devices.find((d) => d.deviceId === where.deviceId) ?? null,
    create: async ({ data }: any) => { if (this.devices.some((d) => d.deviceId === data.deviceId)) throw new Error('unique'); this.devices.push(data); return data; },
  };
  premiumShare = { findUnique: async () => null };
  $transaction = async (cb: any) => cb(this);
}

const keys = generateEntitlementKeyPair();
const env: Record<string, string> = {
  NOTCHPAY_PUBLIC_KEY: 'pk.test', NOTCHPAY_SECRET_KEY: 'sk.test', PREMIUM_PRICE_XAF: '3900', PREMIUM_PERIOD_DAYS: '30',
  ENTITLEMENT_PRIVATE_KEY: keys.privateKeyHex, PUBLIC_API_URL: 'https://api.test',
};
const config: any = { get: (k: string) => env[k], getOrThrow: (k: string) => { if (!env[k]) throw new Error(k); return env[k]; } };
const DEV = 'dev-0190aaaa-bbbb';

function mockNotch(h: { verify?: () => any; fail?: boolean }) {
  return jest.spyOn(global, 'fetch').mockImplementation((async (url: any, init: any) => {
    const method = init?.method ?? 'GET';
    const ok = (b: any) => ({ ok: true, status: 200, json: async () => b });
    if (h.fail) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
    if (method === 'POST' && String(url).endsWith('/payments')) return ok({ transaction: { reference: 'trx.abc', trxref: JSON.parse(init.body).reference }, authorization_url: 'https://pay.notchpay.co/x' });
    if (method === 'POST') return ok({ transaction: { status: 'processing' } });
    return ok(h.verify?.());
  }) as any);
}

describe('Notch Pay → subscription → signed entitlement (public, device-based)', () => {
  let db: FakeDb, subs: SubscriptionsService, settler: PaymentsSettler, payments: PaymentsService;
  beforeEach(() => {
    db = new FakeDb();
    subs = new SubscriptionsService(db as any, config);
    settler = new PaymentsSettler(db as any, config, subs, fakeAudit);
    payments = new PaymentsService(db as any, config, subs, settler, fakeAudit);
  });
  afterEach(() => jest.restoreAllMocks());

  const start = (deviceId = DEV, provider: 'MTN_MOMO' | 'ORANGE_MONEY' = 'MTN_MOMO') => payments.create({ plan: 'PREMIUM', provider, phone: '237677123456', deviceId }, '1.2.3.4');
  const completeTx = (ref: string, over: any = {}) => ({ transaction: { reference: 'trx.abc', trxref: ref, amount: 3900, currency: 'XAF', status: 'complete', ...over } });

  it('server fixes the price (3900), maps MTN/Orange to Notch channels and returns the contract shape + a device token ONCE', async () => {
    const spy = mockNotch({});
    const r = await start();
    expect(r).toMatchObject({ status: 'PENDING', reference: expect.stringMatching(/^IMS-[0-9A-F]{32}$/), deviceToken: expect.any(String) });
    expect(r.deviceToken!.length).toBeGreaterThanOrEqual(40);
    const [init, charge] = spy.mock.calls;
    expect(JSON.parse((init[1] as any).body)).toMatchObject({ amount: 3900, currency: 'XAF', customer: { phone: '+237677123456' } });
    expect((init[1] as any).headers.Authorization).toBe('pk.test');
    expect(JSON.parse((charge[1] as any).body)).toMatchObject({ channel: 'cm.mtn', data: { phone: '+237677123456' } });
    // second payment from the same device: no new token, and the stored token is only a hash
    const again = await start();
    expect(again.deviceToken).toBeUndefined();
    expect(JSON.stringify(db.devices)).not.toContain(r.deviceToken);
    // orange
    const orange = mockNotch({});
    await start('dev-other-0000', 'ORANGE_MONEY');
    expect(JSON.parse((orange.mock.calls.at(-1)![1] as any).body).channel).toBe("cm.orange");
  });

  it('rate-limits payment attempts per device', async () => {
    mockNotch({});
    for (let i = 0; i < 5; i++) await start();
    await expect(start()).rejects.toThrow(/Too many/);
    await expect(start('another-device-1')).resolves.toBeDefined();
  });

  it('rejects an invalid phone before touching Notch Pay', async () => {
    const spy = mockNotch({});
    await expect(payments.create({ plan: 'PREMIUM', provider: 'MTN_MOMO', phone: '12345', deviceId: DEV })).rejects.toThrow(/valid Cameroonian/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never grants Premium while Notch Pay still says pending', async () => {
    let ref = '';
    mockNotch({ verify: () => completeTx(ref, { status: 'pending' }) });
    ref = (await start()).reference;
    expect(await settler.verifyAndSettle(ref)).toBe('PENDING');
    expect(await subs.hasFeature(DEV, 'CLOUD_SYNC')).toBe(false);
    expect(await subs.statusFor(DEV, ref)).toMatchObject({ status: 'PENDING', entitlement: null });
  });

  it('activates only after server-side verification (secret key) and issues an entitlement the DESKTOP can verify', async () => {
    let ref = '';
    const spy = mockNotch({ verify: () => completeTx(ref) });
    ref = (await start()).reference;
    expect(await settler.verifyAndSettle(ref)).toBe('COMPLETE');
    const verifyCall = spy.mock.calls.find((c) => (c[1] as any).method === 'GET')!;
    expect((verifyCall[1] as any).headers.Authorization).toBe('sk.test');

    expect(await subs.hasFeature(DEV, 'CLOUD_SYNC')).toBe(true);
    expect(await subs.hasFeature(DEV, 'AI_STORE_SCAN')).toBe(true);
    expect(await subs.hasFeature('some-other-device', 'CLOUD_SYNC')).toBe(false); // per device

    const st = await subs.statusFor(DEV, ref);
    expect(st.status).toBe('ACTIVE');
    const check = verifyEntitlement(st.entitlement!, subs.publicKeyHex(), { deviceId: DEV });
    expect(check.valid).toBe(true);
    expect((check as any).payload.features).toEqual(['CLOUD_SYNC', 'AI_STORE_SCAN']);
    expect((+new Date(st.expiresAt!) - +new Date((check as any).payload.startedAt)) / 86_400_000).toBe(30);
    expect(verifyEntitlement(st.entitlement!, subs.publicKeyHex(), { deviceId: 'stolen-on-other-pc' })).toEqual({ valid: false, reason: 'WRONG_DEVICE' });
  });

  it('webhook replays / polling races cannot double-credit', async () => {
    let ref = '';
    mockNotch({ verify: () => completeTx(ref) });
    ref = (await start()).reference;
    await Promise.all([settler.verifyAndSettle(ref), settler.settleIfPending(ref, DEV), settler.handleWebhook({ event: 'payment.complete', data: { reference: 'trx.abc', trxref: ref } })]);
    await settler.verifyAndSettle(ref);
    expect(db.subs).toHaveLength(1);
  });

  it('a forged "complete" webhook for an unpaid payment grants nothing (re-verified with Notch Pay)', async () => {
    let ref = '';
    mockNotch({ verify: () => completeTx(ref, { status: 'pending' }) });
    ref = (await start()).reference;
    await settler.handleWebhook({ event: 'payment.complete', data: { reference: 'trx.abc', trxref: ref, status: 'complete', amount: 3900 } });
    expect(db.subs).toHaveLength(0);
  });

  it('wrong amount (e.g. 100 XAF) or someone else’s transaction is rejected and flagged', async () => {
    let ref = '';
    mockNotch({ verify: () => completeTx(ref, { amount: 100 }) });
    ref = (await start()).reference;
    expect(await settler.verifyAndSettle(ref)).toBe('FAILED');
    expect(db.subs).toHaveLength(0);
    expect(await subs.statusFor(DEV, ref)).toMatchObject({ status: 'FAILED' });

    mockNotch({ verify: () => completeTx('SOMEONE-ELSES-ORDER', { reference: 'trx.zzz' }) });
    const second = (await start('dev-second-0001')).reference;
    expect(await settler.verifyAndSettle(second)).toBe('FAILED');
    expect(db.subs).toHaveLength(0);
  });

  it('only the device that owns a reference can follow it', async () => {
    mockNotch({});
    const { reference } = await start();
    expect(await settler.referenceBelongsToDevice(reference, DEV)).toBe(true);
    expect(await settler.referenceBelongsToDevice(reference, 'attacker-device')).toBe(false);
    expect(await settler.referenceBelongsToDevice('IMS-GUESS', DEV)).toBe(false);
  });

  it('a provider outage while verifying leaves the payment pending; failed/cancelled end without Premium', async () => {
    let ref = '';
    const spy = mockNotch({ verify: () => completeTx(ref) });
    ref = (await start()).reference;
    spy.mockImplementation((async () => { throw new Error('network'); }) as any);
    expect(await settler.verifyAndSettle(ref)).toBe('PENDING');
    mockNotch({ verify: () => completeTx(ref, { status: 'failed' }) });
    expect(await settler.verifyAndSettle(ref)).toBe('FAILED');
    expect(db.subs).toHaveLength(0);
  });

  it('a failed initiation charges nothing, is reported clearly and issues no device token', async () => {
    mockNotch({ fail: true });
    await expect(start()).rejects.toThrow(/Nothing was charged/);
    expect(db.payments[0].status).toBe('FAILED');
    expect(db.devices).toHaveLength(0);
  });

  it('renewing while active stacks from the current expiry (no days lost)', async () => {
    let ref = '';
    mockNotch({ verify: () => completeTx(ref) });
    ref = (await start()).reference;
    await settler.verifyAndSettle(ref);
    const firstExpiry = db.subs[0].expiresAt as Date;
    mockNotch({ verify: () => completeTx(ref, { reference: 'trx.def' }) });
    ref = (await start()).reference;
    db.payments[1].notchReference = 'trx.def';
    await settler.verifyAndSettle(ref);
    expect(db.subs).toHaveLength(2);
    expect(+db.subs[1].startedAt).toBe(+firstExpiry);
    expect(+db.subs[1].expiresAt).toBe(+firstExpiry + 30 * 86_400_000);
  });

  it('status lifecycle: NONE → EXPIRED; premium off server-side after expiry while local data is untouched', async () => {
    expect(await subs.statusFor(DEV)).toEqual({ status: 'NONE', entitlement: null, expiresAt: null });
    db.subs.push({ id: 's', deviceId: DEV, plan: 'PREMIUM', status: 'ACTIVE', startedAt: new Date(Date.now() - 40 * 86_400_000), expiresAt: new Date(Date.now() - 10 * 86_400_000), transactionId: 't', userId: null });
    expect(await subs.hasFeature(DEV, 'CLOUD_SYNC')).toBe(false);
    expect(db.subs[0].status).toBe('EXPIRED');
    expect(await subs.statusFor(DEV)).toMatchObject({ status: 'EXPIRED', entitlement: null });
  });
});
