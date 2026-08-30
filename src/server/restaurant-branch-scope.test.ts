import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { requireRestaurantBranchScope } from './restaurant-branch-scope';
import type { TRPCContext } from './trpc';

function context(options: { primary?: string; assigned?: string } = {}) {
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
    },
    session: {
      user: { id: 'user', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
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
    await expect(requireRestaurantBranchScope(context(), 'branch-any')).resolves.toBeUndefined();
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
});
