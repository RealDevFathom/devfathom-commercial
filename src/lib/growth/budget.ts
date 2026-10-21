import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Resolve midnight at the start of the tenant's current month, including DST. */
export async function budgetMonthStart(db: ScopedDb, organizationId: string, now: Date) {
  // Bind ISO text: Prisma's timestamp Date parameter can erase timestamptz semantics.
  const [row] = await db.$queryRaw<{ start: Date }[]>`
    SELECT (date_trunc('month', ${now.toISOString()}::timestamptz AT TIME ZONE timezone)
      AT TIME ZONE timezone) AT TIME ZONE 'UTC' AS start
    FROM organizations WHERE id = ${organizationId}`;
  if (!row) throw new Error('Organization not found.');
  return row.start;
}
