import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  orders: {
    data: {
      orders: [
        {
          id: 'order_1',
          orderNumber: 42,
          businessDate: '2026-08-19',
          status: 'OPEN',
          channel: 'DINE_IN',
          coverCount: 2,
          sectionId: 'section_1',
          serverStaffProfileId: 'staff_server',
          activeTableIds: ['table_1'],
          activeTables: [{ id: 'table_1', code: 'T1' }],
          itemCount: 1,
          subtotal: '18.50',
        },
      ],
      nextCursor: null,
    },
    error: null as unknown,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  order: {
    data: {
      id: 'order_1',
      branchId: 'branch_1',
      orderNumber: 42,
      businessDate: '2026-08-19',
      status: 'OPEN',
      channel: 'DINE_IN',
      coverCount: 2,
      sectionId: 'section_1',
      serverStaffProfileId: 'staff_server',
      staffProfileId: 'staff_opened',
      deviceId: 'device_opened',
      publicationId: 'publication_1',
      priceListVersionId: 'price_1',
      openedAt: new Date('2026-08-19T10:00:00Z'),
      closedAt: null,
      cancelledAt: null,
      items: [],
      tables: [],
      events: [
        {
          id: 'event_1',
          sequence: 1,
          eventType: 'OPENED',
          actorStaffProfileId: 'staff_opened',
          actorDeviceId: 'device_opened',
          payload: null,
          createdAt: new Date('2026-08-19T10:00:00Z'),
        },
      ],
      kitchenTickets: [],
      totals: { subtotal: '18.50', tax: '0', serviceCharge: '0' },
    },
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
  listCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  detailCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  cancel: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantStaff: {
      listBranches: {
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
          error: null,
          isLoading: false,
        }),
      },
      listDirectory: {
        useQuery: () => ({
          data: [
            { id: 'staff_opened', displayName: 'Amina Khan', role: 'Server' },
            { id: 'staff_1', displayName: 'Shift Lead', role: 'Server' },
            { id: 'manager_1', displayName: 'Mina Manager', role: 'Manager' },
          ],
          error: null,
          isLoading: false,
        }),
      },
    },
    restaurantDevices: {
      list: {
        useQuery: () => ({
          data: [
            {
              id: 'device_1',
              name: 'Front Register',
              branch: { id: 'branch_1', name: 'Downtown' },
              status: 'ACTIVE',
            },
          ],
          error: null,
          isLoading: false,
        }),
      },
    },
    useUtils: () => ({
      restaurantOrders: {
        listOrders: { invalidate: mocks.invalidate },
        getOrder: { invalidate: mocks.invalidate },
      },
    }),
    restaurantOrders: {
      listOrders: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.listCalls.push({ input, enabled: options.enabled });
          return mocks.orders;
        },
      },
      getOrder: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.detailCalls.push({ input, enabled: options.enabled });
          return mocks.order;
        },
      },
      cancel: {
        useMutation: () => ({ mutate: mocks.cancel, isPending: false }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { OrdersConsole } from './orders-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-pos'] : [],
    modules: [
      {
        key: 'restaurant-pos',
        name: 'Restaurant POS',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  };
}

function renderConsole(enabled = true) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <OrdersConsole />
    </EntitlementsProvider>
  );
}

describe('OrdersConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCalls.length = 0;
    mocks.detailCalls.length = 0;
  });

  it('gates list and detail reads by entitlement, branch, and selection', () => {
    const disabled = renderConsole(false);
    expect(mocks.listCalls.at(-1)?.enabled).toBe(false);
    expect(mocks.detailCalls.at(-1)?.enabled).toBe(false);
    expect(screen.getByText('Restaurant POS module disabled')).toBeInTheDocument();
    disabled.unmount();

    renderConsole();
    expect(mocks.listCalls.at(-1)?.enabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(mocks.listCalls.at(-1)).toEqual({
      input: { branchId: 'branch_1', limit: 25 },
      enabled: true,
    });
    expect(mocks.detailCalls.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'View order 42' }));
    expect(screen.getByText('Recorded by Amina Khan')).toBeVisible();
    expect(screen.queryByText(/staff_opened/)).not.toBeInTheDocument();
    expect(mocks.detailCalls.at(-1)).toEqual({
      input: { orderId: 'order_1' },
      enabled: true,
    });
  });

  it('names tables by their floor-plan code and never prints raw ids in the ledger', () => {
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    const row = screen.getByRole('button', { name: 'View order 42' }).closest('tr')!;
    expect(row).toHaveTextContent('#42');
    expect(within(row).getByText('T1')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('table_1');
    expect(row).not.toHaveTextContent('order_1');
  });

  it('keeps DELIVERY available for historical order filtering', () => {
    renderConsole();

    const channel = screen.getByLabelText('Channel');
    expect(within(channel).getByRole('option', { name: 'DINE IN' })).toBeInTheDocument();
    expect(within(channel).getByRole('option', { name: 'TAKEAWAY' })).toBeInTheDocument();
    expect(within(channel).getByRole('option', { name: 'DELIVERY' })).toBeInTheDocument();
  });

  it('cancels with session attribution, a verified approver credential, and a native idempotency key', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000045'
    );
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'View order 42' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));

    const dialog = screen.getByRole('dialog', { name: 'Cancel order #42?' });
    // The acting staff is the signed-in user; the console offers no actor picker.
    expect(within(dialog).queryByLabelText('Acting staff member')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/recorded as your own signed-in staff profile/i)).toBeVisible();
    expect(within(dialog).queryByLabelText('Approving PIN or badge secret')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Device'), {
      target: { value: 'device_1' },
    });
    expect(within(dialog).getByText('Front Register — Downtown')).toBeVisible();
    expect(within(dialog).queryByText('device_1')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Guest left' },
    });
    fireEvent.change(within(dialog).getByLabelText('Wastage disposition'), {
      target: { value: 'WASTE' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving staff member (optional)'), {
      target: { value: 'manager_1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving credential type'), {
      target: { value: 'BADGE' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving PIN or badge secret'), {
      target: { value: 'badge-77' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(mocks.cancel).toHaveBeenCalledWith({
      orderId: 'order_1',
      reason: 'Guest left',
      wastageDisposition: 'WASTE',
      approvingStaffProfileId: 'manager_1',
      approvingCredential: { type: 'BADGE', secret: 'badge-77' },
      actor: {
        deviceId: 'device_1',
        idempotencyKey: '00000000-0000-4000-8000-000000000045',
      },
    });
  });
});
