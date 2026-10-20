import { createHash, createHmac, timingSafeEqual } from 'crypto';

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a.trim().toLowerCase(), 'utf8');
  const bb = Buffer.from(b.trim().toLowerCase(), 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Notch Pay documents the `x-notch-signature` header in two ways (HMAC-SHA256 of the payload keyed with the
 * webhook hash key, and sha256(hashKey)). We accept either, in constant time. This is only a cheap
 * pre-filter: the payment is ALWAYS re-verified server-to-server before any subscription is granted,
 * so a forged webhook can never activate Premium.
 */
export function verifyNotchSignature(rawBody: Buffer | string, header: string | undefined, hashKey: string): boolean {
  if (!header || !hashKey) return false;
  const hmac = createHmac('sha256', hashKey).update(rawBody).digest('hex');
  const plain = createHash('sha256').update(hashKey).digest('hex');
  return safeEqualHex(header, hmac) || safeEqualHex(header, plain);
}

/** Normalise Cameroonian mobile numbers to +2376XXXXXXXX. Returns null if invalid. */
export function normalizeCameroonPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
  const national = digits.startsWith('237') ? digits.slice(3) : digits;
  return /^6\d{8}$/.test(national) ? `+237${national}` : null;
}

export type NotchStatus = 'complete' | 'pending' | 'failed' | 'canceled' | 'unknown';
export function mapNotchStatus(s: unknown): NotchStatus {
  const v = String(s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'success') return 'complete';
  if (['failed', 'rejected', 'expired'].includes(v)) return 'failed';
  if (['canceled', 'cancelled'].includes(v)) return 'canceled';
  if (['pending', 'processing', 'initialized', 'sent'].includes(v)) return 'pending';
  return 'unknown';
}
