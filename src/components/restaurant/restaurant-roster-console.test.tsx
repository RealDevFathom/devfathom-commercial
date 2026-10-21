import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  roster: {
    data: [] as unknown[],
    error: null as { message: string; data?: { code?: string } } | null,
    isLoading: false,
    refetch: vi.fn(),
  },
  staff: {
    data: [
      {
        id: 'staff_1',
        displayName: 'Shift Lead',
        email: null,
        userId: null,
        primaryBranchId: 'branch_1',
        status: 'ACTIVE',
        createdAt: new Date('2026-08-18T07:00:00Z'),
        updatedAt: new Date('2026-08-18T07:00:00Z'),
        primaryBranch: { id: 'branch_1', name: 'Downtown' },
      },
    ] as unknown[],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
  mine: {
    data: { actor: { id: 'staff_1', displayName: 'Shift Lead' }, shifts: [] as unknown[] },
    error: null as { message: string; data?: { code?: string } } | null,
    isLoading: false,
  },
  createMutate: vi.fn(),
  cancelMutate: vi.fn(),
  clockInMutate: vi.fn(),
  requestSwapMutate: vi.fn(),
  reviewSwapMutate: vi.fn(),
  noop: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantShifts: {
        list: { invalidate: mocks.invalidate },
        managerRoster: { invalidate: mocks.invalidate },
        myRoster: { invalidate: mocks.invalidate },
        exportAttendanceCsv: { fetch: vi.fn() },
      },
    }),
    restaurantShifts: {
      list: { useQuery: () => mocks.roster },
      managerRoster: { useQuery: () => mocks.roster },
      myRoster: { useQuery: () => mocks.mine },
      swapCandidates: {
        useQuery: () => ({
          data: [{ id: 'staff_2', displayName: 'Kitchen Colleague' }],
          error: null,
          isLoading: false,
        }),
      },
      create: {
        useMutation: () => ({
          mutate: mocks.createMutate,
          reset: mocks.noop,
          isPending: false,
          error: null,
        }),
      },
      update: {
        useMutation: () => ({
          mutate: mocks.noop,
          reset: mocks.noop,
          isPending: false,
          error: null,
        }),
      },
      cancel: {
        useMutation: () => ({
          mutate: mocks.cancelMutate,
          reset: mocks.noop,
          isPending: false,
          error: null,
        }),
      },
      clockIn: { useMutation: () => ({ mutate: mocks.clockInMutate, isPending: false }) },
      startBreak: { useMutation: () => ({ mutate: mocks.noop, isPending: false }) },
      endBreak: { useMutation: () => ({ mutate: mocks.noop, isPending: false }) },
      clockOut: { useMutation: () => ({ mutate: mocks.noop, isPending: false }) },
      requestSwap: { useMutation: () => ({ mutate: mocks.requestSwapMutate, isPending: false }) },
      reviewSwap: { useMutation: () => ({ mutate: mocks.reviewSwapMutate, isPending: false }) },
      correctTime: {
        useMutation: () => ({ mutate: mocks.noop, isPending: false, error: null }),
      },
    },
    restaurantStaff: {
      list: { useQuery: () => mocks.staff },
      listBranches: {
        useQuery: () => ({
          data: [
            { id: 'branch_1', name: 'Downtown', timezone: 'UTC', active: true, isDefault: true },
          ],
          error: null,
          isLoading: false,
        }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantRosterConsole } from './restaurant-roster-console';

const entitlements = {
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: ['restaurant-core', 'restaurant-workforce'],
  modules: [
    {
      key: 'restaurant-core',
      name: 'Restaurant Core',
      enabled: true,
      source: 'OVERRIDE',
      seatLimit: null,
      expiresAt: null,
    },
    {
      key: 'restaurant-workforce',
      name: 'Restaurant Workforce',
      enabled: true,
      source: 'OVERRIDE',
      seatLimit: null,
      expiresAt: null,
    },
  ],
  limits: {},
} as EntitlementView;

function renderConsole(value: EntitlementView = entitlements) {
  return render(
    <EntitlementsProvider value={value}>
      <RestaurantRosterConsole />
    </EntitlementsProvider>
  );
}

function chooseBranch() {
  fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
}

const SHIFT = {
  id: 'shift_1',
  branchId: 'branch_1',
  staffProfileId: 'staff_1',
  businessDate: new Date('2026-08-20T00:00:00Z'),
  startAt: new Date('2026-08-20T09:00:00Z'),
  endAt: new Date('2026-08-20T17:00:00Z'),
  role: 'Cashier',
  notes: null,
  status: 'SCHEDULED',
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  createdAt: new Date('2026-08-19T00:00:00Z'),
  updatedAt: new Date('2026-08-19T00:00:00Z'),
  clockedInAt: null,
  clockedOutAt: null,
  breaks: [],
  adjustments: [],
  swapRequests: [],
  attendanceStatus: 'SCHEDULED',
  lateMinutes: 0,
  lateThresholdMinutes: 5,
  branch: { id: 'branch_1', name: 'Downtown', timezone: 'UTC' },
  staffProfile: { id: 'staff_1', displayName: 'Shift Lead', status: 'ACTIVE' },
};

describe('Restaurant roster console', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.roster.data = [];
    mocks.roster.error = null;
    mocks.roster.isLoading = false;
    mocks.staff.isLoading = false;
    mocks.mine.data = { actor: { id: 'staff_1', displayName: 'Shift Lead' }, shifts: [] };
    mocks.mine.error = null;
    mocks.mine.isLoading = false;
  });

  it('asks for a branch before claiming the roster is empty', () => {
    renderConsole();
    expect(screen.getByRole('heading', { level: 2, name: 'Choose a branch' })).toBeInTheDocument();
    expect(screen.getByText('No branch selected.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule shift' })).not.toBeInTheDocument();
  });

  it('shows loading instead of a false zero-shift count', () => {
    mocks.roster.isLoading = true;
    renderConsole();
    chooseBranch();
    expect(screen.getByRole('heading', { level: 2, name: 'Loading roster…' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: '0 scheduled shifts' })
    ).not.toBeInTheDocument();
  });

  it('offers a retry when the roster read fails', () => {
    mocks.roster.error = { message: 'boom' };
    renderConsole();
    chooseBranch();
    expect(screen.getByRole('alert')).toHaveTextContent('The roster could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.roster.refetch).toHaveBeenCalled();
  });

  it('states the permission-denied case instead of an empty table', () => {
    mocks.roster.error = { message: 'no', data: { code: 'FORBIDDEN' } };
    renderConsole();
    chooseBranch();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You do not have permission to manage restaurant shifts.'
    );
  });

  it('keeps Core scheduling available when the Workforce module is disabled', () => {
    renderConsole({
      ...entitlements,
      enabledModules: ['restaurant-core'],
      modules: entitlements.modules.filter((module) => module.key === 'restaurant-core'),
    } as EntitlementView);
    expect(screen.getByRole('status')).toHaveTextContent('Disabled');
    expect(screen.queryByRole('heading', { name: 'Employee timekeeping' })).not.toBeInTheDocument();
    chooseBranch();
    expect(screen.getByRole('button', { name: 'Schedule shift' })).toBeInTheDocument();
  });

  it('schedules a shift with the selected operator and the entered window', () => {
    renderConsole();
    chooseBranch();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule shift' }));
    fireEvent.change(screen.getByLabelText('Starts'), {
      target: { value: '2026-08-20T09:00' },
    });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-08-20T17:00' } });
    fireEvent.change(screen.getByLabelText('Role (optional)'), { target: { value: ' Cashier ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule shift', hidden: false }));

    const call = mocks.createMutate.mock.calls.at(-1)?.[0];
    expect(call).toMatchObject({
      branchId: 'branch_1',
      staffProfileId: 'staff_1',
      role: 'Cashier',
      notes: null,
    });
    expect(call.startAt).toEqual(new Date('2026-08-20T09:00:00Z'));
    expect(call.endAt).toEqual(new Date('2026-08-20T17:00:00Z'));
  });

  it('renders a cancelled shift as cancelled and locks its row actions', () => {
    mocks.roster.data = [
      {
        ...SHIFT,
        status: 'CANCELLED',
        attendanceStatus: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'Storm closure',
      },
    ];
    renderConsole();
    chooseBranch();
    expect(screen.getByText('CANCELLED')).toBeInTheDocument();
    expect(screen.getByText('Storm closure')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel shift' })).toBeDisabled();
    // A cancelled shift is not counted as scheduled.
    expect(
      screen.getByRole('heading', { level: 2, name: '0 scheduled shifts' })
    ).toBeInTheDocument();
  });

  it('confirms a cancellation and forwards the reason', () => {
    mocks.roster.data = [SHIFT];
    renderConsole();
    chooseBranch();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel shift' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'Called in sick' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel shift', hidden: false }));
    expect(mocks.cancelMutate).toHaveBeenCalledWith({
      id: 'shift_1',
      expectedVersion: SHIFT.version,
      reason: 'Called in sick',
    });
  });

  it('renders an employee path with readable names and server punch actions', () => {
    mocks.mine.data = {
      actor: { id: 'staff_1', displayName: 'Shift Lead' },
      shifts: [SHIFT],
    };
    const { container } = renderConsole();
    expect(screen.getByText('Downtown · Cashier')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.clockInMutate).toHaveBeenCalledWith(
      expect.objectContaining({ shiftId: 'shift_1', idempotencyKey: expect.any(String) })
    );
    expect(container).not.toHaveTextContent('branch_1');
    expect(container).not.toHaveTextContent('staff_1');
  });

  it('lets an employee request a same-branch colleague by name', () => {
    mocks.mine.data = {
      actor: { id: 'staff_1', displayName: 'Shift Lead' },
      shifts: [SHIFT],
    };
    renderConsole();
    fireEvent.change(screen.getByLabelText('Replacement employee'), {
      target: { value: 'staff_2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request swap' }));
    expect(mocks.requestSwapMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        shiftId: 'shift_1',
        replacementStaffProfileId: 'staff_2',
        idempotencyKey: expect.any(String),
      })
    );
  });

  it('gives managers labelled approve and reject actions for a pending swap', () => {
    mocks.roster.data = [
      {
        ...SHIFT,
        swapRequests: [
          {
            id: 'swap_1',
            note: 'Family appointment',
            createdAt: new Date('2026-08-19T08:00:00Z'),
            requestedBy: { id: 'staff_1', displayName: 'Shift Lead' },
            replacement: { id: 'staff_2', displayName: 'Kitchen Colleague' },
            decision: null,
          },
        ],
      },
    ];
    renderConsole();
    chooseBranch();

    expect(screen.getByText(/Shift Lead → Kitchen Colleague/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve swap for Shift Lead' }));
    expect(mocks.reviewSwapMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'swap_1',
        branchId: 'branch_1',
        decision: 'APPROVED',
        idempotencyKey: expect.any(String),
      })
    );
  });
});
