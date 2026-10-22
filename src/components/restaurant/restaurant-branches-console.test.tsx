import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  setActiveMutate: vi.fn(),
  invalidate: vi.fn(),
  branches: [] as Array<Record<string, unknown>>,
  createOnError: null as null | ((error: unknown) => void),
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
      create: {
        useMutation: (options: { onError: (error: unknown) => void }) => {
          mocks.createOnError = options.onError;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
      update: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      setActive: { useMutation: () => ({ mutate: mocks.setActiveMutate, isPending: false }) },
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

  it('confirms a destructive deactivation and explains the immediate impact', () => {
    mocks.branches = [
      activeBranch,
      {
        ...activeBranch,
        id: 'branch-two',
        name: 'Gulberg',
        code: 'GULBERG',
        isDefault: false,
      },
    ];
    render(<RestaurantBranchesConsole />);

    const deactivate = screen.getAllByRole('button', { name: 'Deactivate' })[1];
    expect(deactivate).toHaveClass('bg-destructive');
    fireEvent.click(deactivate);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Deactivate Gulberg?')).toBeInTheDocument();
    expect(within(dialog).getByText(/lose access immediately/i)).toBeInTheDocument();
    expect(mocks.setActiveMutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate branch' }));
    expect(mocks.setActiveMutate).toHaveBeenCalledWith({ id: 'branch-two', active: false });
  });

  it('mirrors deterministic server constraints in the branch form', () => {
    render(<RestaurantBranchesConsole />);

    expect(screen.getByLabelText('Branch code')).toHaveAttribute(
      'pattern',
      '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*'
    );
    expect(screen.getByLabelText('Address')).toHaveAttribute('maxlength', '300');
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxlength', '120');
  });

  it('associates server validation errors with the field that needs correction', () => {
    render(<RestaurantBranchesConsole />);

    act(() => {
      mocks.createOnError?.({
        message: 'Use a valid IANA timezone, such as Asia/Karachi.',
        data: { validation: { timezone: ['Use a valid IANA timezone, such as Asia/Karachi.'] } },
      });
    });

    const timezone = screen.getByLabelText('Timezone');
    expect(timezone).toHaveAttribute('aria-invalid', 'true');
    expect(timezone).toHaveAccessibleDescription(
      'Use a valid IANA timezone, such as Asia/Karachi.'
    );
  });
});
