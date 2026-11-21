import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHARMACY_SUB_ROLES, pharmacySubRoleGroups } from '@/lib/abac/pharmacy-sub-roles';

const state = vi.hoisted(() => ({
  query: vi.fn(),
  approvalMode: vi.fn(() => ({ data: { required: false } })),
  refetch: vi.fn(),
  setSubRole: vi.fn(),
  applyRole: vi.fn(),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    approvalAuthenticator: { mode: { useQuery: state.approvalMode } },
    useUtils: () => ({ organizationAdmin: { memberAccess: { invalidate: state.invalidate } } }),
    organizationAdmin: {
      memberAccess: { useQuery: state.query },
      setMemberSubRole: {
        useMutation: () => ({ mutateAsync: state.setSubRole, isPending: false }),
      },
      applyMemberRoleTemplate: {
        useMutation: () => ({ mutateAsync: state.applyRole, isPending: false }),
      },
    },
  },
}));
import {
  MEMBER_ACCESS_ADMIN_NOTES,
  MEMBER_ACCESS_EDIT_NOTE,
  MEMBER_ACCESS_NOT_HELD_NOTE,
  MEMBER_ACCESS_OWNER_ONLY_NOTE,
  MEMBER_ACCESS_READ_ONLY_NOTE,
  MemberAccessPanel,
} from './member-access-panel';
import { PHARMACY_WEIGHTY_SUB_ROLES } from '@/lib/abac/pharmacy-sub-role-weight';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const member = {
  id: 'u_1',
  name: 'Ayesha',
  status: 'ACTIVE',
  roleName: 'Cashier',
  customRole: false,
  exceptionCount: 0,
  administrator: null as 'full' | 'access-only' | 'role-only' | null,
};

function loaded(allowed: string[], overrides: Partial<typeof member> = {}) {
  state.query.mockReturnValue({
    data: { member: { ...member, ...overrides }, groups: pharmacySubRoleGroups(new Set(allowed)) },
    isLoading: false,
    isError: false,
    refetch: state.refetch,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('what this person can do', () => {
  it('shows every sub-role grouped by role, theirs ticked, and nothing editable', () => {
    loaded(['pharmacy:counter', 'pharmacy:orders', 'sop:complete']);
    render(<MemberAccessPanel userId="u_1" />);
    expect(state.query).toHaveBeenCalledWith({ userId: 'u_1' }, { retry: false });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(PHARMACY_SUB_ROLES.length);
    for (const box of boxes) expect(box).toHaveAttribute('aria-disabled', 'true');
    const checked = boxes.filter((box) => box.getAttribute('aria-checked') === 'true');
    expect(checked.map((box) => box.getAttribute('aria-labelledby'))).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: /Take payment/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('checkbox', { name: /Dispense prescriptions/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    const cashier = within(screen.getByRole('region', { name: 'Cashier' }));
    expect(cashier.getByText('Give discounts')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Pharmacist' })).toBeVisible();
    expect(screen.getByText(MEMBER_ACCESS_READ_ONLY_NOTE)).toBeVisible();
    expect(screen.getByText('Cashier', { selector: 'p' })).toBeVisible();
  });

  it('shows a partly held sub-role as a mixed tick', () => {
    const groups = pharmacySubRoleGroups(new Set());
    const subRole = groups[0].subRoles[0];
    groups[0].subRoles[0] = { ...subRole, state: 'partial' };
    state.query.mockReturnValue({
      data: { member, groups },
      isLoading: false,
      isError: false,
      refetch: state.refetch,
    });
    render(<MemberAccessPanel userId="u_1" />);
    const box = screen.getByRole('checkbox', { name: new RegExp(subRole.label) });
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByText('Partly allowed')).toBeInTheDocument();
  });

  it('lists in plain words what each sub-role allows', () => {
    loaded([]);
    render(<MemberAccessPanel userId="u_1" />);
    const manage = PHARMACY_SUB_ROLES.find((subRole) => subRole.key === 'run-branches')!;
    for (const item of manage.allows) expect(screen.getByText(item.text)).toBeInTheDocument();
  });

  it('ignores a click on a tick', () => {
    loaded([]);
    render(<MemberAccessPanel userId="u_1" />);
    const box = screen.getByRole('checkbox', { name: /Take payment/ });
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('marks the sub-roles that carry extra weight in words, not colour alone', () => {
    loaded([]);
    render(<MemberAccessPanel userId="u_1" />);
    const sensitive = PHARMACY_SUB_ROLES.filter((subRole) => subRole.sensitive);
    expect(screen.getAllByText('Extra care')).toHaveLength(sensitive.length);
    expect(
      screen.getByRole('checkbox', { name: /Dispense prescriptions.*Extra care/ })
    ).toBeVisible();
  });

  it('names a custom role, personal exceptions and an inactive person', () => {
    loaded([], {
      roleName: 'Night shift',
      customRole: true,
      exceptionCount: 2,
      status: 'INACTIVE',
    });
    render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByText('Night shift (custom role), plus 2 personal exceptions')).toBeVisible();
    expect(screen.getByText(/Ayesha cannot sign in right now/)).toBeVisible();
  });

  it.each(['ACTIVE', 'ON_LEAVE'])(
    'says nothing about sign-in for a %s person, who can sign in',
    (status) => {
      loaded([], { status });
      render(<MemberAccessPanel userId="u_1" />);
      expect(screen.queryByText(/cannot sign in/)).toBeNull();
    }
  );

  it.each(['INACTIVE', 'INVITED'])('says a %s person cannot sign in', (status) => {
    loaded([], { status });
    render(<MemberAccessPanel userId="u_1" />);
    expect(
      screen.getByText('Ayesha cannot sign in right now, so they cannot use any of this.')
    ).toBeVisible();
  });

  it.each(['full', 'access-only', 'role-only'] as const)(
    'tells the owner what a %s administrator can do beyond the ticks',
    (administrator) => {
      loaded([], { administrator });
      render(<MemberAccessPanel userId="u_1" />);
      expect(screen.getByText(MEMBER_ACCESS_ADMIN_NOTES[administrator])).toBeVisible();
    }
  );

  it('adds no administrator note for anyone else', () => {
    loaded([]);
    render(<MemberAccessPanel userId="u_1" />);
    for (const note of Object.values(MEMBER_ACCESS_ADMIN_NOTES))
      expect(screen.queryByText(note)).toBeNull();
  });

  it('shows loading, then an error that says nothing changed and can be retried', () => {
    state.query.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { rerender } = render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByLabelText('Loading what this person can do')).toBeVisible();
    state.query.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: state.refetch,
    });
    rerender(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing about their access has changed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetch).toHaveBeenCalled();
  });
});

describe('DEV-959B: ticking for one person', () => {
  const ALL_KEYS = PHARMACY_SUB_ROLES.map((subRole) => subRole.key);
  function editable(
    allowed: string[],
    ticking: Partial<{
      editing: { allowed: boolean; reason: string | null };
      viewerIsOwner: boolean;
      viewerHolds: string[];
      personal: Record<string, 'ALLOW' | 'DENY'>;
    }> = {}
  ) {
    state.query.mockReturnValue({
      data: {
        member,
        groups: pharmacySubRoleGroups(new Set(allowed)),
        ticking: {
          editing: { allowed: true, reason: null },
          viewerIsOwner: true,
          viewerHolds: ALL_KEYS,
          personal: {},
          roleKey: 'cashier',
          startingRoles: PHARMACY_ROLE_TEMPLATES.map(({ key, name }) => ({
            key,
            name,
            weighty: key === 'pharmacist' ? ['dispense-prescriptions', 'record-prescriptions'] : [],
          })),
          weighty: PHARMACY_WEIGHTY_SUB_ROLES,
          ...ticking,
        },
      },
      isLoading: false,
      isError: false,
      refetch: state.refetch,
    });
  }
  const cashier = ['pharmacy:counter', 'pharmacy:orders', 'sop:complete'];

  it('asks for the authenticator approval code before granting the finance tick in code mode', () => {
    state.approvalMode.mockReturnValue({ data: { required: true } });
    try {
      editable(cashier);
      render(<MemberAccessPanel userId="u_1" />);
      fireEvent.click(screen.getByRole('checkbox', { name: /View pharmacy accounts/ }));
      const confirm = screen.getByRole('form', { name: 'Give View pharmacy accounts?' });
      expect(within(confirm).getByLabelText('Your approval code')).toBeRequired();
    } finally {
      state.approvalMode.mockReturnValue({ data: { required: false } });
    }
  });

  it('ticks another role’s sub-role on the server and reloads what the server decided', async () => {
    editable(cashier);
    state.setSubRole.mockResolvedValue({ changed: ['operational-reports'] });
    render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByText(MEMBER_ACCESS_EDIT_NOTE)).toBeVisible();
    const box = screen.getByRole('checkbox', { name: /Use operational reports/ });
    expect(box).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(box);
    await waitFor(() =>
      expect(state.setSubRole).toHaveBeenCalledWith({
        userId: 'u_1',
        subRoleKey: 'operational-reports',
        ticked: true,
      })
    );
    await waitFor(() => expect(state.invalidate).toHaveBeenCalledWith({ userId: 'u_1' }));
  });

  it('unticks one of the role’s own sub-roles without a PIN', async () => {
    editable(cashier);
    state.setSubRole.mockResolvedValue({ changed: ['take-payment'] });
    render(<MemberAccessPanel userId="u_1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Take payment/ }));
    await waitFor(() =>
      expect(state.setSubRole).toHaveBeenCalledWith({
        userId: 'u_1',
        subRoleKey: 'take-payment',
        ticked: false,
      })
    );
  });

  it('asks for the PIN and says in one line what a weighty sub-role allows', async () => {
    editable(cashier);
    state.setSubRole
      .mockRejectedValueOnce(new Error('That PIN is not right.'))
      .mockResolvedValueOnce({ changed: ['dispense-prescriptions', 'record-prescriptions'] });
    render(<MemberAccessPanel userId="u_1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Dispense prescriptions/ }));
    expect(state.setSubRole).not.toHaveBeenCalled();
    const confirm = screen.getByRole('form', { name: 'Give Dispense prescriptions?' });
    expect(
      within(confirm).getByText(PHARMACY_WEIGHTY_SUB_ROLES['dispense-prescriptions'])
    ).toBeVisible();
    fireEvent.change(within(confirm).getByLabelText('Your PIN'), { target: { value: '0000' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Give it' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('That PIN is not right.');
    fireEvent.change(within(confirm).getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Give it' }));
    await waitFor(() =>
      expect(state.setSubRole).toHaveBeenLastCalledWith({
        userId: 'u_1',
        subRoleKey: 'dispense-prescriptions',
        ticked: true,
        pin: '2468',
      })
    );
    expect(
      await screen.findByText('Saved. This also changed: Record prescriptions.')
    ).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Give Dispense prescriptions?' })).toBeNull();
  });

  it('lets an administrator who is not the owner change only non-weighty sub-roles they hold', () => {
    editable(cashier, {
      viewerIsOwner: false,
      viewerHolds: [
        'take-payment',
        'customer-orders',
        'do-procedures',
        'operational-reports',
        'manage-stock',
      ],
    });
    render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByRole('checkbox', { name: /Use financial reports/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('checkbox', { name: /Use operational reports/ })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    // Held, but weighty: only the owner changes it.
    expect(screen.getByRole('checkbox', { name: /Manage stock/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    const weighty = Object.keys(PHARMACY_WEIGHTY_SUB_ROLES).length;
    expect(screen.getAllByText(MEMBER_ACCESS_OWNER_ONLY_NOTE).length).toBe(weighty);
    expect(screen.getAllByText(MEMBER_ACCESS_NOT_HELD_NOTE).length).toBe(
      ALL_KEYS.length - weighty - 4
    );
  });

  it('locks no box for the owner, held or not', () => {
    editable(cashier, { viewerHolds: [] });
    render(<MemberAccessPanel userId="u_1" />);
    for (const box of screen.getAllByRole('checkbox'))
      expect(box).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(MEMBER_ACCESS_NOT_HELD_NOTE)).toBeNull();
    expect(screen.queryByText(MEMBER_ACCESS_OWNER_ONLY_NOTE)).toBeNull();
  });

  it('asks the owner for the PIN before taking a weighty sub-role away', async () => {
    editable([...cashier, 'pharmacy:dispense']);
    state.setSubRole.mockResolvedValue({ changed: ['dispense-prescriptions'] });
    render(<MemberAccessPanel userId="u_1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Dispense prescriptions/ }));
    expect(state.setSubRole).not.toHaveBeenCalled();
    const confirm = screen.getByRole('form', { name: 'Take away Dispense prescriptions?' });
    expect(
      within(confirm).getByText(PHARMACY_WEIGHTY_SUB_ROLES['dispense-prescriptions'])
    ).toBeVisible();
    fireEvent.change(within(confirm).getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Take it away' }));
    await waitFor(() =>
      expect(state.setSubRole).toHaveBeenCalledWith({
        userId: 'u_1',
        subRoleKey: 'dispense-prescriptions',
        ticked: false,
        pin: '2468',
      })
    );
  });

  it('shows the server’s reason and keeps every tick locked when the viewer may not edit', () => {
    editable(cashier, {
      editing: { allowed: false, reason: 'Only the owner can change what this person may do.' },
    });
    render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByText('Only the owner can change what this person may do.')).toBeVisible();
    for (const box of screen.getAllByRole('checkbox'))
      expect(box).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('form', { name: 'Start from a ready-made role' })).toBeNull();
  });

  it('marks a personal exception in words', () => {
    editable([...cashier, 'pharmacy:procurement'], {
      personal: { 'receive-stock': 'ALLOW', 'give-discounts': 'DENY' },
    });
    render(<MemberAccessPanel userId="u_1" />);
    expect(screen.getByText('Added for this person')).toBeVisible();
    expect(screen.getByText('Removed for this person')).toBeVisible();
  });

  it('starts the person from a ready-made role, with the PIN when given', async () => {
    editable(cashier);
    state.applyRole.mockResolvedValue({ changed: [] });
    render(<MemberAccessPanel userId="u_1" />);
    const form = screen.getByRole('form', { name: 'Start from a ready-made role' });
    fireEvent.change(within(form).getByLabelText('Start from a ready-made role'), {
      target: { value: 'pharmacist' },
    });
    // Before confirming, the role's weighty sub-roles are listed with their one-line texts.
    expect(within(form).getByText(/gives these sub-roles that carry extra weight/)).toBeVisible();
    expect(
      within(form).getByText(PHARMACY_WEIGHTY_SUB_ROLES['dispense-prescriptions'])
    ).toBeVisible();
    expect(
      within(form).getByText(PHARMACY_WEIGHTY_SUB_ROLES['record-prescriptions'])
    ).toBeVisible();
    expect(within(form).getByLabelText('Your PIN')).toBeRequired();
    fireEvent.change(within(form).getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Use this role' }));
    await waitFor(() =>
      expect(state.applyRole).toHaveBeenCalledWith({
        userId: 'u_1',
        roleKey: 'pharmacist',
        pin: '2468',
      })
    );
  });

  it('shows a refusal from the server as an alert, changing nothing on screen', async () => {
    editable(cashier);
    state.setSubRole.mockRejectedValue(new Error('At least one active owner must remain.'));
    render(<MemberAccessPanel userId="u_1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Take payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'At least one active owner must remain.'
    );
    expect(screen.getByRole('checkbox', { name: /Take payment/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
