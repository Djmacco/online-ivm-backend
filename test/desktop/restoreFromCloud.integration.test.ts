/**
 * REAL integration for "my computer died": the desktop's own SyncEngine + SQLite code restore a shop from the backend's
 * free /sync/restore snapshot onto a brand-new, NON-Premium computer. No desktop code is modified: a tiny adapter below feeds
 * restore pages to the engine through its normal pull path (what the future "Restore from cloud" button will do).
 *
 * Run (from the desktop repo):  copy this file to desktop/tests/ and  BACKEND_DIR=../backend npm test -- restoreFromCloud
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudClient } from '../src/cloud/client';
import { hasFeature, loadStatus } from '../src/entitlement/entitlement';
import { createCategory } from '../src/services/categories';
import { createProduct, getProduct, updateProductPrice } from '../src/services/products';
import { cancelSale, createSale } from '../src/services/sales';
import { setSetting } from '../src/services/settings';
import { SyncEngine } from '../src/sync/engine';
import type { SyncTransport } from '../src/sync/protocol';
import { makeEnv, type TestEnv } from './helpers';
import { TEST_PRIVATE_KEY } from './testKeys';

const BACKEND = process.env.BACKEND_DIR;
const PORT = 4900 + (process.pid % 90), URL = `http://127.0.0.1:${PORT}`, STATE = `/tmp/ims-restore-${process.pid}.json`, JWT_SECRET = 'j'.repeat(40);
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtFor = (deviceId: string) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ sub: 'u-1', bid: 'biz-1', did: deviceId, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const prod = (name: string, extra: any = {}) => ({ name, cost_price: 300, selling_price: 500, minimum_stock: 5, unit: 'pcs', ...extra });
type Dev = { env: TestEnv; cloud: CloudClient; engine: SyncEngine };

describe.skipIf(!BACKEND)('restore a shop on a new computer from the cloud (real engine, real HTTP)', () => {
  let server: ChildProcess;
  const premium: string[] = [];
  const setPremium = () => writeFileSync(STATE, JSON.stringify({ premium, tokens: Object.fromEntries(premium.map((d) => [`T-${d}`.padEnd(43, 'x'), d])) }));
  const tick = (d: { env: TestEnv }, ms = 120_000) => { d.env.clock.now = new Date(d.env.clock.now.getTime() + ms); };

  async function device(): Promise<Dev> {
    const env = await makeEnv();
    const cloud = new CloudClient(env.db, env.ctx.deviceId);
    await setSetting(env.db, 'cloud_api_url', URL);
    await setSetting(env.db, 'cloud_session', JSON.stringify({ email: 'owner@shop.cm', accessToken: jwtFor(env.ctx.deviceId), refreshToken: 'unused' }));
    const engine = new SyncEngine({
      db: env.db, deviceId: env.ctx.deviceId, transport: cloud.transport(), isOnline: () => true, now: () => env.clock.now,
      isEnabled: async () => hasFeature(await loadStatus(env.db, env.ctx.deviceId, env.clock.now), 'CLOUD_SYNC') && (await cloud.hasSession()),
    });
    return { env, cloud, engine };
  }
  async function enable(d: Dev) {
    premium.push(d.env.ctx.deviceId); setPremium();
    await setSetting(d.env.db, 'cloud_device_token', `T-${d.env.ctx.deviceId}`.padEnd(43, 'x'));
    const { verifyPayment } = await import('../src/cloud/payment');
    expect(await verifyPayment({ db: d.env.db, deviceId: d.env.ctx.deviceId, cloud: d.cloud, now: () => d.env.clock.now }, 'x')).toBe('ACTIVE');
  }
  /** Feeds GET /sync/restore pages into the engine's normal pull path; hands the cursor over to the normal pull at the end. */
  function restoreTransport(d: Dev): SyncTransport {
    const base = d.cloud.transport();
    return {
      push: (r) => base.push(r),
      pull: async (since, deviceId, limit) => {
        if (since !== '0' && /^\d+$/.test(since)) return base.pull(since, deviceId, limit); // normal sync (needs Premium)
        const url = `${URL}/sync/restore?deviceId=${deviceId}&limit=${limit}${since !== '0' ? `&after=${encodeURIComponent(since)}` : ''}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${jwtFor(deviceId)}` } });
        if (!res.ok) throw new Error(`restore HTTP ${res.status}`);
        const j: any = await res.json();
        return { records: j.records, nextCursor: j.hasMore ? j.next : j.snapshotCursor, hasMore: j.hasMore };
      },
    };
  }
  const count = async (d: Dev, sql: string) => ((await d.env.db.selectOne(sql)) as any).n as number;

  beforeAll(async () => {
    setPremium();
    server = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', './test/prisma-redirect.js', 'test/serve-for-desktop.ts'], {
      cwd: BACKEND, env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), STATE_FILE: STATE, DATABASE_URL: 'postgres://x', JWT_SECRET, JWT_REFRESH_SECRET: 'r'.repeat(40), ENTITLEMENT_PRIVATE_KEY: TEST_PRIVATE_KEY, NOTCHPAY_PUBLIC_KEY: 'pk.t', NOTCHPAY_SECRET_KEY: 'sk.t', NOTCHPAY_HASH_KEY: 'h', NOTCHPAY_API_URL: 'http://127.0.0.1:1', PREMIUM_PRICE_XAF: '3900' },
    });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('backend did not start')), 60_000);
      server.stdout!.on('data', (b) => { if (String(b).includes('READY')) { clearTimeout(t); res(); } });
      server.on('exit', (c) => rej(new Error(`backend exited (${c})`)));
    });
  }, 70_000);
  afterAll(() => { server?.kill(); });

  it('the old PC (Premium) syncs the shop; a NEW PC with no subscription restores it completely, then Premium sync continues without re-downloading', async () => {
    // ── the old computer: a small shop ───────────────────────────────
    const old = await device(); await enable(old);
    const cat = await createCategory(old.env.ctx, 'Drinks');
    const coca = await createProduct(old.env.ctx, prod('Coca-Cola', { category_id: cat.id, initial_quantity: 20 }));
    const fanta = await createProduct(old.env.ctx, prod('Fanta', { category_id: cat.id, initial_quantity: 10 }));
    await createSale(old.env.ctx, { lines: [{ product_id: coca.id, quantity: 5 }], payment_method: 'CASH' });
    const refunded = await createSale(old.env.ctx, { lines: [{ product_id: fanta.id, quantity: 2 }], payment_method: 'CASH' });
    await cancelSale(old.env.ctx, refunded.sale.id, 'customer returned');
    await updateProductPrice(old.env.ctx, coca.id, 650);
    tick(old); await old.engine.syncNow();
    expect(await old.engine.getStatus()).toMatchObject({ state: 'IDLE', pending: 0, failed: 0 });

    // the owner also had staff accounts and shop settings in the cloud (pushed by a newer desktop)
    const push = await fetch(`${URL}/sync/push`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwtFor(old.env.ctx.deviceId)}` },
      body: JSON.stringify({ deviceId: old.env.ctx.deviceId, changes: [
        { opId: 'r1', entityType: 'roles', entityId: 'cashier', operation: 'CREATE', baseVersion: 0, data: { code: 'cashier', name: 'Cashier' } },
        { opId: 'r2', entityType: 'users', entityId: 'u-aminata', operation: 'CREATE', baseVersion: 0, data: { username: 'aminata', full_name: 'Aminata', role_code: 'cashier', password_hash: 'a'.repeat(64), password_salt: 'b'.repeat(32), password_iterations: 150000, active: 1 } },
        { opId: 'r3', entityType: 'app_settings', entityId: 'business_name', operation: 'CREATE', baseVersion: 0, data: { key: 'business_name', value: 'Chez Aminata' } },
      ] }),
    });
    expect((await push.json() as any).results.map((r: any) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);

    // ── the computer dies. A brand-new PC, NOT subscribed ────────────
    const fresh = await device();
    const normalPull = await fetch(`${URL}/sync/pull?since=0`, { headers: { Authorization: `Bearer ${jwtFor(fresh.env.ctx.deviceId)}` } });
    expect(normalPull.status).toBe(402);                                     // ongoing sync still needs Premium...
    const engine = new SyncEngine({ db: fresh.env.db, deviceId: fresh.env.ctx.deviceId, transport: restoreTransport(fresh), isOnline: () => true, now: () => fresh.env.clock.now, isEnabled: async () => true });
    // A restore is PULL-ONLY: the new PC still has its own first-run rows queued, and pushing them needs Premium (402).
    // The future "Restore from cloud" button therefore drives the engine's pull step directly, exactly like this:
    const report = { pushed: 0, pulled: 0, conflicts: 0, failed: 0 };
    tick(fresh); await (engine as any).pullAll(report);                      // the free restore works
    expect(report.failed).toBe(0);
    expect(report.pulled).toBeGreaterThanOrEqual(8);

    // the shop is back, byte for byte where it matters
    expect(await getProduct(fresh.env.ctx, coca.id)).toMatchObject({ name: 'Coca-Cola', selling_price: 650, quantity: 15 });   // stock rebuilt from the ledger
    expect(await getProduct(fresh.env.ctx, fanta.id)).toMatchObject({ quantity: 10 });                                         // cancelled sale restored the stock
    expect(await count(fresh, 'SELECT COUNT(*) n FROM sales')).toBe(await count(old, 'SELECT COUNT(*) n FROM sales'));
    expect(await count(fresh, "SELECT COUNT(*) n FROM sales WHERE status='CANCELLED'")).toBe(1);
    expect(await count(fresh, 'SELECT COUNT(*) n FROM sale_items')).toBe(await count(old, 'SELECT COUNT(*) n FROM sale_items'));
    expect(await count(fresh, 'SELECT COUNT(*) n FROM stock_movements')).toBe(await count(old, 'SELECT COUNT(*) n FROM stock_movements'));
    const queuedBefore = await count(fresh, "SELECT COUNT(*) n FROM sync_queue WHERE status <> 'SYNCED'"); // only the PC's own first-run rows; restoring adds nothing to upload
    expect(queuedBefore).toBeLessThanOrEqual(2);
    expect((await fresh.env.db.select('PRAGMA foreign_key_check')).length).toBe(0);                  // every foreign key resolves
    const cursor = ((await fresh.env.db.selectOne("SELECT value v FROM app_settings WHERE key='sync_cursor'")) as any).v;
    expect(cursor).toMatch(/^\d+$/);                                                                  // handed over to normal sync

    // ── the owner subscribes on the new PC: sync continues from the snapshot ────────
    await enable(fresh);
    tick(fresh); const first = await fresh.engine.syncNow();
    expect(first.pulled).toBe(0);                                            // nothing re-downloaded, nothing missed
    await createSale(fresh.env.ctx, { lines: [{ product_id: coca.id, quantity: 3 }], payment_method: 'CASH' });
    for (let i = 0; i < 3; i++) for (const d of [fresh, old]) { tick(d); await d.engine.syncNow(); }
    expect((await getProduct(fresh.env.ctx, coca.id))!.quantity).toBe(12);
    expect((await getProduct(old.env.ctx, coca.id))!.quantity).toBe(12);    // the replacement PC and any other PC agree
  });
});
