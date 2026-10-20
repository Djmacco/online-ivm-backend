/**
 * Pure RBAC definitions (no framework / DB imports so they are trivially testable
 * and can be copied verbatim into the desktop app for UX-level checks).
 */
export const PERMISSIONS = [
  'products.read', 'products.create', 'products.update', 'products.delete',
  'categories.read', 'categories.create', 'categories.update', 'categories.delete',
  'inventory.read', 'inventory.adjust',
  'sales.read', 'sales.create', 'sales.cancel',
  'purchases.read', 'purchases.create',
  'customers.read', 'customers.create', 'customers.update', 'customers.delete',
  'suppliers.read', 'suppliers.create', 'suppliers.update', 'suppliers.delete',
  'expenses.read', 'expenses.create',
  'reports.read',
  'users.manage',
  'settings.manage',
  'sync.manage',
  'subscription.read', 'subscription.manage',
  'audit.read',
  'ai.use', 'ai.store_scan',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleName = 'ADMIN' | 'MANAGER' | 'STAFF';

const MANAGER_EXCLUDED: Permission[] = ['users.manage', 'settings.manage', 'sync.manage', 'subscription.manage', 'audit.read'];

export const ROLE_DEFAULTS: Record<RoleName, readonly Permission[]> = {
  /** Full access. */
  ADMIN: PERMISSIONS,
  /** Business management; no critical system configuration. */
  MANAGER: PERMISSIONS.filter((p) => !MANAGER_EXCLUDED.includes(p)),
  /** Cashier / limited operations. */
  STAFF: [
    'products.read', 'categories.read', 'inventory.read',
    'sales.read', 'sales.create',
    'customers.read', 'customers.create', 'customers.update',
    'suppliers.read',
    'subscription.read',
    'ai.use',
  ],
};

/** Explicit permissions override the role defaults; ADMIN can never be restricted. */
export function effectivePermissions(role: RoleName, custom: readonly string[] | null | undefined): string[] {
  if (role === 'ADMIN') return [...PERMISSIONS];
  if (custom && custom.length > 0) return custom.filter((p) => (PERMISSIONS as readonly string[]).includes(p));
  return [...ROLE_DEFAULTS[role]];
}

export function hasAll(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((p) => granted.includes(p));
}

export function hasAny(granted: readonly string[], anyOf: readonly string[]): boolean {
  return anyOf.some((p) => granted.includes(p));
}

export function isValidPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}
