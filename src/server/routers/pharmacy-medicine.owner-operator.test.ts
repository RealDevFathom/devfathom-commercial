import { describe, expect, it, vi } from 'vitest';

// Exercises the real ABAC engine (not mocked) so the procedures are authorized exactly as
// production resolves the seeded Owner / Operator role grants.
const mocks = vi.hoisted(() => ({ hasModule: vi.fn(() => true) }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { roleTemplatesForVertical } from '@/lib/vertical-catalog';
import type { TRPCContext } from '../trpc';
import { pharmacyMedicineRouter } from './pharmacy-medicine';

function rolePermissions(key: string) {
  return roleTemplatesForVertical('PHARMACY')
    .find((role) => role.key === key)!
    .capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const }));
}

function caller(roleKey: string, models: Record<string, unknown>) {
  const db: Record<string, unknown> = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: rolePermissions(roleKey) },
        permissionOverrides: [],
      }),
    },
    ...models,
  };
  db.$transaction = vi.fn((run: (tx: unknown) => unknown) => run(db));
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org-sehat',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      // Owner / Operator is paired with tenant ADMIN, as its role template requires.
      user: { id: 'owner-1', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('Owner / Operator catalogue review', () => {
  it('holds the exact pharmacy:catalogue-review grant rather than a wildcard', () => {
    const capabilities = rolePermissions('owner-operator').map((rule) => rule.capability);
    expect(capabilities).toContain('pharmacy:catalogue-review');
    expect(capabilities).not.toContain('*');
    expect(capabilities).not.toContain('pharmacy:*');
  });

  it('lists and decides connector proposals', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue({ id: 'proposal-1', status: 'PENDING' });
    const update = vi.fn().mockResolvedValue({ id: 'proposal-1', status: 'REJECTED' });
    const owner = caller('owner-operator', {
      pharmacyReferenceConnectorProposal: { findMany, findFirst, update },
    });

    await expect(owner.referenceConnectorProposals()).resolves.toEqual([]);
    await expect(
      owner.decideReferenceConnectorProposal({ proposalId: 'proposal-1', decision: 'REJECT' })
    ).resolves.toMatchObject({ status: 'REJECTED' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proposal-1' },
        data: expect.objectContaining({ status: 'REJECTED', decidedBy: 'owner-1' }),
      })
    );
  });

  it.each(['ACCEPT', 'REJECT', 'DEFER'] as const)(
    'records a %s review decision on an unreviewed assertion',
    async (action) => {
      const create = vi.fn().mockResolvedValue({ id: 'decision-1', action });
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const owner = caller('owner-operator', {
        medicine: { count: vi.fn().mockResolvedValue(1) },
        medicineProvenance: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 'assertion-1', medicineId: 'med-1', status: 'UNREVIEWED' }]),
          updateMany,
        },
        medicineReviewDecision: { create },
      });

      await expect(
        owner.recordReviewDecision({
          duplicateKey: 'reference:med-1',
          action,
          medicineIds: ['med-1'],
          payload: { assertionIds: ['assertion-1'] },
        })
      ).resolves.toMatchObject({ action });
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action, reviewerId: 'owner-1' }),
      });
      expect(updateMany).toHaveBeenCalledTimes(action === 'DEFER' ? 0 : 1);
    }
  );

  it('keeps the wildcard-only Owner template out of catalogue review', async () => {
    const findMany = vi.fn();
    const owner = caller('owner', { pharmacyReferenceConnectorProposal: { findMany } });
    await expect(owner.referenceConnectorProposals()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
