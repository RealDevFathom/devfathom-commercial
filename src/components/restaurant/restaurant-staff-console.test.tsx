import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type IssueOptions = { onError?: (error: { message: string }) => void };
type IssueCallOptions = { onSettled?: () => void };
type MutationOptions = {
  onSuccess?: (result: { granted: string[]; revoked: string[] }) => void;
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
      },
    }),
    restaurantStaff: {
      list: { useQuery: () => mocks.staff },
      listEligibleUsers: {
        useQuery: () => ({ data: mocks.eligibleUsers, error: null, isLoading: false }),
      },
      listBranches: {
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
          error: null,
          isLoading: false,
        }),
      },
      listCredentials: { useQuery: () => mocks.credentials },
      // SOP-1: the job-roles dialog is mounted (closed) by the console, so its
      // hooks must resolve even though these cases never open it.
      listJobRoles: {
        useQuery: () => ({
          data: [
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
          ],
          error: null,
          isLoading: false,
        }),
      },
      listStaffJobRoles: { useQuery: () => ({ data: [], isLoading: false }) },
      listStaffJobRoleAudit: { useQuery: () => ({ data: [], isLoading: false }) },
      resolveStaffCapabilities: {
        useQuery: () => ({
          data: { capabilities: [], inherited: [], allowed: [], denied: [] },
          error: null,
          isLoading: false,
        }),
      },
      setStaffJobRoles: {
        useMutation: (options: MutationOptions) => {
          mocks.roleSaveOptions = options;
          return { mutate: mocks.roleSave, isPending: false };
        },
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

describe('Restaurant staff role profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.roleSaveOptions = undefined;
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

  it('adds a direct discount and denies an inherited capability with pressed buttons', () => {
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: /Cashier/ }));
    const discount = screen.getByText('orders:discount').parentElement!;
    fireEvent.click(within(discount).getByRole('button', { name: 'Direct' }));
    expect(mocks.setOverride).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'orders:discount', effect: 'ALLOW' })
    );
    const pos = screen.getByText('pos:operate').parentElement!;
    fireEvent.click(within(pos).getByRole('button', { name: 'Deny' }));
    expect(mocks.setOverride).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'pos:operate', effect: 'DENY' })
    );
  });

  it('preserves role selection after a save error and sends it again', () => {
    openProfile();
    const cashier = screen.getByRole('button', { name: /Cashier/ });
    fireEvent.click(cashier);
    fireEvent.click(screen.getByRole('button', { name: 'Save role profiles' }));
    act(() => mocks.roleSaveOptions?.onError?.({ message: 'Save failed.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Your selections are still here');
    expect(cashier).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save role profiles' }));
    expect(mocks.roleSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobRoleIds: ['cashier'] })
    );
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
