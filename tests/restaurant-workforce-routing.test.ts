import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';

import { moduleForPath, moduleForProcedure } from '../src/lib/module-catalog';
import { mapWorkforceError } from '../src/server/routers/restaurant-shifts.errors';

const router = readFileSync('src/server/routers/restaurant-shifts.ts', 'utf8');
const scheduling = readFileSync('src/lib/restaurant/shifts.ts', 'utf8');

function procedureSource(name: string, nextName?: string) {
  const start = router.indexOf(`  ${name}:`);
  const end = nextName ? router.indexOf(`  ${nextName}:`, start + 1) : router.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return router.slice(start, end);
}

describe('restaurant workforce router boundary', () => {
  it.each([
    ['myRoster', 'managerRoster'],
    ['managerRoster', 'swapCandidates'],
    ['swapCandidates', 'clockIn'],
    ['clockIn', 'startBreak'],
    ['startBreak', 'endBreak'],
    ['endBreak', 'clockOut'],
    ['clockOut', 'requestSwap'],
    ['requestSwap', 'reviewSwap'],
    ['reviewSwap', 'correctTime'],
    ['correctTime', 'exportAttendanceCsv'],
    ['exportAttendanceCsv', undefined],
  ])('gates %s on the optional workforce entitlement', (name, nextName) => {
    expect(procedureSource(name, nextName)).toContain('requireWorkforce(ctx)');
  });

  it('keeps scheduling namespace and roster route in Restaurant Core', () => {
    expect(moduleForProcedure('restaurantShifts.list')).toBe('restaurant-core');
    expect(moduleForProcedure('restaurantShifts.create')).toBe('restaurant-core');
    expect(moduleForPath('/restaurant/staff/roster')).toBe('restaurant-core');
    expect(moduleForPath('/restaurant/staff')).toBe('restaurant-core');
  });

  it('serializes overlap decisions and rejects stale manager writes', () => {
    expect(router).toContain('pg_advisory_xact_lock');
    expect(router).toContain('expectedVersion: z.number().int().positive()');
    expect(scheduling).toContain('version: { increment: 1 }');
    expect(readFileSync('src/server/routers/restaurant-shifts.errors.ts', 'utf8')).toContain(
      "hasSqlState(err, '23P01')"
    );
    expect(scheduling).toContain('organizationId: cas.organizationId');
    expect(router).toContain('expectedVersion');
  });

  it('maps a nested swap exclusion SQLSTATE to a professional conflict', () => {
    expect(() =>
      mapWorkforceError({
        cause: { originalError: { meta: { database_error: { code: '23P01' } } } },
      })
    ).toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'CONFLICT',
        message:
          'Approving this swap would create an overlapping shift for the replacement operator.',
      })
    );
  });
});
