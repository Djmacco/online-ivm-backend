import { fakeAudit, FakePrisma } from '../../test/fake-prisma';
import { AuthUser } from '../common/types';
import { effectivePermissions } from '../rbac/permissions';
import { ChangeDto } from './sync.dto';
import { SyncService } from './sync.service';
import { RESTORE_ORDER, SHOP_SETTING_KEYS, SYNC_TABLES, decodeRestoreToken, encodeRestoreToken, sanitizeRow, validateRestrictedRow } from './sync-rules';

const acct = (role: 'ADMIN' | 'MANAGER' | 'STAFF', perms: string[] = []): AuthUser => ({
  kind: 'account', id: 'u-1', businessId: 'biz-1', email: 'o@x.cm', fullName: 'O', role, deviceId: 'dev-aaaaaaaa', permissions: effectivePermissions(role, perms),
});
let n = 0;
const ch = (entityType: string, entityId: string, data: any, over: Partial<ChangeDto> = {}): ChangeDto => ({ opId: `op-${++n}`, entityType, entityId, operation: 'CREATE', baseVersion: 0, data: { id: entityId, ...data }, ...over });
const user = (o: any = {}) => ({ username: 'aminata', full_name: 'Aminata', role_code: 'cashier', password_hash: 'a'.repeat(64), password_salt: 'b'.repeat(32), password_iterations: 150_000, active: 1, ...o });

describe('restore ordering & tokens (pure)', () => {
  it('RESTORE_ORDER is exactly the set of synced tables, each once', () => {
    expect([...RESTORE_ORDER].sort()).toEqual([...SYNC_TABLES].sort());
    expect(new Set(RESTORE_ORDER).size).toBe(RESTORE_ORDER.length);
  });
  it('every foreign-key parent comes before its children (the desktop checks FKs per page)', () => {
    const fk: Array<[string, string]> = [
      ['categories', 'products'], ['suppliers', 'products'], ['products', 'product_batches'], ['products', 'stock_movements'], ['customers', 'sales'],
      ['products', 'sale_items'], ['sales', 'sale_items'], ['customers', 'customer_payments'], ['suppliers', 'purchases'], ['products', 'purchase_items'],
      ['purchases', 'purchase_items'], ['suppliers', 'supplier_payments'], ['roles', 'users'], ['roles', 'role_permissions'],
    ];
    for (const [parent, child] of fk) expect(RESTORE_ORDER.indexOf(parent as any)).toBeLessThan(RESTORE_ORDER.indexOf(child as any));
    expect(RESTORE_ORDER[RESTORE_ORDER.length - 1]).toBe('audit_log');
  });
  it('tokens round-trip and reject junk', () => {
    const t = { c: '42', t: 3, id: 'abc' };
    expect(decodeRestoreToken(encodeRestoreToken(t))).toEqual(t);
    expect(decodeRestoreToken('###')).toBeNull();
    expect(decodeRestoreToken(Buffer.from('{"c":"1","t":-1,"id":""}').toString('base64url'))).toBeNull();
  });
});

describe('restricted tables: users, roles, role_permissions, app_settings', () => {
  let db: FakePrisma, sync: SyncService;
  beforeEach(() => { n = 0; db = new FakePrisma(); sync = new SyncService(db as any, fakeAudit, { getActive: async () => null } as any, { get: () => undefined } as any); });
  const push = async (u: AuthUser, ...c: ChangeDto[]) => (await sync.push(u, c)).results;

  it('an administrator can synchronise a staff account; local-only lock-out state is stripped', async () => {
    const [r] = await push(acct('ADMIN'), ch('users', 'u-9', user({ failed_attempts: 4, locked_until: '2026-10-01T00:00:00Z', last_login_at: 'x' })));
    expect(r).toMatchObject({ status: 'ACCEPTED', version: 1 });
    const stored = db.records.get('biz-1|users|u-9').data;
    expect(stored).not.toHaveProperty('failed_attempts');
    expect(stored).not.toHaveProperty('locked_until');
    expect(stored).not.toHaveProperty('last_login_at');
    expect(stored.password_hash).toBe('a'.repeat(64));
  });

  it('a MANAGER / STAFF cloud login cannot push them (not remembered, so a retry after being promoted works)', async () => {
    const c = ch('users', 'u-9', user());
    const [m] = await push(acct('MANAGER'), c);
    expect(m.status).toBe('REJECTED');
    expect(m.error).toMatch(/administrator/);
    expect((await push(acct('STAFF'), ch('app_settings', 'business_name', { key: 'business_name', value: 'x' })))[0].status).toBe('REJECTED');
    expect(db.records.size).toBe(0);
    expect((await push(acct('MANAGER', ['users.manage']), c))[0].status).toBe('ACCEPTED'); // a custom permission list is honoured
  });

  it('plaintext passwords can never be stored: only a 64-hex PBKDF2 hash with salt and ≥100k iterations', async () => {
    const admin = acct('ADMIN');
    for (const bad of [{ password: 'hunter2' }, { pin: '1234' }, { plain_password: 'x' }, { new_password: 'x' }, { password_hash: 'hunter2' }, { password_hash: 'a'.repeat(63) }, { password_hash: 'z'.repeat(64) }, { password_salt: 'ab' }, { password_iterations: 1000 }, { username: ' ' }, { role_code: '' }]) {
      const [r] = await push(admin, ch('users', `u-${n}`, user(bad)));
      expect(r.status).toBe('REJECTED');
    }
    expect(db.records.size).toBe(0);
  });

  it('only shop-level settings travel; secrets and per-device state are refused', async () => {
    const admin = acct('ADMIN');
    for (const key of SHOP_SETTING_KEYS) expect((await push(admin, ch('app_settings', key, { key, value: 'v' })))[0].status).toBe('ACCEPTED');
    for (const key of ['cloud_session', 'cloud_device_token', 'entitlement', 'recovery_hash', 'recovery_salt', 'recovery_iter', 'sync_cursor', 'device_id', 'last_seen_time', 'pending_payment', 'cloud_api_url', 'whatever']) {
      const [r] = await push(admin, ch('app_settings', key, { key, value: 'secret' }));
      expect(r.status).toBe('REJECTED');
      expect(r.error).toMatch(/private to this computer/);
    }
    expect(Array.from(db.records.keys()).filter((k) => k.includes('cloud_session') || k.includes('recovery'))).toEqual([]);
  });

  it('settings values must be short text; key must match the id', async () => {
    const admin = acct('ADMIN');
    expect((await push(admin, ch('app_settings', 'branch_name', { key: 'branch_name', value: { evil: 1 } })))[0].status).toBe('REJECTED');
    expect((await push(admin, ch('app_settings', 'branch_name', { key: 'branch_name', value: 'x'.repeat(5000) })))[0].status).toBe('REJECTED');
    expect((await push(admin, ch('app_settings', 'branch_name', { key: 'business_name', value: 'x' })))[0].status).toBe('REJECTED');
    expect((await push(admin, ch('app_settings', 'branch_name', { key: 'branch_name', value: null })))[0].status).toBe('ACCEPTED');
  });

  it('roles and role permissions use stable ids; a user can be disabled/deleted without extra fields; versions conflict like any master data', async () => {
    const admin = acct('ADMIN');
    expect((await push(admin, ch('roles', 'cashier', { code: 'cashier', name: 'Cashier' })))[0].status).toBe('ACCEPTED');
    expect((await push(admin, ch('roles', 'cashier', { code: 'other', name: 'x' }, { baseVersion: 1, operation: 'UPDATE' })))[0].status).toBe('REJECTED');
    expect((await push(admin, ch('role_permissions', 'cashier|sales.create', { role_code: 'cashier', permission: 'sales.create' })))[0].status).toBe('ACCEPTED');
    expect((await push(admin, ch('role_permissions', 'wrong-id', { role_code: 'cashier', permission: 'sales.create' })))[0].status).toBe('REJECTED');
    await push(admin, ch('users', 'u-9', user()));
    expect((await push(admin, ch('role_permissions', 'cashier|sales.create', { role_code: 'cashier', permission: 'sales.create', deleted_at: '2026-10-02T00:00:00Z' }, { operation: 'DELETE', baseVersion: 1 })))[0]).toMatchObject({ status: 'ACCEPTED', version: 2 });
    expect((await push(admin, ch('users', 'u-9', { deleted_at: '2026-10-02T00:00:00Z' }, { operation: 'DELETE', baseVersion: 1 })))[0].status).toBe('ACCEPTED');
    expect((await push(admin, ch('users', 'u-9', user({ full_name: 'Late edit' }), { operation: 'UPDATE', baseVersion: 1 })))[0].status).toBe('CONFLICT'); // someone deleted it meanwhile
  });

  it('pure helpers', () => {
    expect(sanitizeRow('users', 'u1', { failed_attempts: 3, a: 1, business_id: 'x' })).toEqual({ a: 1, id: 'u1' });
    expect(sanitizeRow('products', 'p1', { failed_attempts: 3 })).toEqual({ failed_attempts: 3, id: 'p1' }); // only users are special-cased
    expect(validateRestrictedRow('products', 'p', {}, false)).toBeNull();
  });
});
