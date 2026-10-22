import 'server-only';

import { getTierForFeature, type AITier } from '../tiers';

export const REORDER_AI_LABEL = 'DevFathom AI' as const;
export const REORDER_AI_TIER: AITier = getTierForFeature('stock-reorder');

export type ReorderItemInput = {
  organizationId: string;
  branchId: string;
  stockItemId: string;
  stockItemName: string;
  demandUnits: number;
  lookbackDays: number;
  onHandUnits: number;
  onOrderUnits: number;
  leadTimeDays: number;
  safetyStockDays: number;
  reviewPeriodDays: number;
  orderMultiple?: number;
  supplier?: { id: string; name: string; lastUnitCost?: number } | null;
};

export type ReorderSuggestion = {
  organizationId: string;
  branchId: string;
  stockItemId: string;
  stockItemName: string;
  dailyVelocity: number;
  reorderPoint: number;
  suggestedQuantity: number;
  supplierHint: { id: string; name: string; lastUnitCost?: number } | null;
};

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Deterministic inventory maths. Inputs must already be scoped to one org and branch. */
export function calculateReorderSuggestion(input: ReorderItemInput): ReorderSuggestion {
  const values = [
    input.demandUnits,
    input.lookbackDays,
    input.onHandUnits,
    input.onOrderUnits,
    input.leadTimeDays,
    input.safetyStockDays,
    input.reviewPeriodDays,
    input.orderMultiple ?? 1,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Reorder inputs must be finite, non-negative numbers.');
  if (input.lookbackDays <= 0 || (input.orderMultiple ?? 1) <= 0)
    throw new Error('Lookback days and order multiple must be positive.');

  const dailyVelocity = input.demandUnits / input.lookbackDays;
  const reorderPoint = dailyVelocity * (input.leadTimeDays + input.safetyStockDays);
  const target =
    dailyVelocity * (input.leadTimeDays + input.safetyStockDays + input.reviewPeriodDays);
  const shortage = Math.max(0, target - input.onHandUnits - input.onOrderUnits);
  const multiple = input.orderMultiple ?? 1;
  const suggestedQuantity = shortage === 0 ? 0 : Math.ceil(shortage / multiple) * multiple;

  return {
    organizationId: input.organizationId,
    branchId: input.branchId,
    stockItemId: input.stockItemId,
    stockItemName: input.stockItemName,
    dailyVelocity: round6(dailyVelocity),
    reorderPoint: round6(reorderPoint),
    suggestedQuantity: round6(suggestedQuantity),
    supplierHint: input.supplier ?? null,
  };
}

export type ReorderActor = { userId: string; organizationId: string };
export type ReorderAudit = {
  actorId: string;
  organizationId: string;
  action: 'ai.reorder.suggest' | 'ai.reorder.approve' | 'ai.reorder.draft-po';
  oldValue: unknown;
  newValue: unknown;
  ai: { label: typeof REORDER_AI_LABEL; model: string; tier: AITier };
};

export interface ReorderDependencies {
  can(action: 'inventory:read' | 'restaurant:configure'): Promise<boolean>;
  /** Must read the organization's encrypted provider-secret configuration server-side. */
  hasAIProviderSecret(organizationId: string): Promise<boolean>;
  loadItems(scope: { organizationId: string; branchId: string }): Promise<ReorderItemInput[]>;
  createDraftPurchaseOrders(input: {
    organizationId: string;
    branchId: string;
    actorId: string;
    suggestions: ReorderSuggestion[];
  }): Promise<Array<{ id: string; status: string }>>;
  audit(entry: ReorderAudit): Promise<void>;
  model: string;
}

export class ReorderSuggestionError extends Error {
  constructor(readonly code: 'DENIED' | 'AI_DISABLED' | 'TENANT_SCOPE' | 'INVALID') {
    super(code);
  }
}

function assertScope(
  rows: Array<{ organizationId: string; branchId: string }>,
  organizationId: string,
  branchId: string
) {
  if (rows.some((row) => row.organizationId !== organizationId || row.branchId !== branchId))
    throw new ReorderSuggestionError('TENANT_SCOPE');
}

/** Reads suggestions only; it never creates or mutates inventory or purchase orders. */
export async function suggestReorders(
  deps: ReorderDependencies,
  actor: ReorderActor,
  branchId: string
): Promise<ReorderSuggestion[]> {
  if (!(await deps.can('inventory:read'))) throw new ReorderSuggestionError('DENIED');
  if (!(await deps.hasAIProviderSecret(actor.organizationId)))
    throw new ReorderSuggestionError('AI_DISABLED');

  const items = await deps.loadItems({ organizationId: actor.organizationId, branchId });
  assertScope(items, actor.organizationId, branchId);
  const suggestions = items
    .map(calculateReorderSuggestion)
    .filter((item) => item.suggestedQuantity > 0);
  await deps.audit({
    actorId: actor.userId,
    organizationId: actor.organizationId,
    action: 'ai.reorder.suggest',
    oldValue: null,
    newValue: { branchId, suggestions },
    ai: { label: REORDER_AI_LABEL, model: deps.model, tier: REORDER_AI_TIER },
  });
  return suggestions;
}

/** Owner-approved boundary: the strongest possible result is a DRAFT PO. */
export async function approveReordersToDraft(
  deps: ReorderDependencies,
  actor: ReorderActor,
  branchId: string,
  suggestions: ReorderSuggestion[],
  ownerApproved: boolean
) {
  if (!ownerApproved || !(await deps.can('restaurant:configure')))
    throw new ReorderSuggestionError('DENIED');
  if (!(await deps.hasAIProviderSecret(actor.organizationId)))
    throw new ReorderSuggestionError('AI_DISABLED');
  assertScope(suggestions, actor.organizationId, branchId);

  await deps.audit({
    actorId: actor.userId,
    organizationId: actor.organizationId,
    action: 'ai.reorder.approve',
    oldValue: { ownerApproved: false },
    newValue: { ownerApproved: true, branchId, suggestions },
    ai: { label: REORDER_AI_LABEL, model: deps.model, tier: REORDER_AI_TIER },
  });
  const drafts = await deps.createDraftPurchaseOrders({
    organizationId: actor.organizationId,
    branchId,
    actorId: actor.userId,
    suggestions,
  });
  if (drafts.some((draft) => draft.status !== 'DRAFT')) throw new ReorderSuggestionError('INVALID');
  await deps.audit({
    actorId: actor.userId,
    organizationId: actor.organizationId,
    action: 'ai.reorder.draft-po',
    oldValue: null,
    newValue: { branchId, drafts },
    ai: { label: REORDER_AI_LABEL, model: deps.model, tier: REORDER_AI_TIER },
  });
  return drafts;
}
