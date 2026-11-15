/** DEV-73 pure refill-subscription rules, safe to import from any server module. */

export const DAY_MS = 86_400_000;

/**
 * Defaults only. Cycle length, packs and reminder lead time are per-subscription
 * inputs, never fixed facts: a monthly pack is the common case, not a rule.
 */
export const REFILL_SUBSCRIPTION_DEFAULTS = {
  cycleDays: 30,
  reminderLeadDays: 3,
} as const;

export const REFILL_SUBSCRIPTION_LIMITS = {
  packsPerCycle: { min: 1, max: 100 },
  cycleDays: { min: 1, max: 180 },
  reminderLeadDays: { min: 0, max: 30 },
} as const;

export function nextCycleDueAt(dueAt: Date, cycleDays: number) {
  return new Date(dueAt.getTime() + cycleDays * DAY_MS);
}

/**
 * The reminder sends the shared utility refill template. Its only parameter is
 * the due date: no medicine, salt, strength or category ever leaves the
 * pharmacy in a WhatsApp or SMS message (Meta commerce policy, DRAP s.24).
 */
export function refillSubscriptionReminder(cycle: { id: string; dueAt: Date }) {
  const dueDate = cycle.dueAt.toISOString().slice(0, 10);
  return {
    dueDate,
    dedupeKey: `refill-subscription:${cycle.id}`,
    template: 'refillReminder' as const,
    parameters: [dueDate],
    sms: { kind: 'REFILL_REMINDER' as const, dueDate },
  };
}

/** The send window opens `reminderLeadDays` before the due date and closes at it. */
export function refillSubscriptionReminderDue(
  cycle: { dueAt: Date },
  reminderLeadDays: number,
  now: Date
) {
  const sendAt = cycle.dueAt.getTime() - reminderLeadDays * DAY_MS;
  return sendAt <= now.getTime() && now.getTime() < cycle.dueAt.getTime();
}

/**
 * The DEM-03 campaign key that marks a restock interest as the stock
 * hold of one refill-subscription cycle. Only that cycle's lifecycle settles it.
 */
export function refillCycleCampaignKey(cycleId: string) {
  return `refill-cycle:${cycleId}`;
}

export function isRefillCycleCampaignKey(campaignKey: string | null | undefined) {
  return Boolean(campaignKey?.startsWith('refill-cycle:'));
}
