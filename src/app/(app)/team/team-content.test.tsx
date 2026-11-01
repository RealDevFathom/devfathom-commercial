import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  role: 'ADMIN',
  vertical: 'RESTAURANT' as 'RESTAURANT' | 'PHARMACY',
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
  useEntitlements: () => ({ enabledModules: state.modules, vertical: state.vertical }),
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
  state.vertical = 'RESTAURANT';
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
  fireEvent.change(screen.getByPlaceholderText('Ali Raza'), {
    target: { value: 'Second operator' },
  });
  fireEvent.change(screen.getByPlaceholderText('ali@restaurant.pk'), {
    target: { value: 'second@e2e.invalid' },
  });
  fireEvent.change(screen.getByPlaceholderText('Shift Manager'), {
    target: { value: 'Counter operator' },
  });
}

describe('tenant department invitation', () => {
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
      expect(screen.getByPlaceholderText('Ali Raza')).toHaveValue('Second operator');
      expect(screen.getByPlaceholderText('ali@restaurant.pk')).toHaveValue('second@e2e.invalid');
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
    expect(screen.getByPlaceholderText('Ali Raza')).toHaveValue('Second operator');
  });
});

describe('vertical-aware invitation copy', () => {
  it('shows pharmacy copy and the pharmacy role catalog to a pharmacy owner', () => {
    state.vertical = 'PHARMACY';
    state.roles.data = [
      { id: 'role_owner', key: 'owner-operator', name: 'Owner / Operator' },
      { id: 'role_pharmacist', key: 'pharmacist', name: 'Pharmacist' },
    ];
    const { container } = render(<AddMemberModal onClose={vi.fn()} />);
    const roleSelect = screen.getByLabelText('Pharmacy staff role');
    expect(roleSelect).toHaveAttribute('id', 'invite-role-template');
    expect(screen.getByRole('option', { name: 'Owner / Operator' })).toHaveValue('role_owner');
    expect(screen.getByRole('option', { name: 'Pharmacist' })).toHaveValue('role_pharmacist');
    expect(screen.getByRole('option', { name: 'No pharmacy role' })).toHaveValue('');
    expect(screen.getByPlaceholderText('Pharmacist')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('+92 300 1234567')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manager' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/restaurant/i);
    const placeholders = Array.from(container.querySelectorAll('[placeholder]')).map((el) =>
      el.getAttribute('placeholder')
    );
    expect(placeholders.join(' ')).not.toMatch(/restaurant|555-01|Full Stack Developer/i);
  });

  it('keeps restaurant copy for a restaurant tenant', () => {
    render(<AddMemberModal onClose={vi.fn()} />);
    expect(screen.getByLabelText('Restaurant staff role')).toHaveAttribute(
      'id',
      'invite-role-template'
    );
    expect(screen.getByPlaceholderText('Shift Manager')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('+92 300 1234567')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Employee' })).toBeInTheDocument();
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

describe('pharmacy staff page (#980)', () => {
  it('drops the agency FIRM label, the empty member count and the HR module notice', () => {
    state.vertical = 'PHARMACY';
    state.modules = ['admin'];
    render(<TeamContent />);
    expect(screen.queryByText('FIRM')).toBeNull();
    expect(screen.getByText('STAFF')).toBeInTheDocument();
    expect(screen.queryByText(/0 team members/)).toBeNull();
    expect(screen.queryByText(/requires the HR module/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Organization' })).toHaveAttribute(
      'href',
      '/organization'
    );
    expect(screen.getByRole('button', { name: 'Add Member' })).toBeInTheDocument();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  it('keeps the agency directory notice for a workspace without HR', () => {
    state.vertical = 'RESTAURANT';
    render(<TeamContent />);
    expect(screen.getByText('FIRM')).toBeInTheDocument();
    expect(screen.getByText(/requires the HR module/)).toBeInTheDocument();
  });

  it('notifies the host surface after a successful invite', () => {
    state.vertical = 'PHARMACY';
    state.roles.data = [{ id: 'role_pharmacist', key: 'pharmacist', name: 'Pharmacist' }];
    const onInvited = vi.fn();
    render(<AddMemberModal onClose={vi.fn()} onInvited={onInvited} />);
    fireEvent.change(screen.getByPlaceholderText('Ali Raza'), { target: { value: 'Ayesha' } });
    fireEvent.change(screen.getByPlaceholderText('ali@pharmacy.pk'), {
      target: { value: 'ayesha@pharmacy.test' },
    });
    fireEvent.change(screen.getByPlaceholderText('Pharmacist'), {
      target: { value: 'Pharmacist' },
    });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.change(screen.getByLabelText('Pharmacy staff role'), {
      target: { value: 'role_pharmacist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(state.invite.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationRoleId: 'role_pharmacist', department: 'COUNTER' }),
      expect.any(Object)
    );
    act(() =>
      state.invite.mutate.mock.calls[0][1].onSuccess({ inviteUrl: 'https://x.test/invite/t' })
    );
    expect(onInvited).toHaveBeenCalledOnce();
  });
});
