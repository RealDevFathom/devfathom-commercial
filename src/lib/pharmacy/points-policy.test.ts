import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readPointsPolicy,
  savePointsPolicy,
  requirePointsManager,
  DEFAULT_POINTS_POLICY,
} from './points-policy';
import { can } from '@/lib/abac';
import { isPharmacyOwner } from './owner';
vi.mock('@/lib/abac', () => ({ can: vi.fn(), subjectFromSession: (u: unknown) => u }));
vi.mock('./owner', () => ({ isPharmacyOwner: vi.fn() }));
const policy = {
  pointsEnabled: true,
  earnEveryMinor: 1000,
  pointValueMinor: 50,
  minimumRedeemPoints: 5,
};
describe('pharmacy points policy', () => {
  beforeEach(() => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(isPharmacyOwner).mockResolvedValue(false);
  });
  it('disables earning and redemption until explicitly configured', async () => {
    const db = { pharmacyLoyaltySettings: { findUnique: vi.fn(async () => null) } };
    expect(await readPointsPolicy(db as never, 'org')).toEqual(DEFAULT_POINTS_POLICY);
    expect(DEFAULT_POINTS_POLICY.pointsEnabled).toBe(false);
  });
  it('serializes first configuration and audits before the update', async () => {
    const order: string[] = [];
    const db = {
      $queryRaw: vi.fn(async () => {
        order.push('lock');
      }),
      pharmacyLoyaltySettings: {
        findUnique: vi.fn(async () => DEFAULT_POINTS_POLICY),
        upsert: vi.fn(async () => {
          order.push('update');
          return policy;
        }),
      },
      pharmacyLoyaltySettingsAudit: {
        create: vi.fn(async () => {
          order.push('audit');
        }),
      },
    };
    await savePointsPolicy(db as never, 'org', 'owner', policy);
    expect(order).toEqual(['lock', 'audit', 'update']);
    expect(db.pharmacyLoyaltySettingsAudit.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org',
        actorId: 'owner',
        oldValue: DEFAULT_POINTS_POLICY,
        newValue: policy,
      },
    });
  });
  it.each(['earnEveryMinor', 'pointValueMinor', 'minimumRedeemPoints'] as const)(
    'rejects invalid %s before writes',
    async (field) => {
      const db = { $queryRaw: vi.fn() };
      await expect(
        savePointsPolicy(db as never, 'org', 'owner', { ...policy, [field]: 0 })
      ).rejects.toThrow();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    }
  );
  function context(role = 'ADMIN', organizationId = 'org') {
    return {
      session: { user: { id: 'actor', organizationId, role } },
      entitlements: { organizationId: 'org' },
      organization: { id: 'org', vertical: 'PHARMACY' },
      db: {},
    } as never;
  }
  it('allows a verified owner or administrator, with central DENY precedence', async () => {
    expect(await requirePointsManager(context())).toEqual({
      organizationId: 'org',
      actorId: 'actor',
    });
    await expect(requirePointsManager(context('EMPLOYEE'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    vi.mocked(isPharmacyOwner).mockResolvedValue(true);
    await expect(requirePointsManager(context('EMPLOYEE'))).resolves.toMatchObject({
      actorId: 'actor',
    });
    vi.mocked(can).mockResolvedValue(false);
    await expect(requirePointsManager(context())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('refuses cross-tenant administration', async () => {
    await expect(requirePointsManager(context('ADMIN', 'other'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
