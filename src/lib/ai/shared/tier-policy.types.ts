/**
 * Narrow integration seam for the tier-policy work developed on a parallel branch.
 * Consumers must not infer a provider model from a tier themselves.
 */
export type AIWorkload = 'daily-tip' | 'owner-report';
export type AIServiceTier = 'standard' | 'owner-report';

export type TierPolicySelection = {
  tier: AIServiceTier;
  provider: 'anthropic' | 'bedrock';
  model: string;
};

export interface TierPolicyPort {
  select(input: { workload: AIWorkload; organizationId: string }): Promise<TierPolicySelection>;
}
