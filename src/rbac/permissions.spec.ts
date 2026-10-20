import { effectivePermissions, hasAll, ROLE_DEFAULTS } from './permissions';

describe('RBAC', () => {
  it('ADMIN has everything and cannot be restricted by a custom list', () => {
    expect(effectivePermissions('ADMIN', ['products.read'])).toContain('users.manage');
  });
  it('MANAGER manages the business but not system configuration', () => {
    const p = ROLE_DEFAULTS.MANAGER;
    expect(p).toContain('products.delete');
    expect(p).toContain('reports.read');
    expect(p).not.toContain('users.manage');
    expect(p).not.toContain('settings.manage');
  });
  it('STAFF is a cashier', () => {
    const p = ROLE_DEFAULTS.STAFF;
    expect(p).toContain('sales.create');
    expect(p).not.toContain('products.delete');
    expect(p).not.toContain('sales.cancel');
    expect(p).not.toContain('reports.read');
  });
  it('custom permissions override role defaults and unknown ones are dropped', () => {
    const p = effectivePermissions('STAFF', ['reports.read', 'made.up']);
    expect(p).toEqual(['reports.read']);
    expect(hasAll(p, ['reports.read'])).toBe(true);
  });
});
