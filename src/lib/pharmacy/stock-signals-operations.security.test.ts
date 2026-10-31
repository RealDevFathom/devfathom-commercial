// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { createDraftAction } from './stock-signals-operations';

it.each(['role', 'override'])(
  'honors a %s DENY before an administrator creates a draft',
  async (source) => {
    const deny = { capability: 'pharmacy:procurement', effect: 'DENY' };
    const db = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ organizationId: 'org', branchId: null }]),
      user: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          role: 'ADMIN',
          organization: { status: 'ACTIVE', vertical: 'PHARMACY' },
          organizationRole: {
            key: 'owner',
            isSystem: true,
            permissions: [
              { capability: '*', effect: 'ALLOW' },
              ...(source === 'role' ? [deny] : []),
            ],
          },
          permissionOverrides: [
            { capability: 'pharmacy:procurement', effect: 'ALLOW' },
            ...(source === 'override' ? [deny] : []),
          ],
        }),
      },
      pharmacyRequisition: { create: vi.fn() },
      pharmacyBranch: { findFirst: vi.fn() },
    };
    await expect(
      createDraftAction(
        db as unknown as ScopedDb,
        {
          organizationId: 'org',
          branchId: 'branch',
          actorId: 'owner',
        },
        {
          kind: 'DRAFT_REQUISITION',
          signalId: 'signal',
          reference: 'REQ-1',
          medicineId: 'medicine',
          packLevelId: 'pack',
          canonicalUnitsPerPack: 10,
          quantityPacks: 1,
        }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  }
);
