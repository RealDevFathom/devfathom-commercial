import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verticalForModuleKey, type EntitlementView } from '@/lib/module-catalog';

const state = vi.hoisted(() => ({
  role: 'ADMIN',
  // The catalog-derived tenant is installed in beforeEach, after imports resolve.
  vertical: undefined as EntitlementView['vertical'],
  modules: ['admin'] as string[],
  activeSeats: 1,
  overview: {
    data: {
      organization: {
        users: [] as Array<{
          id: string;
          name: string;
          role: 'ADMIN' | 'HR' | 'EMPLOYEE';
          status: string;
          title: string;
          organizationRoleId: string | null;
        }>,
        roles: [] as Array<{ id: string; name: string }>,
      },
    },
    isLoading: false,
    isError: false,
  },
  overviewQuery: vi.fn(),
  invalidateOverview: vi.fn(),
  invalidateDirectory: vi.fn(),
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
  memberAccess: vi.fn(() => ({ data: undefined, isLoading: true, isError: false })),
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
    useUtils: () => ({
      team: { getAll: { invalidate: state.invalidateDirectory } },
      organizationAdmin: {
        overview: { invalidate: state.invalidateOverview },
        memberAccess: { invalidate: vi.fn() },
      },
    }),
    organizationAdmin: {
      overview: { useQuery: state.overviewQuery },
      departments: { useQuery: () => state.departments },
      roles: { useQuery: () => state.roles },
      memberAccess: { useQuery: state.memberAccess },
      setMemberSubRole: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      applyMemberRoleTemplate: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    team: {
      getAll: { useQuery: state.directory },
      inviteMember: { useMutation: () => state.invite },
    },
  },
}));
import { inviteCopyForVertical } from '@/lib/team/invite-copy';
import { AddMemberModal, TeamContent } from './team-content';

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'ADMIN';
  state.modules = ['admin'];
  state.activeSeats = 1;
  state.overview.data.organization = {
    users: [
      {
        id: 'owner',
        name: 'Pharmacy owner',
        role: 'ADMIN',
        status: 'ACTIVE',
        title: 'Owner',
        organizationRoleId: null,
      },
    ],
    roles: [],
  };
  state.overview.isLoading = state.overview.isError = false;
  state.overviewQuery.mockReturnValue(state.overview);
  state.vertical = verticalForModuleKey('restaurant-core')!;
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

  it('shows delivery failure, copies the link, and replaces it after a resend', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    act(() =>
      state.invite.mutate.mock.calls[0][1].onSuccess({
        inviteUrl: '/invite/first',
        emailDelivery: 'FAILED',
      })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invite email failed');
    expect(screen.queryByText(/Invitation sent to/)).toBeNull();
    expect(screen.getByText('/invite/first')).toBeVisible();
    expect(state.invalidateOverview).toHaveBeenCalledOnce();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }))
    );
    expect(writeText).toHaveBeenCalledWith('/invite/first');
    fireEvent.click(screen.getByRole('button', { name: 'Resend invite' }));
    expect(state.invite.mutate.mock.calls[1][0]).toEqual(state.invite.mutate.mock.calls[0][0]);
    act(() => state.invite.mutate.mock.calls[1][1].onError({ message: 'Try again later' }));
    expect(screen.getByText('Try again later')).toBeVisible();
    expect(screen.getByText('/invite/first')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Resend invite' }));
    act(() =>
      state.invite.mutate.mock.calls[2][1].onSuccess({
        inviteUrl: '/invite/replacement',
        emailDelivery: 'SENT',
      })
    );
    expect(screen.getByText('Invitation sent to second@e2e.invalid')).toBeVisible();
    expect(screen.getByText('/invite/replacement')).toBeVisible();
    expect(screen.queryByText('/invite/first')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend invite' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeEnabled();
  });

  it('refreshes member queries and notifies the host only after a successful invitation', () => {
    const onInvited = vi.fn();
    render(<AddMemberModal onClose={vi.fn()} onInvited={onInvited} />);
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    const callbacks = state.invite.mutate.mock.calls[0][1];
    act(() => callbacks.onError({ message: 'Forbidden' }));
    expect(onInvited).not.toHaveBeenCalled();
    expect(state.invalidateDirectory).not.toHaveBeenCalled();
    expect(state.invalidateOverview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    act(() =>
      state.invite.mutate.mock.calls[1][1].onSuccess({
        inviteUrl: '/invite/token',
        emailDelivery: 'SENT',
      })
    );
    expect(onInvited).toHaveBeenCalledOnce();
    expect(state.invalidateDirectory).toHaveBeenCalledOnce();
    expect(state.invalidateOverview).toHaveBeenCalledOnce();
    expect(screen.getByText('Invitation sent to second@e2e.invalid')).toBeVisible();
  });
});

describe('vertical-aware invitation copy', () => {
  it('shows pharmacy copy and the pharmacy role catalog to a pharmacy owner', () => {
    state.vertical = 'PHARMACY';
    state.roles.data = [
      { id: 'role_manager', key: 'manager', name: 'Manager' },
      { id: 'role_pharmacist', key: 'pharmacist', name: 'Pharmacist' },
    ];
    const { container } = render(<AddMemberModal onClose={vi.fn()} />);
    const roleSelect = screen.getByLabelText('Role');
    expect(roleSelect).toHaveAttribute('id', 'invite-role-template');
    expect(screen.queryByLabelText('Pharmacy staff role')).toBeNull();
    expect(screen.getByRole('option', { name: 'Manager' })).toHaveValue('role_manager');
    expect(screen.getByRole('option', { name: 'Pharmacist' })).toHaveValue('role_pharmacist');
    expect(screen.getByRole('option', { name: 'No pharmacy role' })).toHaveValue('');
    expect(screen.getByPlaceholderText('Pharmacist')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('+92 300 1234567')).toBeInTheDocument();
    // DEV-673: one role picker; the Staff / Manager / Admin switch is folded into it.
    expect(screen.getAllByRole('combobox')).toHaveLength(2); // Department and Role
    for (const name of ['Staff', 'Manager', 'Admin']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(container.textContent).not.toMatch(/restaurant/i);
    const placeholders = Array.from(container.querySelectorAll('[placeholder]')).map((el) =>
      el.getAttribute('placeholder')
    );
    expect(placeholders.join(' ')).not.toMatch(/restaurant|555-01|Full Stack Developer/i);
  });

  describe('pharmacy single role picker (DEV-673)', () => {
    beforeEach(() => {
      state.vertical = 'PHARMACY';
      state.roles.data = [
        { id: 'role_admin', key: 'admin', name: 'Organization administrator' },
        { id: 'role_owner', key: 'owner', name: 'Owner' },
        { id: 'role_operator', key: 'owner-operator', name: 'Owner / Operator' },
        { id: 'role_manager', key: 'manager', name: 'Manager' },
        { id: 'role_pharmacist', key: 'pharmacist', name: 'Pharmacist' },
        { id: 'role_cashier', key: 'cashier', name: 'Cashier' },
      ];
    });

    function fillPharmacy() {
      fireEvent.change(screen.getByPlaceholderText('Ali Raza'), {
        target: { value: 'Second operator' },
      });
      fireEvent.change(screen.getByPlaceholderText('ali@pharmacy.pk'), {
        target: { value: 'second@e2e.invalid' },
      });
      fireEvent.change(screen.getByPlaceholderText('Pharmacist'), {
        target: { value: 'Counter operator' },
      });
      fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    }

    it.each([
      ['Organization administrator', 'role_admin', 'ADMIN'],
      // SEC-I (DEV-827): Manager grants its template only, never HR.
      ['Manager', 'role_manager', 'EMPLOYEE'],
      ['Pharmacist', 'role_pharmacist', 'EMPLOYEE'],
      ['Cashier', 'role_cashier', 'EMPLOYEE'],
      ['No pharmacy role', '', 'EMPLOYEE'],
    ])('sends %s (%s) with its %s base role from one picker', (_name, id, baseRole) => {
      render(<AddMemberModal onClose={vi.fn()} />);
      fillPharmacy();
      fireEvent.change(screen.getByLabelText('Role'), { target: { value: id } });
      fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
      expect(state.invite.mutate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ role: baseRole, organizationRoleId: id || null }),
        expect.any(Object)
      );
    });

    // DEV-622: the one-person "Pharmacist and cashier" role explains itself and stays staff.
    it('explains the Pharmacist and cashier role and invites it as staff', () => {
      state.roles.data = [
        ...state.roles.data,
        { id: 'role_combined', key: 'pharmacist-cashier', name: 'Pharmacist and cashier' },
      ];
      render(<AddMemberModal onClose={vi.fn()} />);
      fillPharmacy();
      const picker = screen.getByLabelText('Role');
      const help = document.getElementById('invite-role-template-help')!;
      expect(screen.getByRole('option', { name: 'Pharmacist and cashier' })).toHaveValue(
        'role_combined'
      );
      expect(help).not.toHaveTextContent(/one-person shop/);
      fireEvent.change(picker, { target: { value: 'role_combined' } });
      expect(help).toHaveTextContent(
        'Dispenses prescriptions and takes payment, for a one-person shop or a pharmacist who also runs the till.'
      );
      expect(help).toHaveTextContent('Access level: Staff.');
      fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
      expect(state.invite.mutate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ role: 'EMPLOYEE', organizationRoleId: 'role_combined' }),
        expect.any(Object)
      );
    });

    // SEC-I (DEV-827): no base role grants exactly what Owner or Owner / Operator says.
    it('does not offer Owner or Owner / Operator by invite', () => {
      render(<AddMemberModal onClose={vi.fn()} />);
      expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'Owner / Operator' })).toBeNull();
      expect(
        screen.getByRole('option', { name: 'Organization administrator' })
      ).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Manager' })).toBeInTheDocument();
    });

    it('shows the access level each role grants', () => {
      render(<AddMemberModal onClose={vi.fn()} />);
      const picker = screen.getByLabelText('Role');
      const help = document.getElementById('invite-role-template-help')!;
      expect(picker).toHaveAttribute('aria-describedby', 'invite-role-template-help');
      expect(help).toHaveTextContent('Access level: Staff.');
      fireEvent.change(picker, { target: { value: 'role_admin' } });
      expect(help).toHaveTextContent('Access level: Admin.');
      expect(help).toHaveTextContent(/billing and team/);
      expect(help.textContent).not.toContain(inviteCopyForVertical('PHARMACY').staffRoleHelp);
      fireEvent.change(picker, { target: { value: 'role_manager' } });
      expect(help).toHaveTextContent('Access level: Staff.');
      expect(help).not.toHaveTextContent('Access level: Manager.');
    });
  });

  it('keeps the base role switch for a restaurant tenant and submits the chosen base role', () => {
    render(<AddMemberModal onClose={vi.fn()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'HR' }));
    fireEvent.change(screen.getByLabelText('Restaurant staff role'), {
      target: { value: 'role_gm' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(state.invite.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'HR', organizationRoleId: 'role_gm' }),
      expect.any(Object)
    );
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
  it('shows an explicit invitation without HR and opens the form without fetching HR data', () => {
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a colleague' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });
  });
  it('keeps Add Member available with HR and Administration', () => {
    state.modules = ['admin', 'hr'];
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Invite a colleague' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: true });
  });
  it('keeps invitations unavailable to employees', () => {
    state.role = 'EMPLOYEE';
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a colleague' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Workspace members' })).toBeNull();
    expect(state.overviewQuery).toHaveBeenCalledWith(undefined, {
      enabled: false,
      retry: false,
    });
    state.role = 'ADMIN';
  });
});

describe('pharmacy team without HR', () => {
  beforeEach(() => {
    state.vertical = 'PHARMACY';
  });

  it('preserves pharmacy invitation guidance without offering the HR module', () => {
    render(<TeamContent />);
    expect(screen.getByRole('heading', { name: 'Pharmacy staff' })).toBeVisible();
    expect(
      screen.getByText(
        /Pharmacy staff are invited here and receive an email to set their own password/
      )
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Organization' })).toHaveAttribute(
      'href',
      '/organization'
    );
    expect(screen.queryByText(/add the HR module to your plan/)).toBeNull();
    expect(screen.queryByPlaceholderText('Search by name or role...')).toBeNull();
  });

  it('lists occupied seats with base and pharmacy roles instead of an empty HR directory', () => {
    state.activeSeats = 3;
    state.overview.data.organization.roles = [{ id: 'pharmacist', name: 'Pharmacist' }];
    state.overview.data.organization.users.push(
      {
        id: 'pharmacist',
        name: 'Ayesha',
        role: 'EMPLOYEE',
        status: 'ON_LEAVE',
        title: 'Dispensing pharmacist',
        organizationRoleId: 'pharmacist',
      },
      {
        id: 'invite',
        name: 'Bilal',
        role: 'HR',
        status: 'INVITED',
        title: 'Counter manager',
        organizationRoleId: null,
      },
      {
        id: 'inactive',
        name: 'Former colleague',
        role: 'EMPLOYEE',
        status: 'INACTIVE',
        title: 'Cashier',
        organizationRoleId: null,
      }
    );

    render(<TeamContent />);

    expect(screen.getByText('Pharmacy')).toBeVisible();
    expect(screen.queryByText('FIRM')).toBeNull();
    expect(screen.getByText('3 team members in this workspace.')).toBeVisible();
    const members = within(screen.getByRole('list', { name: 'Workspace members' }));
    expect(members.getAllByRole('listitem')).toHaveLength(3);
    expect(members.getByText('Pharmacy owner')).toBeVisible();
    expect(members.getByText('Admin')).toBeVisible();
    expect(members.getByText('Ayesha')).toBeVisible();
    expect(members.getByText('Staff · Pharmacist')).toBeVisible();
    expect(members.getByText('On leave')).toBeVisible();
    expect(members.getByText('Bilal')).toBeVisible();
    expect(members.getByText('Manager')).toBeVisible();
    expect(members.getByText('Invited')).toBeVisible();
    expect(members.queryByText('Former colleague')).toBeNull();
    expect(state.overviewQuery).toHaveBeenCalledWith(undefined, { enabled: true, retry: false });
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  it('offers a read-only view of what each member can do', () => {
    state.overview.data.organization.users.push({
      id: 'cashier',
      name: 'Ayesha',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      title: 'Cashier',
      organizationRoleId: null,
    });
    render(<TeamContent />);
    const members = within(screen.getByRole('list', { name: 'Workspace members' }));
    expect(members.getAllByRole('button', { name: /^What they can do/ })).toHaveLength(2);
    expect(state.memberAccess).not.toHaveBeenCalled();
    fireEvent.click(members.getByRole('button', { name: 'What they can do: Ayesha' }));
    expect(screen.getByRole('dialog', { name: 'What Ayesha can do' })).toBeVisible();
    expect(state.memberAccess).toHaveBeenCalledWith({ userId: 'cashier' }, { retry: false });
  });

  it('shows member loading and failure states without claiming there are no members', () => {
    state.overview.isLoading = true;
    const view = render(<TeamContent />);
    expect(screen.getByLabelText('Loading members')).toBeVisible();
    expect(screen.getByText('1 team member in this workspace.')).toBeVisible();

    state.overview.isLoading = false;
    state.overview.isError = true;
    view.rerender(<TeamContent />);
    expect(screen.getByRole('alert')).toHaveTextContent('The member list could not be loaded.');
    expect(screen.queryByText('No team members found')).toBeNull();
    expect(screen.getByRole('button', { name: 'Invite a colleague' })).toBeEnabled();
  });

  it('uses the seat snapshot until member data loads, then honors an empty member list', () => {
    state.overviewQuery.mockReturnValue({
      ...state.overview,
      data: undefined,
      isLoading: true,
    });
    const view = render(<TeamContent />);
    expect(screen.getByText('1 team member in this workspace.')).toBeVisible();
    expect(screen.getByLabelText('Loading members')).toBeVisible();

    state.overview.data.organization.users = [];
    state.overviewQuery.mockReturnValue(state.overview);
    view.rerender(<TeamContent />);

    expect(state.activeSeats).toBe(1);
    expect(screen.getByText('0 team members in this workspace.')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Workspace members' })).toBeNull();
  });

  it('keeps member management unavailable without the Administration module', () => {
    state.modules = [];
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a colleague' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Workspace members' })).toBeNull();
    expect(state.overviewQuery).toHaveBeenCalledWith(undefined, { enabled: false, retry: false });
  });

  it('does not offer member management when only HR is enabled', () => {
    state.modules = ['hr'];
    render(<TeamContent />);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a colleague' })).toBeNull();
    expect(screen.queryByText('Add Team Member')).toBeNull();
  });

  it.each(['module', 'role'])('hides an open invitation when %s access is removed', (access) => {
    const view = render(<TeamContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite a colleague' }));
    expect(screen.getByText('Add Team Member')).toBeVisible();

    if (access === 'module') state.modules = [];
    else state.role = 'HR';
    view.rerender(<TeamContent />);

    expect(screen.queryByText('Add Team Member')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a colleague' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Workspace members' })).toBeNull();
    expect(state.overviewQuery).toHaveBeenLastCalledWith(undefined, {
      enabled: false,
      retry: false,
    });
    expect(state.invite.mutate).not.toHaveBeenCalled();
  });

  it('opens the explicit invite action and refreshes workspace members after a successful invite', () => {
    const view = render(<TeamContent />);
    expect(screen.getByText('1 team member in this workspace.')).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Workspace members' })).getAllByRole('listitem')
    ).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Invite a colleague' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add Member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a colleague' }));
    fireEvent.change(screen.getByPlaceholderText('Ali Raza'), { target: { value: 'Ayesha' } });
    fireEvent.change(screen.getByPlaceholderText('ali@pharmacy.pk'), {
      target: { value: 'ayesha@e2e.invalid' },
    });
    fireEvent.change(screen.getByPlaceholderText('Pharmacist'), {
      target: { value: 'Dispensing pharmacist' },
    });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'COUNTER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(state.invite.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ email: 'ayesha@e2e.invalid', department: 'COUNTER' }),
      expect.any(Object)
    );
    act(() =>
      state.invite.mutate.mock.calls[0][1].onSuccess({
        inviteUrl: '/invite/token',
        emailDelivery: 'SENT',
      })
    );
    expect(state.invalidateDirectory).toHaveBeenCalledOnce();
    expect(state.invalidateOverview).toHaveBeenCalledOnce();
    expect(screen.getByText('Invitation sent to ayesha@e2e.invalid')).toBeVisible();
    expect(state.directory).toHaveBeenCalledWith(undefined, { enabled: false });

    // The invalidated overview returns the invitation, while the server layout's
    // entitlement snapshot remains unchanged for this client session.
    state.overview.data = {
      organization: {
        ...state.overview.data.organization,
        users: [
          ...state.overview.data.organization.users,
          {
            id: 'ayesha',
            name: 'Ayesha',
            role: 'EMPLOYEE',
            status: 'INVITED',
            title: 'Dispensing pharmacist',
            organizationRoleId: null,
          },
        ],
      },
    };
    view.rerender(<TeamContent />);

    expect(state.activeSeats).toBe(1);
    expect(screen.queryByText('1 team member in this workspace.')).toBeNull();
    expect(screen.getByText('2 team members in this workspace.')).toBeVisible();
    const members = within(screen.getByRole('list', { name: 'Workspace members' }));
    expect(members.getAllByRole('listitem')).toHaveLength(2);
    expect(members.getByText('Pharmacy owner')).toBeVisible();
    expect(members.getByText('Ayesha')).toBeVisible();
    expect(members.getByText('Invited')).toBeVisible();
  });
});
