import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type EnrollmentOptions = {
  onSuccess?: (result: {
    device: { id: string; name: string; branchId: string; status: string };
    enrollmentSecret: string;
  }) => void;
};

type RotationOptions = {
  onSuccess?: (result: { secret: string }) => void;
};

type UiError = { message: string; data?: { code?: string } | null };

type StationOptions = {
  onSuccess?: (result: { id: string; name: string; branchId: string }) => void;
};

const mocks = vi.hoisted(() => ({
  session: { status: 'authenticated', data: { user: { id: 'admin', organizationId: 'org_1' } } },
  inventoryProps: [] as { ownerKey: string; refreshVersion: number }[],
  devices: {
    data: [] as unknown[],
    error: null as unknown,
    isLoading: false,
  },
  approvers: {
    data: undefined as
      | {
          actingStaff: { id: string; displayName: string };
          approvers: { id: string; displayName: string }[];
          selfApprovalAllowed?: boolean;
        }
      | undefined,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
  deviceQueryEnabled: [] as boolean[],
  approverQueries: [] as { deviceId: string; enabled: boolean }[],
  enrollmentOptions: undefined as EnrollmentOptions | undefined,
  rotationOptions: undefined as RotationOptions | undefined,
  enrollmentMutate: vi.fn(),
  enrollmentReset: vi.fn(),
  revokeMutate: vi.fn(),
  revokeReset: vi.fn(),
  rotateMutate: vi.fn(),
  rotateReset: vi.fn(),
  invalidateDevices: vi.fn(),
  invalidateStations: vi.fn(),
  // WHA-1181 (9): a new organization has no KDS station, which is the state the
  // enrollment dialog used to dead-end on.
  stations: {
    data: [] as { id: string; name: string; active: boolean }[],
    error: null as UiError | null,
    isLoading: false,
  },
  createStation: vi.fn(),
  stationOptions: undefined as StationOptions | undefined,
}));

vi.mock('next-auth/react', () => ({ useSession: () => mocks.session }));
vi.mock('./print-bridge-enrollment', () => ({
  PrintBridgeEnrollment: ({ onCreated }: { onCreated: () => void }) => (
    <button onClick={onCreated}>Complete bridge enrollment</button>
  ),
}));
vi.mock('./printer-inventory-panel', () => ({
  PrinterInventoryPanel: (props: { ownerKey: string; refreshVersion: number }) => {
    mocks.inventoryProps.push(props);
    return null;
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantDevices: { list: { invalidate: mocks.invalidateDevices } },
      restaurantFloor: { listStations: { invalidate: mocks.invalidateStations } },
    }),
    restaurantDevices: {
      list: {
        useQuery: (_input: undefined, options: { enabled: boolean }) => {
          mocks.deviceQueryEnabled.push(options.enabled);
          return mocks.devices;
        },
      },
      listApprovers: {
        useQuery: (input: { deviceId: string }, options: { enabled: boolean }) => {
          mocks.approverQueries.push({ deviceId: input.deviceId, enabled: options.enabled });
          return mocks.approvers;
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
      rotate: {
        useMutation: (options: RotationOptions) => {
          mocks.rotationOptions = options;
          return {
            mutate: mocks.rotateMutate,
            reset: mocks.rotateReset,
            isPending: false,
            error: null,
          };
        },
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
    },
    restaurantFloor: {
      listStations: { useQuery: () => mocks.stations },
      createStation: {
        useMutation: (options: StationOptions) => {
          mocks.stationOptions = options;
          return { mutate: mocks.createStation, isPending: false, error: null };
        },
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
    mocks.session = {
      status: 'authenticated',
      data: { user: { id: 'admin', organizationId: 'org_1' } },
    };
    mocks.inventoryProps.length = 0;
    mocks.deviceQueryEnabled.length = 0;
    mocks.approverQueries.length = 0;
    mocks.devices.data = [];
    mocks.devices.error = null;
    mocks.devices.isLoading = false;
    mocks.approvers.data = undefined;
    mocks.approvers.error = null;
    mocks.approvers.isLoading = false;
    mocks.enrollmentOptions = undefined;
    mocks.rotationOptions = undefined;
    mocks.enrollmentMutate.mockImplementation((_input, options?: EnrollmentOptions) => {
      const result = {
        device: { id: 'device_2', name: 'Expo terminal', branchId: 'branch_1', status: 'ACTIVE' },
        enrollmentSecret: 'rdk_once_only',
      };
      mocks.enrollmentOptions?.onSuccess?.(result);
      options?.onSuccess?.(result);
    });
    mocks.rotateMutate.mockImplementation((_input, options?: { onSettled?: () => void }) => {
      mocks.rotationOptions?.onSuccess?.({ secret: 'rdk_rotated_once' });
      options?.onSettled?.();
    });
    mocks.stations = { data: [], error: null, isLoading: false };
    mocks.stationOptions = undefined;
  });

  it('gates queries, clears submitted co-auth secrets, and forgets closed enrollment secrets', () => {
    const disabled = renderConsole(false);
    expect(mocks.deviceQueryEnabled).toEqual([false]);
    expect(mocks.approverQueries).toEqual([{ deviceId: '', enabled: false }]);
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
    mocks.approvers.data = {
      actingStaff: { id: 'staff_1', displayName: 'Acting Admin' },
      approvers: [{ id: 'staff_2', displayName: 'Shift Manager' }],
    };

    const revokeView = renderConsole(true);
    expect(screen.getByText('POS-1')).toBeVisible();
    expect(screen.getByText('Downtown')).toBeVisible();
    expect(screen.queryByText('device_1')).not.toBeInTheDocument();
    expect(screen.queryByText('branch_1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke POS-1' }));
    const approvingStaff = screen.getByLabelText('Approving staff');
    const reason = screen.getByLabelText('Reason');
    expect(screen.getByText('Acting Admin')).toBeVisible();
    fireEvent.change(approvingStaff, { target: { value: 'staff_2' } });
    const approvingSecret = screen.getByLabelText('Approving PIN or badge secret');
    fireEvent.change(approvingSecret, { target: { value: '482913' } });
    fireEvent.change(reason, { target: { value: 'Lost terminal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));

    expect(approvingSecret).toHaveValue('');
    expect(approvingStaff).toHaveValue('staff_2');
    expect(reason).toHaveValue('Lost terminal');
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

  it('lets a solo branch owner approve their own revocation with a PIN only', () => {
    mocks.devices.data = [
      {
        id: 'device_1',
        name: 'Solo POS',
        branch: { id: 'branch_1', name: 'Downtown' },
        status: 'ACTIVE',
        health: 'HEALTHY',
        lastSeenAt: null,
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ];
    mocks.approvers.data = {
      actingStaff: { id: 'staff_1', displayName: 'Solo Owner' },
      approvers: [],
      selfApprovalAllowed: true,
    };

    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Solo POS' }));
    expect(screen.getByText(/approve with your own PIN/)).toBeVisible();
    expect(
      screen.queryByText('No distinct active device manager is eligible to approve this action.')
    ).not.toBeInTheDocument();
    const approvingStaff = screen.getByLabelText('Approving staff');
    expect(screen.getByRole('option', { name: 'Solo Owner (you, PIN only)' })).toBeInTheDocument();
    fireEvent.change(approvingStaff, { target: { value: 'staff_1' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Lost terminal' } });

    // A badge never satisfies the solo-owner exception.
    fireEvent.change(screen.getByLabelText('Approving credential type'), {
      target: { value: 'BADGE' },
    });
    fireEvent.change(screen.getByLabelText('Approving PIN or badge secret'), {
      target: { value: 'badge-value' },
    });
    const confirm = screen.getByRole('button', { name: 'Confirm revocation' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(screen.getByRole('alert')).toHaveTextContent('requires your PIN');
    expect(mocks.revokeMutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Approving credential type'), {
      target: { value: 'PIN' },
    });
    fireEvent.change(screen.getByLabelText('Approving PIN or badge secret'), {
      target: { value: '482913' },
    });
    fireEvent.click(confirm);
    expect(mocks.revokeMutate).toHaveBeenCalledWith(
      {
        deviceId: 'device_1',
        actingStaffProfileId: 'staff_1',
        approvingStaffProfileId: 'staff_1',
        approvingType: 'PIN',
        approvingSecret: '482913',
        reason: 'Lost terminal',
      },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
  });

  it('still refuses self-approval when the server does not allow the solo-owner exception', () => {
    mocks.devices.data = [
      {
        id: 'device_1',
        name: 'Team POS',
        branch: { id: 'branch_1', name: 'Downtown' },
        status: 'ACTIVE',
        health: 'HEALTHY',
        lastSeenAt: null,
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ];
    mocks.approvers.data = {
      actingStaff: { id: 'staff_1', displayName: 'Acting Admin' },
      approvers: [{ id: 'staff_2', displayName: 'Shift Manager' }],
      selfApprovalAllowed: false,
    };

    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Team POS' }));
    expect(
      screen.queryByRole('option', { name: 'Acting Admin (you, PIN only)' })
    ).not.toBeInTheDocument();
  });

  it('scopes printer inventory to the verified owner and refreshes it after enrollment', () => {
    renderConsole(true);
    expect(mocks.inventoryProps.at(-1)).toEqual({ ownerKey: 'org_1:admin', refreshVersion: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Complete bridge enrollment' }));
    expect(mocks.inventoryProps.at(-1)).toEqual({ ownerKey: 'org_1:admin', refreshVersion: 1 });
    expect(mocks.invalidateDevices).toHaveBeenCalledOnce();
  });
  it('withholds printer inventory for disabled, mismatched-owner, and denied sessions', () => {
    const disabled = renderConsole(false);
    expect(mocks.inventoryProps).toHaveLength(0);
    disabled.unmount();
    mocks.session.data.user.organizationId = 'other';
    const mismatch = renderConsole(true);
    expect(mocks.inventoryProps).toHaveLength(0);
    mismatch.unmount();
    mocks.session.data.user.organizationId = 'org_1';
    mocks.devices.error = { data: { code: 'FORBIDDEN' } };
    renderConsole(true);
    expect(mocks.inventoryProps).toHaveLength(0);
  });

  it('shows loading instead of a false zero device count', () => {
    mocks.devices.isLoading = true;

    renderConsole(true);

    expect(screen.getByRole('heading', { level: 2, name: 'Loading devices…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '0 devices' })).not.toBeInTheDocument();
  });

  it('confirms a friendly device and exposes the rotated secret in an accessible one-time state', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mocks.devices.data = [
      {
        id: 'device_1',
        name: 'Kitchen display',
        branch: { id: 'branch_1', name: 'Downtown' },
        status: 'ACTIVE',
        health: 'HEALTHY',
        lastSeenAt: new Date('2026-08-18T08:00:00Z'),
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ];
    mocks.approvers.data = {
      actingStaff: { id: 'staff_1', displayName: 'Acting Admin' },
      approvers: [{ id: 'staff_2', displayName: 'Shift Manager' }],
    };

    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(screen.getByRole('heading', { name: 'Rotate Kitchen display?' })).toBeInTheDocument();
    expect(screen.getByText(/current secret stops working immediately/i)).toBeVisible();
    expect(screen.queryByLabelText('Acting staff')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Approving staff'), { target: { value: 'staff_2' } });
    fireEvent.change(screen.getByLabelText('Approving PIN or badge secret'), {
      target: { value: '482913' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Scheduled rotation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }));

    expect(mocks.rotateMutate).toHaveBeenCalledWith(
      {
        deviceId: 'device_1',
        approvingStaffProfileId: 'staff_2',
        approvingType: 'PIN',
        approvingSecret: '482913',
        reason: 'Scheduled rotation',
      },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );

    expect(screen.getByRole('heading', { name: 'New secret for Kitchen display' })).toBeVisible();
    expect(screen.getByLabelText('One-time device secret')).toHaveValue('rdk_rotated_once');
    expect(screen.getByRole('status')).toHaveTextContent(/only time DevFathom will show/i);
    fireEvent.click(screen.getByRole('button', { name: 'Copy secret' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rdk_rotated_once'));
    expect(screen.getByRole('status')).toHaveTextContent('Secret copied to the clipboard.');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('rdk_rotated_once')).not.toBeInTheDocument();
  });

  it('keeps device actions available without staff-directory access and preserves approver failures', () => {
    mocks.devices.data = [
      {
        id: 'device_1',
        name: 'Devices-only POS',
        branch: { id: 'branch_1', name: 'Downtown' },
        status: 'ACTIVE',
        health: 'HEALTHY',
        lastSeenAt: null,
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ];
    mocks.approvers.isLoading = true;

    const loadingView = renderConsole(true);
    const rotate = screen.getByRole('button', { name: 'Rotate secret' });
    const revoke = screen.getByRole('button', { name: 'Revoke Devices-only POS' });
    expect(rotate).toBeEnabled();
    expect(revoke).toBeEnabled();

    fireEvent.click(rotate);
    expect(mocks.approverQueries.at(-1)).toEqual({ deviceId: 'device_1', enabled: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading eligible approvers');
    expect(screen.getByRole('button', { name: 'Confirm rotation' })).toBeDisabled();
    loadingView.unmount();

    mocks.approvers.isLoading = false;
    mocks.approvers.error = { message: 'Forbidden', data: { code: 'FORBIDDEN' } };
    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Eligible approvers could not be loaded for this device.'
    );
    expect(screen.getByRole('button', { name: 'Confirm rotation' })).toBeDisabled();
  });

  // ── WHA-1181 (9b): the kitchen-display enrollment dead end ─────────────────

  function openKdsEnrollment() {
    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enroll device' }));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.change(screen.getByLabelText('Device kind'), { target: { value: 'KDS' } });
  }

  it('shows the station field only for a kitchen display', () => {
    renderConsole(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enroll device' }));

    // A POS register has no station to pick, so the field must not be there at
    // all — not merely disabled.
    expect(screen.queryByText('KDS station')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Device kind'), { target: { value: 'KDS' } });
    expect(screen.getByText('KDS station')).toBeInTheDocument();
  });

  it('explains what a station is and creates one inline when the branch has none', () => {
    openKdsEnrollment();

    expect(
      screen.getByText(
        'This branch has no KDS station yet. A KDS station is a kitchen screen that receives tickets — e.g. Kitchen, Grill, Bar.'
      )
    ).toBeInTheDocument();
    // No empty required select to dead-end on.
    expect(screen.queryByRole('combobox', { name: 'KDS station' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create station' }));
    expect(mocks.createStation).toHaveBeenCalledWith({ branchId: 'branch_1', name: 'Kitchen' });
  });

  it('selects the station it just created so enrollment can proceed', () => {
    openKdsEnrollment();
    mocks.stations.data = [{ id: 'station_new', name: 'Kitchen', active: true }];

    fireEvent.click(screen.getByRole('button', { name: 'Create station' }));
    act(() =>
      mocks.stationOptions?.onSuccess?.({
        id: 'station_new',
        name: 'Kitchen',
        branchId: 'branch_1',
      })
    );

    expect(screen.getByRole('combobox', { name: 'KDS station' })).toHaveValue('station_new');
  });

  it('says the POS module is missing rather than claiming the branch has no station', () => {
    // Kitchen stations live behind Restaurant POS, so an organization without it
    // gets FORBIDDEN from `listStations`. Rendering the empty state there would
    // point the operator at a Create action that fails for the same reason —
    // the same kind of dead end this whole item is about.
    mocks.stations = {
      data: [],
      error: { message: 'Forbidden', data: { code: 'FORBIDDEN' } },
      isLoading: false,
    };
    openKdsEnrollment();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Kitchen displays need the Restaurant POS module.'
    );
    expect(screen.queryByRole('button', { name: 'Create station' })).not.toBeInTheDocument();
    expect(screen.queryByText(/This branch has no KDS station yet/)).not.toBeInTheDocument();
  });

  it('reports a missing station itself rather than through the browser tooltip', () => {
    mocks.stations.data = [{ id: 'station_grill', name: 'Grill', active: true }];
    openKdsEnrollment();

    const select = screen.getByRole('combobox', { name: 'KDS station' });
    // The native constraint is gone; the form owns the message.
    expect(select).not.toBeRequired();
    fireEvent.submit(select.closest('form')!);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the KDS station this display shows tickets for.'
    );
    expect(select).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(select, { target: { value: 'station_grill' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
