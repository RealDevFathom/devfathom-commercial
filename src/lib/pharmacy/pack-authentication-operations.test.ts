import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import { readPackAuthenticationFlags } from './pack-authentication-operations';

function capture() {
  const scans = vi.fn().mockResolvedValue([]);
  const components = vi
    .fn()
    .mockResolvedValue([{ medicineId: 'med_1' }, { medicineId: 'med_2' }]);
  const db = {
    pharmacyPackAuthenticationScan: { findMany: scans },
    medicineStrengthComponent: { findMany: components },
  } as unknown as ScopedDb;
  return { db, scans, components };
}

describe('DEV-256 pack authentication flag report filters', () => {
  it('keeps the branch-only read when no dimension is selected', async () => {
    const { db, scans, components } = capture();
    await readPackAuthenticationFlags(db, ['branch_1']);
    expect(components).not.toHaveBeenCalled();
    expect(scans).toHaveBeenCalledWith({
      where: { branchId: { in: ['branch_1'] }, status: { not: 'VERIFIED' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  it('narrows flags to scans matched to the selected batch and ingredient medicines', async () => {
    const { db, scans, components } = capture();
    await readPackAuthenticationFlags(db, ['branch_1'], {
      organizationId: 'org_1',
      ingredientId: 'ing_1',
      batchId: 'batch_1',
    });
    expect(components).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', ingredientId: 'ing_1' },
      select: { medicineId: true },
    });
    expect(scans).toHaveBeenCalledWith({
      where: {
        branchId: { in: ['branch_1'] },
        status: { not: 'VERIFIED' },
        manufacturingBatchId: 'batch_1',
        medicineId: { in: ['med_1', 'med_2'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  it('reads as unavailable, not unfiltered, when a supplier is selected', async () => {
    const { db, scans, components } = capture();
    await expect(
      readPackAuthenticationFlags(db, ['branch_1'], { organizationId: 'org_1', supplierId: 'sup_1' })
    ).resolves.toBeNull();
    expect(scans).not.toHaveBeenCalled();
    expect(components).not.toHaveBeenCalled();
  });

  it('refuses an ingredient filter without a server-resolved tenant', async () => {
    const { db, scans } = capture();
    await expect(
      readPackAuthenticationFlags(db, ['branch_1'], { ingredientId: 'ing_1' })
    ).rejects.toThrow('PACK_AUTHENTICATION_SCOPE_REQUIRED');
    expect(scans).not.toHaveBeenCalled();
  });
});
