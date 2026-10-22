export type UpsellSuggestion = {
  menuItemId: string;
  name: string;
  reason: string;
};

export type UpsellSuggestionResult = {
  suggestion: UpsellSuggestion | null;
  model: string;
  tier: 'standard' | 'deep';
};

export type UpsellSuggestionContext = {
  organizationId: string;
  branchId: string;
  orderId: string;
};

/** Boundary owned by the upsell engine. The parallel UI lane deliberately ships inert. */
export interface UpsellEnginePort {
  suggest(context: UpsellSuggestionContext): Promise<UpsellSuggestionResult>;
}

export const emptyUpsellEngine: UpsellEnginePort = {
  async suggest() {
    return { suggestion: null, model: 'not-configured', tier: 'standard' };
  },
};
