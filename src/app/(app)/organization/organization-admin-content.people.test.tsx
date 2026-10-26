import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const overviewData = vi.hoisted(() => ({ current: null as unknown }));
const invalidateOverview = vi.hoisted(() => vi.fn());
const showError = vi.hoisted(() => vi.fn());
const mutations = vi.hoisted(() => ({
  map: new Map<
    string,
    {
      mutate: ReturnType<typeof vi.fn>;
      isPending: boolean;
      reset: () => void;
      onSuccess?: () => void | Promise<void>;
      onError?: (error: { message: string }) => void;
    }
  >(),
}));

function mutationFor(key: string) {
  let entry = mutations.map.get(key);
  if (!entry) {
    entry = { mutate: vi.fn(), isPending: false, reset: vi.fn() };
    mutations.map.set(key, entry);
  }
  return entry;
}

vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'unauthenticated', data: null }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: showError } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ organizationAdmin: { overview: { invalidate: invalidateOverview } } }),
    organizationAdmin: new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === 'overview') {
            return {
              useQuery: () => ({ data: overviewData.current, isLoading: false, error: null }),
            };
          }
          return {
            useMutation: (options?: {
              onSuccess?: () => void | Promise<void>;
              onError?: (error: { message: string }) => void;
            }) => {
              const mutation = mutationFor(key);
              mutation.onSuccess = options?.onSuccess;
              mutation.onError = options?.onError;
              return mutation;
            },
          };
        },
      }
    ),
  },
}));

import { OrganizationAdminContent } from './organization-admin-content';

const PHARMACY_DEPARTMENTS = [
  { id: 'd1', key: 'COUNTER', name: 'Counter' },
  { id: 'd2', key: 'DISPENSARY', name: 'Dispensary' },
  { id: 'd3', key: 'STORE', name: 'Store' },
];

beforeEach(() => {
  mutations.map.clear();
  showError.mockReset();
  invalidateOverview.mockReset();
  invalidateOverview.mockResolvedValue(undefined);
  overviewData.current = {
    organization: {
      id: 'org_ph',
      slug: 'qa-clifton',
      legalName: 'Clifton Chemist',
      displayName: 'Clifton Chemist',
      status: 'ACTIVE',
      vertical: 'PHARMACY',
      deploymentMode: 'SHARED',
      timezone: 'Asia/Karachi',
      locale: 'en',
      currency: 'PKR',
      primaryContactName: null,
      primaryContactEmail: null,
      activatedAt: null,
      package: { name: 'Pharmacy Professional' },
      brand: null,
      emailSettings: null,
      domains: [],
      identityConnections: [],
      scimTokens: [],
      departments: PHARMACY_DEPARTMENTS,
      roles: [
        {
          id: 'role_cashier',
          key: 'cashier',
          name: 'Cashier',
          description: null,
          isSystem: false,
          permissions: [],
          _count: { users: 0 },
        },
      ],
      users: [
        {
          id: 'owner_1',
          name: 'Owner',
          email: 'owner@qa-clifton.test',
          role: 'ADMIN',
          status: 'ACTIVE',
          title: 'Organization administrator',
          department: 'COUNTER',
          organizationRoleId: null,
          lastActiveAt: null,
          permissionOverrides: [],
        },
      ],
      usageCounters: [],
    },
    entitlements: { activeSeats: 1, seatLimit: 10, modules: [] },
    pharmacyBranches: [
      { id: 'branch_clifton', name: 'Clifton', code: 'CLF' },
      { id: 'branch_dha', name: 'DHA', code: 'DHA' },
    ],
  };
});

afterEach(cleanup);

describe('organization people and access — staff onboarding', () => {
  it('offers an add-staff form with the organization pharmacy departments', () => {
    render(<OrganizationAdminContent />);

    const form = screen.getByRole('form', { name: 'Add staff member' });
    const options = [...within(form).getByLabelText('Department').querySelectorAll('option')].map(
      (option) => option.textContent
    );
    expect(options).toEqual(['Counter', 'Dispensary', 'Store']);
    // The agency vocabulary from before is gone.
    expect(options).not.toContain('Engineering');
    // The pharmacy role template is attachable to the new member.
    expect(within(form).getByLabelText('Role template')).toHaveTextContent('Cashier');
  });

  it('adds a cashier scoped to the pharmacy department and role template', () => {
    render(<OrganizationAdminContent />);
    const form = screen.getByRole('form', { name: 'Add staff member' });

    fireEvent.change(within(form).getByLabelText('Full name'), { target: { value: 'Ayesha' } });
    fireEvent.change(within(form).getByLabelText('Email'), {
      target: { value: 'ayesha@qa-clifton.test' },
    });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Cashier' } });
    fireEvent.change(within(form).getByLabelText('Department'), {
      target: { value: 'DISPENSARY' },
    });
    fireEvent.change(within(form).getByLabelText('Role template'), {
      target: { value: 'role_cashier' },
    });
    fireEvent.change(within(form).getByLabelText('Temporary password'), {
      target: { value: 'temporary-123456' },
    });
    fireEvent.click(within(form).getByLabelText('Clifton'));
    fireEvent.submit(form);

    expect(mutationFor('createMember').mutate).toHaveBeenCalledWith(
      {
        name: 'Ayesha',
        email: 'ayesha@qa-clifton.test',
        password: 'temporary-123456',
        title: 'Cashier',
        role: 'EMPLOYEE',
        department: 'DISPENSARY',
        organizationRoleId: 'role_cashier',
        branchIds: ['branch_clifton'],
      },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('files the existing member under a pharmacy department, not an agency one', () => {
    render(<OrganizationAdminContent />);

    const memberDepartment = screen.getAllByLabelText('Department')[1]!;
    const options = [...memberDepartment.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['Counter', 'Dispensary', 'Store']);
  });

  it('shows the complete password policy when adding or resetting a staff password', () => {
    render(<OrganizationAdminContent />);

    expect(
      screen.getAllByText(
        /12–256 characters, with a lowercase letter, an uppercase letter and a digit\./
      )
    ).toHaveLength(2);
    expect(
      screen.queryByText(/Minimum 12(?:-character password| characters)\./)
    ).not.toBeInTheDocument();
  });

  it('reconciles Goods-in access with the confirmed grant after refusal or refresh', async () => {
    const view = render(<OrganizationAdminContent />);
    const control = screen.getByRole('checkbox', { name: 'Goods-in access' });

    fireEvent.click(control);
    expect(mutationFor('setMemberGoodsInAccess').mutate).toHaveBeenCalledWith({
      id: 'owner_1',
      granted: true,
    });
    expect(control).not.toBeChecked();

    mutationFor('setMemberGoodsInAccess').onError?.({ message: 'Grant refused.' });
    expect(showError).toHaveBeenCalledWith('Grant refused.');
    expect(invalidateOverview).not.toHaveBeenCalled();
    expect(control).not.toBeChecked();

    fireEvent.click(control);
    expect(mutationFor('setMemberGoodsInAccess').mutate).toHaveBeenNthCalledWith(2, {
      id: 'owner_1',
      granted: true,
    });

    const data = overviewData.current as {
      organization: { users: Array<{ permissionOverrides: Array<{ id: string }> }> };
    };
    invalidateOverview.mockImplementationOnce(async () => {
      data.organization.users[0]!.permissionOverrides = [{ id: 'grant_1' }];
      view.rerender(<OrganizationAdminContent />);
    });
    await mutationFor('setMemberGoodsInAccess').onSuccess?.();
    expect(invalidateOverview).toHaveBeenCalledOnce();
    expect(control).toBeChecked();

    data.organization.users[0]!.permissionOverrides = [];
    view.rerender(<OrganizationAdminContent />);
    expect(control).not.toBeChecked();
  });
});

it('limits the license ledger to workspace modules and explicit grants', () => {
  const data = overviewData.current as { entitlements: { modules: unknown[] } };
  data.entitlements.modules = [
    { key: 'pharmacy-inventory', name: 'Pharmacy Inventory', source: 'PACKAGE', enabled: true },
    { key: 'pharmacy-crm', name: 'Pharmacy CRM', source: 'NONE', enabled: false },
    { key: 'restaurant-core', name: 'Restaurant Core', source: 'NONE', enabled: false },
    { key: 'hr', name: 'HR', source: 'NONE', enabled: false },
    { key: 'notes', name: 'Notes', source: 'OVERRIDE', enabled: true },
  ];
  render(<OrganizationAdminContent />);
  const ledger = screen.getByRole('heading', { name: 'License and modules' }).closest('section')!;
  expect(within(ledger).getByText('Pharmacy Inventory')).toBeInTheDocument();
  expect(within(ledger).getByText('Pharmacy CRM')).toBeInTheDocument();
  expect(within(ledger).getByText('Notes')).toBeInTheDocument();
  expect(within(ledger).queryByText('Restaurant Core')).not.toBeInTheDocument();
  expect(within(ledger).queryByText('HR')).not.toBeInTheDocument();
});
