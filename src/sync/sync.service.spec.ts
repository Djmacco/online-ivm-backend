import { fakeAudit, FakePrisma } from '../../test/fake-prisma';
import { AuthUser } from '../common/types';
import { ChangeDto } from './sync.dto';
import { SyncService } from './sync.service';

const BIZ = 'biz-1';
const user = (device: string, business = BIZ): AuthUser => ({ kind: 'account', id: 'u1', businessId: business, email: 'a@b.cm', fullName: 'A', role: 'ADMIN', deviceId: device, permissions: [] });
const A = user('dev-AAAAAAAA'), B = user('dev-BBBBBBBB');

let n = 0;
const ch = (c: Partial<ChangeDto> & Pick<ChangeDto, 'entityType' | 'entityId' | 'operation' | 'data'>): ChangeDto => ({ opId: `op-${++n}`, baseVersion: 0, ...c });
const product = (o: any = {}) => ({ id: 'p1', name: 'Coca-Cola', selling_price: 500, quantity: 10, updated_at: '2026-10-01T10:00:00.000Z', device_id: 'dev-AAAAAAAA', deleted_at: null, ...o });

describe('SyncService – desktop contract (docs/BACKEND_CONTRACT.md)', () => {
  let db: FakePrisma, sync: SyncService;
  beforeEach(() => { db = new FakePrisma(); sync = new SyncService(db as any, fakeAudit, { getActive: async () => null } as any, { get: () => undefined } as any); n = 0; });
  const push = async (u: AuthUser, ...changes: ChangeDto[]) => (await sync.push(u, changes)).results;

  it('ACCEPTED: new record starts at version 1, update on the latest version → version+1', async () => {
    const [c] = await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
    expect(c).toMatchObject({ status: 'ACCEPTED', version: 1, entityId: 'p1' });
    const [u] = await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ selling_price: 600 }) }));
    expect(u).toMatchObject({ status: 'ACCEPTED', version: 2 });
    expect(db.records.get(`${BIZ}|products|p1`).data.selling_price).toBe(600);
  });

  it('idempotency: replaying an opId returns DUPLICATE with the ORIGINAL version and writes nothing', async () => {
    const c = ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() });
    await push(A, c);
    const [again] = await push(A, c);
    expect(again).toMatchObject({ status: 'DUPLICATE', version: 1 });
    expect(db.changes).toHaveLength(1);
  });

  it('CONFLICT: stale baseVersion → server copy returned in the contract shape, nothing overwritten', async () => {
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ selling_price: 550 }) }));
    const [r] = await push(B, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ selling_price: 700 }) }));
    expect(r.status).toBe('CONFLICT');
    expect(r.serverRecord).toEqual({ entityType: 'products', entityId: 'p1', version: 2, deleted: false, data: expect.objectContaining({ selling_price: 550 }) });
    expect(db.records.get(`${BIZ}|products|p1`).data.selling_price).toBe(550);
  });

  it('after a CONFLICT the desktop re-sends the SAME opId on the new base – it must be accepted (conflicts are not remembered)', async () => {
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ selling_price: 550 }) }));
    const mine = ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ selling_price: 700 }) });
    expect((await push(B, mine))[0].status).toBe('CONFLICT');
    const [retry] = await push(B, { ...mine, baseVersion: 2 });
    expect(retry).toMatchObject({ status: 'ACCEPTED', version: 3 });
  });

  it('creating an id that already exists with baseVersion 0 is a CONFLICT (not a silent overwrite)', async () => {
    await push(A, ch({ entityType: 'categories', entityId: 'c1', operation: 'CREATE', data: { id: 'c1', name: 'Drinks' } }));
    const [r] = await push(B, ch({ entityType: 'categories', entityId: 'c1', operation: 'CREATE', data: { id: 'c1', name: 'Other' } }));
    expect(r.status).toBe('CONFLICT');
  });

  it('immutable ledgers: same id = same record → DUPLICATE, never CONFLICT, never modified', async () => {
    const m = { id: 'm1', product_id: 'p1', quantity: -5, reason: 'SALE' };
    expect((await push(A, ch({ entityType: 'stock_movements', entityId: 'm1', operation: 'CREATE', data: m })))[0]).toMatchObject({ status: 'ACCEPTED', version: 1 });
    const [dup] = await push(B, ch({ entityType: 'stock_movements', entityId: 'm1', operation: 'CREATE', baseVersion: 0, data: { ...m, quantity: -999 } }));
    expect(dup).toMatchObject({ status: 'DUPLICATE', version: 1 });
    expect(db.records.get(`${BIZ}|stock_movements|m1`).data.quantity).toBe(-5);
    for (const t of ['sale_items', 'customer_payments', 'supplier_payments', 'purchase_items', 'audit_log']) {
      await push(A, ch({ entityType: t, entityId: 'x1', operation: 'CREATE', data: { id: 'x1' } }));
      expect((await push(B, ch({ entityType: t, entityId: 'x1', operation: 'CREATE', data: { id: 'x1', evil: 1 } })))[0].status).toBe('DUPLICATE');
    }
  });

  it('delete = tombstone with deleted:true (pulled by other devices); an edit on the tombstone version resurrects it', async () => {
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
    const [d] = await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'DELETE', baseVersion: 1, data: product({ deleted_at: '2026-10-02T00:00:00Z' }) }));
    expect(d).toMatchObject({ status: 'ACCEPTED', version: 2 });
    const pulled = await sync.pull(B, BigInt(0), 100);
    expect(pulled.records.map((r) => [r.version, r.deleted])).toEqual([[1, false], [2, true]]);
    const [res] = await push(B, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 2, data: product({ quantity: 3, deleted_at: null }) }));
    expect(res).toMatchObject({ status: 'ACCEPTED', version: 3 });
    expect(db.records.get(`${BIZ}|products|p1`).deletedAt).toBeNull();
  });

  it('a soft delete sent as an UPDATE (deleted_at set) is stored as deleted', async () => {
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
    await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'UPDATE', baseVersion: 1, data: product({ deleted_at: '2026-10-02T00:00:00Z' }) }));
    expect((await sync.pull(B, BigInt(0), 100)).records[1].deleted).toBe(true);
  });

  describe('completed sales are never rewritten', () => {
    const sale = { id: 's1', receipt_no: 'R-1', subtotal: 2500, discount_total: 0, total: 2500, amount_paid: 3000, change_due: 500, payment_method: 'CASH', status: 'COMPLETED', cost_total: 0, sold_at: '2026-10-02T09:00:00Z', updated_at: '2026-10-02T09:00:00Z' };
    beforeEach(async () => { await push(A, ch({ entityType: 'sales', entityId: 's1', operation: 'CREATE', data: sale })); });
    const upd = (data: any, baseVersion = 1) => ch({ entityType: 'sales', entityId: 's1', operation: 'UPDATE', baseVersion, data: { ...sale, ...data } });

    it("the desktop's own follow-up (cost_total is set right after creation) is accepted", async () => {
      expect((await push(A, upd({ cost_total: 1750 })))[0]).toMatchObject({ status: 'ACCEPTED', version: 2 });
    });
    it('changing the total / amounts / payment method is REJECTED', async () => {
      for (const f of [{ total: 1 }, { amount_paid: 1 }, { payment_method: 'CARD' }, { subtotal: 5 }, { sold_at: '2020-01-01T00:00:00Z' }]) {
        const [r] = await push(A, upd(f));
        expect(r.status).toBe('REJECTED');
        expect(r.error).toMatch(/immutable/);
      }
      expect(db.records.get(`${BIZ}|sales|s1`).data.total).toBe(2500);
    });
    it('cancelling is the only legal status change and it is never undone', async () => {
      expect((await push(A, upd({ status: 'CANCELLED', cancelled_at: '2026-10-03T00:00:00Z', cancel_reason: 'error' })))[0]).toMatchObject({ status: 'ACCEPTED', version: 2 });
      expect((await push(A, upd({ status: 'COMPLETED' }, 2)))[0].status).toBe('REJECTED');
      expect((await push(A, upd({ status: 'REFUNDED' }, 2)))[0].status).toBe('REJECTED');
    });
  });

  describe('input hardening', () => {
    it('rejects unknown tables, mismatched ids and oversized rows (REJECTED, row kept by the app)', async () => {
      expect((await push(A, ch({ entityType: 'users', entityId: 'x', operation: 'CREATE', data: {} })))[0]).toMatchObject({ status: 'REJECTED' });
      expect((await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: { id: 'p2' } })))[0].error).toMatch(/entityId/);
      expect((await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: { id: 'p1', image: 'x'.repeat(300_000) } })))[0].error).toMatch(/too large/);
    });
    it('ignores client-supplied business_id / version / sync_status', async () => {
      await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product({ business_id: 'evil', businessId: 'evil', version: 99, sync_status: 'SYNCED' }) }));
      const row = db.records.get(`${BIZ}|products|p1`);
      expect(row.businessId).toBe(BIZ);
      expect(row.version).toBe(1);
      expect(row.data).not.toHaveProperty('business_id');
      expect(row.data).not.toHaveProperty('version');
      expect(row.data).not.toHaveProperty('sync_status');
    });
    it('businesses are isolated even when ids collide', async () => {
      const other = user('dev-CCCCCCCC', 'biz-2');
      await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product() }));
      expect((await push(other, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product({ name: 'Other shop' }) })))[0]).toMatchObject({ status: 'ACCEPTED', version: 1 });
      expect((await sync.pull(other, BigInt(0), 100)).records).toHaveLength(1);
      expect(db.records.get(`${BIZ}|products|p1`).data.name).toBe('Coca-Cola');
    });
    it('desktop snake_case data is stored and returned untouched', async () => {
      await push(A, ch({ entityType: 'products', entityId: 'p1', operation: 'CREATE', data: product({ min_stock: 4, cost_price: 350 }) }));
      expect((await sync.pull(B, BigInt(0), 10)).records[0].data).toMatchObject({ min_stock: 4, cost_price: 350, selling_price: 500 });
    });
  });

  describe('pull', () => {
    it('global cursor; includes the caller’s own changes; pages with hasMore', async () => {
      for (let i = 1; i <= 5; i++) await push(A, ch({ entityType: 'categories', entityId: `c${i}`, operation: 'CREATE', data: { id: `c${i}`, name: `C${i}` } }));
      const p1 = await sync.pull(A, BigInt(0), 2);
      expect(p1.records.map((r) => r.entityId)).toEqual(['c1', 'c2']);
      expect(p1).toMatchObject({ hasMore: true, nextCursor: '2' });
      expect(p1.records[0].cursor).toBe('1');
      const p2 = await sync.pull(A, BigInt(p1.nextCursor), 10);
      expect(p2.records.map((r) => r.entityId)).toEqual(['c3', 'c4', 'c5']);
      expect(p2.hasMore).toBe(false);
      const p3 = await sync.pull(B, BigInt(p2.nextCursor), 10);
      expect(p3).toMatchObject({ records: [], nextCursor: '5', hasMore: false });
    });
  });

  it('server failure mid-batch → request fails (5xx), the app replays the batch, applied ops come back DUPLICATE and nothing is duplicated', async () => {
    const batch = [
      ch({ entityType: 'categories', entityId: 'c1', operation: 'CREATE', data: { id: 'c1' } }),
      ch({ entityType: 'categories', entityId: 'c2', operation: 'CREATE', data: { id: 'c2' } }),
    ];
    const real = db.syncRecord.upsert; let calls = 0; let fail = true;
    db.syncRecord.upsert = (async (...a: any[]) => { if (fail && ++calls === 2) throw new Error('db down'); return (real as any)(...a); }) as any;
    await expect(sync.push(A, batch)).rejects.toThrow('db down');
    expect(db.changes).toHaveLength(1);
    fail = false;
    const { results } = await sync.push(A, batch);
    expect(results.map((r) => r.status)).toEqual(['DUPLICATE', 'ACCEPTED']);
    expect(db.changes).toHaveLength(2);
  });

  it('offline → many queued ops in order → online: parents before children, all ACCEPTED', async () => {
    const r = await push(A,
      ch({ entityType: 'sales', entityId: 's1', operation: 'CREATE', data: { id: 's1', total: 1000, status: 'COMPLETED' } }),
      ch({ entityType: 'sale_items', entityId: 'si1', operation: 'CREATE', data: { id: 'si1', sale_id: 's1', quantity: 2 } }),
      ch({ entityType: 'stock_movements', entityId: 'm1', operation: 'CREATE', data: { id: 'm1', product_id: 'p1', quantity: -2 } }),
    );
    expect(r.map((x) => x.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
  });
});
