import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { createSale } from './sales';
import { applyPharmacyTender } from './settlement';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };

function admissionDb(status: 'ACTIVE' | 'ONBOARDING', profile: object | null) {
  const saleCreate = vi.fn();
  const idempotencyFind = vi.fn();
  const db = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ status }])
      .mockResolvedValueOnce([{ id: scope.branchId }]),
    branchRegulatoryProfile: { findFirst: vi.fn().mockResolvedValue(profile) },
    pharmacySale: { create: saleCreate },
    pharmacyMoneyIdempotencyKey: { findUnique: idempotencyFind },
  } as unknown as ScopedDb;
  return { db, idempotencyFind, saleCreate };
}

describe('pharmacy sale domain admission boundary', () => {
  it('denies every direct sale creator while the organization is onboarding', async () => {
    const { db, saleCreate } = admissionDb('ONBOARDING', null);

    await expect(createSale(db, scope)).rejects.toMatchObject({
      message: 'PHARMACY_ORGANIZATION_NOT_OPERATIONAL',
    });
    expect(saleCreate).not.toHaveBeenCalled();
  });

  it('denies every direct tender caller before idempotency or money writes', async () => {
    const { db, idempotencyFind } = admissionDb('ACTIVE', null);

    await expect(
      applyPharmacyTender(db, scope, {
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        cashReceivedMinor: 100,
        idempotencyKey: 'attempt-1',
      })
    ).rejects.toMatchObject({ reason: 'PROFILE_MISSING' });
    expect(idempotencyFind).not.toHaveBeenCalled();
  });
});
