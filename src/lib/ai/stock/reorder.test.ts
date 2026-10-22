import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveReordersToDraft,
  calculateReorderSuggestion,
  REORDER_AI_LABEL,
  REORDER_AI_TIER,
  ReorderSuggestionError,
  suggestReorders,
  type ReorderDependencies,
  type ReorderItemInput,
} from './reorder';

const item: ReorderItemInput = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  stockItemId: 'rice',
  stockItemName: 'Rice',
  demandUnits: 70,
  lookbackDays: 14,
  onHandUnits: 12,
  onOrderUnits: 3,
  leadTimeDays: 2,
  safetyStockDays: 1,
  reviewPeriodDays: 4,
  orderMultiple: 5,
  supplier: { id: 'supplier-a', name: 'Local Foods', lastUnitCost: 2.5 },
};

function fixture() {
  const deps: ReorderDependencies = {
    can: vi.fn(async () => true),
    hasAIProviderSecret: vi.fn(async () => true),
    loadItems: vi.fn(async () => [item]),
    createDraftPurchaseOrders: vi.fn(async () => [{ id: 'po-1', status: 'DRAFT' as const }]),
    audit: vi.fn(async () => undefined),
    model: 'standard-model',
  };
  return deps;
}

beforeEach(() => vi.restoreAllMocks());

describe('velocity reorder maths', () => {
  it('calculates lead-time plus safety stock and rounds quantity to the order multiple', () => {
    expect(calculateReorderSuggestion(item)).toEqual({
      organizationId: 'org-a',
      branchId: 'branch-a',
      stockItemId: 'rice',
      stockItemName: 'Rice',
      dailyVelocity: 5,
      reorderPoint: 15,
      suggestedQuantity: 20,
      supplierHint: { id: 'supplier-a', name: 'Local Foods', lastUnitCost: 2.5 },
    });
  });

  it('subtracts on-order stock and never suggests a negative quantity', () => {
    expect(
      calculateReorderSuggestion({ ...item, onHandUnits: 30, onOrderUnits: 10 }).suggestedQuantity
    ).toBe(0);
    expect(() => calculateReorderSuggestion({ ...item, lookbackDays: 0 })).toThrow('positive');
  });
});

describe('secure reorder workflow', () => {
  it('scopes every read and audit to the actor organization', async () => {
    const deps = fixture();
    const result = await suggestReorders(
      deps,
      { userId: 'owner-a', organizationId: 'org-a' },
      'branch-a'
    );
    expect(deps.loadItems).toHaveBeenCalledWith({ organizationId: 'org-a', branchId: 'branch-a' });
    expect(result).toHaveLength(1);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'owner-a',
        organizationId: 'org-a',
        action: 'ai.reorder.suggest',
        ai: { label: REORDER_AI_LABEL, model: 'standard-model', tier: REORDER_AI_TIER },
      })
    );
  });

  it('fails closed if a repository returns another tenant row', async () => {
    const deps = fixture();
    vi.mocked(deps.loadItems).mockResolvedValue([{ ...item, organizationId: 'org-b' }]);
    await expect(
      suggestReorders(deps, { userId: 'owner-a', organizationId: 'org-a' }, 'branch-a')
    ).rejects.toEqual(expect.objectContaining({ code: 'TENANT_SCOPE' }));
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('is off without the organization provider secret and honors an explicit deny', async () => {
    const deps = fixture();
    vi.mocked(deps.hasAIProviderSecret).mockResolvedValue(false);
    await expect(
      suggestReorders(deps, { userId: 'owner-a', organizationId: 'org-a' }, 'branch-a')
    ).rejects.toEqual(expect.objectContaining({ code: 'AI_DISABLED' }));
    expect(deps.loadItems).not.toHaveBeenCalled();

    vi.mocked(deps.can).mockResolvedValue(false);
    await expect(
      suggestReorders(deps, { userId: 'owner-a', organizationId: 'org-a' }, 'branch-a')
    ).rejects.toBeInstanceOf(ReorderSuggestionError);
  });

  it('creates only draft POs after owner approval and audits approval and draft', async () => {
    const deps = fixture();
    const suggestion = calculateReorderSuggestion(item);
    await expect(
      approveReordersToDraft(
        deps,
        { userId: 'owner-a', organizationId: 'org-a' },
        'branch-a',
        [suggestion],
        false
      )
    ).rejects.toEqual(expect.objectContaining({ code: 'DENIED' }));
    expect(deps.createDraftPurchaseOrders).not.toHaveBeenCalled();

    await expect(
      approveReordersToDraft(
        deps,
        { userId: 'owner-a', organizationId: 'org-a' },
        'branch-a',
        [suggestion],
        true
      )
    ).resolves.toEqual([{ id: 'po-1', status: 'DRAFT' }]);
    expect(deps.createDraftPurchaseOrders).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' })
    );
    expect(vi.mocked(deps.audit).mock.calls.map(([entry]) => entry.action)).toEqual([
      'ai.reorder.approve',
      'ai.reorder.draft-po',
    ]);
  });
});
