import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync('src/server/routers/restaurant-shifts.ts', 'utf8');

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

  it.each([
    ['list', 'create'],
    ['create', 'update'],
    ['update', 'cancel'],
    ['cancel', 'myRoster'],
  ])('keeps Core scheduling procedure %s independent of Workforce', (name, nextName) => {
    expect(procedureSource(name, nextName)).not.toContain('requireWorkforce(ctx)');
  });

  it('serializes overlap decisions and rejects stale manager writes', () => {
    expect(router).toContain('pg_advisory_xact_lock');
    expect(router).toContain('expectedUpdatedAt: z.coerce.date()');
    expect(router).toContain('assertCurrentVersion');
  });
});
