import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { Decimal, add, formatMoney, money } from '@/lib/restaurant/money-arithmetic';
import { formatMoney as serverFormatMoney } from '@/lib/restaurant/money';

describe('client-safe promotion money arithmetic', () => {
  it('preserves exact display rounding through both client and server entrypoints', () => {
    for (const [input, expected] of [
      ['28', '28.00'],
      ['-0.5', '-0.50'],
      ['1.005', '1.01'],
    ]) {
      expect(formatMoney(input)).toBe(expected);
      expect(serverFormatMoney(input)).toBe(expected);
    }
  });

  it('shares the Prisma constructor used by server serialization and database writes', () => {
    expect(Decimal).toBe(Prisma.Decimal);
    const input = new Prisma.Decimal('12.50');
    expect(money(input)).toBe(input);
    expect(add('0.10', '0.20')).toBeInstanceOf(Prisma.Decimal);
  });

  it('accepts Prisma Decimal values without losing exact arithmetic', () => {
    const input = new Prisma.Decimal('9007199254740993.01');
    expect(money(input).toFixed(2)).toBe('9007199254740993.01');
    expect(add(input, '0.09').toFixed(2)).toBe('9007199254740993.10');
  });

  it('bundles the canonical promotion evaluator for a browser target', () => {
    const result = spawnSync(
      'bun',
      ['build', resolve('src/lib/restaurant/promotion-evaluator.ts'), '--target=browser'],
      { encoding: 'utf8' }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('server-only');
  });
});
