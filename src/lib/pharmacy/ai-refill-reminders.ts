import 'server-only';

import { generateText } from 'ai';
import { can, type Subject } from '@/lib/abac';
import { routeAI } from '@/lib/ai/router';
import { getTierForFeature } from '@/lib/ai/tiers';

const DAY_MS = 86_400_000;
export const REFILL_AI_FEATURE = 'pharmacy-refill-reminders';

export type Purchase = { purchasedAt: Date };
export type CadenceSuggestion = {
  medianIntervalDays: number;
  lastPurchasedAt: Date;
  reminderAt: Date;
};

/** Median cadence is resistant to an unusually early or late purchase. */
export function suggestRefillDate(
  purchases: readonly Purchase[],
  leadDays: number
): CadenceSuggestion | null {
  if (purchases.length < 2 || !Number.isInteger(leadDays) || leadDays < 0) return null;
  const dates = [...new Set(purchases.map((item) => item.purchasedAt.getTime()))].sort(
    (a, b) => a - b
  );
  if (dates.length < 2) return null;
  const intervals = dates.slice(1).map((date, index) => (date - dates[index]!) / DAY_MS);
  if (intervals.some((days) => !Number.isFinite(days) || days <= 0)) return null;
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const median =
    intervals.length % 2
      ? intervals[middle]!
      : (intervals[middle - 1]! + intervals[middle]!) / 2;
  const medianIntervalDays = Math.max(1, Math.round(median));
  const lastPurchasedAt = new Date(dates.at(-1)!);
  return {
    medianIntervalDays,
    lastPurchasedAt,
    reminderAt: new Date(lastPurchasedAt.getTime() + (medianIntervalDays - leadDays) * DAY_MS),
  };
}

export function aiProviderSecretConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (provider === 'bedrock')
    return Boolean(
      env.AWS_ACCESS_KEY_ID?.trim() || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim()
    );
  return false;
}

export function refillAIEnabled(orgEnabled: boolean, env: NodeJS.ProcessEnv = process.env) {
  return orgEnabled && aiProviderSecretConfigured(env);
}

const DOSAGE =
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|tablet(?:s)?|capsule(?:s)?|dose(?:s)?)\b|\b(?:once|twice|three times)\s+(?:a|per)\s+day\b/gi;
const CLINICAL = /\b(?:diagnos|treat|cure|dose|dosage|take|stop taking|side effect)\w*\b/gi;

/** Defence in depth: model output cannot contain dosage or clinical advice. */
export function safeReminderText(text: string): string {
  const cleaned = text
    .replace(DOSAGE, '')
    .replace(CLINICAL, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s.,;:!?-]+/, '');
  if (!cleaned)
    return 'A medicine you previously purchased may be due for a refill. Please contact the pharmacy if you would like us to prepare it.';
  return cleaned.slice(0, 500);
}

export type ReminderRecord = {
  id: string;
  organizationId: string;
  status: 'DRAFT' | 'APPROVED' | 'SKIPPED' | 'SENT';
  customerId: string;
  medicineName: string;
  reminderAt: Date;
  draftText: string;
};

export type ReminderDependencies = {
  authorize: typeof can;
  db: {
    find: (organizationId: string, id: string) => Promise<ReminderRecord | null>;
    update: (
      organizationId: string,
      id: string,
      expectedStatus: ReminderRecord['status'],
      patch: Partial<ReminderRecord>
    ) => Promise<ReminderRecord>;
    optedIn: (organizationId: string, customerId: string) => Promise<boolean>;
  };
  audit: (entry: {
    actorId: string;
    organizationId: string;
    action: string;
    old: unknown;
    new: unknown;
    model: string | null;
    tier: 'standard';
  }) => Promise<void>;
  send: (toCustomerId: string, text: string) => Promise<void>;
};

async function allowed(deps: ReminderDependencies, subject: Subject, organizationId: string) {
  return deps.authorize(subject, 'pharmacy:refill-reminders', { type: 'Organization', organizationId }, { db: deps.db as never });
}

export async function approveOrSkipReminder(
  deps: ReminderDependencies,
  input: { organizationId: string; reminderId: string; decision: 'APPROVED' | 'SKIPPED' },
  actor: Subject
) {
  if (!(await allowed(deps, actor, input.organizationId))) throw new Error('FORBIDDEN');
  const old = await deps.db.find(input.organizationId, input.reminderId);
  if (!old || old.status !== 'DRAFT') throw new Error('REMINDER_NOT_DRAFT');
  const next = await deps.db.update(input.organizationId, input.reminderId, 'DRAFT', {
    status: input.decision,
  });
  await deps.audit({ actorId: actor.id, organizationId: input.organizationId, action: `refill.${input.decision.toLowerCase()}`, old, new: next, model: null, tier: 'standard' });
  return next;
}

export async function sendApprovedReminder(
  deps: ReminderDependencies,
  input: { organizationId: string; reminderId: string },
  actor: Subject
) {
  if (!(await allowed(deps, actor, input.organizationId))) throw new Error('FORBIDDEN');
  const old = await deps.db.find(input.organizationId, input.reminderId);
  if (!old || old.status !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
  // This is intentionally the last read before the external side effect.
  if (!(await deps.db.optedIn(input.organizationId, old.customerId))) throw new Error('OPT_IN_REQUIRED');
  await deps.send(old.customerId, safeReminderText(old.draftText));
  const next = await deps.db.update(input.organizationId, input.reminderId, 'APPROVED', { status: 'SENT' });
  await deps.audit({ actorId: actor.id, organizationId: input.organizationId, action: 'refill.send', old, new: next, model: null, tier: 'standard' });
  return next;
}

export async function draftReminderText(input: {
  organizationId: string;
  actorId: string;
  customerFirstName: string;
  medicineName: string;
  audit: ReminderDependencies['audit'];
}) {
  return routeAI({
    tier: getTierForFeature(REFILL_AI_FEATURE),
    feature: REFILL_AI_FEATURE,
    organizationId: input.organizationId,
    execute: async ({ model, modelId }) => {
      const result = await generateText({
        model,
        system: 'Draft a short retail pharmacy refill reminder. Do not give clinical advice. Do not mention dosage, strength, or directions. Ask the customer to contact the pharmacy. Output only the message.',
        prompt: `First name: ${input.customerFirstName}\nMedicine name: ${input.medicineName}`,
      });
      const draft = safeReminderText(result.text);
      await input.audit({
        actorId: input.actorId,
        organizationId: input.organizationId,
        action: 'refill.ai_draft',
        old: null,
        new: { draftText: draft },
        model: modelId,
        tier: 'standard',
      });
      return { value: draft, usage: result.usage };
    },
  });
}
