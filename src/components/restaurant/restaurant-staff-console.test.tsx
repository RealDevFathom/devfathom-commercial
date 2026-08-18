import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type IssueOptions = { onError?: (error: { message: string }) => void };
type IssueCallOptions = { onSettled?: () => void };

const mocks = vi.hoisted(() => ({
  staff: {
    data: [
      {
        id: 'staff_1',
        displayName: 'Shift Lead',
        email: 'lead@example.com',
        userId: null,
        primaryBranchId: 'branch_1',
        status: 'ACTIVE',
        createdAt: new Date('2026-08-18T07:00:00Z'),
        updatedAt: new Date('2026-08-18T07:00:00Z'),
        primaryBranch: { id: 'branch_1', name: 'Downtown' },
      },
    ],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
  credentials: {
    data: [] as unknown[],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
  issueOptions: undefined as IssueOptions | undefined,
  issueMutate: vi.fn(),
  issueReset: vi.fn(),
  noopMutate: vi.fn(),
  noopReset: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantStaff: {
        list: { invalidate: mocks.invalidate },
        listCredentials: { invalidate: mocks.invalidate },
      },
    }),
    restaurantStaff: {
      list: { useQuery: () => mocks.staff },
      listCredentials: { useQuery: () => mocks.credentials },
      create: {
        useMutation: () => ({
          mutate: mocks.noopMutate,
          reset: mocks.noopReset,
          isPending: false,
          error: null,
        }),
      },
      update: {
        useMutation: () => ({
          mutate: mocks.noopMutate,
          reset: mocks.noopReset,
          isPending: false,
          error: null,
        }),
      },
      setStatus: {
        useMutation: () => ({ mutate: mocks.noopMutate, isPending: false }),
      },
      issueCredential: {
        useMutation: (options: IssueOptions) => {
          mocks.issueOptions = options;
          return {
            mutate: mocks.issueMutate,
            reset: mocks.issueReset,
            isPending: false,
          };
        },
      },
      rotateCredential: {
        useMutation: () => ({
          mutate: mocks.noopMutate,
          reset: mocks.noopReset,
          isPending: false,
        }),
      },
      revokeCredential: {
        useMutation: () => ({
          mutate: mocks.noopMutate,
          reset: mocks.noopReset,
          isPending: false,
          error: null,
        }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantStaffConsole } from './restaurant-staff-console';

const entitlements = {
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: ['restaurant-core'],
  modules: [
    {
      key: 'restaurant-core',
      name: 'Restaurant Core',
      enabled: true,
      source: 'OVERRIDE',
      seatLimit: null,
      expiresAt: null,
    },
  ],
  limits: {},
} as EntitlementView;

describe('Restaurant staff credential UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueOptions = undefined;
    mocks.issueMutate.mockImplementation((_input, options?: IssueCallOptions) => {
      mocks.issueOptions?.onError?.({ message: 'Credential rejected.' });
      options?.onSettled?.();
    });
  });

  it('clears a rejected secret while preserving non-secret credential fields', () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    const type = screen.getByLabelText('Credential type');
    const deviceId = screen.getByLabelText('Device ID (optional)');
    const secret = screen.getByLabelText('New operator secret');
    fireEvent.change(type, { target: { value: 'BADGE' } });
    fireEvent.change(deviceId, { target: { value: 'device_1' } });
    fireEvent.change(secret, { target: { value: 'badge-482913' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    expect(mocks.issueMutate).toHaveBeenCalledWith(
      {
        staffProfileId: 'staff_1',
        type: 'BADGE',
        secret: 'badge-482913',
        deviceId: 'device_1',
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onSettled: expect.any(Function) })
    );
    expect(secret).toHaveValue('');
    expect(type).toHaveValue('BADGE');
    expect(deviceId).toHaveValue('device_1');
    expect(screen.getByRole('alert')).toHaveTextContent('Credential rejected.');
  });

  it('shows loading instead of a false zero staff count', () => {
    mocks.staff.data = [];
    mocks.staff.isLoading = true;

    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Loading staff…' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 3, name: '0 staff members' })
    ).not.toBeInTheDocument();
  });
});
