import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  role: 'ADMIN',
  vertical: 'RESTAURANT' as 'RESTAURANT' | 'PHARMACY',
  modules: ['admin'] as string[],
  activeSeats: 5,
  directory: vi.fn(() => ({ data: [], isLoading: false })),
  overview: vi.fn(() => ({
    data: {
      organization: {
        roles: [
          { id: 'role_cashier', name: 'Cashier' },
          { id: 'role_pharmacist', name: 'Pharmacist' },
        ],
        users: [
          {
            id: 'u_owner',
            name: 'QA Owner',
            title: 'Owner',
            role: 'ADMIN',
            organizationRoleId: null,
            status: 'ACTIVE',
          },
          {
            id: 'u_mgr',
            name: 'QA Manager',
            title: 'Procurement approver',
            role: 'HR',
            organizationRoleId: null,
            status: 'ACTIVE',
          },
          {
            id: 'u_cash',
            name: 'QA Cashier',
            title: 'Counter',
            role: 'EMPLOYEE',
            organizationRoleId: 'role_cashier',
            status: 'INVITED',
          },
          {
            id: 'u_leave',
            name: 'On Leave Pharmacist',
            title: 'Pharmacist',
            role: 'EMPLOYEE',
            organizationRoleId: 'role_pharmacist',
            status: 'ON_LEAVE',
          },
          {
            id: 'u_rx',
            name: 'Second Pharmacist',
            title: 'Pharmacist',
            role: 'EMPLOYEE',
            organizationRoleId: 'role_pharmacist',
            status: 'ACTIVE',
          },
          {
            id: 'u_gone',
            name: 'Former Staff',
            title: 'Cashier',
            role: 'EMPLOYEE',
            organizationRoleId: 'role_cashier',
            status: 'INACTIVE',
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  })),
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
  utils: {
    team: { getAll: { invalidate: vi.fn() } },
    organizationAdmin: { overview: { invalidate: vi.fn() } },
  },
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: state.role } } }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({
    enabledModules: state.modules,
    vertical: state.vertical,
    activeSeats: state.activeSeats,
  }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => state.utils,
    organizationAdmin: {
      departments: { useQuery: () => state.departments },
      roles: { useQuery: () => state.roles },
      overview: { useQuery: state.overview },
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
  state.role = 'ADMIN';
  state.modules = ['admin'];
  state.activeSeats = 5;
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
  it('shows Add Member to an administrator when the HR module is on', () => {
    state.modules = ['admin', 'hr'];
    render(<TeamContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: true });
  });
  it('keeps invitations unavailable to employees', () => {
    state.modules = ['admin', 'hr'];
    state.role = 'EMPLOYEE';
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
  });
  it('keeps invitations unavailable to HR staff, who cannot invite', () => {
    state.modules = ['admin', 'hr'];
    state.role = 'HR';
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
  });
});

describe('team page without the HR module (QA batch 3-5)', () => {
  it('shows the occupied-seat count Organization shows, not zero', () => {
    render(<TeamContent />);
    expect(screen.getByText('5 team members in this workspace.')).toBeInTheDocument();
    expect(screen.queryByText(/0 team members/)).toBeNull();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  it('hides Add Member, the search toolbar and the "Invite here" dead end', () => {
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    expect(screen.queryByPlaceholderText('Search by name or role...')).toBeNull();
    expect(screen.queryByText(/invite workspace members here/i)).toBeNull();
    expect(screen.queryByText(/requires the HR module/)).toBeNull();
  });

  it('lists the members occupying seats for the owner and links to Organization', () => {
    state.vertical = 'PHARMACY';
    render(<TeamContent />);
    expect(state.overview).toHaveBeenCalledWith(undefined, { enabled: true, retry: false });
    const list = screen.getByRole('list', { name: 'Workspace members' });
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByText('QA Manager')).toBeInTheDocument();
    expect(screen.getByText('QA Cashier')).toBeInTheDocument();
    expect(screen.queryByText('Former Staff')).toBeNull();
    const owner = within(list).getByText('QA Owner').closest('li')!;
    expect(within(owner).getByText('Admin')).toBeInTheDocument();
    const cashier = within(list).getByText('QA Cashier').closest('li')!;
    expect(within(cashier).getByText('Staff · Cashier')).toBeInTheDocument();
    expect(within(cashier).getByText('Counter')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Organization' })).toHaveAttribute(
      'href',
      '/organization'
    );
    expect(screen.getByText(/ask your platform operator/)).toBeInTheDocument();
  });

  it('keeps the email invite reachable for the owner from the notice', () => {
    state.vertical = 'PHARMACY';
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a colleague' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();
  });

  it('refreshes the member list after an invite sent from the notice', () => {
    render(<TeamContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite a colleague' }));
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    act(() => state.invite.mutate.mock.calls[0][1].onSuccess({ inviteUrl: 'x' }));
    expect(state.utils.organizationAdmin.overview.invalidate).toHaveBeenCalledOnce();
    expect(state.utils.team.getAll.invalidate).toHaveBeenCalledOnce();
    expect(screen.getByText('Invitation sent to second@e2e.invalid')).toBeVisible();
  });

  it('explains plainly to non-administrators without loading the member list', () => {
    state.vertical = 'PHARMACY';
    state.role = 'EMPLOYEE';
    render(<TeamContent />);
    expect(screen.getByText('Staff profiles are not part of your plan')).toBeInTheDocument();
    expect(screen.getByText(/ask the workspace owner or an administrator/)).toBeInTheDocument();
    expect(screen.getByText('5 team members in this workspace.')).toBeInTheDocument();
    expect(state.overview).toHaveBeenCalledWith(undefined, { enabled: false, retry: false });
    expect(screen.queryByRole('list', { name: 'Workspace members' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Organization' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
  });

  it('uses a singular label for a one-person workspace', () => {
    state.activeSeats = 1;
    render(<TeamContent />);
    expect(screen.getByText('1 team member in this workspace.')).toBeInTheDocument();
  });
});

describe('team page eyebrow', () => {
  it('reads Pharmacy for a pharmacy organization instead of FIRM', () => {
    state.vertical = 'PHARMACY';
    render(<TeamContent />);
    expect(screen.getByText('Pharmacy')).toBeInTheDocument();
    expect(screen.queryByText('FIRM')).toBeNull();
  });

  it('keeps FIRM for other verticals', () => {
    render(<TeamContent />);
    expect(screen.getByText('FIRM')).toBeInTheDocument();
  });
});
