import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantBranches: { list: { invalidate: mocks.invalidate } } }),
    restaurantBranches: {
      list: {
        useQuery: () => ({
          data: {
            limit: 2,
            branches: [
              {
                id: 'cmtxopaque123',
                name: 'DHA Phase 6',
                code: 'DHA-PH6',
                timezone: 'Asia/Karachi',
                businessDayCutoff: '04:00',
                address: null,
                active: true,
                isDefault: true,
                shiftSignInEnforced: false,
              },
            ],
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

describe('RestaurantBranchesConsole', () => {
  it('presents readable branch identity and a professional deactivate guard', () => {
    render(<RestaurantBranchesConsole />);
    expect(screen.getByRole('heading', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.getByText('DHA Phase 6')).toBeInTheDocument();
    expect(screen.getByText('DHA-PH6')).toBeInTheDocument();
    expect(screen.queryByText('cmtxopaque123')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    expect(screen.getByTitle('Choose another primary branch first.')).toBeInTheDocument();
  });
});
