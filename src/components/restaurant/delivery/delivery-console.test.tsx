import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  zoneCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  addressCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  customerCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  createZone: vi.fn(),
  createAddress: vi.fn(),
  mutate: vi.fn(),
  reactivateZone: vi.fn(),
  setDefaultAddress: vi.fn(),
  invalidate: vi.fn(),
  zones: [] as Array<Record<string, unknown>>,
  addresses: [] as Array<Record<string, unknown>>,
  pendingProcedure: '',
  mutationOptions: {} as Record<string, { onSuccess: () => void }>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantDelivery: {
        listZones: { invalidate: mocks.invalidate },
        listAddresses: { invalidate: mocks.invalidate },
      },
    }),
    restaurantStaff: {
      listBranches: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => ({
          data: options.enabled
            ? [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }]
            : undefined,
          error: null,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
    },
    restaurantDelivery: new Proxy(
      {
        listCustomers: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.customerCalls.push({ input, enabled: options.enabled });
            return {
              data: options.enabled
                ? {
                    customers: [
                      {
                        id: 'customer_1',
                        displayName: 'Ayesha Khan',
                        givenName: null,
                        familyName: null,
                      },
                    ],
                  }
                : undefined,
              error: null,
              isLoading: false,
              refetch: vi.fn(),
            };
          },
        },
        listZones: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.zoneCalls.push({ input, enabled: options.enabled });
            return { data: mocks.zones, error: null, isLoading: false, refetch: vi.fn() };
          },
        },
        listAddresses: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.addressCalls.push({ input, enabled: options.enabled });
            return { data: mocks.addresses, error: null, isLoading: false, refetch: vi.fn() };
          },
        },
      },
      {
        get: (target, procedure: string) =>
          procedure in target
            ? target[procedure as keyof typeof target]
            : {
                useMutation: (options: { onSuccess: () => void }) => {
                  mocks.mutationOptions[procedure] = options;
                  return {
                    mutate:
                      procedure === 'createZone'
                        ? mocks.createZone
                        : procedure === 'createAddress'
                          ? mocks.createAddress
                          : procedure === 'reactivateZone'
                            ? mocks.reactivateZone
                            : procedure === 'setDefaultAddress'
                              ? mocks.setDefaultAddress
                              : mocks.mutate,
                    isPending: mocks.pendingProcedure === procedure,
                  };
                },
              },
      }
    ),
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { DeliveryConsole } from './delivery-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    vertical: 'RESTAURANT',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-core'] : [],
    modules: [],
    limits: {},
  };
}

function renderConsole(enabled = true) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <DeliveryConsole />
    </EntitlementsProvider>
  );
}

describe('DeliveryConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.zoneCalls.length = 0;
    mocks.addressCalls.length = 0;
    mocks.customerCalls.length = 0;
    mocks.zones.length = 0;
    mocks.addresses.length = 0;
    mocks.pendingProcedure = '';
    mocks.mutationOptions = {};
  });

  it('gates reads and uses friendly selectors instead of raw identifiers', () => {
    const disabled = renderConsole(false);
    expect(screen.getByText('Restaurant Core module disabled')).toBeInTheDocument();
    expect(mocks.zoneCalls.at(-1)?.enabled).toBe(false);
    expect(mocks.addressCalls.at(-1)?.enabled).toBe(false);
    expect(mocks.customerCalls.at(-1)?.enabled).toBe(false);
    disabled.unmount();

    renderConsole();
    expect(screen.getByRole('option', { hidden: true, name: 'Downtown' })).toBeInTheDocument();
    expect(screen.getByRole('option', { hidden: true, name: 'Ayesha Khan' })).toBeInTheDocument();
    expect(screen.queryByText('customer_1')).not.toBeInTheDocument();
    expect(mocks.customerCalls.at(-1)).toEqual({ input: { limit: 100 }, enabled: true });
    expect(screen.queryByRole('textbox', { name: /customer id/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find customer'), { target: { value: 'Ayesha' } });
    expect(mocks.customerCalls.at(-1)).toEqual({
      input: { query: 'Ayesha', limit: 100 },
      enabled: true,
    });
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'branch_1' } }
    );
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Customer', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'customer_1' } }
    );
    expect(mocks.zoneCalls.at(-1)).toEqual({ input: { branchId: 'branch_1' }, enabled: true });
    expect(mocks.addressCalls.at(-1)).toEqual({
      input: { customerId: 'customer_1' },
      enabled: true,
    });
  });

  it('creates a branch-scoped zone with the exact router payload', () => {
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'branch_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add zone' }));
    const dialog = screen.getByRole('dialog', { name: 'Add delivery zone' });
    fireEvent.change(within(dialog).getByLabelText('Zone name'), {
      target: { value: 'Central' },
    });
    fireEvent.change(within(dialog).getByLabelText('Fixed fee'), { target: { value: '3.50' } });
    fireEvent.change(within(dialog).getByLabelText('Minimum subtotal'), {
      target: { value: '20.00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Promised minutes'), {
      target: { value: '35' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add zone' }));

    expect(mocks.createZone).toHaveBeenCalledWith({
      branchId: 'branch_1',
      name: 'Central',
      fixedFee: '3.50',
      minimumSubtotal: '20.00',
      promisedMinutes: 35,
      sortOrder: 0,
      areaPostalLabel: null,
    });
  });

  it('submits address PII only in the selected customer mutation payload', () => {
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Customer', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'customer_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }));
    const dialog = screen.getByRole('dialog', { name: 'Add saved address' });
    const fields: Record<string, string> = {
      'Address label': 'Home',
      'Recipient name': 'Ayesha Khan',
      Phone: '+923001234567',
      'Country code': 'pk',
      'Address line 1': '42 Canal Road',
      'City or locality': 'Lahore',
    };
    for (const [label, fieldValue] of Object.entries(fields)) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value: fieldValue } });
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add address' }));

    expect(mocks.createAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'customer_1',
        phone: '+923001234567',
        addressLine1: '42 Canal Road',
        countryCode: 'PK',
      })
    );
    expect(window.location.href).not.toContain('Canal');
  });

  it('reactivates an inactive delivery zone after confirmation', () => {
    mocks.zones.push({
      id: 'zone_1',
      name: 'Central',
      fixedFee: '3.50',
      minimumSubtotal: '20.00',
      promisedMinutes: 35,
      sortOrder: 0,
      areaPostalLabel: null,
      active: false,
    });
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'branch_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm reactivation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }));

    expect(mocks.reactivateZone).toHaveBeenCalledWith({ branchId: 'branch_1', zoneId: 'zone_1' });
  });

  it('makes a non-default address default without resubmitting PII', () => {
    mocks.addresses.push({
      id: 'address_1',
      label: 'Home',
      recipientName: 'Ayesha Khan',
      normalizedPhone: '+923001234567',
      addressLine1: '42 Canal Road',
      addressLine2: null,
      locality: 'Lahore',
      administrativeArea: null,
      postalCode: null,
      countryCode: 'PK',
      latitude: null,
      longitude: null,
      isDefault: false,
    });
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Customer', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'customer_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));

    expect(mocks.setDefaultAddress).toHaveBeenCalledWith({
      customerId: 'customer_1',
      addressId: 'address_1',
    });
  });

  it.each([
    ['Edit', 'Edit saved address'],
    ['Add address', 'Add saved address'],
  ])('preserves unsaved %s input when a delayed Make default request succeeds', (action, title) => {
    mocks.addresses.push({
      id: 'address_1',
      label: 'Home',
      recipientName: 'Ayesha Khan',
      normalizedPhone: '+923001234567',
      addressLine1: '42 Canal Road',
      locality: 'Lahore',
      countryCode: 'PK',
      isDefault: false,
    });
    const view = renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Customer', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'customer_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    const completeRequest = mocks.mutationOptions.setDefaultAddress.onSuccess;
    mocks.pendingProcedure = 'setDefaultAddress';
    view.rerender(
      <EntitlementsProvider value={entitlements(true)}>
        <DeliveryConsole />
      </EntitlementsProvider>
    );
    expect(screen.getByRole('button', { name: 'Make default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: action }));
    const dialog = screen.getByRole('dialog', { name: title });
    fireEvent.change(within(dialog).getByLabelText('Address label'), {
      target: { value: 'Unsaved office name' },
    });

    act(() => {
      mocks.pendingProcedure = '';
      completeRequest();
    });

    expect(screen.getByRole('dialog', { name: title })).toBeVisible();
    expect(within(dialog).getByLabelText('Address label')).toHaveValue('Unsaved office name');
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Default address updated.');
  });

  it('does not offer an uncheck transition while editing the current default address', () => {
    mocks.addresses.push({
      id: 'address_1',
      label: 'Home',
      recipientName: 'Ayesha Khan',
      normalizedPhone: '+923001234567',
      addressLine1: '42 Canal Road',
      addressLine2: null,
      locality: 'Lahore',
      administrativeArea: null,
      postalCode: null,
      countryCode: 'PK',
      latitude: null,
      longitude: null,
      isDefault: true,
    });
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Customer', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'customer_1' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('checkbox', { name: 'Use as default address' })).toBeDisabled();
    expect(screen.getByText(/use Make default on another saved address/i)).toBeInTheDocument();
  });
});
