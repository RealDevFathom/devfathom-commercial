import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrderPad } from './order-pad';
import { PosOfflineRuntime } from '@/lib/restaurant/pos-offline-runtime';
import { reviveCommercialTerms } from '@/lib/restaurant/commercial-terms';
import { quoteDraftCheckTotal } from '@/lib/restaurant/draft-check-total';

const commercialTerms = {
  profiles: [
    {
      id: 'profile-1',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: '2099-01-01T00:00:00.000Z',
      status: 'PUBLISHED' as const,
      approvalReference: 'TAX-1',
      approvedAt: '2019-12-01T00:00:00.000Z',
    },
  ],
  rules: (['CASH', 'CARD', 'OTHER'] as const).map((category) => ({
    id: `rule-${category}`,
    profileVersionId: 'profile-1',
    paymentCategory: category,
    priceMode: 'EXCLUSIVE' as const,
    rate: '0.05',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    effectiveTo: '2099-01-01T00:00:00.000Z',
    status: 'PUBLISHED' as const,
    approvalReference: 'TAX-1',
    approvedAt: '2019-12-01T00:00:00.000Z',
    sourceExpiresAt: '2099-01-01T00:00:00.000Z',
  })),
  serviceChargeRate: '0.10',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const detail = {
  id: 'order-1',
  orderNumber: 42,
  status: 'OPEN',
  channel: 'DINE_IN',
  publicationId: 'publication-1',
  coverCount: 2,
  tables: [{ id: 'link-1', tableId: 'table-1', active: true }],
  kitchenTickets: [] as Array<{ id: string; ticketNumber: number; stationId: string }>,
  items: [] as Array<{
    id: string;
    course: number;
    seatNumber: number | null;
    name: string;
    unitPrice: string;
    quantity: number;
    status: string;
    modifiers: { id: string; name: string; priceDelta: string }[];
  }>,
  totals: { subtotal: '0.00', tax: '0.00', serviceCharge: '0.00' },
};

function menu(publicationId: string, itemName: string) {
  return {
    version: `version-${publicationId}`,
    branchId: 'branch-1',
    channel: publicationId.includes('TAKEAWAY') ? 'TAKEAWAY' : 'DINE_IN',
    publicationId,
    channelOpen: true,
    menu: { id: 'menu-1', name: 'Dinner' },
    sections: [
      {
        id: 'section-1',
        name: 'Drinks',
        sortOrder: 1,
        items: [
          {
            id: 'menu-item-1',
            productId: 'product-1',
            variantId: null,
            displayName: itemName,
            product: { name: itemName },
            price: '4.00',
            priceSource: 'BASE_LIST',
            sortOrder: 1,
            available: true,
            modifierGroups: [
              {
                id: 'group-1',
                name: 'Milk',
                minSelect: 0,
                maxSelect: 1,
                options: [
                  { id: 'option-1', name: 'Oat milk', priceDelta: '0.50' },
                  { id: 'option-2', name: 'Whole milk', priceDelta: '0.00' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function transport({
  failedOpenAttempts = 0,
  openErrors = [],
  detailResponse = detail,
  detailGate,
  failedAddAttempts = 0,
  refreshGate,
  openOrders = [],
  checkoutBillErrors = [],
  customerSearchGates = [],
  deliveryZoneGates = [],
  checkoutSettled = false,
  closeError,
}: {
  failedOpenAttempts?: number;
  openErrors?: { status: number; error: string }[];
  detailResponse?: typeof detail;
  detailGate?: Promise<void>;
  failedAddAttempts?: number;
  refreshGate?: Promise<void>;
  openOrders?: {
    id: string;
    orderNumber: number;
    status: string;
    channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    activeTableIds: string[];
    itemCount: number;
    subtotal: string;
  }[];
  checkoutBillErrors?: ({ status: number; error: string } | Error)[];
  customerSearchGates?: Promise<void>[];
  deliveryZoneGates?: Promise<void>[];
  checkoutSettled?: boolean;
  closeError?: { status: number; error: string };
} = {}) {
  let openAttempts = 0;
  let addAttempts = 0;
  let closeAttempts = 0;
  let openOrderReads = 0;
  let closed = false;
  let billCut = false;
  let checkoutBillAttempts = 0;
  let customerSearchAttempts = 0;
  let deliveryZoneAttempts = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith('/terminal/establish')) {
      return json(
        {
          sessionToken: 'session-token',
          session: { id: 'session-1', state: 'LOCKED', establishedAt: '2026-08-19T00:00:00Z' },
          device: {
            id: 'device-1',
            organizationId: 'organization-1',
            branchId: 'branch-1',
            name: 'Front register',
            branchName: 'Clifton Flagship',
          },
        },
        201
      );
    }
    if (path.endsWith('/terminal/operators')) {
      return json({
        operators: [
          { staffProfileId: 'staff-1', displayName: 'Amina Rahman', role: 'Shift lead' },
          { staffProfileId: 'staff-2', displayName: 'Bilal Khan', role: 'Cashier' },
        ],
      });
    }
    if (path.endsWith('/terminal/layout')) {
      return json({
        floors: [
          {
            id: 'floor-1',
            name: 'Main room',
            tables: [
              { id: 'table-1', code: 'T1', capacity: 4, occupied: false, activeOrderIds: [] },
              { id: 'table-2', code: 'T2', capacity: 2, occupied: false, activeOrderIds: [] },
            ],
          },
        ],
        sections: [{ id: 'server-section-1', name: 'Window section' }],
      });
    }
    if (path.endsWith('/terminal/unlock')) {
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-1' },
      });
    }
    if (path.endsWith('/terminal/lock')) {
      return json({ session: { id: 'session-1', state: 'LOCKED' } });
    }
    if (path.endsWith('/terminal/switch')) {
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-2' },
      });
    }
    if (path.endsWith('/orders/delivery/zones')) {
      await deliveryZoneGates[deliveryZoneAttempts++];
      return json({
        zones: [
          {
            id: 'zone-1',
            name: 'Central',
            minimumSubtotal: '0.00',
            fee: '2.00',
            promisedMinutes: 30,
          },
        ],
      });
    }
    if (path.includes('/orders/customer/search')) {
      const gate = customerSearchGates[customerSearchAttempts++];
      await gate;
      return json({
        customers: [{ customerId: 'customer-1', displayName: 'Private Guest', identifiers: [] }],
      });
    }
    if (path.includes('/orders/delivery/addresses')) {
      return json({
        addresses: [
          { id: 'address-1', label: 'Home', recipientName: 'Private Guest', isDefault: true },
        ],
      });
    }
    if (path.endsWith('/orders/delivery/attach')) {
      return json({ fulfillmentId: 'fulfillment-1' }, 201);
    }
    if (path.endsWith('/orders/commercial-terms')) {
      return json(commercialTerms);
    }
    if (path.includes('/orders/effective-menu')) {
      const publicationId = new URL(path, 'http://localhost').searchParams.get('publicationId');
      return json(
        publicationId
          ? menu(publicationId, 'Pinned coffee')
          : menu(`draft-${new URL(path, 'http://localhost').searchParams.get('channel')}`, 'Coffee')
      );
    }
    if (path.endsWith('/orders/open-orders')) {
      openOrderReads += 1;
      if (openOrderReads > 1) await refreshGate;
      return json({ orders: openOrders });
    }
    if (path.includes('/orders/detail')) {
      await detailGate;
      return json({
        ...detailResponse,
        status: closed ? 'PAYMENT_PENDING' : detailResponse.status,
      });
    }
    if (path.endsWith('/orders/open')) {
      openAttempts += 1;
      if (openAttempts <= failedOpenAttempts) throw new TypeError('network failed');
      const responseError = openErrors[openAttempts - failedOpenAttempts - 1];
      if (responseError) return json({ error: responseError.error }, responseError.status);
      return json({ orderId: 'order-1', orderNumber: 42 }, 201);
    }
    if (path.endsWith('/orders/add-item')) {
      addAttempts += 1;
      if (addAttempts <= failedAddAttempts) throw new TypeError('network failed');
      return json({ itemId: 'item-1' }, 201);
    }
    if (path.endsWith('/orders/close')) {
      closeAttempts += 1;
      if (closeError && closeAttempts === 1) {
        return json({ error: closeError.error }, closeError.status);
      }
      closed = true;
      return json({ orderId: 'order-1', status: 'PAYMENT_PENDING' });
    }
    if (path.includes('/checkout/summary')) {
      return json({
        orderId: 'order-1',
        settled: checkoutSettled,
        blocker: checkoutSettled ? null : billCut ? 'BILLS_OPEN' : 'ITEMS_UNBILLED',
        derivedOrderTotal: '24.00',
        accountedTotal: billCut ? '24.00' : '0.00',
        unbilledItemIds: billCut ? [] : ['item-1'],
        bills: billCut
          ? [
              {
                id: 'bill-1',
                status: 'OPEN',
                splitKind: 'NONE',
                grandTotal: '24.00',
                compTotal: '0.00',
                receiptNumber: null,
              },
            ]
          : [],
      });
    }
    if (path.endsWith('/checkout/bill')) {
      checkoutBillAttempts += 1;
      const responseError = checkoutBillErrors[checkoutBillAttempts - 1];
      if (responseError instanceof Error) throw responseError;
      if (responseError) return json({ error: responseError.error }, responseError.status);
      billCut = true;
      return json({ billIds: ['bill-1'] }, 201);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return vi.fn(fetch);
}

async function unlock(fetch: ReturnType<typeof transport>) {
  vi.stubGlobal('fetch', fetch);
  render(<OrderPad />);

  await screen.findByRole('heading', { name: 'Terminal locked' });
  expect(screen.getByText('Front register · Clifton Flagship')).toBeVisible();
  expect(screen.queryByText(/branch-1/)).not.toBeInTheDocument();
  await screen.findByRole('option', { name: 'Amina Rahman — Shift lead' });
  fireEvent.change(screen.getByLabelText('Operator'), {
    target: { value: 'staff-1' },
  });
  fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock terminal' }));
  await screen.findByRole('heading', { name: 'Order pad' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OrderPad transport', () => {
  it('bootstraps an unlocked demo runtime without asking for enrollment or a PIN', async () => {
    const ordinary = transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/demo/restaurants/device-session')) {
        return json({
          ready: true,
          branchId: 'branch-1',
          sessionToken: 'session-token',
          session: {
            id: 'session-1',
            state: 'UNLOCKED',
            activeStaffProfileId: 'staff-1',
            establishedAt: '2026-08-19T00:00:00Z',
          },
          device: {
            id: 'device-1',
            organizationId: 'org_demo_restaurant_seat_1',
            branchId: 'branch-1',
            name: 'Demo register',
            branchName: 'Clifton Flagship',
          },
          operator: {
            staffProfileId: 'staff-1',
            displayName: 'Demo Manager',
            role: 'Manager',
          },
        });
      }
      return ordinary(input, init);
    });
    vi.stubGlobal('fetch', fetch);

    render(
      <StrictMode>
        <OrderPad demo />
      </StrictMode>
    );

    expect(await screen.findByRole('heading', { name: 'Order pad' })).toBeVisible();
    await waitFor(() => {
      expect(
        fetch.mock.calls.some(([input]) => String(input).includes('/orders/effective-menu'))
      ).toBe(true);
      expect(
        fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/open-orders'))
      ).toBe(true);
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/terminal/layout'))).toBe(
        true
      );
    });
    expect(screen.getByRole('button', { name: /Coffee4\.00/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Terminal locked' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Operator PIN')).not.toBeInTheDocument();
    const bootstraps = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith('/demo/restaurants/device-session')
    );
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'POS' }),
    });
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/terminal/establish'))).toBe(
      false
    );
  });

  it('clears an open demo runtime when the server reports that demo access expired', async () => {
    const ordinary = transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/demo/restaurants/device-session')) {
        return json({
          ready: true,
          branchId: 'branch-1',
          sessionToken: 'session-token',
          session: {
            id: 'session-1',
            state: 'UNLOCKED',
            activeStaffProfileId: 'staff-1',
            establishedAt: '2026-08-19T00:00:00Z',
          },
          device: {
            id: 'device-1',
            organizationId: 'org_demo_restaurant_seat_1',
            branchId: 'branch-1',
            name: 'Demo register',
            branchName: 'Clifton Flagship',
          },
          operator: {
            staffProfileId: 'staff-1',
            displayName: 'Demo Manager',
            role: 'Manager',
          },
        });
      }
      if (path.endsWith('/checkout/refund')) {
        return json({ error: 'Demo access has expired; reopen the restaurant demo.' }, 401);
      }
      return ordinary(input, init);
    });
    vi.stubGlobal('fetch', fetch);
    render(<OrderPad demo />);
    await screen.findByRole('heading', { name: 'Order pad' });

    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));

    expect(await screen.findByRole('heading', { name: 'Demo entry required' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Reopen restaurant demo' })).toHaveAttribute(
      'href',
      '/demo/restaurants'
    );
  });

  it('keeps a normal terminal open after a rejected approving PIN', async () => {
    const ordinary = transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/terminal/operators')) {
        return json({
          operators: [
            {
              staffProfileId: 'staff-1',
              displayName: 'Amina Rahman',
              role: 'Shift lead',
              canApprove: true,
            },
            {
              staffProfileId: 'staff-2',
              displayName: 'Bilal Khan',
              role: 'Manager',
              canApprove: true,
            },
          ],
        });
      }
      if (path.endsWith('/checkout/refund')) {
        if (init?.method === 'POST') {
          return json({ error: 'Invalid approving credential.' }, 401);
        }
        return json({
          tenders: [
            {
              tenderId: 'tender-1',
              orderNumber: 42,
              receiptNumber: 'R-0042',
              type: 'CARD',
              paidAmount: '20.00',
              refundedAmount: '0.00',
              remainingAmount: '20.00',
              tipPaidAmount: '0.00',
              tipRefundedAmount: '0.00',
              tipRemainingAmount: '0.00',
              paidAt: '2026-09-04T12:00:00.000Z',
            },
          ],
        });
      }
      return ordinary(input, init);
    });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    await screen.findByRole('option', { name: /R-0042/ });
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: 'tender-1' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Guest request' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), {
      target: { value: 'staff-2' },
    });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid approving credential.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  });

  it('clears delivery instructions when the terminal locks before another operator can unlock', async () => {
    const fetch = transport();
    await unlock(fetch);

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    const instructions = await screen.findByLabelText('Delivery instructions');
    fireEvent.change(instructions, { target: { value: 'Private gate code 9876' } });
    expect(instructions).toHaveValue('Private gate code 9876');

    fireEvent.click(screen.getByRole('button', { name: 'Lock terminal' }));
    await screen.findByRole('heading', { name: 'Terminal locked' });
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'staff-1' } });
    fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock terminal' }));
    await screen.findByRole('heading', { name: 'Order pad' });
    expect(await screen.findByLabelText('Delivery instructions')).toHaveValue('');
  });

  it('ignores a deferred customer response after lock', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = transport({ customerSearchGates: [gate] });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    fireEvent.change(await screen.findByLabelText('Customer name'), {
      target: { value: 'Private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock terminal' }));
    await screen.findByRole('heading', { name: 'Terminal locked' });
    release();
    await Promise.resolve();
    expect(screen.queryByText('Private Guest')).not.toBeInTheDocument();
  });

  it('ignores a deferred customer response after operator switch', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = transport({ customerSearchGates: [gate] });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    fireEvent.change(await screen.findByLabelText('Customer name'), {
      target: { value: 'Private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    fireEvent.change(screen.getByLabelText('Operator', { selector: '#switch-operator-id' }), {
      target: { value: 'staff-2' },
    });
    fireEvent.change(screen.getByLabelText('Operator PIN', { selector: '#switch-operator-pin' }), {
      target: { value: '1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
    await screen.findByText('Operator switched. New actions use the incoming identity.');
    release();
    await Promise.resolve();
    expect(screen.queryByText('Private Guest')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Customer name')).toHaveValue('');
  });

  it('ignores a deferred customer response after device revocation', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = transport({
      customerSearchGates: [Promise.resolve(), gate],
      openErrors: [{ status: 403, error: 'This device has been revoked.' }],
    });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    const customerName = await screen.findByLabelText('Customer name');
    fireEvent.change(customerName, { target: { value: 'Private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Private Guest' }));
    await waitFor(() => expect(screen.getByLabelText('Saved address')).toHaveValue('address-1'));
    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByRole('heading', { name: 'Not enrolled' });
    release();
    await Promise.resolve();
    expect(screen.queryByText('Private Guest')).not.toBeInTheDocument();
  });

  it('ignores a deferred customer response after successful delivery handoff', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = transport({ customerSearchGates: [Promise.resolve(), gate] });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    const customerName = await screen.findByLabelText('Customer name');
    fireEvent.change(customerName, { target: { value: 'Private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Private Guest' }));
    await waitFor(() => expect(screen.getByLabelText('Saved address')).toHaveValue('address-1'));
    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/delivery/attach'))
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByLabelText('Customer name')).toHaveValue(''));
    release();
    await Promise.resolve();
    expect(screen.queryByText('Private Guest')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Customer name')).toHaveValue('');
  });

  it('preserves the delivery success notice while reconciling the opened order', async () => {
    const fetch = transport({ customerSearchGates: [Promise.resolve()] });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    fireEvent.change(await screen.findByLabelText('Customer name'), {
      target: { value: 'Private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Private Guest' }));
    await waitFor(() => expect(screen.getByLabelText('Saved address')).toHaveValue('address-1'));
    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));

    expect(
      await screen.findByText('Delivery order 42 opened and fulfillment attached.')
    ).toBeVisible();
    expect(screen.queryByText('Order 42 active.')).not.toBeInTheDocument();
  });

  it('announces the active order when its detail is selected directly', async () => {
    const fetch = transport({
      openOrders: [
        {
          id: 'order-1',
          orderNumber: 42,
          status: 'OPEN',
          channel: 'DINE_IN',
          activeTableIds: ['table-1'],
          itemCount: 0,
          subtotal: '0.00',
        },
      ],
    });
    await unlock(fetch);

    fireEvent.click(await screen.findByRole('button', { name: /#42/ }));

    expect(await screen.findByText('Order 42 active.')).toBeVisible();
  });

  it('uses singular and plural unit labels for open orders', async () => {
    const fetch = transport({
      openOrders: [
        {
          id: 'order-1',
          orderNumber: 41,
          status: 'OPEN',
          channel: 'DINE_IN',
          activeTableIds: [],
          itemCount: 1,
          subtotal: '4.00',
        },
        {
          id: 'order-2',
          orderNumber: 42,
          status: 'OPEN',
          channel: 'DINE_IN',
          activeTableIds: [],
          itemCount: 2,
          subtotal: '8.00',
        },
      ],
    });
    await unlock(fetch);

    expect(await screen.findByRole('button', { name: /#41 · 1 item/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /#42 · 2 items/ })).toBeVisible();
  });

  it('refetches zones when customer selection invalidates an in-flight zone response', async () => {
    let releaseZones = () => {};
    const zoneGate = new Promise<void>((resolve) => (releaseZones = resolve));
    const fetch = transport({
      customerSearchGates: [Promise.resolve()],
      deliveryZoneGates: [zoneGate, Promise.resolve()],
    });
    await unlock(fetch);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'DELIVERY' } });
    fireEvent.change(await screen.findByLabelText('Customer name'), {
      target: { value: 'Private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Private Guest' }));

    await waitFor(() => expect(screen.getByLabelText('Delivery zone')).toHaveValue('zone-1'));
    releaseZones();
    await Promise.resolve();
    expect(
      fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/delivery/zones'))
    ).toHaveLength(2);
    expect(screen.getByLabelText('Delivery zone')).toHaveValue('zone-1');
  });

  it('uses AA semantic text tokens on the initial POS screen', () => {
    render(<OrderPad />);

    expect(screen.getByText('not enrolled')).toHaveClass('!text-text-strong');
    expect(
      screen.getByText('Restaurant POS', { selector: '[data-slot="eyebrow"] span' })
    ).toHaveClass('text-text-strong');
    expect(screen.getByText(/Verifying this browser with the server/)).toHaveClass(
      'text-text-body'
    );
  });

  it('composes item taps locally without a round trip', async () => {
    const fetch = transport();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000099'
    );
    await unlock(fetch);
    const callsBeforeTap = fetch.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Oat milk/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(fetch).toHaveBeenCalledTimes(callsBeforeTap);
    expect(screen.getByText('1 × Coffee')).toBeVisible();
    expect(screen.getByText('Coffee added locally. No request was sent.')).toBeVisible();
  });

  it('opens a composed draft directly while online and makes it the active order', async () => {
    const fetch = transport();
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Oat milk/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));

    expect(await screen.findByText('Order 42 opened.')).toBeVisible();
    expect(await screen.findByText('Order 42')).toBeVisible();
    expect(screen.queryByText('Order saved to the queue.')).not.toBeInTheDocument();
    expect(screen.getByText('Queued 0')).toBeVisible();
    const paths = fetch.mock.calls.map(([input]) => String(input));
    const openIndex = paths.findIndex((path) => path.endsWith('/orders/open'));
    const addIndex = paths.findIndex((path) => path.endsWith('/orders/add-item'));
    expect(openIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(openIndex);
    expect(JSON.parse(String(fetch.mock.calls[addIndex]?.[1]?.body))).toMatchObject({
      orderId: 'order-1',
      menuItemId: 'menu-item-1',
      quantity: 1,
      modifierOptionIds: ['option-1'],
    });
    expect(
      screen.getByText('Tap menu items to compose. Nothing is sent until Send order.')
    ).toBeVisible();
  });

  it('starts a fresh draft once the settled check closes', async () => {
    const fetch = transport({
      detailResponse: { ...detail, status: 'PAYMENT_PENDING' },
      checkoutSettled: true,
    });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    await screen.findByText('settled');

    fireEvent.click(screen.getByRole('button', { name: 'Close checkout' }));

    expect(await screen.findByRole('heading', { name: 'No active order' })).toBeVisible();
    const callsBeforeTap = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    expect(screen.getByText('Coffee added locally. No request was sent.')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(callsBeforeTap);
  });

  it.each(['PAYMENT_PENDING', 'SERVED'])(
    'finalizes a paid and delivered %s delivery order without reopening checkout',
    async (status) => {
      const fetch = transport({
        detailResponse: {
          ...detail,
          channel: 'DELIVERY',
          status,
          deliveryStatus: 'DELIVERED',
          settled: true,
        },
      });
      await unlock(fetch);
      fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
      await screen.findByText('Order 42');

      const closeOrder = screen.getByRole('button', { name: 'Close order' });
      fireEvent.click(closeOrder);
      fireEvent.click(closeOrder);

      await waitFor(() =>
        expect(
          fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/close'))
        ).toHaveLength(1)
      );
      expect(
        fetch.mock.calls.filter(([input]) => String(input).includes('/checkout/'))
      ).toHaveLength(0);
      expect(screen.queryByRole('heading', { name: 'Collect payment' })).not.toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'No active order' })).toBeVisible();
    }
  );

  it('keeps a delivered delivery order active when finalization fails', async () => {
    const fetch = transport({
      detailResponse: {
        ...detail,
        channel: 'DELIVERY',
        status: 'PAYMENT_PENDING',
        deliveryStatus: 'DELIVERED',
        settled: true,
      },
      closeError: { status: 409, error: 'Order settlement changed.' },
    });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');

    fireEvent.click(screen.getByRole('button', { name: 'Close order' }));

    expect(await screen.findByText('Order settlement changed.')).toBeVisible();
    expect(screen.getByText('Order 42')).toBeVisible();
    const retryClose = screen.getByRole('button', { name: 'Close order' });
    expect(retryClose).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'No active order' })).not.toBeInTheDocument();

    fireEvent.click(retryClose);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/close'))
      ).toHaveLength(2)
    );
    expect(await screen.findByRole('heading', { name: 'No active order' })).toBeVisible();
  });

  it('keeps an unsettled check active when checkout closes', async () => {
    const fetch = transport({ detailResponse: { ...detail, status: 'PAYMENT_PENDING' } });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    await screen.findByRole('button', { name: 'Cut single bill' });

    fireEvent.click(screen.getByRole('button', { name: 'Close checkout' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Collect payment' })).not.toBeInTheDocument()
    );
    expect(screen.getByText('Order 42')).toBeVisible();
  });

  it('queues a composed new order offline and disables connected-only operations', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const fetch = transport();
    await unlock(fetch);

    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cash drawer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refund' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    const callsBeforeQueue = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));

    await screen.findByText('Queued 2');
    expect(fetch).toHaveBeenCalledTimes(callsBeforeQueue);
    expect(screen.getByText(/Checkout, tenders, refunds, drawers/)).toBeVisible();
  });

  it('requires reauthentication after replay pauses and resumes the preserved queue on unlock', async () => {
    let connected = false;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => connected);
    const fetch = transport({ openErrors: [{ status: 401, error: 'Terminal session expired.' }] });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Queued 2');

    connected = true;
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByRole('heading', { name: 'Terminal locked' })).toBeVisible();
    expect(
      screen.getByText('Queued orders are paused. Reauthenticate to resume replay.')
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock terminal' }));
    await screen.findByRole('heading', { name: 'Order pad' });
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/open'))
      ).toHaveLength(2)
    );
  });

  it('fails closed when IndexedDB hydration is unrecoverable', async () => {
    vi.spyOn(PosOfflineRuntime.prototype, 'hydrate').mockResolvedValue('unrecoverable');
    const fetch = transport();
    vi.stubGlobal('fetch', fetch);
    render(<OrderPad />);

    expect(
      await screen.findByRole('heading', { name: 'Local POS recovery required' })
    ).toBeVisible();
    expect(screen.getByText(/Local POS data could not be recovered/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Unlock terminal' })).not.toBeInTheDocument();
  });

  it('keeps internal profile IDs out of the UI and sends the selected hidden ID', async () => {
    const fetch = transport();
    await unlock(fetch);

    expect(screen.getByText('Amina Rahman · Shift lead')).toBeVisible();
    expect(screen.getByText('Server: Amina Rahman')).toBeVisible();
    expect(screen.queryByText('staff-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/profile id/i)).not.toBeInTheDocument();

    const unlockCall = fetch.mock.calls.find(([input]) =>
      String(input).endsWith('/terminal/unlock')
    );
    expect(JSON.parse(String(unlockCall?.[1]?.body))).toEqual({
      staffProfileId: 'staff-1',
      type: 'PIN',
      secret: '1234',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/open'))).toBe(true)
    );
    const openCall = fetch.mock.calls.find(([input]) => String(input).endsWith('/orders/open'));
    expect(JSON.parse(String(openCall?.[1]?.body))).not.toHaveProperty('serverStaffProfileId');
  });

  it.each(['native', 'HTTP fallback'])(
    'reuses an uncertain retry key, creates a fresh later key, and pins the active menu (%s)',
    async (mode) => {
      const fetch = transport({ failedOpenAttempts: 1 });
      if (mode === 'native') {
        vi.spyOn(globalThis.crypto, 'randomUUID')
          .mockReturnValueOnce('00000000-0000-4000-8000-000000000046')
          .mockReturnValueOnce('00000000-0000-4000-8000-000000000047');
      } else {
        let next = 0x46;
        vi.stubGlobal('crypto', {
          getRandomValues(bytes: Uint8Array) {
            bytes.fill(0);
            bytes[15] = next++;
            return bytes;
          },
        });
      }
      await unlock(fetch);

      fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
      await screen.findByText('Network request failed. Retry this action.');
      fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
      await screen.findByText('Order 42');
      expect(screen.getByRole('button', { name: /Pinned coffee/ })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /^Coffee/ })).not.toBeInTheDocument();
      expect(
        fetch.mock.calls.some(([input]) =>
          String(input).includes(
            '/orders/effective-menu?channel=DINE_IN&publicationId=publication-1'
          )
        )
      ).toBe(true);

      const channel = screen.getByLabelText('Channel');
      expect(channel).toHaveValue('DINE_IN');
      expect(screen.getByRole('option', { name: 'Delivery' })).toBeEnabled();
      expect(screen.getByRole('option', { name: 'Takeaway' })).toBeInTheDocument();

      await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
      await waitFor(() =>
        expect(
          fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/open'))
        ).toHaveLength(3)
      );

      const opens = fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/open'));
      expect(opens.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
        '00000000-0000-4000-8000-000000000046',
        '00000000-0000-4000-8000-000000000046',
        '00000000-0000-4000-8000-000000000047',
      ]);
      expect(new Headers(opens[0]?.[1]?.headers).get('X-Terminal-Session')).toBe('session-token');
    }
  );

  it('omits stale tables when opening a non-dine-in order', async () => {
    const fetch = transport();
    await unlock(fetch);

    fireEvent.click(screen.getByLabelText(/T1/));
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'TAKEAWAY' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));

    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/open'))).toBe(true)
    );
    const open = fetch.mock.calls.find(([input]) => String(input).endsWith('/orders/open'));
    expect(JSON.parse(String(open?.[1]?.body))).toEqual({
      channel: 'TAKEAWAY',
      publicationId: 'draft-TAKEAWAY',
    });
  });

  it('reuses a mutation retry key and refreshes it after completion', async () => {
    const fetch = transport({ failedAddAttempts: 1 });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000045')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000046')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000047');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: /Pinned coffee/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await screen.findByText('Network request failed. Retry this action.');
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'))
      ).toHaveLength(2)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'))
      ).toHaveLength(3)
    );

    const adds = fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'));
    expect(adds.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000047',
    ]);
  });

  it('keeps the outer command pending through detail and menu reconciliation', async () => {
    let releaseDetail = () => {};
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    const fetch = transport({ detailGate });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).includes('/orders/detail'))).toBe(
        true
      )
    );
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
    expect(screen.getByText('Request pending. Controls are paused.')).toBeVisible();

    releaseDetail();
    await screen.findByText('Order 42');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
  });

  it('exposes pending state for a standalone refresh', async () => {
    let releaseRefresh = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetch = transport({ refreshGate });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText('Request pending. Controls are paused.')).toBeVisible();

    releaseRefresh();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('keeps ordinary permission denial in session but resets immediately on device revocation', async () => {
    const fetch = transport({
      openErrors: [
        { status: 403, error: 'Missing order.open capability.' },
        { status: 403, error: 'This device has been revoked.' },
      ],
    });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Permission denied: Missing order.open capability.');
    expect(screen.getByRole('heading', { name: 'Order pad' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByRole('heading', { name: 'Not enrolled' });
    expect(screen.getByText(/Device revoked:/)).toBeVisible();
  });

  it('opens checkout only after close refreshes the order into payment pending', async () => {
    const fetch = transport();
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');

    fireEvent.click(screen.getByRole('button', { name: 'Close order' }));

    expect(await screen.findByRole('heading', { name: 'Collect payment' })).toBeVisible();
    const closeIndex = fetch.mock.calls.findIndex(([input]) =>
      String(input).endsWith('/orders/close')
    );
    const refreshedDetailIndex = fetch.mock.calls.findLastIndex(([input]) =>
      String(input).includes('/orders/detail')
    );
    const summaryIndex = fetch.mock.calls.findIndex(([input]) =>
      String(input).includes('/checkout/summary')
    );
    expect(closeIndex).toBeGreaterThan(-1);
    expect(refreshedDetailIndex).toBeGreaterThan(closeIndex);
    expect(summaryIndex).toBeGreaterThan(refreshedDetailIndex);
  });

  it('opens payment pending directly and carries auth plus idempotency to checkout bill', async () => {
    const fetch = transport({ detailResponse: { ...detail, status: 'PAYMENT_PENDING' } });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000061')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000062');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');

    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    await screen.findByRole('button', { name: 'Cut single bill' });
    expect(
      fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/close'))
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cut single bill' }));
    await screen.findByText('Bill total');
    const bill = fetch.mock.calls.find(([input]) => String(input).endsWith('/checkout/bill'));
    expect(JSON.parse(String(bill?.[1]?.body))).toEqual({
      orderId: 'order-1',
      split: { kind: 'NONE' },
    });
    const headers = new Headers(bill?.[1]?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Terminal-Session')).toBe('session-token');
    expect(headers.get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000062');
  });

  it('retains checkout idempotency across ambiguous failures and releases it after a client error', async () => {
    const messages = [
      'Request timed out.',
      'Rate limited.',
      'Service unavailable.',
      'network failed',
      'request timed out',
      'Invalid split.',
    ];
    const fetch = transport({
      detailResponse: { ...detail, status: 'PAYMENT_PENDING' },
      checkoutBillErrors: [
        { status: 408, error: messages[0]! },
        { status: 429, error: messages[1]! },
        { status: 503, error: messages[2]! },
        new TypeError(messages[3]),
        Object.assign(new Error(messages[4]), { name: 'TimeoutError' }),
        { status: 400, error: messages[5]! },
      ],
    });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000061')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000062')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000063');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    const cut = await screen.findByRole('button', { name: 'Cut single bill' });

    for (const failureMessage of messages) {
      fireEvent.click(cut);
      await screen.findByText(failureMessage);
      await waitFor(() => expect(cut).toBeEnabled());
    }
    fireEvent.click(cut);
    await screen.findByText('Bill total');

    const bills = fetch.mock.calls.filter(([input]) => String(input).endsWith('/checkout/bill'));
    expect(bills.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000063',
    ]);
  });

  it('keeps the open-order form uncapped and prices modifiers into the draft total', async () => {
    await unlock(transport());
    const card = screen
      .getByRole('heading', { name: 'Open order' })
      .closest('[data-slot="section-card"]');
    expect(card?.className).not.toContain('max-h-40');
    expect(screen.getByRole('button', { name: 'Open order' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Oat milk/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    const terms = reviveCommercialTerms(commercialTerms);
    const priced = quoteDraftCheckTotal({
      profiles: terms.profiles,
      rules: terms.rules,
      serviceChargeRate: terms.serviceChargeRate,
      lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
    });
    expect(priced).toBe('5.18');
    expect(screen.getByText('Cash total')).toBeVisible();
    expect(await screen.findByText(priced)).toBeVisible();
  });

  it('does not let F9 close the check while a void dialog is open or a field is focused', async () => {
    const fetch = transport({
      openOrders: [
        {
          id: 'order-1',
          orderNumber: 42,
          status: 'OPEN',
          channel: 'DINE_IN',
          activeTableIds: ['table-1'],
          itemCount: 1,
          subtotal: '24.00',
        },
      ],
      detailResponse: {
        ...detail,
        kitchenTickets: [],
        items: [
          {
            id: 'item-1',
            course: 1,
            seatNumber: null,
            name: 'Steak',
            unitPrice: '24.00',
            quantity: 1,
            status: 'QUEUED',
            modifiers: [],
          },
        ],
      },
    });
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: /#42/ }));
    const pay = await screen.findByRole('button', { name: 'Close order' });
    const click = vi.spyOn(pay, 'click');

    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    expect(await screen.findByRole('dialog', { name: 'Void Steak' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'F9' });
    expect(click).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Void Steak' })).not.toBeInTheDocument()
    );
    const covers = screen.getByLabelText('Covers');
    covers.focus();
    fireEvent.keyDown(covers, { key: 'F9' });
    expect(click).not.toHaveBeenCalled();

    covers.blur();
    screen.getByLabelText('Menu search').blur();
    fireEvent.keyDown(window, { key: 'F9' });
    expect(click).toHaveBeenCalledTimes(1);
  });
});
