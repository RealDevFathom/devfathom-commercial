import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  DuplicateSaltAcknowledgementError,
  verifyDuplicateSaltAcknowledgement,
} from './duplicate-salt-acknowledgement';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const AT = new Date('2026-10-31T09:00:00.000Z');

function saleLine(id: string, medicineId: string, productName: string, salts: string[]) {
  return {
    id,
    medicineId,
    medicine: {
      productName,
      strengths: salts.map((name) => ({ ingredientId: `ing-${name}`, ingredient: { name } })),
    },
  };
}

function dbWith(sale: unknown) {
  const findFirst = vi.fn(async () => sale);
  return { db: { pharmacySale: { findFirst } } as unknown as ScopedDb, findFirst };
}

describe('verifyDuplicateSaltAcknowledgement (#724)', () => {
  it('returns the server-derived duplicate for two paracetamol brands', async () => {
    const { db, findFirst } = dbWith({
      id: 'sale-1',
      lines: [
        saleLine('line-1', 'panadol', 'Panadol', ['Paracetamol']),
        saleLine('line-2', 'calpol', 'Calpol', ['Paracetamol']),
      ],
    });

    await expect(
      verifyDuplicateSaltAcknowledgement(
        db,
        scope,
        { saleId: 'sale-1', ingredientKey: 'paracetamol' },
        AT
      )
    ).resolves.toEqual({
      saleId: 'sale-1',
      branchId: 'branch-1',
      ingredientKey: 'paracetamol',
      ingredientName: 'Paracetamol',
      medicines: [
        { medicineId: 'panadol', displayName: 'Panadol', ref: 'line-1' },
        { medicineId: 'calpol', displayName: 'Calpol', ref: 'line-2' },
      ],
      acknowledgedByUserId: 'actor-1',
      acknowledgedAt: AT.toISOString(),
    });
    // The sale read is pinned to the caller's tenant AND branch.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sale-1', organizationId: 'org-1', branchId: 'branch-1' },
      })
    );
  });

  it('refuses a sale outside the scope', async () => {
    const { db } = dbWith(null);
    await expect(
      verifyDuplicateSaltAcknowledgement(db, scope, {
        saleId: 'sale-x',
        ingredientKey: 'paracetamol',
      })
    ).rejects.toEqual(new DuplicateSaltAcknowledgementError('NOT_FOUND'));
  });

  it('refuses to acknowledge a duplicate the bill does not carry', async () => {
    const { db } = dbWith({
      id: 'sale-1',
      lines: [
        saleLine('line-1', 'panadol', 'Panadol', ['Paracetamol']),
        saleLine('line-2', 'brufen', 'Brufen', ['Ibuprofen']),
      ],
    });
    await expect(
      verifyDuplicateSaltAcknowledgement(db, scope, {
        saleId: 'sale-1',
        ingredientKey: 'paracetamol',
      })
    ).rejects.toMatchObject({ reason: 'NOT_DUPLICATE' });
  });
});
