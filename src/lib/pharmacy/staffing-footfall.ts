import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

const DAY = 86_400_000;

export type StaffingFootfallConfig = {
  /** Configurable planning assumption, not an asserted service-capacity fact. */
  receiptsPerStaffHour: number;
  minimumSuggestedStaff: number;
};

export type StaffingFootfallInput = StaffingFootfallConfig & {
  branchId: string;
  from: string;
  to: string;
};

type HourCount = { hourLocal: number; receiptCount: number };

export function validateStaffingFootfallInput(input: StaffingFootfallInput) {
  // UTC is used only to validate/count calendar labels. Query bounds are resolved
  // by PostgreSQL in the workspace's IANA timezone below.
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  if (
    !input.branchId ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString().slice(0, 10) !== input.from ||
    to.toISOString().slice(0, 10) !== input.to ||
    from > to ||
    to.getTime() - from.getTime() >= 90 * DAY
  )
    throw new Error('Use valid local dates spanning at most 90 days for one authorized branch.');
  if (!Number.isInteger(input.receiptsPerStaffHour) || input.receiptsPerStaffHour < 1)
    throw new Error('Receipts per staff hour must be a positive whole number.');
  if (!Number.isInteger(input.minimumSuggestedStaff) || input.minimumSuggestedStaff < 0)
    throw new Error('Minimum suggested staff must be a non-negative whole number.');
  return { days: Math.round((to.getTime() - from.getTime()) / DAY) + 1 };
}

export function calculateStaffingFootfall(
  aggregate: readonly HourCount[],
  days: number,
  config: StaffingFootfallConfig
) {
  const counts = new Map(aggregate.map((row) => [row.hourLocal, Number(row.receiptCount)]));
  return Array.from({ length: 24 }, (_, hourLocal) => {
    const receiptCount = counts.get(hourLocal) ?? 0;
    const averageReceipts = receiptCount / days;
    return {
      hourLocal,
      receiptCount,
      averageReceipts,
      suggestedStaff: Math.max(
        config.minimumSuggestedStaff,
        Math.ceil(averageReceipts / config.receiptsPerStaffHour)
      ),
    };
  });
}

/** Read-only receipt proxy. A receipt is an observed visit, not measured door footfall. */
export async function readStaffingFootfall(
  db: ScopedDb,
  organizationId: string,
  input: StaffingFootfallInput
) {
  const { days } = validateStaffingFootfallInput(input);
  // Pharmacy branches inherit their organization's workspace timezone. Binding
  // both tenant and active branch here keeps this helper safe outside the router.
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: input.branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new Error('Branch is outside your report scope.');
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const timezone = workspaceTimezone(organization?.timezone);

  // Aggregate in PostgreSQL so a 90-day report always returns at most 24 rows.
  // `AT TIME ZONE` resolves each local-midnight boundary with the correct offset,
  // including days on either side of daylight-saving changes.
  const aggregate = await db.$queryRaw<HourCount[]>(Prisma.sql`
    SELECT
      EXTRACT(HOUR FROM ("completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})::integer AS "hourLocal",
      COUNT(*)::integer AS "receiptCount"
    FROM pharmacy_sales
    WHERE "organizationId" = ${organizationId}
      AND "branchId" = ${input.branchId}
      AND status = 'COMPLETED'
      AND "receiptNumber" IS NOT NULL
      AND "completedAt" >= ((${input.from}::date AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')
      AND "completedAt" < (((${input.to}::date + 1) AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')
    GROUP BY 1
    ORDER BY 1
  `);

  return {
    period: { from: input.from, to: input.to, timezone, days },
    method: 'COMPLETED_RECEIPTS_BY_LOCAL_HOUR' as const,
    estimated: true as const,
    config: {
      receiptsPerStaffHour: input.receiptsPerStaffHour,
      minimumSuggestedStaff: input.minimumSuggestedStaff,
    },
    hours: calculateStaffingFootfall(aggregate, days, input),
  };
}
