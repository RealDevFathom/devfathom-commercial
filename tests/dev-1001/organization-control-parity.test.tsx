import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectFieldControl } from '@/lib/testing/select-field';

const mocks = vi.hoisted(() => ({
  overview: undefined as unknown,
  authenticatorRequired: false,
  mutations: new Map<string, { mutate: ReturnType<typeof vi.fn>; isPending: boolean }>(),
}));

function mutation(name: string) {
  let entry = mocks.mutations.get(name);
  if (!entry) {
    entry = { mutate: vi.fn(), isPending: false };
    mocks.mutations.set(name, entry);
  }
  return entry;
}

vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'unauthenticated', data: null }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(app)/team/team-content', () => ({ AddMemberModal: () => null }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    approvalAuthenticator: {
      mode: { useQuery: () => ({ data: { required: mocks.authenticatorRequired } }) },
    },
    useUtils: () => ({ organizationAdmin: { overview: { invalidate: vi.fn() } } }),
    organizationAdmin: new Proxy(
      {},
      {
        get: (_target, name: string) =>
          name === 'overview'
            ? { useQuery: () => ({ data: mocks.overview, isLoading: false, error: null }) }
            : { useMutation: () => mutation(name) },
      }
    ),
  },
}));

import { OrganizationAdminContent } from '@/app/(app)/organization/organization-admin-content';

function overview(vertical = 'PHARMACY') {
  return {
    organization: {
      id: 'example-org',
      slug: 'example-pharmacy',
      legalName: 'Example pharmacy',
      displayName: 'Example pharmacy',
      vertical,
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
      timezone: 'Asia/Karachi',
      locale: 'en',
      currency: 'PKR',
      activatedAt: null,
      primaryContactName: null,
      primaryContactEmail: null,
      package: { name: 'Example package' },
      brand: null,
      emailSettings: null,
      domains: [],
      identityConnections: [],
      scimTokens: [],
      departments: [{ id: 'counter', key: 'COUNTER', name: 'Counter' }],
      roles: [
        {
          id: 'goods-in',
          key: 'goods-in',
          name: 'Goods-in',
          description: 'Receive deliveries',
          isSystem: false,
          permissions: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
          _count: { users: 1 },
        },
      ],
      users: [
        {
          id: 'example-member',
          name: 'Example member',
          email: 'member@example.test',
          role: 'ADMIN',
          status: 'ACTIVE',
          title: 'Administrator',
          department: 'COUNTER',
          organizationRoleId: null,
          lastActiveAt: null,
        },
      ],
      usageCounters: [],
    },
    entitlements: { activeSeats: 1, seatLimit: 10, modules: [] },
    pharmacyBranches: [],
  };
}

function openMember() {
  render(<OrganizationAdminContent />);
  const details = screen.getByText('Example member').closest('details')!;
  fireEvent.click(details.querySelector('summary')!);
  expect(details).toHaveAttribute('open');
  return details.querySelector('form')!;
}

async function chooseLastWithKeyboard(trigger: HTMLElement, name: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const listbox = await screen.findByRole('listbox');
  const option = within(listbox).getByRole('option', { name });
  await waitFor(() => expect(listbox).toContainElement(document.activeElement as HTMLElement));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  await waitFor(() => expect(option).toHaveFocus());
  fireEvent.keyDown(option, { key: 'Enter' });
  // jsdom does not synthesize browser activation. This explicit click supplies
  // that default action; actual browser Enter is verified separately.
  fireEvent.click(option, { detail: 0 });
  await waitFor(() => expect(trigger).toHaveTextContent(name));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
}

beforeEach(() => {
  mocks.authenticatorRequired = false;
  mocks.mutations.clear();
  mocks.overview = overview();
});
afterEach(cleanup);

describe('organization shared controls preserve upstream access behavior', () => {
  it('uses the authenticator label and submits the typed approval code in code mode', () => {
    mocks.authenticatorRequired = true;
    const form = openMember();
    fireEvent.change(within(form).getByLabelText(/^Your approval code/), {
      target: { value: '123456' },
    });
    fireEvent.submit(form);
    expect(mutation('updateMember').mutate).toHaveBeenCalledWith(
      expect.objectContaining({ pin: '123456' }),
      expect.anything()
    );
  });

  it('keeps pharmacy labels and stored roles, then submits keyboard selection with the typed PIN', async () => {
    const form = openMember();
    const role = within(form).getByRole('combobox', { name: 'System role' });
    expect(role).toHaveTextContent('Admin');
    expect(new FormData(form).get('role')).toBe('ADMIN');
    expect(new FormData(form).get('organizationRoleId')).toBe('');
    expect(
      Array.from((selectFieldControl(role) as HTMLSelectElement).options, (option) => ({
        value: option.value,
        label: option.text,
        disabled: option.disabled,
      }))
    ).toEqual([
      { value: 'ADMIN', label: 'Admin', disabled: false },
      { value: 'HR', label: 'Manager', disabled: false },
      { value: 'EMPLOYEE', label: 'Staff', disabled: false },
    ]);
    await chooseLastWithKeyboard(role, 'Staff');
    fireEvent.change(within(form).getByLabelText(/^Your PIN/), { target: { value: '456789' } });
    fireEvent.submit(form);
    expect(mutation('updateMember').mutate).toHaveBeenCalledWith(
      {
        id: 'example-member',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationRoleId: null,
        title: 'Administrator',
        pin: '456789',
        department: 'COUNTER',
      },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it.each(['PHARMACY', 'AGENCY'])(
    'omits an empty PIN and preserves member values for %s',
    (vertical) => {
      mocks.overview = overview(vertical);
      const form = openMember();
      expect(within(form).queryByLabelText(/^Your PIN/) !== null).toBe(vertical === 'PHARMACY');
      fireEvent.submit(form);
      expect(mutation('updateMember').mutate).toHaveBeenCalledWith(
        {
          id: 'example-member',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRoleId: null,
          title: 'Administrator',
          department: 'COUNTER',
        },
        expect.objectContaining({ onError: expect.any(Function) })
      );
    }
  );

  it('restores the server-confirmed blank custom role after a refused keyboard-selected grant', async () => {
    const form = openMember();
    const role = within(form).getByRole('combobox', { name: 'Custom role' });
    await chooseLastWithKeyboard(role, 'Goods-in');
    expect(new FormData(form).get('organizationRoleId')).toBe('goods-in');
    fireEvent.submit(form);
    expect(mutation('updateMember').mutate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationRoleId: 'goods-in' }),
      expect.objectContaining({ onError: expect.any(Function) })
    );
    act(() => mutation('updateMember').mutate.mock.calls[0]![1].onError());
    await waitFor(() => {
      expect(role).toHaveTextContent('No custom role');
      expect(new FormData(form).get('organizationRoleId')).toBe('');
    });
  });

  it('preserves pending submission disablement without newly disabling role choices', () => {
    mutation('updateMember').isPending = true;
    const form = openMember();
    expect(within(form).getByRole('combobox', { name: 'System role' })).not.toBeDisabled();
    expect(within(form).getByRole('combobox', { name: 'Custom role' })).not.toBeDisabled();
    expect(within(form).getByRole('button')).toBeDisabled();
  });

  it('preserves the PIN on an in-use pharmacy custom-role permission update', () => {
    render(<OrganizationAdminContent />);
    const key = screen
      .getByRole('heading', { name: 'Custom roles' })
      .closest('section')!
      .querySelector<HTMLInputElement>('input[name="key"]')!;
    const form = key.closest('form')!;
    fireEvent.click(form.closest('details')!.querySelector('summary')!);
    fireEvent.change(within(form).getByLabelText(/^Your PIN/), { target: { value: '456789' } });
    fireEvent.submit(form);
    expect(mutation('upsertRole').mutate).toHaveBeenCalledWith({
      id: 'goods-in',
      key: 'goods-in',
      name: 'Goods-in',
      description: 'Receive deliveries',
      permissions: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
      pin: '456789',
    });
  });
});
