import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type InviteOptions = {
  onSuccess?: (result: { staffProfileId: string; userId: string; inviteUrl: string }) => void;
  onError?: (error: { message: string }) => void;
};

const mocks = vi.hoisted(() => ({
  roles: {
    data: [
      { id: 'role_server', key: 'server', name: 'Server' },
      { id: 'role_bm', key: 'branch-manager', name: 'Branch Manager' },
    ] as { id: string; key: string; name: string }[] | undefined,
    error: null as { message: string } | null,
    isLoading: false,
  },
  inviteMutate: vi.fn(),
  inviteOptions: undefined as InviteOptions | undefined,
  inviteError: null as { message: string } | null,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantStaff: {
      listInviteRoles: { useQuery: () => mocks.roles },
      invite: {
        useMutation: (options: InviteOptions) => {
          mocks.inviteOptions = options;
          return { mutate: mocks.inviteMutate, isPending: false, error: mocks.inviteError };
        },
      },
    },
  },
}));

import { RestaurantStaffInviteDialog } from './restaurant-staff-invite-dialog';

const branches = [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }];

function renderDialog(overrides: { onOpenChange?: () => void; onInvited?: () => void } = {}) {
  return render(
    <RestaurantStaffInviteDialog
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      onInvited={overrides.onInvited ?? vi.fn()}
      branches={branches}
      branchesLoading={false}
      branchesError={false}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roles.data = [
    { id: 'role_server', key: 'server', name: 'Server' },
    { id: 'role_bm', key: 'branch-manager', name: 'Branch Manager' },
  ];
  mocks.roles.error = null;
  mocks.roles.isLoading = false;
  mocks.inviteError = null;
});

describe('RestaurantStaffInviteDialog', () => {
  it('invites a new waiter with a name, email, role, and branch', () => {
    renderDialog();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Full name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Sara Waiter' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Email', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'sara@example.com' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Role', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'role_server' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Primary branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'branch_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(mocks.inviteMutate).toHaveBeenCalledWith({
      displayName: 'Sara Waiter',
      email: 'sara@example.com',
      organizationRoleId: 'role_server',
      primaryBranchId: 'branch_1',
    });
  });

  it('shows the shareable link after the invitation is sent and refreshes the list', () => {
    const onInvited = vi.fn();
    renderDialog({ onInvited });
    act(() =>
      mocks.inviteOptions?.onSuccess?.({
        staffProfileId: 'staff_new',
        userId: 'user_new',
        inviteUrl: 'https://www.devfathom.com/invite/token',
      })
    );

    expect(onInvited).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Invitation sent.');
    expect(selectFieldControl(screen.getByLabelText('Invitation link', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(
      'https://www.devfathom.com/invite/token'
    );
  });

  it('surfaces a server refusal inline', () => {
    mocks.inviteError = { message: 'You cannot invite someone with this role.' };
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You cannot invite someone with this role.'
    );
  });

  it('disables sending when there is no role the actor may assign', () => {
    mocks.roles.data = [];
    renderDialog();
    expect(screen.getByLabelText('Role', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
    expect(screen.getByRole('option', { hidden: true, name: 'No roles you can assign' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
  });

  it('explains a role-directory failure instead of an empty list', () => {
    mocks.roles.data = undefined;
    mocks.roles.error = { message: 'boom' };
    renderDialog();
    expect(screen.getByRole('option', { hidden: true, name: 'Roles unavailable' })).toBeInTheDocument();
    expect(screen.getByLabelText('Role', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
  });
});
