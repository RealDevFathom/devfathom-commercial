import 'server-only';

import { getTierForFeature, type AITier } from '../tiers';
import type { StockBatchReadPort, StockBatchSnapshot } from '../shared/reorder-suggest.types';

export const EXPIRY_MARKDOWN_LABEL = 'DevFathom AI' as const;
export const EXPIRY_MARKDOWN_TIER = getTierForFeature('expiry-markdown');

export type ExpiryMarkdownSuggestion = {
  batchId: string;
  expiresAt: Date;
  quantity: number;
  projectedSalesBeforeExpiry: number;
  atRiskUnits: number;
  currentPriceMinor: number;
  suggestedPriceMinor: number;
  markdownPercent: number;
  requiresOwnerApproval: true;
};

export type ExpiryMarkdownAudit = {
  actorId: string;
  orgId: string;
  event: 'AI_ACTION' | 'AI_DRAFT' | 'AI_APPROVAL' | 'AI_SEND';
  batchId?: string;
  oldValue: unknown;
  newValue: unknown;
  model: string;
  tier: AITier;
};

export interface ExpiryMarkdownPort extends StockBatchReadPort {
  /** This server-side check must verify the org has enabled AI and configured its provider secret. */
  getAIConfiguration(orgId: string): Promise<{ enabled: boolean; model: string | null }>;
  /** Delegates to the central can(); false (including an explicit DENY) always wins. */
  can(input: {
    actorId: string;
    orgId: string;
    action: 'stock:expiry-risk' | 'stock:markdown-approve' | 'stock:markdown-send';
    batchId?: string;
  }): Promise<boolean>;
  audit(entry: ExpiryMarkdownAudit): Promise<void>;
  saveDraft(orgId: string, suggestion: ExpiryMarkdownSuggestion): Promise<void>;
  /** Must update with both org_id and batch id predicates. */
  applyPrice(orgId: string, batchId: string, priceMinor: number): Promise<void>;
  sendAlert?(orgId: string, suggestion: ExpiryMarkdownSuggestion): Promise<void>;
}

export class ExpiryMarkdownUnavailableError extends Error {}
export class ExpiryMarkdownForbiddenError extends Error {}

function assertMoney(batch: StockBatchSnapshot): void {
  for (const value of [batch.costMinor, batch.priceMinor, batch.mrpMinor]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid batch money value.');
  }
}

function suggestionFor(
  batch: StockBatchSnapshot,
  now: Date,
  allowBelowCost: boolean
): ExpiryMarkdownSuggestion | null {
  if (batch.status !== 'AVAILABLE' || batch.quantity <= 0 || batch.expiresAt <= now) return null;
  assertMoney(batch);
  const daysRemaining = Math.max(1, (batch.expiresAt.getTime() - now.getTime()) / 86_400_000);
  const projected = Math.max(0, batch.unitsSoldPerDay) * daysRemaining;
  if (projected >= batch.quantity) return null;

  const requiredVelocity = batch.quantity / daysRemaining;
  const percent = Math.min(
    100,
    Math.max(1, Math.ceil((1 - Math.max(0, batch.unitsSoldPerDay) / requiredVelocity) * 100))
  );
  const startingPrice = Math.min(batch.priceMinor, batch.mrpMinor);
  const discounted = Math.floor((startingPrice * (100 - percent)) / 100);
  const suggestedPriceMinor = Math.min(
    batch.mrpMinor,
    allowBelowCost ? discounted : Math.max(batch.costMinor, discounted)
  );
  return {
    batchId: batch.id,
    expiresAt: batch.expiresAt,
    quantity: batch.quantity,
    projectedSalesBeforeExpiry: Math.floor(projected),
    atRiskUnits: Math.max(1, Math.ceil(batch.quantity - projected)),
    currentPriceMinor: batch.priceMinor,
    suggestedPriceMinor,
    markdownPercent:
      startingPrice === 0
        ? 0
        : Math.max(0, Math.round((1 - suggestedPriceMinor / startingPrice) * 100)),
    requiresOwnerApproval: true,
  };
}

async function authorizeAndConfigure(
  port: ExpiryMarkdownPort,
  actorId: string,
  orgId: string,
  action: Parameters<ExpiryMarkdownPort['can']>[0]['action'],
  batchId?: string
): Promise<string> {
  if (!(await port.can({ actorId, orgId, action, batchId })))
    throw new ExpiryMarkdownForbiddenError('Permission denied.');
  const config = await port.getAIConfiguration(orgId);
  if (!config.enabled || !config.model)
    throw new ExpiryMarkdownUnavailableError(
      'DevFathom AI is not configured for this organization.'
    );
  return config.model;
}

export async function createExpiryMarkdownDrafts(input: {
  actorId: string;
  orgId: string;
  port: ExpiryMarkdownPort;
  now?: Date;
  allowBelowCost?: boolean;
}): Promise<ExpiryMarkdownSuggestion[]> {
  const { actorId, orgId, port } = input;
  const model = await authorizeAndConfigure(port, actorId, orgId, 'stock:expiry-risk');
  const batches = await port.listStockBatches(orgId);
  const suggestions = batches
    .filter((batch) => batch.orgId === orgId)
    .map((batch) => suggestionFor(batch, input.now ?? new Date(), input.allowBelowCost === true))
    .filter((item): item is ExpiryMarkdownSuggestion => item !== null);
  await port.audit({
    actorId,
    orgId,
    event: 'AI_ACTION',
    oldValue: null,
    newValue: { candidateCount: suggestions.length },
    model,
    tier: EXPIRY_MARKDOWN_TIER,
  });
  for (const suggestion of suggestions) {
    await port.saveDraft(orgId, suggestion);
    await port.audit({
      actorId,
      orgId,
      event: 'AI_DRAFT',
      batchId: suggestion.batchId,
      oldValue: { priceMinor: suggestion.currentPriceMinor },
      newValue: { priceMinor: suggestion.suggestedPriceMinor },
      model,
      tier: EXPIRY_MARKDOWN_TIER,
    });
  }
  return suggestions;
}

/** Owner-facing approval is the only route to a price write. */
export async function approveExpiryMarkdown(input: {
  actorId: string;
  orgId: string;
  suggestion: ExpiryMarkdownSuggestion;
  port: ExpiryMarkdownPort;
  allowBelowCost?: boolean;
}): Promise<void> {
  const { actorId, orgId, suggestion, port } = input;
  const model = await authorizeAndConfigure(
    port,
    actorId,
    orgId,
    'stock:markdown-approve',
    suggestion.batchId
  );
  const batch = (await port.listStockBatches(orgId)).find(
    (candidate) => candidate.orgId === orgId && candidate.id === suggestion.batchId
  );
  if (
    !batch ||
    batch.status !== 'AVAILABLE' ||
    suggestion.suggestedPriceMinor > batch.mrpMinor ||
    (!input.allowBelowCost && suggestion.suggestedPriceMinor < batch.costMinor)
  )
    throw new Error('Markdown no longer satisfies the batch pricing policy.');
  await port.applyPrice(orgId, suggestion.batchId, suggestion.suggestedPriceMinor);
  await port.audit({
    actorId,
    orgId,
    event: 'AI_APPROVAL',
    batchId: suggestion.batchId,
    oldValue: { priceMinor: suggestion.currentPriceMinor },
    newValue: { priceMinor: suggestion.suggestedPriceMinor },
    model,
    tier: EXPIRY_MARKDOWN_TIER,
  });
}

export async function sendExpiryAlert(input: {
  actorId: string;
  orgId: string;
  suggestion: ExpiryMarkdownSuggestion;
  port: ExpiryMarkdownPort;
}): Promise<void> {
  const { actorId, orgId, suggestion, port } = input;
  const model = await authorizeAndConfigure(
    port,
    actorId,
    orgId,
    'stock:markdown-send',
    suggestion.batchId
  );
  await port.sendAlert?.(orgId, suggestion);
  await port.audit({
    actorId,
    orgId,
    event: 'AI_SEND',
    batchId: suggestion.batchId,
    oldValue: null,
    newValue: suggestion,
    model,
    tier: EXPIRY_MARKDOWN_TIER,
  });
}
