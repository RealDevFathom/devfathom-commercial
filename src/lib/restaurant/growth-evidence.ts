import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AssistantHelpers } from '@/lib/ai/context';
import { businessDateToUtcDate } from './business-date';
import { readFinancialComparison, restaurantComparisonWindows } from './financial-comparison';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      businessDateToUtcDate(value);
      return true;
    } catch {
      return false;
    }
  });
export const restaurantGrowthEvidenceInput = z
  .object({
    branchId: z.string().trim().min(1).max(200),
    from: day,
    to: day,
  })
  .strict();
const major = z
  .string()
  .max(32)
  .regex(/^-?\d+(?:\.\d{1,2})?$/);

/** Exact conversion for supported USD/PKR two-decimal major-unit readers. */
export function restaurantMajorToMinor(value: string): string {
  major.parse(value);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const minor = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  return ((negative ? BigInt(-1) : BigInt(1)) * minor).toString();
}

const definitions = {
  grossSales: 'Settled bill subtotals before comps and discounts, on bill business date.',
  netSales:
    'Settled gross minus comps, discounts and the sales part of processing-date refunds (refunded tax, service charge and delivery fees excluded). Refunds already deducted. Not profit or cash.',
  compTotal: 'Comps on settled bills, on bill business date.',
  discountTotal: 'Discounts on settled bills, on bill business date.',
  refundTotal:
    'Refund principal on processing business date, possibly for earlier sales; includes refunded tax and service charge. Its sales part is already deducted from net sales.',
} as const;
const keys = ['grossSales', 'netSales', 'compTotal', 'discountTotal', 'refundTotal'] as const;
const driver = z.object({ current: major.nullable(), previous: major.nullable() });
const coverage = z
  .object({
    status: z.enum(['CURRENT', 'STALE', 'PARTIAL', 'NO_CLOSED_DAYS']),
    expectedDayCount: z.number().int().min(1).max(45),
    closedDayCount: z.number().int().min(0).max(45),
    missingClosedDayCount: z.number().int().min(0).max(45),
    staleDayCount: z.number().int().min(0).max(45),
    unprojectedDayCount: z.number().int().min(0).max(45),
    correctedDayCount: z.number().int().min(0).max(45),
  })
  .superRefine((v, ctx) => {
    const expectedStatus = !v.closedDayCount
      ? 'NO_CLOSED_DAYS'
      : v.staleDayCount
        ? 'STALE'
        : v.missingClosedDayCount || v.unprojectedDayCount
          ? 'PARTIAL'
          : 'CURRENT';
    if (
      v.closedDayCount + v.missingClosedDayCount !== v.expectedDayCount ||
      v.staleDayCount + v.unprojectedDayCount > v.closedDayCount ||
      v.correctedDayCount > v.closedDayCount ||
      v.status !== expectedStatus
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent coverage.' });
  });
const period = z.object({ from: day, to: day });
const reportSchema = z.object({
  scope: z.object({ organizationId: z.string(), branchIds: z.array(z.string()).length(1) }),
  currency: z.enum(['USD', 'PKR']),
  moneyUnit: z.literal('DECIMAL_MAJOR'),
  periodBasis: z.literal('BUSINESS_DATE'),
  periods: z.object({ current: period, previous: period, daysPerPeriod: z.number().int() }),
  asOf: z.iso.datetime(),
  observedThrough: z.iso.datetime(),
  coverage: z.object({ current: coverage, previous: coverage }),
  drivers: z.object({
    grossSales: driver,
    netSales: driver,
    compTotal: driver,
    discountTotal: driver,
    refundTotal: driver,
  }),
});

const denied = () => ({ status: 'DENIED' as const });
const unavailable = () => ({
  status: 'UNAVAILABLE' as const,
  failure: 'SOURCE_UNAVAILABLE' as const,
});

/**
 * Request-scoped authenticated helpers only. Recreate them from the current session
 * and entitlements for every invocation. Returned snapshot is SERVER-ONLY: it holds
 * scope IDs, not a provider input. No model or write path is connected here.
 */
export async function readRestaurantGrowthEvidence(h: AssistantHelpers, raw: unknown) {
  const parsed = restaurantGrowthEvidenceInput.safeParse(raw);
  if (!parsed.success) return { status: 'INVALID_INPUT' as const };
  const input = parsed.data;
  let windows: ReturnType<typeof restaurantComparisonWindows>;
  try {
    windows = restaurantComparisonWindows({
      branchIds: [input.branchId],
      from: input.from,
      to: input.to,
    });
  } catch {
    return { status: 'INVALID_INPUT' as const };
  }
  try {
    if (
      h.ctx.vertical !== 'RESTAURANT' ||
      !h.ctx.enabledModules?.includes('restaurant-core') ||
      !h.ctx.enabledModules.includes('restaurant-pos') ||
      !(await h.can('reports:financial'))
    )
      return denied();
    const organization = await h.db.organization.findUnique({
      where: { id: h.ctx.organizationId },
      select: { vertical: true },
    });
    if (organization?.vertical !== 'RESTAURANT') return denied();
    const all = await h.can('restaurant:configure');
    if (!all) {
      // Same active-primary/assignment policy as restaurant-reports router, with
      // explicit tenant predicates in addition to the mandatory scoped DB.
      const [staff, assignment] = await Promise.all([
        h.db.restaurantStaffProfile.findFirst({
          where: { organizationId: h.ctx.organizationId, userId: h.ctx.userId, status: 'ACTIVE' },
          select: { primaryBranchId: true },
        }),
        h.db.restaurantBranchAssignment.findFirst({
          where: {
            organizationId: h.ctx.organizationId,
            userId: h.ctx.userId,
            branchId: input.branchId,
          },
          select: { branchId: true },
        }),
      ]);
      if (staff?.primaryBranchId !== input.branchId && assignment?.branchId !== input.branchId)
        return denied();
    }
    const branch = await h.db.restaurantBranch.findFirst({
      where: { id: input.branchId, organizationId: h.ctx.organizationId, active: true },
      select: { id: true },
    });
    if (branch?.id !== input.branchId) return denied();
    const source = reportSchema.safeParse(
      await readFinancialComparison(h.db, windows.current, { organizationId: h.ctx.organizationId })
    );
    if (!source.success) return unavailable();
    const report = source.data;
    if (
      report.scope.organizationId !== h.ctx.organizationId ||
      report.scope.branchIds[0] !== input.branchId ||
      report.periods.daysPerPeriod !== windows.days ||
      report.periods.current.from !== windows.current.from ||
      report.periods.current.to !== windows.current.to ||
      report.periods.previous.from !== windows.previous.from ||
      report.periods.previous.to !== windows.previous.to ||
      report.coverage.current.expectedDayCount !== windows.days ||
      report.coverage.previous.expectedDayCount !== windows.days ||
      report.asOf > report.observedThrough
    )
      return unavailable();

    const periods = (['current', 'previous'] as const).map((name) => {
      const freshness = report.coverage[name];
      const readable = freshness.status === 'CURRENT' || freshness.status === 'PARTIAL';
      const values = Object.fromEntries(
        keys.map((key) => {
          const value = report.drivers[key][name];
          if (readable && value === null) throw new Error('Missing source value');
          return [key, readable && value !== null ? restaurantMajorToMinor(value) : null];
        })
      ) as Record<(typeof keys)[number], string | null>;
      if (readable) {
        // Net sales deduct only the SALES part of refunds; refundTotal still carries
        // refunded tax and service charge. So net must lie between sales before
        // refunds minus the whole refundTotal and sales before refunds.
        const salesBeforeRefunds =
          BigInt(values.grossSales!) - BigInt(values.compTotal!) - BigInt(values.discountTotal!);
        const net = BigInt(values.netSales!);
        if (
          BigInt(values.refundTotal!) < BigInt(0) ||
          net > salesBeforeRefunds ||
          net < salesBeforeRefunds - BigInt(values.refundTotal!)
        )
          throw new Error('Inconsistent source equation');
      }
      const recordedZero = readable && keys.every((key) => values[key] === '0');
      const state =
        freshness.status === 'STALE'
          ? 'STALE'
          : freshness.status === 'NO_CLOSED_DAYS'
            ? 'UNKNOWN'
            : freshness.status === 'PARTIAL'
              ? 'PARTIAL'
              : recordedZero
                ? 'ZERO_RECORDED_AMOUNTS'
                : 'AVAILABLE';
      const selected = report.periods[name];
      const cutoff = businessDateToUtcDate(selected.to);
      cutoff.setUTCDate(cutoff.getUTCDate() + 1);
      return {
        period: name === 'current' ? ('CURRENT' as const) : ('COMPARISON' as const),
        from: `${selected.from}T00:00:00.000Z`,
        cutoff: cutoff.toISOString(),
        businessDates: selected,
        state,
        coverage: freshness,
        facts: keys.map((key) => ({ key, valueMinor: values[key], definition: definitions[key] })),
      };
    });
    const snapshot = {
      version: 'restaurant-growth-evidence-v1' as const,
      scope: { organizationId: h.ctx.organizationId, branchId: input.branchId },
      currency: report.currency,
      currencyBasis: 'CURRENT_ORGANIZATION_NOT_PINNED_HISTORICALLY' as const,
      periodBasis: 'BUSINESS_DATE' as const,
      unit: 'INTEGER_MINOR' as const,
      source: 'readFinancialComparison/readPaymentsReport:authoritative-close-chain-tips' as const,
      observedFrom: report.asOf,
      observedThrough: report.observedThrough,
      sourceFreshAt: null,
      snapshotGuaranteed: false as const,
      periods,
      sourceLink: `/restaurant/reports?${new URLSearchParams({ branch: input.branchId, from: input.from, to: input.to })}`,
      gateway: {
        eligible: false as const,
        facts: [] as never[],
        reason: 'FROZEN_CONTRACT_AND_CUSTOMER_COHORT_EVIDENCE_REQUIRED' as const,
      },
      unavailableMetrics: [
        'receipt_count',
        'loyalty_cohorts',
        'recipe_margin',
        'inventory',
        'waste',
        'catering_headcounts_capacity_margin',
      ] as const,
      limitations: [
        'Observational, not causal.',
        'Zero recorded amounts do not prove no receipts.',
        'Refunds already deducted; never subtract twice.',
        'Source observation time is not source freshness.',
      ] as const,
    };
    return {
      status: 'EVIDENCE' as const,
      evidenceHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      snapshot,
    };
  } catch {
    return unavailable();
  }
}
