import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  branches: [] as Array<Record<string, unknown>>,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantBranches: { list: { invalidate: mocks.invalidate } } }),
    restaurantBranches: {
      list: {
        useQuery: () => ({
          data: {
            limit: 2,
            branches: mocks.branches,
          },
          error: null,
          isLoading: false,
        }),
      },
      create: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      update: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      setActive: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
  },
}));

import { RestaurantBranchesConsole } from './restaurant-branches-console';

const activeBranch = {
  id: 'cmtxopaque123',
  name: 'DHA Phase 6',
  code: 'DHA-PH6',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '04:00',
  address: null,
  active: true,
  isDefault: true,
  shiftSignInEnforced: false,
};

beforeEach(() => {
  mocks.branches = [activeBranch];
});

describe('RestaurantBranchesConsole', () => {
  it('presents readable branch identity and a professional deactivate guard', () => {
    render(<RestaurantBranchesConsole />);
    expect(screen.getByRole('heading', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.getByText('DHA Phase 6')).toBeInTheDocument();
    expect(screen.getByText('DHA-PH6')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toHaveAttribute('data-tone', 'info');
    expect(screen.queryByText('cmtxopaque123')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    expect(screen.getByTitle('Choose another primary branch first.')).toBeInTheDocument();
  });

  it('counts active usage without treating inactive history as plan usage', () => {
    mocks.branches = [
      activeBranch,
      {
        ...activeBranch,
        id: 'inactive-id',
        name: 'Old Location',
        code: 'OLD',
        active: false,
        isDefault: false,
      },
    ];
    render(<RestaurantBranchesConsole />);
    expect(screen.getByText('1 of 2 active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeEnabled();
  });
});
