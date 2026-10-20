/** Fail fast on missing configuration instead of failing at the first request. */
const ALWAYS = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const PROD_ONLY = [
  'DIRECT_URL', 'ENTITLEMENT_PRIVATE_KEY',
  'NOTCHPAY_PUBLIC_KEY', 'NOTCHPAY_SECRET_KEY', 'NOTCHPAY_HASH_KEY', 'PUBLIC_API_URL',
];

export function validateEnv(config: Record<string, unknown>) {
  const prod = config.NODE_ENV === 'production';
  const missing = [...ALWAYS, ...(prod ? PROD_ONLY : [])].filter((k) => !config[k] || String(config[k]).startsWith('replace'));
  if (missing.length) throw new Error(`Missing/placeholder environment variables: ${missing.join(', ')}`);
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if (String(config[k]).length < 32) throw new Error(`${k} must be at least 32 characters`);
  }
  if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  if (config.ENTITLEMENT_PRIVATE_KEY && !/^[0-9a-fA-F]{64}$/.test(String(config.ENTITLEMENT_PRIVATE_KEY))) {
    throw new Error('ENTITLEMENT_PRIVATE_KEY must be 64 hex characters – generate one with `npm run keys:generate`');
  }
  const provider = String(config.AI_PROVIDER ?? 'gemini').toLowerCase();
  if (!['gemini', 'anthropic'].includes(provider)) throw new Error('AI_PROVIDER must be "gemini" or "anthropic"');
  if (config.AI_THINKING_BUDGET !== undefined && config.AI_THINKING_BUDGET !== '' && Number.isNaN(Number(config.AI_THINKING_BUDGET))) {
    throw new Error('AI_THINKING_BUDGET must be a number (0 disables thinking)');
  }
  return config;
}
