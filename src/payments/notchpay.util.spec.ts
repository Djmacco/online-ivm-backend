import { createHash, createHmac } from 'crypto';
import { mapNotchStatus, normalizeCameroonPhone, verifyNotchSignature } from './notchpay.util';

describe('Notch Pay helpers', () => {
  const key = 'hash-key-123';
  const body = Buffer.from(JSON.stringify({ event: 'payment.complete', data: { reference: 'trx.1' } }));

  it('accepts a valid HMAC-SHA256 signature', () => {
    expect(verifyNotchSignature(body, createHmac('sha256', key).update(body).digest('hex'), key)).toBe(true);
  });
  it('accepts the sha256(hashKey) variant', () => {
    expect(verifyNotchSignature(body, createHash('sha256').update(key).digest('hex'), key)).toBe(true);
  });
  it('rejects wrong / missing signatures and a wrong key', () => {
    expect(verifyNotchSignature(body, 'deadbeef', key)).toBe(false);
    expect(verifyNotchSignature(body, undefined, key)).toBe(false);
    expect(verifyNotchSignature(body, createHmac('sha256', 'other').update(body).digest('hex'), key)).toBe(false);
    expect(verifyNotchSignature(body, createHmac('sha256', key).update(body).digest('hex'), '')).toBe(false);
  });
  it('rejects a signature computed over a different body (tampering)', () => {
    const sig = createHmac('sha256', key).update(body).digest('hex');
    expect(verifyNotchSignature(Buffer.from('{"event":"payment.complete","data":{"reference":"trx.EVIL"}}'), sig, key)).toBe(false);
  });
  it('normalises Cameroon phone numbers', () => {
    expect(normalizeCameroonPhone('677 12 34 56')).toBe('+237677123456');
    expect(normalizeCameroonPhone('+237 650-123-456')).toBe('+237650123456');
    expect(normalizeCameroonPhone('00237699887766')).toBe('+237699887766');
    expect(normalizeCameroonPhone('12345')).toBeNull();
    expect(normalizeCameroonPhone('+33612345678')).toBeNull();
  });
  it('maps provider statuses', () => {
    expect(mapNotchStatus('complete')).toBe('complete');
    expect(mapNotchStatus('Processing')).toBe('pending');
    expect(mapNotchStatus('failed')).toBe('failed');
    expect(mapNotchStatus('canceled')).toBe('canceled');
    expect(mapNotchStatus('???')).toBe('unknown');
  });
});
