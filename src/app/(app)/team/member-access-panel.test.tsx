import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHARMACY_SUB_ROLES, pharmacySubRoleGroups } from '@/lib/abac/pharmacy-sub-roles';

const state = vi.hoisted(() => ({
  query: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: { organizationAdmin: { memberAccess: { useQuery: state.query } } },
}));
import { MEMBER_ACCESS_READ_ONLY_NOTE, MemberAccessPanel } from './member-access-panel';

const member = {
  id: 'u_1',
  name: 'Ayesha',
  status: 'ACTIVE',
  roleName: 'Cashier',
  customRole: false,
  exceptionCount: 0,
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
    expect(screen.getByText(/Ayesha is not active/)).toBeVisible();
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
