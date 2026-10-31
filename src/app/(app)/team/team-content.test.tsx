import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  role: 'ADMIN',
  modules: ['admin'] as string[],
  directory: vi.fn(() => ({ data: [], isLoading: false })),
  departments: {
    data: [] as Array<{ key: string; name: string; active: boolean }>,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  roles: {
    data: [] as Array<{ id: string; key: string; name: string }>,
    isFetching: false,
    isError: false,
  },
  invite: { mutate: vi.fn(), isPending: false },
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: state.role } } }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ enabledModules: state.modules }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ team: { getAll: { invalidate: vi.fn() } } }),
    organizationAdmin: {
      departments: { useQuery: () => state.departments },
      roles: { useQuery: () => state.roles },
    },
    team: {
      getAll: { useQuery: state.directory },
      inviteMember: { useMutation: () => state.invite },
    },
  },
}));
import { AddMemberModal, TeamContent } from './team-content';

beforeEach(() => {
  vi.clearAllMocks();
  state.departments.data = [
    { key: 'COUNTER', name: 'Counter', active: true },
    { key: 'OLD', name: 'Old department', active: false },
  ];
  state.roles.data = [
    { id: 'role_gm', key: 'general-manager', name: 'General Manager' },
    { id: 'role_branch', key: 'branch-manager', name: 'Branch Manager' },
    { id: 'role_bar', key: 'bar-barista', name: 'Bar / Barista' },
    { id: 'role_accountant', key: 'accountant', name: 'Accountant' },
  ];
  state.departments.isFetching = state.departments.isError = state.invite.isPending = false;
  state.roles.isFetching = state.roles.isError = false;
});
afterEach(cleanup);
function fill() {
  fireEvent.change(screen.getByPlaceholderText('John Doe'), {
    target: { value: 'Second operator' },
  });
  fireEvent.change(screen.getByPlaceholderText('john@company.com'), {
    target: { value: 'second@e2e.invalid' },
  });
  fireEvent.change(screen.getByPlaceholderText('Full Stack Developer'), {
    target: { value: 'Counter operator' },
  });
}

describe('tenant department invitation', () => {
  it('shows a rejected email retry and preserves the fallback link through recovery', () => {
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    act(() =>
      state.invite.mutate.mock.calls[0][1].onSuccess({
        id: 'user_2',
        inviteUrl: 'https://app.example/invite/token',
        emailDelivery: 'FAILED',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry email' }));
    act(() => state.invite.mutate.mock.calls[1][1].onError({ message: 'Forbidden' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Forbidden');
    expect(screen.getByText('https://app.example/invite/token')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry email' }));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() =>
      state.invite.mutate.mock.calls[2][1].onSuccess({
        id: 'user_2',
        inviteUrl: 'https://app.example/invite/refreshed-token',
        emailDelivery: 'SENT',
      })
    );
    expect(screen.getByText('Invitation sent to second@e2e.invalid')).toBeVisible();
    expect(screen.getByText('https://app.example/invite/refreshed-token')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['SENT', 'Invitation sent to second@e2e.invalid'],
    ['FAILED', 'Invitation created, but email delivery failed'],
  ] as const)(
    'renders the %s delivery result without losing the fallback link',
    (status, heading) => {
      render(<AddMemberModal onClose={vi.fn()} />);
      fill();
      fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
      act(() =>
        state.invite.mutate.mock.calls[0][1].onSuccess({
          id: 'user_2',
          inviteUrl: 'https://app.example/invite/token',
          emailDelivery: status,
        })
      );
      expect(screen.getByText(heading)).toBeVisible();
      expect(screen.getByText('https://app.example/invite/token')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
      if (status === 'FAILED') {
        fireEvent.click(screen.getByRole('button', { name: 'Retry email' }));
        expect(state.invite.mutate).toHaveBeenCalledTimes(2);
        act(() =>
          state.invite.mutate.mock.calls[1][1].onSuccess({
            id: 'user_2',
            inviteUrl: 'https://app.example/invite/refreshed-token',
            emailDelivery: 'SENT',
          })
        );
        expect(screen.getByText('Invitation sent to second@e2e.invalid')).toBeVisible();
        expect(screen.getByText('https://app.example/invite/refreshed-token')).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Retry email' })).toBeNull();
      } else {
        expect(screen.queryByRole('button', { name: 'Retry email' })).toBeNull();
      }
    }
  );

  it.each([
    ['General Manager', 'role_gm'],
    ['Branch Manager', 'role_branch'],
    ['Bar / Barista', 'role_bar'],
    ['Accountant', 'role_accountant'],
  ])('submits the %s restaurant role template', (name, id) => {
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    expect(screen.getByRole('option', { name })).toHaveValue(id);
    fireEvent.change(screen.getByLabelText('Restaurant staff role'), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(state.invite.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationRoleId: id }),
      expect.any(Object)
    );
  });

  it.each([
    ['COUNTER', 'Counter'],
    ['KITCHEN', 'Kitchen'],
    ['ENGINEERING', 'Engineering'],
  ])('submits an explicit active %s choice with its readable label', (key, name) => {
    state.departments.data = [{ key, name, active: true }];
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    expect(screen.getByLabelText('Department')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send Invite' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: key } });
    expect(screen.getByRole('option', { name })).toHaveValue(key);
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(state.invite.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ department: key, email: 'second@e2e.invalid' }),
      expect.any(Object)
    );
  });

  it.each(['loading', 'error', 'empty', 'stale'])(
    'blocks %s department data and preserves the form',
    (kind) => {
      const view = render(<AddMemberModal onClose={vi.fn()} />);
      fill();
      fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
      if (kind === 'loading') state.departments.isFetching = true;
      if (kind === 'error') state.departments.isError = true;
      if (kind === 'empty') state.departments.data = [];
      if (kind === 'stale')
        state.departments.data = [{ key: 'STORE', name: 'Store', active: true }];
      view.rerender(<AddMemberModal onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
      expect(state.invite.mutate).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('John Doe')).toHaveValue('Second operator');
      expect(screen.getByPlaceholderText('john@company.com')).toHaveValue('second@e2e.invalid');
      if (kind === 'error') {
        fireEvent.click(screen.getByRole('button', { name: 'Retry departments' }));
        expect(state.departments.refetch).toHaveBeenCalledOnce();
      }
    }
  );

  it('omits inactive departments and preserves entries when server authorization refuses the invite', () => {
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    expect(screen.queryByRole('option', { name: 'Old department' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    act(() => state.invite.mutate.mock.calls[0][1].onError({ message: 'Forbidden' }));
    expect(screen.getByText('Forbidden')).toBeVisible();
    expect(screen.getByLabelText('Department')).toHaveValue('COUNTER');
    expect(screen.getByPlaceholderText('John Doe')).toHaveValue('Second operator');
  });
});

describe('baseline workspace invitations', () => {
  it('shows Add Member without HR and opens the invitation form without fetching HR data', () => {
    render(<TeamContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });
  });
  it('keeps invitations unavailable to employees', () => {
    state.role = 'EMPLOYEE';
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    state.role = 'ADMIN';
  });
});
