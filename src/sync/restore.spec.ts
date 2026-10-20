import { fakeAudit, FakePrisma } from '../../test/fake-prisma';
import { AuthUser } from '../common/types';
import { effectivePermissions } from '../rbac/permissions';
import { ChangeDto } from './sync.dto';
import { SyncService } from './sync.service';
import { RESTORE_ORDER } from './sync-rules';

const hex = (n: number, c = 'a') => c.repeat(n);
const acct = (device: string, role: 'ADMIN' | 'MANAGER' | 'STAFF' = 'ADMIN', business = 'biz-1'): AuthUser => ({
  kind: 'account', id: 'u-1', businessId: business, email: 'o@shop.cm', fullName: 'Owner', role, deviceId: device, permissions: effectivePermissions(role, []),
});
const OLD_PC = 'dev-old-pc-0001', NEW_PC = 'dev-new-pc-0002';

let n = 0;
const ch = (entityType: string, entityId: string, data: any, over: Partial<ChangeDto> = {}): ChangeDto =>
  ({ opId: `op-${++n}`, entityType, entityId, operation: 'CREATE', baseVersion: 0, data: { id: entityId, ...data }, ...over });
const userRow = (id: string) => ({ username: id, full_name: id, role_code: 'cashier', password_hash: hex(64), password_salt: hex(32, 'b'), password_iterations: 150_000, active: 1 });

describe('free restore from the cloud (new computer after a crash)', () => {
  let db: FakePrisma, sync: SyncService, premium: Set<string>, cfg: Record<string, string>;
  beforeEach(() => {
    n = 0; db = new FakePrisma(); premium = new Set(); cfg = {};
    const subs = { getActive: async (d: string) => (premium.has(d) ? { id: 's' } : null) } as any;
    sync = new SyncService(db as any, fakeAudit, subs, { get: (k: string) => cfg[k] } as any);
  });

  /** The dead computer had Premium and synced a small shop. */
  async function seedShop() {
    premium.add(OLD_PC);
    const owner = acct(OLD_PC);
    await sync.push(owner, [
      ch('sale_items', 'si-1', { sale_id: 's-1', product_id: 'p-1', quantity: 2 }),
      ch('sales', 's-1', { receipt_no: 'R-1', total: 1000, status: 'COMPLETED' }),
      ch('products', 'p-1', { name: 'Coca-Cola', selling_price: 500, category_id: 'c-1' }),
      ch('categories', 'c-1', { name: 'Drinks' }),
      ch('audit_log', 'a-1', { action: 'SALE' }),
      ch('stock_movements', 'm-1', { product_id: 'p-1', quantity: -2 }),
      ch('roles', 'cashier', { code: 'cashier', name: 'Cashier' }),
      ch('role_permissions', 'cashier|sales.create', { role_code: 'cashier', permission: 'sales.create' }),
      ch('users', 'u-9', userRow('aminata')),
      ch('app_settings', 'business_name', { key: 'business_name', value: 'Chez Aminata' }),
      ch('customers', 'cu-1', { name: 'Paul' }),
    ]);
    await sync.push(owner, [ch('products', 'p-1', { name: 'Coca-Cola 50cl', selling_price: 600, category_id: 'c-1' }, { operation: 'UPDATE', baseVersion: 1 })]);
    await sync.push(owner, [ch('products', 'p-2', { name: 'Old item' }), ]);
    await sync.push(owner, [ch('products', 'p-2', { name: 'Old item', deleted_at: '2026-10-01T00:00:00Z' }, { operation: 'DELETE', baseVersion: 1 })]);
  }
  const drain = async (user: AuthUser, limit = 200) => {
    const pages: any[] = []; let after: string | undefined;
    do { const p: any = await sync.restore(user, after, limit); pages.push(p); after = p.next ?? undefined; } while (after);
    return pages;
  };

  it('a new computer WITHOUT Premium gets the current state: latest versions only, tombstones included, parents before children', async () => {
    await seedShop();
    const pages = await drain(acct(NEW_PC));
    const recs = pages.flatMap((p) => p.records);
    const key = (r: any) => `${r.entityType}/${r.entityId}`;
    expect(new Set(recs.map(key)).size).toBe(recs.length);                                    // no duplicates
    const p1 = recs.find((r) => key(r) === 'products/p-1');
    expect(p1).toMatchObject({ version: 2, deleted: false, data: expect.objectContaining({ name: 'Coca-Cola 50cl', selling_price: 600 }) }); // newest version, not history
    expect(recs.find((r) => key(r) === 'products/p-2')).toMatchObject({ version: 2, deleted: true }); // tombstone kept: rows may still be referenced
    const idx = (t: string) => recs.findIndex((r) => r.entityType === t);
    for (const [parent, child] of [['roles', 'users'], ['roles', 'role_permissions'], ['categories', 'products'], ['products', 'stock_movements'], ['products', 'sale_items'], ['sales', 'sale_items'], ['customers', 'sales']] as const) {
      if (idx(parent) >= 0 && idx(child) >= 0) expect(idx(parent)).toBeLessThan(idx(child));
    }
    expect(recs[recs.length - 1].entityType).toBe('audit_log');                                // biggest table last
    expect(recs.map((r) => RESTORE_ORDER.indexOf(r.entityType))).toEqual([...recs.map((r) => RESTORE_ORDER.indexOf(r.entityType))].sort((a, b) => a - b));
  });

  it('paging: tiny pages (limit 2) return exactly the same records as one big page; snapshotCursor is identical on every page', async () => {
    await seedShop();
    const big = (await drain(acct(NEW_PC), 500)).flatMap((p) => p.records);
    db.grants.clear();
    const pages = await drain(acct(NEW_PC), 2);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.flatMap((p) => p.records).map((r) => `${r.entityType}/${r.entityId}`)).toEqual(big.map((r) => `${r.entityType}/${r.entityId}`));
    expect(new Set(pages.map((p) => p.snapshotCursor)).size).toBe(1);
    expect(pages[0].snapshotCursor).toBe(String(db.changes[db.changes.length - 1].serverSeq));
    expect(pages.slice(0, -1).every((p) => p.hasMore && p.next)).toBe(true);
    expect(pages[pages.length - 1]).toMatchObject({ hasMore: false, next: null });
    expect(pages.every((p) => p.records.every((r: any) => r.cursor === pages[0].snapshotCursor))).toBe(true);
  });

  it('a change made on another device WHILE restoring is not lost: it is above snapshotCursor, so the next pull returns it', async () => {
    await seedShop();
    const first = await sync.restore(acct(NEW_PC), undefined, 3);
    // the shop's second computer sells something while the restore is in progress
    const other = acct('dev-other-pc-0003');
    await sync.push(other, [ch('categories', 'c-new', { name: 'Fresh' })]);
    const rest = await drain(acct(NEW_PC), 3).catch(() => []); // continue with a fresh walk for simplicity of the assertion below
    void rest;
    // walk the remaining pages of the ORIGINAL restore using its token
    const pages = [first]; let after = first.next as string | undefined;
    while (after) { const p: any = await sync.restore(acct(NEW_PC), after, 3); pages.push(p); after = p.next ?? undefined; }
    const snapshot = pages[0].snapshotCursor;
    const afterSnapshot = await sync.pull(acct(NEW_PC), BigInt(snapshot), 100);
    expect(afterSnapshot.records.map((r) => r.entityId)).toContain('c-new'); // delivered by the normal sync that follows
    const alsoInSnapshot = pages.flatMap((p) => p.records).some((r) => r.entityId === 'c-new');
    expect(alsoInSnapshot || afterSnapshot.records.some((r) => r.entityId === 'c-new')).toBe(true); // never missed either way
  });

  it('restore is read-only: it writes nothing to the change log', async () => {
    await seedShop();
    const before = db.changes.length;
    await drain(acct(NEW_PC));
    expect(db.changes.length).toBe(before);
  });

  describe('who may restore for free', () => {
    it('a device with Premium always may (no grant needed); a free device gets a grant for the window', async () => {
      await seedShop();
      premium.add(NEW_PC);
      await drain(acct(NEW_PC));
      expect(db.grants.size).toBe(0);
      premium.delete(NEW_PC);
      await drain(acct(NEW_PC));
      expect(db.grants.get(NEW_PC)).toBeDefined();
      await expect(drain(acct(NEW_PC))).resolves.toBeDefined(); // can be repeated inside the window
    });

    it('after the window (default 7 days) a non-Premium device is refused with 402 PREMIUM_REQUIRED (local data untouched)', async () => {
      await seedShop();
      await sync.restore(acct(NEW_PC), undefined, 5);
      db.grants.get(NEW_PC).firstAt = new Date(Date.now() - 8 * 86_400_000);
      await expect(sync.restore(acct(NEW_PC), undefined, 5)).rejects.toMatchObject({ status: 402, response: expect.objectContaining({ code: 'PREMIUM_REQUIRED', reason: 'RESTORE_WINDOW_EXPIRED' }) });
      premium.add(NEW_PC); // subscribing re-opens it
      await expect(sync.restore(acct(NEW_PC), undefined, 5)).resolves.toBeDefined();
    });

    it('RESTORE_WINDOW_DAYS is configurable', async () => {
      await seedShop(); cfg.RESTORE_WINDOW_DAYS = '30';
      await sync.restore(acct(NEW_PC), undefined, 5);
      db.grants.get(NEW_PC).firstAt = new Date(Date.now() - 20 * 86_400_000);
      await expect(sync.restore(acct(NEW_PC), undefined, 5)).resolves.toBeDefined();
    });

    it('a business cannot use many free computers as mirrors: the 4th new device in 30 days gets 429', async () => {
      await seedShop();
      for (const d of ['dev-pc-aaaa0001', 'dev-pc-aaaa0002', 'dev-pc-aaaa0003']) await sync.restore(acct(d), undefined, 5);
      await expect(sync.restore(acct('dev-pc-aaaa0004'), undefined, 5)).rejects.toMatchObject({ status: 429, response: expect.objectContaining({ code: 'RESTORE_DEVICE_LIMIT' }) });
      await expect(sync.restore(acct('dev-pc-aaaa0001'), undefined, 5)).resolves.toBeDefined(); // existing grants keep working
    });

    it('a business with nothing in the cloud gets an empty result and no grant is used up', async () => {
      const r = await sync.restore(acct(NEW_PC, 'ADMIN', 'biz-empty'), undefined, 50);
      expect(r).toEqual({ records: [], next: null, hasMore: false, snapshotCursor: '0' });
      expect(db.grants.size).toBe(0);
    });

    it('businesses are isolated: restoring never returns another business\'s data', async () => {
      await seedShop();
      await sync.push(acct('dev-x-0000001', 'ADMIN', 'biz-2'), [ch('products', 'p-secret', { name: 'Other shop product' })]);
      const recs = (await drain(acct(NEW_PC))).flatMap((p) => p.records);
      expect(recs.some((r) => r.entityId === 'p-secret')).toBe(false);
      const other = (await drain(acct('dev-y-0000002', 'ADMIN', 'biz-2'))).flatMap((p) => p.records);
      expect(other.map((r) => r.entityId)).toEqual(['p-secret']);
    });

    it('a device already used to restore business A cannot restore business B', async () => {
      await seedShop();
      await sync.push(acct('dev-x-0000001', 'ADMIN', 'biz-2'), [ch('products', 'p-b', { name: 'B' })]);
      await sync.restore(acct(NEW_PC), undefined, 5);
      await expect(sync.restore(acct(NEW_PC, 'ADMIN', 'biz-2'), undefined, 5)).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('staff accounts and settings are administrator-only', () => {
    it('an ADMIN restores users, roles and settings; a MANAGER never receives password hashes', async () => {
      await seedShop();
      const admin = (await drain(acct(NEW_PC, 'ADMIN'))).flatMap((p) => p.records).map((r) => r.entityType);
      for (const t of ['users', 'roles', 'role_permissions', 'app_settings']) expect(admin).toContain(t);
      db.grants.clear();
      const manager = (await drain(acct(NEW_PC, 'MANAGER'))).flatMap((p) => p.records).map((r) => r.entityType);
      for (const t of ['users', 'roles', 'role_permissions', 'app_settings']) expect(manager).not.toContain(t);
      expect(manager).toContain('products');
    });
    it('the normal pull hides them from a MANAGER as well, and the cursor still advances', async () => {
      await seedShop();
      const asManager = await sync.pull(acct('dev-m-0000001', 'MANAGER'), BigInt(0), 500);
      expect(asManager.records.some((r) => ['users', 'roles', 'role_permissions', 'app_settings'].includes(r.entityType))).toBe(false);
      const asAdmin = await sync.pull(acct('dev-a-0000001', 'ADMIN'), BigInt(0), 500);
      expect(asAdmin.records.some((r) => r.entityType === 'users')).toBe(true);
    });
  });

  it('malformed or tampered restore tokens are refused with 400', async () => {
    await seedShop();
    for (const bad of ['garbage', Buffer.from('{"c":"x","t":0,"id":""}').toString('base64url'), Buffer.from('{"c":"5","t":999,"id":""}').toString('base64url'), Buffer.from('{"c":"5","t":0,"id":' + JSON.stringify('x'.repeat(300)) + '}').toString('base64url')]) {
      await expect(sync.restore(acct(NEW_PC), bad, 10)).rejects.toMatchObject({ status: 400 });
    }
  });
});
