import 'server-only';

import { tool } from 'ai';
import { z } from 'zod';

import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import {
  readCateringReport,
  readPaymentsReport,
  validateRestaurantReportRange,
} from '@/lib/restaurant/reports';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      businessDateToUtcDate(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use a real YYYY-MM-DD calendar date.');

const inputSchema = z
  .object({
    report: z.enum(['settled_sales', 'upcoming_catering', 'operational_attention']),
    branch: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('Exact active branch ID or name. One authorized branch is required.'),
    from: calendarDate.describe('Inclusive business date; Catering uses its stored event date.'),
    to: calendarDate.describe('Inclusive end date, at most 90 days including the start.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    try {
      validateRestaurantReportRange({ branchIds: ['validation'], from: input.from, to: input.to });
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Use an ordered range of at most 90 calendar days.',
      });
    }
  });

const freshnessSchema = z.object({
  status: z.enum(['CURRENT', 'STALE', 'PARTIAL', 'NO_CLOSED_DAYS']),
  expectedDayCount: z.number().int().nonnegative(),
  closedDayCount: z.number().int().nonnegative(),
  missingClosedDayCount: z.number().int().nonnegative(),
  staleDayCount: z.number().int().nonnegative(),
  unprojectedDayCount: z.number().int().nonnegative(),
  correctedDayCount: z.number().int().nonnegative(),
});
const money = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
const paymentsSchema = z.object({
  freshness: freshnessSchema,
  grossSales: money,
  netSales: money,
  compTotal: money,
  discountTotal: money,
  refundTotal: money,
});
const cateringSchema = z.object({
  truncated: z.boolean(),
  orders: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        branchId: z.string().min(1).max(200),
        eventDate: calendarDate,
        status: z.enum([
          'DRAFT',
          'QUOTED',
          'CONFIRMED',
          'IN_PRODUCTION',
          'READY',
          'DELIVERED',
          'CLOSED',
          'CANCELLED',
        ]),
      })
    )
    .max(50),
});
const refusal = () => ({
  kind: 'refusal' as const,
  message: 'This Restaurant report is outside your authorized scope.',
});
const unavailable = () => ({
  kind: 'unavailable' as const,
  dataState: 'unknown' as const,
  message: 'The authorized report is unavailable. No figures were inferred.',
});

/** Mirrors the reports router's active primary-branch/assignment/configure rules.
 * Its resolver is private at the integration base. Never accept scope from the model.
 * Requiring exactly one branch avoids implicit all-branch escalation.
 */
async function resolveBranch(h: AssistantHelpers, branch: string) {
  const allBranches = await h.can('restaurant:configure');
  let ids: string[] | undefined;
  if (!allBranches) {
    const [staff, assignments] = await Promise.all([
      h.db.restaurantStaffProfile.findFirst({
        where: { userId: h.ctx.userId, status: 'ACTIVE' },
        select: { primaryBranchId: true },
      }),
      h.db.restaurantBranchAssignment.findMany({
        where: { userId: h.ctx.userId },
        select: { branchId: true },
      }),
    ]);
    ids = [
      ...new Set([
        ...assignments.map((row) => row.branchId),
        ...(staff?.primaryBranchId ? [staff.primaryBranchId] : []),
      ]),
    ];
  }
  const branches = await h.db.restaurantBranch.findMany({
    where: {
      organizationId: h.ctx.organizationId,
      active: true,
      ...(ids ? { id: { in: ids } } : {}),
      OR: [{ id: branch }, { name: { equals: branch, mode: 'insensitive' } }],
    },
    select: { id: true },
    take: 2,
  });
  return branches.length === 1 ? branches[0].id : null;
}

/** Standalone read-only builder; registry integration belongs to Desktop. */
export function buildRestaurantReportTools(h: AssistantHelpers): ToolSet {
  return {
    askRestaurantReports: tool({
      description:
        'Read authorized Restaurant settled sales/refunds or upcoming Catering event statuses for one branch. Open/unpaid bills, headcounts and POS/KDS backlog are explicitly unavailable; never infer them or use quoted amounts as sales.',
      inputSchema,
      execute: async (rawInput) => {
        // Validate here as well: callers invoking execute directly cannot bypass bounds.
        const parsed = inputSchema.safeParse(rawInput);
        if (!parsed.success)
          return {
            kind: 'invalid_input',
            message: 'Choose one branch and valid dates spanning at most 90 days.',
          };
        const input = parsed.data;
        try {
          if (
            !h.ctx.enabledModules?.includes('restaurant-core') ||
            (input.report !== 'upcoming_catering' &&
              !h.ctx.enabledModules.includes('restaurant-pos'))
          )
            return refusal();
          const organization = await h.db.organization.findUnique({
            where: { id: h.ctx.organizationId },
            select: { vertical: true },
          });
          if (organization?.vertical !== 'RESTAURANT') return refusal();
          const permission =
            input.report === 'operational_attention' ? 'reports:operational' : 'reports:financial';
          if (!(await h.can(permission))) return refusal();
          // Catering is licensed by Restaurant Core at this base, not a separate vertical.
          if (input.report === 'upcoming_catering' && !(await h.can('catering:read')))
            return refusal();
          const branchId = await resolveBranch(h, input.branch);
          if (!branchId) return refusal();
          const range = { branchIds: [branchId], from: input.from, to: input.to };
          const query = new URLSearchParams({ branch: branchId, from: input.from, to: input.to });
          const citation = {
            period: { from: input.from, to: input.to, inclusive: true },
            branchScope: { branchIds: [branchId] },
            drillThrough: `/restaurant/reports?${query}`,
            observedAt: h.now().toISOString(),
          };
          if (input.report === 'operational_attention')
            return {
              ...citation,
              kind: 'unavailable',
              dataState: 'unknown',
              definition: 'POS/KDS operational backlog, separate from settled sales.',
              source: 'No bounded web-actor backlog report is exposed by the existing readers.',
              freshness: { status: 'UNKNOWN' },
              message:
                'Station queue access requires a separate station authorization contract. No backlog was inferred.',
            };
          if (input.report === 'settled_sales') {
            const report = paymentsSchema.safeParse(await readPaymentsReport(h.db, range));
            if (!report.success) return unavailable();
            const { freshness, ...values } = report.data;
            if (freshness.status === 'STALE' || freshness.status === 'NO_CLOSED_DAYS')
              return {
                ...citation,
                kind: 'unavailable',
                dataState: 'unknown',
                freshness,
                source: 'readPaymentsReport / authoritative RestaurantDailyClose chain tips',
                message:
                  'Stale projections or missing closed days prevent this answer. No figures were used.',
              };
            return {
              ...citation,
              kind: 'answer',
              dataState: freshness.status === 'PARTIAL' ? 'partial' : 'available',
              freshness,
              source: 'readPaymentsReport / authoritative RestaurantDailyClose chain tips',
              moneyUnit:
                'Decimal major-unit strings in the source ledger currency; currency code not supplied by this reader.',
              metrics: {
                grossSales: {
                  value: values.grossSales,
                  definition:
                    'SETTLED bill subtotals, pre-comp and pre-discount, for authoritative closed business dates.',
                },
                netSales: {
                  value: values.netSales,
                  definition:
                    'Gross sales minus comps and discounts. Refunds are separate, not deducted here; excludes delivery fees, tax, service charges and tips.',
                },
                comps: {
                  value: values.compTotal,
                  definition: 'Comp totals already deducted from netSales; do not subtract again.',
                },
                discounts: {
                  value: values.discountTotal,
                  definition:
                    'Discount totals already deducted from netSales; do not subtract again.',
                },
                refunds: {
                  value: values.refundTotal,
                  definition:
                    'Refund amounts on their processing business date, which may differ from the original sale date. Not an additional sale.',
                },
              },
              openUnpaid: {
                status: 'unavailable',
                value: null,
                definition:
                  'OPEN/unpaid bills are excluded from settled sales. This closed-day reader does not provide their count or value.',
              },
              averageCheck: {
                status: 'unavailable',
                value: null,
                denominator: null,
                definition:
                  'No matched settled-order denominator is exposed by this reader; tender counts are not order counts.',
              },
              instruction:
                'Retain period, branch scope, definitions and freshness. Partial closed dates do not represent the whole period.',
            };
          }
          if (input.from < h.now().toISOString().slice(0, 10))
            return {
              kind: 'invalid_input',
              message:
                'Upcoming Catering dates must start on or after today (UTC event-date calendar).',
            };
          const report = cateringSchema.safeParse(await readCateringReport(h.db, range, 50));
          if (
            !report.success ||
            report.data.orders.some(
              (row) =>
                row.branchId !== branchId || row.eventDate < input.from || row.eventDate > input.to
            )
          )
            return unavailable();
          const events = report.data.orders.filter(
            (row) => !['DELIVERED', 'CLOSED', 'CANCELLED'].includes(row.status)
          );
          return {
            ...citation,
            kind: 'answer',
            dataState: report.data.truncated ? 'partial' : events.length ? 'available' : 'empty',
            definition:
              'Upcoming non-delivered, non-closed, non-cancelled Catering orders by stored event date. Drafts/quotes are plans, not sales or confirmed bookings.',
            source: 'readCateringReport / RestaurantCateringOrder',
            freshness: {
              status: 'UNKNOWN',
              reason:
                'Live reader has no source update timestamp; observedAt is retrieval time only.',
            },
            events,
            truncated: report.data.truncated,
            headcount: {
              status: 'unavailable',
              value: null,
              definition: 'The report does not expose headcount. Recipe portions are not people.',
            },
            instruction:
              'Only these bounded events are shown; partial results are not a total. No customer names, quoted revenue or costing claims are provided.',
          };
        } catch {
          return unavailable();
        }
      },
    }),
  };
}
