/** Premium features. The plan contains exactly these two – nothing else is gated. */
export const Feature = {
  CLOUD_SYNC: 'CLOUD_SYNC',
  AI_STORE_SCAN: 'AI_STORE_SCAN',
} as const;
export type FeatureName = (typeof Feature)[keyof typeof Feature];
export const PREMIUM_FEATURES: readonly FeatureName[] = [Feature.CLOUD_SYNC, Feature.AI_STORE_SCAN];
