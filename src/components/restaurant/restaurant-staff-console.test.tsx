import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type IssueOptions = { onError?: (error: { message: string }) => void };
type IssueCallOptions = { onSettled?: () => void };
type MutationOptions = {
  onSuccess?: (result: {
    granted: string[];
    revoked: string[];
    overrides?: unknown[];
  }) => void | Promise<void>;
  onError?: (error: { message: string }) => void;
};

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
  roleSave: vi.fn(),
  roleSaveOptions: undefined as MutationOptions | undefined,
  setOverride: vi.fn(),
  clearOverride: vi.fn(),
  seedRoles: vi.fn(),
  /** Job roles the dialog's `listJobRoles` query answers with. */
  jobRoles: [] as unknown[],
  heldRoles: [] as { jobRole: { id: string } }[],
  extraBranches: [] as { id: string; name: string; active: boolean; isDefault: boolean }[],
  /** The committed override state the staged changes sit on top of. */
  access: {
    data: { capabilities: [], inherited: [], allowed: [] as string[], denied: [] as string[] },
    error: null,
    isLoading: false,
  },
  eligibleUsers: [
    {
      id: 'user_available',
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      status: 'ACTIVE',
      restaurantStaffProfiles: [],
    },
    {
      id: 'user_linked',
      name: 'Bilal Ahmed',
      email: 'bilal@example.com',
      status: 'ACTIVE',
      restaurantStaffProfiles: [{ id: 'staff_other', displayName: 'Sous Chef' }],
    },
  ],
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantStaff: {
        list: { invalidate: mocks.invalidate },
        listCredentials: { invalidate: mocks.invalidate },
        // SOP-1: the job-roles dialog invalidates its own two queries on save.
        listStaffJobRoles: { invalidate: mocks.invalidate },
        listStaffJobRoleAudit: { invalidate: mocks.invalidate },
        resolveStaffCapabilities: { invalidate: mocks.invalidate },
        listJobRoles: { invalidate: mocks.invalidate },
      },
    }),
    restaurantStaff: {
      list: { useQuery: () => mocks.staff },
      listEligibleUsers: {
        useQuery: () => ({ data: mocks.eligibleUsers, error: null, isLoading: false }),
      },
      listBranches: {
        useQuery: () => ({
          data: [
            { id: 'branch_1', name: 'Downtown', active: true, isDefault: true },
            ...mocks.extraBranches,
          ],
          error: null,
          isLoading: false,
        }),
      },
      listCredentials: { useQuery: () => mocks.credentials },
      // SOP-1: the job-roles dialog is mounted (closed) by the console, so its
      // hooks must resolve even though these cases never open it.
      listJobRoles: {
        useQuery: () => ({ data: mocks.jobRoles, error: null, isLoading: false }),
      },
      listStaffJobRoles: { useQuery: () => ({ data: mocks.heldRoles, isLoading: false }) },
      listStaffJobRoleAudit: { useQuery: () => ({ data: [], isLoading: false }) },
      resolveStaffCapabilities: { useQuery: () => mocks.access },
      // WHA-1181 (7)/(8): the dialog commits role selection AND staged direct /
      // deny changes through this one mutation.
      setStaffAccess: {
        useMutation: (options: MutationOptions) => {
          mocks.roleSaveOptions = options;
          return { mutate: mocks.roleSave, isPending: false };
        },
      },
      seedDefaultJobRoles: {
        useMutation: () => ({ mutate: mocks.seedRoles, isPending: false, error: null }),
      },
      setStaffJobRoles: {
        useMutation: () => ({ mutate: mocks.noopMutate, isPending: false }),
      },
      setStaffCapabilityOverride: {
        useMutation: () => ({ mutate: mocks.setOverride, isPending: false }),
      },
      clearStaffCapabilityOverride: {
        useMutation: () => ({ mutate: mocks.clearOverride, isPending: false }),
      },
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
    restaurantDevices: {
      list: {
        useQuery: () => ({
          data: [
            {
              id: 'device_1',
              name: 'Front Register',
              branch: { id: 'branch_1', name: 'Downtown' },
              status: 'ACTIVE',
            },
          ],
          error: null,
          isLoading: false,
        }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
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
  it('shows the branch name without exposing its ID and preserves branch selection', () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );

    const row = screen.getByRole('row', { name: /Shift Lead/ });
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent(/^Downtown$/);
    expect(document.body).not.toHaveTextContent('branch_1');

    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(screen.getByRole('row', { name: /Shift Lead/ })).toBeVisible();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit staff member' });
    expect(within(dialog).getByLabelText('Primary branch')).toHaveValue('branch_1');
  });

  it.each([false, true])(
    'offers the Team invitation path when the user directory is empty: %s',
    (empty) => {
      const users = mocks.eligibleUsers;
      if (empty) mocks.eligibleUsers = [];
      try {
        render(
          <EntitlementsProvider value={entitlements}>
            <RestaurantStaffConsole />
          </EntitlementsProvider>
        );
        fireEvent.click(screen.getByRole('button', { name: 'Add staff member' }));
        const dialog = screen.getByRole('dialog', { name: 'Add staff member' });
        expect(within(dialog).getByRole('link', { name: 'Invite from Team' })).toHaveAttribute(
          'href',
          '/team'
        );
        expect(dialog).toHaveTextContent('organization administrator');
        expect(dialog).toHaveTextContent('After they accept');
        expect(dialog).toHaveTextContent('Job roles');
        expect(mocks.noopMutate).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(screen.queryByRole('link', { name: 'Invite from Team' })).not.toBeInTheDocument();
      } finally {
        mocks.eligibleUsers = users;
      }
    }
  );

  it('selects organization users by human identity and marks linked users unavailable', () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add staff member' }));
    const dialog = screen.getByRole('dialog', { name: 'Add staff member' });
    const selector = within(dialog).getByLabelText('Organization user');
    expect(
      within(selector).getByRole('option', { name: 'Ayesha Khan — ayesha@example.com' })
    ).toBeEnabled();
    expect(
      within(selector).getByRole('option', {
        name: 'Bilal Ahmed — bilal@example.com — linked to Sous Chef',
      })
    ).toBeDisabled();
    expect(within(dialog).queryByText(/linked user id/i)).not.toBeInTheDocument();
  });

  it.each(['create', 'edit'] as const)(
    'can %s with an unlisted account using its exact email',
    (operation) => {
      const users = mocks.eligibleUsers;
      // The real branch-scoped directory has no selectable unlinked accounts.
      mocks.eligibleUsers = users.filter((user) => user.restaurantStaffProfiles.length > 0);
      try {
        render(
          <EntitlementsProvider value={entitlements}>
            <RestaurantStaffConsole />
          </EntitlementsProvider>
        );
        fireEvent.click(
          screen.getByRole('button', {
            name: operation === 'create' ? 'Add staff member' : 'Edit',
          })
        );
        const dialog = screen.getByRole('dialog');
        const selector = within(dialog).getByLabelText('Organization user');
        const emailOption = within(selector).getByRole('option', { name: /Link an unlisted user/ });
        expect(emailOption).toBeEnabled();
        fireEvent.change(selector, { target: { value: (emailOption as HTMLOptionElement).value } });
        fireEvent.change(within(dialog).getByLabelText('Organization account email'), {
          target: { value: 'unlisted@example.com' },
        });
        fireEvent.change(within(dialog).getByLabelText('Display name'), {
          target: { value: 'New colleague' },
        });
        fireEvent.change(within(dialog).getByLabelText('Primary branch'), {
          target: { value: 'branch_1' },
        });
        fireEvent.submit(within(dialog).getByLabelText('Display name').closest('form')!);
        expect(mocks.noopMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            ...(operation === 'edit' ? { id: 'staff_1' } : {}),
            displayName: 'New colleague',
            primaryBranchId: 'branch_1',
            userEmail: 'unlisted@example.com',
          })
        );
        expect(mocks.noopMutate.mock.calls[0][0]).not.toHaveProperty('userId');

        fireEvent.change(selector, { target: { value: '' } });
        expect(
          within(dialog).queryByLabelText('Organization account email')
        ).not.toBeInTheDocument();
        fireEvent.submit(within(dialog).getByLabelText('Display name').closest('form')!);
        expect(mocks.noopMutate).toHaveBeenLastCalledWith(
          expect.objectContaining({ userId: null })
        );
        expect(mocks.noopMutate.mock.lastCall?.[0]).not.toHaveProperty('userEmail');
      } finally {
        mocks.eligibleUsers = users;
      }
    }
  );
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
    const deviceId = screen.getByLabelText('Device restriction');
    const secret = screen.getByLabelText('New operator secret');
    fireEvent.change(type, { target: { value: 'BADGE' } });
    fireEvent.change(deviceId, { target: { value: 'device_1' } });
    expect(screen.getByText('Front Register — Downtown')).toBeVisible();
    expect(screen.queryByText('device_1')).not.toBeInTheDocument();
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

    expect(screen.getByRole('heading', { level: 2, name: 'Loading staff…' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: '0 staff members' })
    ).not.toBeInTheDocument();
  });
});

const JOB_ROLES = [
  {
    id: 'cashier',
    key: 'cashier',
    name: 'Cashier',
    isSystem: true,
    description: '',
    capabilities: [{ capability: 'pos:operate' }, { capability: 'payments:collect' }],
  },
  {
    id: 'server',
    key: 'server',
    name: 'Server',
    isSystem: true,
    description: '',
    capabilities: [{ capability: 'orders:read' }, { capability: 'customers:read' }],
  },
];

describe('Restaurant staff role profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.roleSaveOptions = undefined;
    mocks.heldRoles = [];
    mocks.extraBranches = [];
    mocks.invalidate.mockReset();
    mocks.jobRoles = JOB_ROLES;
    mocks.access = {
      data: { capabilities: [], inherited: [], allowed: [], denied: [] },
      error: null,
      isLoading: false,
    };
    mocks.staff.data = [
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
    ];
    mocks.staff.isLoading = false;
  });

  function openProfile() {
    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Job roles' }));
  }

  it('double clicks send one access command while the first save is in flight', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    const save = screen.getByRole('button', { name: 'Save 1 change' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(mocks.roleSave).toHaveBeenCalledTimes(1);
  });

  it('edits made after submit survive the first success', async () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    fireEvent.click(screen.getByRole('button', { name: /Server/ }));
    fireEvent.click(within(discount).getByRole('button', { name: 'Deny' }));
    await act(async () => {
      await mocks.roleSaveOptions?.onSuccess?.({ granted: [], revoked: [], overrides: [] });
    });
    expect(screen.getByRole('button', { name: /Server/ })).toHaveAttribute('aria-pressed', 'true');
    expect(discount).toHaveAttribute('data-pending', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(mocks.roleSave).toHaveBeenCalledTimes(2);
    expect(mocks.roleSave.mock.calls[1]![0].overrides).toContainEqual({
      capability: 'orders:discount',
      effect: 'DENY',
    });
  });

  it('blocks override-only resave until delayed refetch preserves Cashier and converges', async () => {
    let finishRefetch!: () => void;
    const refetch = new Promise<void>((resolve) => {
      finishRefetch = resolve;
    });
    mocks.invalidate.mockReturnValue(refetch);
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    fireEvent.click(within(discount).getByRole('button', { name: 'Deny' }));
    let success: void | Promise<void>;
    act(() => {
      success = mocks.roleSaveOptions?.onSuccess?.({
        granted: ['cashier'],
        revoked: [],
        overrides: [],
      });
    });
    expect(mocks.heldRoles).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(mocks.roleSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Cashier/ })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      mocks.heldRoles = [{ jobRole: { id: 'cashier' } }];
      mocks.access.data.allowed = ['orders:discount'];
      finishRefetch();
      await success;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(mocks.roleSave).toHaveBeenNthCalledWith(2, {
      staffProfileId: 'staff_1',
      branchId: 'branch_1',
      jobRoleIds: ['cashier'],
      overrides: [{ capability: 'orders:discount', effect: 'DENY' }],
    });
    expect(mocks.invalidate).toHaveBeenNthCalledWith(1, {
      staffProfileId: 'staff_1',
      branchId: 'branch_1',
    });
    expect(mocks.invalidate).toHaveBeenNthCalledWith(2, {
      staffProfileId: 'staff_1',
      branchId: 'branch_1',
    });
    await act(async () => {
      mocks.access.data = {
        capabilities: [],
        inherited: [],
        allowed: [],
        denied: ['orders:discount'],
      };
      await mocks.roleSaveOptions?.onSuccess?.({ granted: [], revoked: [], overrides: [] });
    });
    expect(screen.getByRole('button', { name: 'Save role profiles' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cashier/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('delayed success invalidates its submitted branch without clearing the new branch draft', async () => {
    mocks.extraBranches = [{ id: 'branch_2', name: 'Uptown', active: true, isDefault: false }];
    let finishRefetch!: () => void;
    mocks.invalidate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRefetch = resolve;
      })
    );
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    let success: void | Promise<void>;
    act(() => {
      success = mocks.roleSaveOptions?.onSuccess?.({
        granted: ['cashier'],
        revoked: [],
        overrides: [],
      });
    });
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Branch' }), {
      target: { value: 'branch_2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Server/ }));
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Deny' }));
    await act(async () => {
      finishRefetch();
      await success;
    });
    expect(screen.getByRole('button', { name: /Cashier/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: /Server/ })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.invalidate).toHaveBeenNthCalledWith(1, {
      staffProfileId: 'staff_1',
      branchId: 'branch_1',
    });
    expect(mocks.invalidate).toHaveBeenNthCalledWith(2, {
      staffProfileId: 'staff_1',
      branchId: 'branch_1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(mocks.roleSave).toHaveBeenNthCalledWith(2, {
      staffProfileId: 'staff_1',
      branchId: 'branch_2',
      jobRoleIds: ['server'],
      overrides: [{ capability: 'orders:discount', effect: 'DENY' }],
    });
  });

  it('previews Cashier inherited defaults, supports multi-role selection, and survives filtering', () => {
    openProfile();
    const cashier = screen.getByRole('button', { name: /Cashier/ });
    const server = screen.getByRole('button', { name: /Server/ });
    fireEvent.click(cashier);
    expect(cashier).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('pos:operate').parentElement).toHaveTextContent('Inherited');
    fireEvent.click(server);
    expect(server).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('customers:read').parentElement).toHaveTextContent('Inherited');
    fireEvent.change(screen.getByPlaceholderText('Search capabilities'), {
      target: { value: 'cash:' },
    });
    fireEvent.change(screen.getByPlaceholderText('Search capabilities'), { target: { value: '' } });
    expect(cashier).toHaveAttribute('aria-pressed', 'true');
  });

  // WHA-1181 (7): the row repaints on click with no request in flight.
  it('flips Direct and Deny optimistically, sending nothing until the single save', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));

    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    // Instant: pressed state and provenance badge, before any server answer.
    expect(within(discount).getByRole('button', { name: 'Direct' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(discount).toHaveTextContent('Direct');
    expect(discount).toHaveAttribute('data-pending', 'true');

    const pos = screen.getByText('pos:operate').parentElement!;
    fireEvent.click(within(pos).getByRole('button', { name: 'Deny' }));
    expect(pos).toHaveTextContent('Denied');

    // The per-click mutations are gone; nothing reached the server yet.
    expect(mocks.setOverride).not.toHaveBeenCalled();
    expect(mocks.clearOverride).not.toHaveBeenCalled();
    expect(mocks.roleSave).not.toHaveBeenCalled();
  });

  // WHA-1181 (8): one button commits everything, labelled with the count.
  it('counts role and capability changes together and commits them in one command', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeEnabled();

    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    const pos = screen.getByText('pos:operate').parentElement!;
    fireEvent.click(within(pos).getByRole('button', { name: 'Deny' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save 3 changes' }));
    expect(mocks.roleSave).toHaveBeenCalledTimes(1);
    expect(mocks.roleSave).toHaveBeenCalledWith(
      expect.objectContaining({
        jobRoleIds: ['cashier'],
        overrides: expect.arrayContaining([
          { capability: 'orders:discount', effect: 'ALLOW' },
          { capability: 'pos:operate', effect: 'DENY' },
        ]),
      })
    );
  });

  it('does not count a capability toggled back to where it started', () => {
    openProfile();
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeInTheDocument();
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    // Back to the committed state: nothing to save, so the button reverts to
    // its idle label and is disabled again.
    expect(screen.getByRole('button', { name: 'Save role profiles' })).toBeDisabled();
  });

  it('rolls back to the server state and pins an inline row error when the commit fails', () => {
    openProfile();
    const cashier = screen.getByRole('button', { name: /Cashier/ });
    fireEvent.click(cashier);
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    act(() => mocks.roleSaveOptions?.onError?.({ message: 'Save failed.' }));

    // Nothing was written, so the base is still the server's answer — and the
    // operator's staged intent survives so a retry sends the same thing.
    expect(screen.getByText('Nothing was saved; your changes are still here.', { exact: false }));
    expect(within(discount).getByRole('alert')).toHaveTextContent('Not saved');
    expect(cashier).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(mocks.roleSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        jobRoleIds: ['cashier'],
        overrides: [{ capability: 'orders:discount', effect: 'ALLOW' }],
      })
    );
  });

  // WHA-1181 (6): the bulk actions, and roles staying the primary path.
  it('stages every capability as a direct exception behind a confirmation', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Grant all as direct exceptions' }));
    // Confirmation first — nothing is staged by opening it.
    expect(screen.getByRole('button', { name: 'Save role profiles' })).toBeDisabled();
    const confirm = screen.getByRole('alertdialog', {
      name: 'Confirm granting every capability directly',
    });
    expect(confirm).toHaveTextContent('a role profile is the better tool');

    fireEvent.click(within(confirm).getByRole('button', { name: 'Grant all as direct' }));
    fireEvent.click(
      screen.getByRole('button', { name: `Save ${RESTAURANT_CAPABILITIES.length} changes` })
    );
    const overrides = mocks.roleSave.mock.calls[0]![0].overrides as {
      capability: string;
      effect: string | null;
    }[];
    expect(overrides).toHaveLength(RESTAURANT_CAPABILITIES.length);
    expect(overrides.every((override) => override.effect === 'ALLOW')).toBe(true);
  });

  it('cancels the grant-all confirmation without staging anything', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Grant all as direct exceptions' }));
    fireEvent.click(
      within(
        screen.getByRole('alertdialog', { name: 'Confirm granting every capability directly' })
      ).getByRole('button', { name: 'Cancel' })
    );
    expect(screen.getByRole('button', { name: 'Save role profiles' })).toBeDisabled();
  });

  it('clears direct exceptions without re-granting anything an operator denied', () => {
    mocks.access = {
      data: {
        capabilities: [],
        inherited: [],
        allowed: ['orders:discount'],
        denied: ['cash:open'],
      },
      error: null,
      isLoading: false,
    };
    openProfile();

    fireEvent.click(screen.getByRole('button', { name: 'Clear direct exceptions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));

    expect(mocks.roleSave.mock.calls[0]![0].overrides).toEqual([
      { capability: 'orders:discount', effect: null },
    ]);
  });

  it('asks before discarding pending changes on close', async () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);

    const prompt = screen.getByRole('alertdialog', { name: 'Discard unsaved changes' });
    expect(prompt).toHaveTextContent('Discard 1 unsaved change?');
    // "Keep editing" leaves the dialog open with the change intact.
    fireEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('button', { name: /Cashier/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes without a prompt when nothing is pending', async () => {
    openProfile();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers the role seed inline instead of pointing at a page that does not exist', () => {
    mocks.jobRoles = [];
    openProfile();

    expect(screen.getByText(/No active role profiles exist/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add the default role profiles' }));
    expect(mocks.seedRoles).toHaveBeenCalledOnce();
  });

  it('uses an opaque modal, traps focus, closes with Escape, and restores trigger focus', async () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <RestaurantStaffConsole />
      </EntitlementsProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Job roles' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Shift Lead — role profile' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass('bg-surface-page');
    expect(trigger.closest('[aria-hidden="true"]')).toHaveAttribute('data-base-ui-inert');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    const save = within(dialog).getByRole('button', { name: 'Save role profiles' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const close = within(dialog).getAllByRole('button', { name: 'Close' })[0]!;
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('pins AA text tokens and an internal mobile scroll region', () => {
    openProfile();
    const dialog = screen.getByRole('dialog', { name: 'Shift Lead — role profile' });
    expect(dialog).toHaveClass(
      'max-h-[calc(100dvh-2rem)]',
      'grid-rows-[auto_minmax(0,1fr)_auto]',
      'overflow-hidden'
    );
    expect(screen.getByTestId('role-dialog-scroll-region')).toHaveClass(
      'min-h-0',
      'overflow-y-auto'
    );
    for (const count of screen.getAllByText('2 inherited capabilities')) {
      expect(count).toHaveClass('text-text-strong');
    }
    expect(screen.getByText('Inherited from role')).toHaveClass('!text-text-strong');
  });

  it('keeps the open role dialog heading outline contiguous', () => {
    openProfile();
    const headings = [...document.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6')]
      .filter((heading) => !heading.hidden)
      .map((heading) => ({ level: Number(heading.tagName.slice(1)), name: heading.textContent }));

    expect(headings).toEqual([
      { level: 1, name: 'Staff' },
      { level: 2, name: '1 staff member' },
      { level: 2, name: 'Shift Lead — role profile' },
      { level: 3, name: 'Role profiles' },
      { level: 3, name: 'Capabilities' },
    ]);
    expect(
      headings.every(
        (heading, index) => index === 0 || heading.level <= headings[index - 1]!.level + 1
      )
    ).toBe(true);
  });
});
