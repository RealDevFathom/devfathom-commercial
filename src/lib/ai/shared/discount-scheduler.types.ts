export type DiscountDraftStatus = 'SCHEDULED' | 'APPROVED' | 'ACTIVE' | 'REJECTED';

export interface ScheduledDiscountDraft {
  id: string;
  orgId: string;
  name: string;
  percentage: number;
  startsAt: Date;
  endsAt: Date;
  status: DiscountDraftStatus;
  model: string;
  tier: 'standard' | 'deep';
}

export type DiscountDraftPatch = Partial<
  Pick<ScheduledDiscountDraft, 'name' | 'percentage' | 'startsAt' | 'endsAt'>
>;

/** Tenant-scoped seam implemented by the discount scheduler feature. */
export interface DiscountSchedulerPort {
  /** Must default false for an org which has not explicitly enabled configured AI. */
  isAIEnabled(orgId: string): Promise<boolean>;
  listDrafts(orgId: string): Promise<ScheduledDiscountDraft[]>;
  getDraft(orgId: string, id: string): Promise<ScheduledDiscountDraft | null>;
  updateDraft(
    orgId: string,
    id: string,
    patch: DiscountDraftPatch
  ): Promise<ScheduledDiscountDraft>;
  transitionDraft(
    orgId: string,
    id: string,
    status: Extract<DiscountDraftStatus, 'APPROVED' | 'ACTIVE' | 'REJECTED'>,
    at: Date
  ): Promise<ScheduledDiscountDraft>;
}

export const unconfiguredDiscountScheduler: DiscountSchedulerPort = {
  async isAIEnabled() {
    return false;
  },
  async listDrafts() {
    return [];
  },
  async getDraft() {
    return null;
  },
  async updateDraft() {
    throw new Error('Discount scheduler is not configured.');
  },
  async transitionDraft() {
    throw new Error('Discount scheduler is not configured.');
  },
};
