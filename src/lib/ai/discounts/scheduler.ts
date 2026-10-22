import 'server-only';

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { can, type Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from '@/server/audit';
import { routeAI } from '../router';
import { getTierForFeature } from '../tiers';

export const AI_DISCOUNT_LABEL = 'DevFathom AI' as const;
export const AI_DISCOUNT_TIER = getTierForFeature('growth');

export type PakistanHolidayDates = {
  ramadanStart: string;
  ramadanEnd: string;
  eidUlFitr: string;
  eidUlAdha: string;
};

/** Code-owned defaults. An organization may replace any year with a locally confirmed table. */
export const PAKISTAN_HOLIDAY_DATES: Readonly<Record<number, PakistanHolidayDates>> = {
  2025: {
    ramadanStart: '2025-03-02',
    ramadanEnd: '2025-03-30',
    eidUlFitr: '2025-03-31',
    eidUlAdha: '2025-06-07',
  },
  2026: {
    ramadanStart: '2026-02-19',
    ramadanEnd: '2026-03-19',
    eidUlFitr: '2026-03-20',
    eidUlAdha: '2026-05-27',
  },
  2027: {
    ramadanStart: '2027-02-09',
    ramadanEnd: '2027-03-10',
    eidUlFitr: '2027-03-11',
    eidUlAdha: '2027-05-17',
  },
  2028: {
    ramadanStart: '2028-01-29',
    ramadanEnd: '2028-02-26',
    eidUlFitr: '2028-02-27',
    eidUlAdha: '2028-05-05',
  },
};

export type DiscountableItem = {
  category: string;
  sellingPriceMinor: number;
  costMinor: number;
  mrpMinor: number;
  isPrescription: boolean;
  isControlled: boolean;
};

export type DiscountEvent = {
  id: string;
  kind: 'RAMADAN' | 'EID_UL_FITR' | 'EID_UL_ADHA' | 'PAYDAY' | 'SUMMER' | 'WINTER' | 'MONSOON';
  from: string;
  to: string;
};

export type PendingDiscountDraft = {
  status: 'PENDING';
  sourceLabel: typeof AI_DISCOUNT_LABEL;
  category: string;
  percent: number;
  from: string;
  to: string;
  event: DiscountEvent['kind'];
  model: string;
  tier: typeof AI_DISCOUNT_TIER;
};

type SchedulerConfig = {
  aiEnabled: boolean;
  providerSecretConfigured: boolean;
  paydayWindowStartDay?: number;
  holidays?: Readonly<Record<number, PakistanHolidayDates>>;
};

type AuditValue = { old: unknown; new: unknown; model: string; tier: typeof AI_DISCOUNT_TIER };

export type DiscountSchedulerDependencies = {
  loadConfig: (organizationId: string) => Promise<SchedulerConfig>;
  loadItems: (organizationId: string) => Promise<readonly DiscountableItem[]>;
  savePendingDraft: (
    organizationId: string,
    draft: PendingDiscountDraft
  ) => Promise<{ id: string }>;
  audit?: (
    organizationId: string,
    actor: Subject,
    action: string,
    value: AuditValue
  ) => void | Promise<void>;
  route?: typeof routeAI;
  now?: () => Date;
};

export type ScheduleDiscountsInput = {
  organizationId: string;
  actor: Subject;
  db: ScopedDb;
  year: number;
};

function isDiscountableItem(item: DiscountableItem): boolean {
  const prices = [item.sellingPriceMinor, item.costMinor, item.mrpMinor];
  return (
    !item.isPrescription &&
    !item.isControlled &&
    prices.every(Number.isSafeInteger) &&
    item.costMinor >= 0 &&
    item.sellingPriceMinor > 0 &&
    item.sellingPriceMinor <= item.mrpMinor &&
    item.costMinor <= item.sellingPriceMinor
  );
}

const proposalSchema = z
  .object({
    proposals: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            category: z.string().min(1),
            percent: z.number().int().min(1).max(90),
          })
          .strict()
      )
      .max(12),
  })
  .strict();

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function endOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function pakistanDiscountCalendar(
  year: number,
  paydayWindowStartDay = 25,
  table: Readonly<Record<number, PakistanHolidayDates>> = PAKISTAN_HOLIDAY_DATES
): DiscountEvent[] {
  if (!Number.isInteger(year) || paydayWindowStartDay < 2 || paydayWindowStartDay > 28)
    throw new Error('Invalid discount calendar configuration.');
  const dates = table[year];
  if (!dates) throw new Error(`No Pakistan holiday dates configured for ${year}.`);
  const events: DiscountEvent[] = [
    { id: `${year}:ramadan`, kind: 'RAMADAN', from: dates.ramadanStart, to: dates.ramadanEnd },
    { id: `${year}:fitr`, kind: 'EID_UL_FITR', from: dates.eidUlFitr, to: dates.eidUlFitr },
    { id: `${year}:adha`, kind: 'EID_UL_ADHA', from: dates.eidUlAdha, to: dates.eidUlAdha },
    { id: `${year}:summer`, kind: 'SUMMER', from: iso(year, 5, 1), to: iso(year, 8, 31) },
    { id: `${year}:monsoon`, kind: 'MONSOON', from: iso(year, 7, 1), to: iso(year, 9, 30) },
    {
      id: `${year}:winter`,
      kind: 'WINTER',
      from: iso(year, 11, 1),
      to: iso(year + 1, 2, endOfMonth(year + 1, 2)),
    },
  ];
  for (let month = 1; month <= 12; month++) {
    events.push({
      id: `${year}:payday:${month}:first`,
      kind: 'PAYDAY',
      from: iso(year, month, 1),
      to: iso(year, month, 1),
    });
    const priorYear = month === 1 ? year - 1 : year;
    const priorMonth = month === 1 ? 12 : month - 1;
    events.push({
      id: `${year}:payday:${month}:window`,
      kind: 'PAYDAY',
      from: iso(priorYear, priorMonth, paydayWindowStartDay),
      to: iso(year, month, 1),
    });
  }
  return events;
}

function defaultAudit(organizationId: string, actor: Subject, action: string, value: AuditValue) {
  return recordAudit({
    organizationId,
    source: 'SYSTEM',
    actorType: 'USER',
    actorId: actor.id,
    actorRole: actor.role,
    category: 'PHARMACY',
    operation: 'CREATE',
    action: `discountScheduler.${action}`,
    changes: { state: { before: value.old, after: value.new } },
    metadata: { sourceLabel: AI_DISCOUNT_LABEL, model: value.model, tier: value.tier },
  });
}

/**
 * Generates and persists review-only drafts. It deliberately exposes no activation,
 * approval, or send path: those remain separate human-authorized operations.
 */
export async function scheduleDiscountDrafts(
  input: ScheduleDiscountsInput,
  dependencies: DiscountSchedulerDependencies
): Promise<PendingDiscountDraft[]> {
  const audit = dependencies.audit ?? defaultAudit;
  const denied = async (reason: string) => {
    await audit(input.organizationId, input.actor, 'proposalDenied', {
      old: null,
      new: { status: 'DENIED', reason },
      model: 'unconfigured',
      tier: AI_DISCOUNT_TIER,
    });
  };
  // Central ABAC resolves explicit DENY before policy grants and receives the tenant DB.
  if (!(await can(input.actor, 'pharmacy:manage', undefined, { db: input.db, source: 'TRPC' }))) {
    await denied('FORBIDDEN');
    throw new Error('FORBIDDEN');
  }

  const config = await dependencies.loadConfig(input.organizationId);
  if (!config.aiEnabled || !config.providerSecretConfigured) {
    await denied('AI_NOT_CONFIGURED');
    throw new Error('AI_NOT_CONFIGURED');
  }
  const events = pakistanDiscountCalendar(
    input.year,
    config.paydayWindowStartDay,
    config.holidays ?? PAKISTAN_HOLIDAY_DATES
  );
  const items = await dependencies.loadItems(input.organizationId);
  // Minor-unit prices must be integers so the percentage cap cannot be weakened by
  // floating-point or malformed monetary values before a draft reaches review.
  const safeItems = items.filter(isDiscountableItem);
  const categoryCaps = new Map<string, number>();
  for (const item of safeItems) {
    const cap = Math.floor(
      ((item.sellingPriceMinor - item.costMinor) * 100) / item.sellingPriceMinor
    );
    categoryCaps.set(item.category, Math.min(categoryCaps.get(item.category) ?? 90, cap, 90));
  }
  for (const [category, cap] of categoryCaps) if (cap < 1) categoryCaps.delete(category);
  if (!categoryCaps.size) return [];

  let usedModel = 'unknown';
  let proposals: z.infer<typeof proposalSchema>;
  try {
    proposals = await (dependencies.route ?? routeAI)({
      tier: AI_DISCOUNT_TIER,
      feature: 'ai-discount-scheduler',
      organizationId: input.organizationId,
      execute: async (selection) => {
        usedModel = selection.modelId;
        const response = await generateText({
          model: selection.model,
          providerOptions: selection.providerOptions,
          output: Output.object({ schema: proposalSchema }),
          system:
            'Propose conservative retail discounts using only supplied event IDs and categories. Never activate, approve, or send a promotion.',
          prompt: JSON.stringify({
            country: 'Pakistan',
            events,
            categories: [...categoryCaps].map(([category, maximumPercent]) => ({
              category,
              maximumPercent,
            })),
          }),
          maxRetries: 0,
        });
        return { value: proposalSchema.parse(response.output), usage: response.usage };
      },
    });
  } catch (error) {
    await audit(input.organizationId, input.actor, 'propose', {
      old: null,
      new: { status: 'FAILED' },
      model: usedModel,
      tier: AI_DISCOUNT_TIER,
    });
    throw error;
  }
  await audit(input.organizationId, input.actor, 'propose', {
    old: null,
    new: { proposalCount: proposals.proposals.length },
    model: usedModel,
    tier: AI_DISCOUNT_TIER,
  });

  const drafts: PendingDiscountDraft[] = [];
  for (const proposal of proposals.proposals) {
    const event = events.find((candidate) => candidate.id === proposal.eventId);
    const cap = categoryCaps.get(proposal.category);
    if (!event || cap === undefined) continue;
    const percent = Math.min(proposal.percent, cap);
    const draft: PendingDiscountDraft = {
      status: 'PENDING',
      sourceLabel: AI_DISCOUNT_LABEL,
      category: proposal.category,
      percent,
      from: event.from,
      to: event.to,
      event: event.kind,
      model: usedModel,
      tier: AI_DISCOUNT_TIER,
    };
    const saved = await dependencies.savePendingDraft(input.organizationId, draft);
    await audit(input.organizationId, input.actor, 'draftCreated', {
      old: null,
      new: { id: saved.id, ...draft },
      model: usedModel,
      tier: AI_DISCOUNT_TIER,
    });
    drafts.push(draft);
  }
  return drafts;
}
