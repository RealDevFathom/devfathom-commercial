// @vitest-environment node
import { hashSync } from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
import { soloOwnerApprovalAllowed, verifyPurchaseApprover } from './purchase-approval';

const hash = hashSync('1234', 4);
let state: { failedAttempts: number; lockedUntil: Date | null };
const approver = {
  status: 'ACTIVE',
  role: 'EMPLOYEE',
  organizationRole: {
    permissions: [
      { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      { capability: 'pharmacy:procurement-approve', effect: 'ALLOW' },
    ],
  },
  permissionOverrides: [] as { capability: string; effect: string }[],
};
const credentialDb = {
  user: {
    findUnique: vi.fn(() => approver),
  },
  $queryRaw: vi.fn(),
  restaurantOperatorCredential: {
    findFirst: vi.fn(() => ({ id: 'credential', credentialHash: hash, ...state })),
    update: vi.fn(({ data }: { data: typeof state }) => {
      state = data;
    }),
  },
};
const businessDb = { $queryRaw: vi.fn() };
const input = { organizationId: 'org', approverId: 'buyer', pin: '9999' };
beforeEach(() => {
  vi.clearAllMocks();
  credentialDb.user.findUnique.mockReturnValue(approver);
  state = { failedAttempts: 0, lockedUntil: null };
  mocks.withTenantDb.mockImplementation(async (_org, run) => run(credentialDb));
});

describe('purchase PIN transaction boundary', () => {
  it.each(['missing', 'denied'] as const)(
    'refuses a valid PIN when approval capability is %s, before touching credentials',
    async (approval) => {
      credentialDb.user.findUnique.mockReturnValue({
        ...approver,
        organizationRole: {
          permissions:
            approval === 'missing'
              ? [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }]
              : approver.organizationRole.permissions,
        },
        permissionOverrides:
          approval === 'denied'
            ? [{ capability: 'pharmacy:procurement-approve', effect: 'DENY' }]
            : [],
      });
      await expect(
        verifyPurchaseApprover(businessDb as unknown as ScopedDb, { ...input, pin: '1234' })
      ).resolves.toHaveProperty('blocked');
      expect(credentialDb.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
      expect(credentialDb.$queryRaw).not.toHaveBeenCalled();
      expect(businessDb.$queryRaw).not.toHaveBeenCalled();
    }
  );

  it('retains strikes and locks out even if every business request rolls back', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        (async () => {
          expect(
            await verifyPurchaseApprover(businessDb as unknown as ScopedDb, input)
          ).toHaveProperty('blocked');
          throw new Error('Sibling mutation failed');
        })()
      ).rejects.toThrow('Sibling mutation failed');
    }
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(
      await verifyPurchaseApprover(businessDb as unknown as ScopedDb, { ...input, pin: '1234' })
    ).toHaveProperty('blocked');
    expect(businessDb.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org', expect.any(Function), {
      skipDrain: true,
    });
  });
  it('places verified PIN proof only in the business transaction', async () => {
    expect(
      await verifyPurchaseApprover(businessDb as unknown as ScopedDb, { ...input, pin: '1234' })
    ).toEqual({ verified: true });
    expect(businessDb.$queryRaw).toHaveBeenCalledExactlyOnceWith(expect.any(Array), 'buyer');
    expect(credentialDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});

describe('solo-owner self-approval eligibility', () => {
  function soloDb(role: 'ADMIN' | 'EMPLOYEE', key: string) {
    return {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          role,
          organizationRole: {
            key,
            isSystem: true,
            permissions: [{ capability: '*', effect: 'ALLOW' }],
          },
          permissionOverrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        }),
        // Nobody else is active at the branch.
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as ScopedDb;
  }

  it('refuses an EMPLOYEE holding the owner-operator template even when alone', async () => {
    await expect(
      soloOwnerApprovalAllowed(soloDb('EMPLOYEE', 'owner-operator'), 'org', 'user', 'branch')
    ).resolves.toBe(false);
  });

  it('still allows a real tenant owner who is alone at the branch', async () => {
    await expect(
      soloOwnerApprovalAllowed(soloDb('EMPLOYEE', 'owner'), 'org', 'user', 'branch')
    ).resolves.toBe(true);
  });
});
