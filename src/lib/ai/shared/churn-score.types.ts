export type ChurnRisk = 'HIGH' | 'MEDIUM' | 'LOW';

export type ChurnRiskCustomer = {
  customerId: string;
  displayName: string;
  risk: ChurnRisk;
  score: number;
  reason: string;
  lastActivityAt: string | null;
};

/** Boundary owned by the churn-score feature. Every method is explicitly tenant scoped. */
export interface ChurnScorePort {
  isAIConfigured(organizationId: string): Promise<boolean>;
  listChurnRisks(input: { organizationId: string; limit: number }): Promise<ChurnRiskCustomer[]>;
}

/** Safe default while the scoring implementation is developed on its parent branch. */
export const unavailableChurnScorePort: ChurnScorePort = {
  async isAIConfigured() {
    return false;
  },
  async listChurnRisks() {
    return [];
  },
};
