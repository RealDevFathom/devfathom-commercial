import 'server-only';

import { Prisma } from '@/generated/prisma/client';

import type { PharmacyBranchDayWindow } from './business-day';

/**
 * DEV-958A — the SQL predicate "this row's instant falls on one of its own branch's picked
 * business days". `windows` comes from `pharmacyBranchDayWindows`: with one window (every
 * branch on the same hours, as every branch is until an owner changes one) it is exactly the
 * fragment readers always used, `<time> >= from AND <time> < to`; with several, each branch is
 * bounded by its own window. Callers keep their own `branchId IN (...)` filter.
 */
export function pharmacyBranchWindowSql(
  windows: readonly PharmacyBranchDayWindow[],
  branchColumn: Prisma.Sql,
  timeColumn: Prisma.Sql
): Prisma.Sql {
  if (windows.length === 1) {
    const [only] = windows;
    return Prisma.sql`${timeColumn}>=${only!.from} AND ${timeColumn}<${only!.to}`;
  }
  if (!windows.length) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(
    windows.map(
      (window) =>
        Prisma.sql`(${branchColumn} IN (${Prisma.join(window.branchIds)}) AND ${timeColumn}>=${window.from} AND ${timeColumn}<${window.to})`
    ),
    ' OR '
  )})`;
}

/**
 * The same predicate for a Prisma `where`: with one window, `{ [field]: { gte, lt } }` exactly
 * as before; with several, an `OR` of each branch group's own window.
 */
export function pharmacyBranchWindowWhere<Field extends string>(
  windows: readonly PharmacyBranchDayWindow[],
  field: Field
): Record<string, unknown> {
  if (windows.length === 1) {
    const [only] = windows;
    return { [field]: { gte: only!.from, lt: only!.to } };
  }
  return {
    OR: windows.map((window) => ({
      branchId: { in: window.branchIds },
      [field]: { gte: window.from, lt: window.to },
    })),
  };
}

/** The earliest start and latest end of `windows`: the span every branch's window lies in. */
export function spanOf(windows: readonly PharmacyBranchDayWindow[]): { from: Date; to: Date } {
  if (!windows.length) throw new RangeError('A report window needs at least one branch.');
  return {
    from: new Date(Math.min(...windows.map((window) => window.from.getTime()))),
    to: new Date(Math.max(...windows.map((window) => window.to.getTime()))),
  };
}
