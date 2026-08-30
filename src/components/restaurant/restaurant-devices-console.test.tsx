import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type EnrollmentOptions = {
  onSuccess?: (result: {
    device: { id: string; name: string; branchId: string; status: string };
    enrollmentSecret: string;
  }) => void;
};

const mocks = vi.hoisted(() => ({
  devices: {
    data: [] as unknown[],
    error: null as unknown,
    isLoading: false,
  },
  staff: {
    data: [] as unknown[],
    error: null as unknown,
    isLoading: false,
  },
  deviceQueryEnabled: [] as boolean[],
  staffQueryEnabled: [] as boolean[],
  enrollmentOptions: undefined as EnrollmentOptions | undefined,
  enrollmentMutate: vi.fn(),
  enrollmentReset: vi.fn(),
  revokeMutate: vi.fn(),
  revokeReset: vi.fn(),
  invalidateDevices: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantDevices: { list: { invalidate: mocks.invalidateDevices } } }),
    restaurantDevices: {
      list: {
        useQuery: (_input: undefined, options: { enabled: boolean }) => {
          mocks.deviceQueryEnabled.push(options.enabled);
          return mocks.devices;
        },
      },
      initiateEnrollment: {
        useMutation: (options: EnrollmentOptions) => {
          mocks.enrollmentOptions = options;
          return {
            mutate: mocks.enrollmentMutate,
            reset: mocks.enrollmentReset,
            isPending: false,
            error: null,
          };
        },
      },
      revoke: {
        useMutation: () => ({
          mutate: mocks.revokeMutate,
          reset: mocks.revokeReset,
          isPending: false,
          error: null,
        }),
      },
    },
    restaurantStaff: {
      listBranches: {
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
          error: null,
          isLoading: false,
        }),
      },
      list: {
        useQuery: (_input: undefined, options: { enabled: boolean }) => {
          mocks.staffQueryEnabled.push(options.enabled);
          return mocks.staff;
        },
      },
    },
    restaurantFloor: {
      listStations: {
        useQuery: () => ({ data: [], error: null, isLoading: false }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantDevicesConsole } from './restaurant-devices-console';

function entitlements(enabled: boolean) {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-core'] : [],
    modules: [
      {
        key: 'restaurant-core',
        name: 'Restaurant Core',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  } as EntitlementView;
}

function renderConsole(enabled: boolean) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <RestaurantDevicesConsole />
    </EntitlementsProvider>
  );
}

describe('Restaurant device security UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deviceQueryEnabled.length = 0;
    mocks.staffQueryEnabled.length = 0;
    mocks.devices.data = [];
    mocks.devices.error = null;
    mocks.devices.isLoading = false;
    mocks.staff.data = [];
    mocks.staff.error = null;
    mocks.staff.isLoading = false;
    mocks.enrollmentOptions = undefined;
    mocks.enrollmentMutate.mockImplementation((_input, options?: EnrollmentOptions) => {
      const result = {
        device: { id: 'device_2', name: 'Expo terminal', branchId: 'branch_1', status: 'ACTIVE' },
        enrollmentSecret: 'rdk_once_only',
      };
      mocks.enrollmentOptions?.onSuccess?.(result);
      options?.onSuccess?.(result);
    });
  });

  it('gates queries, clears submitted co-auth secrets, and forgets closed enrollment secrets', () => {
    const disabled = renderConsole(false);
    expect(mocks.deviceQueryEnabled).toEqual([false]);
    expect(mocks.staffQueryEnabled).toEqual([false]);
    expect(screen.queryByRole('button', { name: 'Enroll device' })).not.toBeInTheDocument();
    expect(screen.getByText('Restaurant module disabled')).toBeInTheDocument();
    disabled.unmount();

    mocks.devices.data = [
      {
        id: 'device_1',
        name: 'POS-1',
        branch: { id: 'branch_1', name: 'Downtown' },
        status: 'ACTIVE',
        health: 'HEALTHY',
        lastSeenAt: new Date('2026-08-18T08:00:00Z'),
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ];
    mocks.staff.data = [
      {
        id: 'staff_1',
        displayName: 'Acting Admin',
        status: 'ACTIVE',
        primaryBranch: { id: 'branch_1', name: 'Downtown' },
      },
      {
        id: 'staff_2',
        displayName: 'Shift Manager',
        status: 'ACTIVE',
        primaryBranch: { id: 'branch_1', name: 'Downtown' },
      },
    ];

    const revokeView = renderConsole(true);
    expect(screen.getByText('POS-1')).toBeVisible();
    expect(screen.getByText('Downtown')).toBeVisible();
    expect(screen.queryByText('device_1')).not.toBeInTheDocument();
    expect(screen.queryByText('branch_1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke POS-1' }));
    const actingStaff = screen.getByLabelText('Acting staff');
    const approvingStaff = screen.getByLabelText('Approving staff');
    const reason = screen.getByLabelText('Reason');
    fireEvent.change(actingStaff, { target: { value: 'staff_1' } });
    fireEvent.change(approvingStaff, { target: { value: 'staff_1' } });
    const approvingSecret = screen.getByLabelText('Approving PIN or badge secret');
    fireEvent.change(approvingSecret, { target: { value: '482913' } });
    fireEvent.change(reason, { target: { value: 'Lost terminal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));

    expect(approvingSecret).toHaveValue('');
    expect(actingStaff).toHaveValue('staff_1');
    expect(approvingStaff).toHaveValue('staff_1');
    expect(reason).toHaveValue('Lost terminal');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Acting and approving staff must be different active people.'
    );
    expect(mocks.revokeMutate).not.toHaveBeenCalled();

    fireEvent.change(approvingStaff, { target: { value: 'staff_2' } });
    fireEvent.change(approvingSecret, { target: { value: '482913' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));

    expect(approvingSecret).toHaveValue('');
    expect(mocks.revokeMutate).toHaveBeenCalledWith(
      {
        deviceId: 'device_1',
        actingStaffProfileId: 'staff_1',
        approvingStaffProfileId: 'staff_2',
        approvingType: 'PIN',
        approvingSecret: '482913',
        reason: 'Lost terminal',
      },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    revokeView.unmount();

    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enroll device' }));
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Expo terminal' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    const confirmation = screen.getByRole('checkbox', {
      name: /sign out of administration and open only as this terminal/,
    });
    fireEvent.click(confirmation);

    const enrollButton = screen.getByRole('button', { name: 'Enroll this browser' });
    expect(enrollButton).toHaveAttribute('type', 'submit');
    expect(enrollButton.closest('form')).toHaveAttribute(
      'action',
      '/api/restaurant/devices/browser-enroll'
    );
    expect(confirmation).toBeChecked();
    expect(document.body.textContent).not.toContain('rdk_');
    expect(mocks.enrollmentMutate).not.toHaveBeenCalled();
  });

  it('shows loading instead of a false zero device count', () => {
    mocks.devices.isLoading = true;

    renderConsole(true);

    expect(screen.getByRole('heading', { level: 3, name: 'Loading devices…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: '0 devices' })).not.toBeInTheDocument();
  });
});
