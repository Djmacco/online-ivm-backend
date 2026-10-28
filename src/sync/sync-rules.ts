/**
 * Pure server-side rules for the sync API (contract: docs/BACKEND_CONTRACT.md in the desktop repo + docs/RESTORE_CONTRACT.md).
 * The server is a VERSIONED STORE: it detects conflicts (baseVersion != current) and returns its copy;
 * the desktop resolves them (src/sync/conflict.ts). The server additionally protects the financial ledger,
 * keeps secrets out of the cloud, and only shows access-control data to administrators.
 */
export type Json = Record<string, any>;

/** Tables the desktop synchronises. */
export const SYNC_TABLES = [
  'categories', 'suppliers', 'customers', 'products', 'product_batches', 'stock_movements',
  'cash_sessions', 'sales', 'sale_items', 'customer_payments', 'purchases', 'purchase_items',
  'supplier_payments', 'expenses', 'audit_log',
  'stock_counts', 'stock_count_items', 'documents', 'document_items', 'shop_transfers', 'shop_transfer_items',
  // access control + shop settings (administrators only, see RESTRICTED_TABLES)
  'roles', 'role_permissions', 'users', 'app_settings',
] as const;
const TABLE_SET = new Set<string>(SYNC_TABLES);
export const isSyncTable = (t: string) => TABLE_SET.has(t);

/**
 * Order in which a RESTORE sends tables: parents before children. The desktop checks foreign keys at the end of every
 * page, so a page of sale_items must never arrive before the sales (and products) it points to.
 * audit_log goes last: it is the biggest table and nothing depends on it.
 */
export const RESTORE_ORDER = [
  'roles', 'role_permissions', 'users',
  'categories', 'suppliers', 'customers', 'cash_sessions', 'expenses', 'app_settings',
  'products', 'product_batches', 'stock_movements',
  'sales', 'sale_items', 'customer_payments',
  'purchases', 'purchase_items', 'supplier_payments',
  'stock_counts', 'stock_count_items', 'documents', 'document_items', 'shop_transfers', 'shop_transfer_items',
  'audit_log',
] as const;

/** Same id = same record. Replays are DUPLICATE, never CONFLICT, and they can never be modified. */
export const IMMUTABLE_TABLES = new Set(['stock_movements', 'sale_items', 'customer_payments', 'supplier_payments', 'purchase_items', 'audit_log', 'document_items', 'shop_transfers', 'shop_transfer_items']);

/**
 * Staff accounts (with their password HASHES), roles and shop settings are only pushed, stored or sent to accounts that hold
 * the matching permission (ADMIN). A MANAGER's cloud login never receives other people's password hashes.
 */
export const RESTRICTED_TABLES: Record<string, string> = {
  users: 'users.manage', roles: 'users.manage', role_permissions: 'users.manage', app_settings: 'settings.manage',
};
export const canSeeTable = (granted: readonly string[], table: string): boolean => !RESTRICTED_TABLES[table] || granted.includes(RESTRICTED_TABLES[table]);
export const hiddenTables = (granted: readonly string[]): string[] => Object.keys(RESTRICTED_TABLES).filter((t) => !canSeeTable(granted, t));

/**
 * Shop-level settings that may travel to the cloud. An ALLOW-list on purpose: app_settings also holds secrets and per-device state
 * (cloud_session, entitlement, cloud_device_token, recovery_hash/salt, sync_cursor, device_id, last_seen_time…) that must never leave the PC.
 * Add a key here only when it is a business-wide setting.
 */
export const SHOP_SETTING_KEYS = [
  'business_name', 'branch_name', 'expiry_alert_days', 'max_discount_percent', 'payment_methods', 'default_minimum_stock',
  'business_tax_id', 'tax_rate', 'invoice_prefix', 'proforma_prefix', 'proforma_valid_days', 'invoice_notes',
] as const;
const SETTING_SET = new Set<string>(SHOP_SETTING_KEYS);

export const MAX_ROW_BYTES = 256 * 1024;
/** Owned by the server / local bookkeeping – never trusted from the client. */
const STRIPPED = ['businessId', 'business_id', 'version', 'sync_status'];
/** Local-only state: syncing a lock-out counter would lock a cashier out on every PC. */
const STRIPPED_BY_TABLE: Record<string, string[]> = { users: ['failed_attempts', 'locked_until', 'last_login_at'] };

/** The financial figures of a sale are final once recorded. Only status → CANCELLED (+ cost/notes bookkeeping) may change. */
export const SALE_FINAL_FIELDS = ['receipt_no', 'customer_id', 'subtotal', 'discount_total', 'total', 'amount_paid', 'change_due', 'payment_method', 'sold_at'];

export function sanitizeRow(entityType: string, entityId: string, data: Json): Json {
  const out: Json = { ...data };
  for (const k of STRIPPED) delete out[k];
  for (const k of STRIPPED_BY_TABLE[entityType] ?? []) delete out[k];
  out.id = entityId;
  return out;
}

export function isDeleted(operation: string, data: Json): boolean {
  return operation === 'DELETE' || !!data.deleted_at;
}

/** Returns an error message when the update would rewrite a recorded sale, otherwise null. */
export function checkSaleUpdate(current: Json, incoming: Json): string | null {
  for (const f of SALE_FINAL_FIELDS) {
    if (f in incoming && incoming[f] !== current[f] && !(incoming[f] == null && current[f] == null)) {
      return `Completed sales are immutable (field "${f}" cannot change). Cancel the sale instead.`;
    }
  }
  if (current.status === 'CANCELLED' && incoming.status && incoming.status !== 'CANCELLED') return 'A cancelled sale cannot be reopened.';
  if (incoming.status && incoming.status !== current.status && incoming.status !== 'CANCELLED') return 'A completed sale can only be cancelled.';
  return null;
}

export function validRow(data: unknown): data is Json {
  return !!data && typeof data === 'object' && !Array.isArray(data);
}

const PLAINTEXT_KEYS = ['password', 'plain_password', 'new_password', 'pin', 'secret', 'token'];
const HEX = /^[0-9a-f]+$/i;

/** Extra validation for the restricted tables. Returns an error message, or null when the row is acceptable. Deletions skip it. */
export function validateRestrictedRow(entityType: string, entityId: string, d: Json, deleting: boolean): string | null {
  if (!RESTRICTED_TABLES[entityType]) return null;
  if (entityType === 'app_settings') {
    if (!SETTING_SET.has(entityId)) return `Setting "${entityId}" is not synchronised (it is private to this computer).`;
    if (d.key !== undefined && d.key !== entityId) return 'data.key must equal entityId.';
    if (deleting) return null;
    if (d.value != null && (typeof d.value !== 'string' || d.value.length > 4000)) return 'A setting value must be text of at most 4000 characters.';
    return null;
  }
  if (deleting) return null;
  if (entityType === 'users') {
    const leaked = PLAINTEXT_KEYS.find((k) => k in d);
    if (leaked) return `A user row must never contain "${leaked}": only the salted password hash may be synchronised.`;
    if (typeof d.username !== 'string' || !d.username.trim()) return 'A user needs a username.';
    if (typeof d.role_code !== 'string' || !d.role_code) return 'A user needs a role_code.';
    if (typeof d.password_hash !== 'string' || d.password_hash.length !== 64 || !HEX.test(d.password_hash)) return 'password_hash must be a 64-character hex PBKDF2 hash.';
    if (typeof d.password_salt !== 'string' || d.password_salt.length < 16 || !HEX.test(d.password_salt)) return 'password_salt must be hex.';
    if (!Number.isInteger(d.password_iterations) || d.password_iterations < 100_000) return 'password_iterations must be at least 100000.';
    return null;
  }
  if (entityType === 'roles') {
    if (typeof d.code !== 'string' || !d.code) return 'A role needs a code.';
    if (d.code !== entityId) return 'entityId must equal the role code.';
    return null;
  }
  if (entityType === 'role_permissions') {
    if (typeof d.role_code !== 'string' || typeof d.permission !== 'string' || !d.role_code || !d.permission) return 'A role permission needs role_code and permission.';
    if (entityId !== `${d.role_code}|${d.permission}`) return 'entityId must be "<role_code>|<permission>".';
    return null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ restore paging token
export interface RestoreCursor { c: string; t: number; id: string }

export function encodeRestoreToken(s: RestoreCursor): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
}
/** Returns null for anything that is not a well-formed token (the controller answers 400). */
export function decodeRestoreToken(token: string): RestoreCursor | null {
  try {
    const s = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof s?.c !== 'string' || !/^\d{1,18}$/.test(s.c)) return null;
    if (!Number.isInteger(s.t) || s.t < 0 || s.t > RESTORE_ORDER.length) return null;
    if (typeof s.id !== 'string' || s.id.length > 200) return null;
    return { c: s.c, t: s.t, id: s.id };
  } catch { return null; }
}
