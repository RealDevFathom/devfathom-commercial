import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { requireRestaurantBranchScope } from './restaurant-branch-scope';
import type { TRPCContext } from './trpc';

function context(
  options: { primary?: string; assigned?: string; branches?: string[] | null } = {}
) {
  return {
    db: {
      restaurantStaffProfile: {
        findFirst: vi.fn(async ({ where }) =>
          options.primary === where.primaryBranchId ? { id: 'staff' } : null
        ),
      },
      restaurantBranchAssignment: {
        findFirst: vi.fn(async ({ where }) =>
          options.assigned === where.branchId ? { id: 'assignment' } : null
        ),
      },
      restaurantBranch: {
        findMany: vi.fn(async ({ where }) => {
          if (options.branches === null) return [];
          const ids = (where.id?.in ?? []) as string[];
          const allowed = options.branches ?? ids;
          return ids.filter((id) => allowed.includes(id)).map((id) => ({ id }));
        }),
      },
    },
    entitlements: { organizationId: 'org-1' },
    session: {
      user: {
        id: 'user',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(false);
});

describe('requireRestaurantBranchScope', () => {
  it('allows only the exact active primary branch', async () => {
    const ctx = context({ primary: 'branch-a' });
    await expect(requireRestaurantBranchScope(ctx, 'branch-a')).resolves.toBeUndefined();
    await expect(requireRestaurantBranchScope(ctx, 'branch-b')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows only the exact explicitly assigned branch', async () => {
    const ctx = context({ assigned: 'branch-b' });
    await expect(requireRestaurantBranchScope(ctx, 'branch-b')).resolves.toBeUndefined();
    await expect(requireRestaurantBranchScope(ctx, 'branch-a')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows an organization-wide configurator and denies every other branch', async () => {
    mocks.can.mockResolvedValueOnce(true);
    const allowed = context();
    await expect(requireRestaurantBranchScope(allowed, 'branch-any')).resolves.toBeUndefined();
    expect(allowed.db.restaurantBranch.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['branch-any'] }, organizationId: 'org-1', active: true },
      select: { id: true },
    });
    await expect(requireRestaurantBranchScope(context(), 'branch-any')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'restaurant:configure',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });

  it('rejects a missing or inactive branch even for a configurator', async () => {
    mocks.can.mockResolvedValue(true);
    await expect(
      requireRestaurantBranchScope(context({ branches: null }), 'branch-any')
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
  });
});
