import { describe, expect, it } from 'vitest';

import { FinanceAccountCode } from '@/generated/prisma/enums';
import { ACCOUNT_NORMAL_SIDE } from '@/lib/finance/journal';

import * as referenceModule from './account-code-reference';
import { accountCodeLabel, accountCodeReference } from './account-code-reference';

describe('canonical account-code normal-side reference', () => {
  it('lists every canonical code exactly once with its exact canonical normal side', () => {
    const { rows } = accountCodeReference();
    const codes = rows.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(Object.keys(ACCOUNT_NORMAL_SIDE).sort());
    for (const row of rows) expect(row.normalSide).toBe(ACCOUNT_NORMAL_SIDE[row.code]);
  });

  it('covers every database account code enum value, and nothing else', () => {
    const codes = accountCodeReference().rows.map((row) => row.code);
    expect([...codes].sort()).toEqual(Object.values(FinanceAccountCode).sort());
  });

  it('keeps the canonical declaration order deterministically across calls', () => {
    const first = accountCodeReference().rows.map((row) => row.code);
    const second = accountCodeReference().rows.map((row) => row.code);
    expect(first).toEqual(Object.keys(ACCOUNT_NORMAL_SIDE));
    expect(second).toEqual(first);
  });

  it('pins known normal sides so a reclassification cannot slip through', () => {
    const side = Object.fromEntries(
      accountCodeReference().rows.map((row) => [row.code, row.normalSide])
    );
    expect(side).toMatchObject({
      INVENTORY: 'DEBIT',
      GOODS_RECEIVED_ACCRUAL: 'CREDIT',
      SALES_REVENUE: 'CREDIT',
      SALES_DISCOUNT: 'DEBIT',
      COST_OF_GOODS_SOLD: 'DEBIT',
      CASH: 'DEBIT',
      ACCOUNTS_PAYABLE: 'CREDIT',
      OPENING_BALANCE_EQUITY: 'CREDIT',
    });
  });

  it('counts debit and credit codes from the derived rows', () => {
    const reference = accountCodeReference();
    const sides = Object.values(ACCOUNT_NORMAL_SIDE);
    expect(reference.debitCount).toBe(sides.filter((s) => s === 'DEBIT').length);
    expect(reference.creditCount).toBe(sides.filter((s) => s === 'CREDIT').length);
    expect(reference.debitCount + reference.creditCount).toBe(reference.rows.length);
  });

  it('hands out frozen rows and lists, and never mutates the canonical mapping', () => {
    const before = { ...ACCOUNT_NORMAL_SIDE };
    const reference = accountCodeReference();
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.isFrozen(reference.rows)).toBe(true);
    for (const row of reference.rows) expect(Object.isFrozen(row)).toBe(true);
    expect(() => {
      (reference.rows as unknown as { normalSide: string }[])[0]!.normalSide = 'CREDIT';
    }).toThrow(TypeError);
    expect(() => {
      (reference.rows as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(ACCOUNT_NORMAL_SIDE).toEqual(before);
    expect(accountCodeReference().rows).not.toBe(reference.rows);
  });

  it('exports no mapping object of its own, only derivation functions', () => {
    for (const value of Object.values(referenceModule)) expect(typeof value).toBe('function');
  });

  it('derives a presentation-only label from the code', () => {
    expect(accountCodeLabel('COST_OF_GOODS_SOLD')).toBe('Cost of goods sold');
    expect(accountCodeLabel('CASH')).toBe('Cash');
  });
});
