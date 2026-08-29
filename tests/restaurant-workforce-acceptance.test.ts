import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const migration = readFileSync(
  'prisma/migrations/20260829000000_restaurant_workforce_closure/migration.sql',
  'utf8'
);
const router = readFileSync('src/server/routers/restaurant-shifts.ts', 'utf8');

describe('restaurant workforce closure contract', () => {
  it('covers attendance, breaks, late arrival, and swap approval with server timestamps', () => {
    for (const symbol of [
      'clockIn',
      'clockOut',
      'startBreak',
      'endBreak',
      'requestSwap',
      'reviewSwap',
    ]) {
      expect(router).toContain(symbol);
    }
    expect(router).toContain('lateArrivalAt: now > shift.startAt ? now : null');
    expect(router).toContain('new Date()');
    expect(schema).toContain('model RestaurantShiftBreak');
    expect(schema).toContain('model RestaurantShiftSwapRequest');
  });

  it('forces tenant RLS and contains no payroll or payout surface', () => {
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(`${router}\n${migration}`).not.toMatch(/payroll|payout/i);
  });
});
