export type AITier = 'cheap' | 'standard' | 'deep';

/** Stable feature identifiers shared by current and planned AI entry points. */
export type AIFeature =
  | 'growth'
  | 'growth-recommendations'
  | 'restaurant-growth'
  | 'pharmacy-marketing-assistance'
  | 'whatsapp'
  | 'retention'
  | 'analytics'
  | 'periodic-owner-reports'
  /** The weekly owner summary: always the deep model, Anthropic only, never failed over. */
  | 'weekly-owner-summary'
  | 'ask-fathom'
  | 'pharmacy.marketing-assistance'
  | 'pharmacy-rx-ocr'
  | 'pharmacy-pack-ocr'
  | 'pharmacy-invoice-ocr'
  | 'restaurant-menu-vision';

const FEATURE_TIERS: Readonly<Partial<Record<AIFeature, AITier>>> = {
  growth: 'standard',
  'growth-recommendations': 'standard',
  'restaurant-growth': 'standard',
  'pharmacy-marketing-assistance': 'standard',
  'pharmacy.marketing-assistance': 'standard',
  'ask-fathom': 'standard',
  'pharmacy-rx-ocr': 'standard',
  'pharmacy-pack-ocr': 'standard',
  'pharmacy-invoice-ocr': 'standard',
  'restaurant-menu-vision': 'standard',
  whatsapp: 'standard',
  retention: 'standard',
  analytics: 'standard',
  'periodic-owner-reports': 'deep',
  'weekly-owner-summary': 'deep',
};

/** Unknown and newly introduced features deliberately start on the lowest-cost tier. */
export function getTierForFeature(feature: string): AITier {
  return FEATURE_TIERS[feature as AIFeature] ?? 'cheap';
}

export { FEATURE_TIERS };
