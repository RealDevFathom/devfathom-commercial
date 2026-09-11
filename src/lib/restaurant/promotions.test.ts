import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { canonicalHash } from '@/lib/restaurant/promotion-snapshot';

vi.mock('server-only', () => ({}));

import { createPublishedOrderPercentagePromotion } from './promotions';

const input = {
  organizationId: 'org_1',
  code: 'KARAHI10',
  name: 'Karahi Family Table 10%',
  effectiveFrom: new Date('2026-08-21T19:00:00.000Z'),
  effectiveTo: new Date('2026-10-04T18:59:00.000Z'),
  publishedAt: new Date('2026-08-21T19:00:00.000Z'),
  timezone: 'Asia/Karachi',
  allowedBranchIds: ['branch_1', 'branch_2'],
  minimumSpend: 2_500,
  percentageOff: 10,
  currency: 'PKR',
  actorUserId: 'user_1',
  actorStaffProfileId: 'staff_1',
};

function database(publicationBranchIds = input.allowedBranchIds) {
  const rows = {
    promotionCreate: vi.fn().mockResolvedValue({ id: 'promotion_1', code: input.code }),
    versionCreate: vi.fn().mockResolvedValue({
      id: 'version_1',
      promotionId: 'promotion_1',
      status: 'PUBLISHED',
      ruleHash: 'stored_hash',
    }),
    auditCreateMany: vi.fn().mockResolvedValue({ count: 2 }),
  };
  const db = {
    organization: { findFirst: vi.fn().mockResolvedValue({ id: input.organizationId }) },
    restaurantBranch: {
      findMany: vi.fn().mockResolvedValue(input.allowedBranchIds.map((id) => ({ id }))),
    },
    restaurantBranchMenuPublication: {
      findMany: vi.fn().mockResolvedValue(publicationBranchIds.map((branchId) => ({ branchId }))),
    },
    restaurantStaffProfile: { findFirst: vi.fn().mockResolvedValue({ id: 'staff_1' }) },
    restaurantPromotion: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: rows.promotionCreate,
    },
    restaurantPromotionVersion: { create: rows.versionCreate },
    restaurantPromotionAuditEvent: { createMany: rows.auditCreateMany },
  } as unknown as ScopedDb;
  return { db, rows };
}

describe('createPublishedOrderPercentagePromotion', () => {
  it('validates, evaluates, publishes, and audits one immutable rule', async () => {
    const { db, rows } = database();

    await expect(createPublishedOrderPercentagePromotion(db, input)).resolves.toMatchObject({
      promotion: { id: 'promotion_1' },
      version: { id: 'version_1', status: 'PUBLISHED' },
    });

    const version = rows.versionCreate.mock.calls[0]![0].data;
    expect(version).toMatchObject({
      promotionId: 'promotion_1',
      status: 'PUBLISHED',
      targetKind: 'ORDER',
      benefitKind: 'PERCENT_OFF',
      benefitBasisPoints: 1_000,
      currency: 'PKR',
      allowedBranchIds: input.allowedBranchIds,
      approvedByStaffId: 'staff_1',
    });
    expect(version.minimumAmount.toString()).toBe('2500');
    expect(version.ruleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(version.ruleSnapshot)).toBe(false);
    expect(version.ruleSnapshot).toMatchObject({
      promotionId: 'promotion_1',
      promotionCode: 'KARAHI10',
      status: 'PUBLISHED',
    });
    expect(canonicalHash(version.ruleSnapshot)).toBe(version.ruleHash);
    expect(rows.auditCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ action: 'DRAFT_CREATED', payloadHash: version.ruleHash }),
        expect.objectContaining({ action: 'PUBLISHED', payloadHash: version.ruleHash }),
      ]),
    });
  });

  it('rejects a branch without a published menu before authoring', async () => {
    const { db, rows } = database(['branch_1']);

    await expect(createPublishedOrderPercentagePromotion(db, input)).rejects.toMatchObject({
      code: 'PROMOTION_RULE_INVALID',
      message: 'Every promotion branch requires a published menu.',
    });
    expect(rows.promotionCreate).not.toHaveBeenCalled();
  });

  it('rejects non-finite benefit input before touching persistence', async () => {
    const { db, rows } = database();

    await expect(
      createPublishedOrderPercentagePromotion(db, {
        ...input,
        percentageOff: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow();
    expect(rows.promotionCreate).not.toHaveBeenCalled();
  });
});
