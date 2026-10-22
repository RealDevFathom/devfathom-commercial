import 'server-only';

import { getTierForFeature, type AITier } from '../tiers';

export const UPSELL_LABEL = 'DevFathom AI' as const;

export type UpsellProduct = {
  id: string;
  name: string;
  rxOnly: boolean;
  controlled: boolean;
  scheduled: boolean;
};

export type CoPurchaseCandidate = UpsellProduct & {
  coPurchaseCount: number;
};

export type UpsellSuggestion = {
  productId: string;
  name: string;
  message: string;
  /** Suggestions are advisory. There is deliberately no quantity or add-to-cart command. */
  advisoryOnly: true;
};

export type UpsellContext = {
  organizationId: string;
  actorId: string;
  cart: UpsellProduct[];
};

type RankedSuggestion = { productId: string; message: string };

export type UpsellDependencies = {
  /** This must use the central can() implementation; false is an explicit deny. */
  canSuggest(): Promise<boolean>;
  /** Reads the tenant's setting and verifies that its provider secret is configured server-side. */
  readAIConfiguration(organizationId: string): Promise<{
    enabled: boolean;
    providerSecretConfigured: boolean;
    model: string | null;
  }>;
  /** Server-owned co-purchase aggregation. Implementations must predicate every query by orgId. */
  readCoPurchases(organizationId: string, cartProductIds: string[]): Promise<CoPurchaseCandidate[]>;
  rankAndPhrase(input: {
    candidates: ReadonlyArray<{ productId: string; name: string; coPurchaseCount: number }>;
    tier: AITier;
  }): Promise<RankedSuggestion[]>;
  audit(entry: {
    actorId: string;
    organizationId: string;
    action: 'AI_UPSELL_SUGGEST';
    old: null;
    new: { status: 'DENIED' | 'DISABLED' | 'SUPPRESSED' | 'SUGGESTED'; productIds: string[] };
    model: string | null;
    tier: AITier;
  }): Promise<void>;
};

/**
 * Server-only checkout suggestion boundary. Product eligibility and co-purchase evidence are
 * decided before the AI sees anything; the model may only order and phrase eligible products.
 */
export async function suggestUpsells(
  context: UpsellContext,
  dependencies: UpsellDependencies
): Promise<UpsellSuggestion[]> {
  if (!context.organizationId || !context.actorId)
    throw new Error('Tenant and actor are required.');

  const tier = getTierForFeature('growth'); // Growth/checkout recommendations require standard.
  let status: 'DENIED' | 'DISABLED' | 'SUPPRESSED' | 'SUGGESTED' = 'DENIED';
  let model: string | null = null;
  let productIds: string[] = [];

  try {
    if (!(await dependencies.canSuggest())) return [];

    const configuration = await dependencies.readAIConfiguration(context.organizationId);
    model = configuration.model;
    if (!configuration.enabled || !configuration.providerSecretConfigured || !model) {
      status = 'DISABLED';
      return [];
    }

    // Do not even read co-purchase data for a controlled cart. Besides blocking an unsafe
    // suggestion, this keeps controlled-product/contraindication context out of the AI request.
    if (context.cart.some((item) => item.controlled)) {
      status = 'SUPPRESSED';
      return [];
    }

    const cartIds = new Set(context.cart.map((item) => item.id));
    const rows = await dependencies.readCoPurchases(context.organizationId, [...cartIds]);
    const eligible = rows
      .filter(
        (item) =>
          !cartIds.has(item.id) &&
          !item.rxOnly &&
          !item.controlled &&
          !item.scheduled &&
          Number.isSafeInteger(item.coPurchaseCount) &&
          item.coPurchaseCount > 0
      )
      .sort((a, b) => b.coPurchaseCount - a.coPurchaseCount || a.id.localeCompare(b.id));
    if (eligible.length === 0) {
      status = 'SUPPRESSED';
      return [];
    }

    const byId = new Map(eligible.map((item) => [item.id, item]));
    const ranked = await dependencies.rankAndPhrase({
      tier,
      candidates: eligible.map(({ id, name, coPurchaseCount }) => ({
        productId: id,
        name,
        coPurchaseCount,
      })),
    });
    const seen = new Set<string>();
    const suggestions = ranked.flatMap((item) => {
      const source = byId.get(item.productId);
      const message = item.message.trim();
      if (!source || seen.has(item.productId) || !message) return [];
      seen.add(item.productId);
      return [{ productId: source.id, name: source.name, message, advisoryOnly: true as const }];
    });
    productIds = suggestions.map((item) => item.productId);
    status = suggestions.length ? 'SUGGESTED' : 'SUPPRESSED';
    return suggestions;
  } finally {
    await dependencies.audit({
      actorId: context.actorId,
      organizationId: context.organizationId,
      action: 'AI_UPSELL_SUGGEST',
      old: null,
      new: { status, productIds },
      model,
      tier,
    });
  }
}
