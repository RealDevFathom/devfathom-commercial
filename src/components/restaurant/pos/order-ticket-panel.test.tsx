import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  canCloseDeliveredOrder,
  OrderTicketPanel,
  type OrderDetail,
} from './order-ticket-panel';

const order: OrderDetail = {
  id: 'order-1',
  orderNumber: 42,
  status: 'OPEN',
  channel: 'DINE_IN',
  publicationId: 'publication-1',
  coverCount: 2,
  items: [
    {
      id: 'item-1',
      course: 2,
      seatNumber: 1,
      name: 'Steak',
      unitPrice: '24.00',
      quantity: 1,
      status: 'PREPARED',
      modifiers: [],
    },
  ],
  kitchenTickets: [{ id: 'ticket-1', ticketNumber: 7, stationId: 'station-1' }],
  tables: [{ id: 'link-1', tableId: 'table-1', active: true }],
  totals: { subtotal: '24.00', tax: '0.00', serviceCharge: '0.00' },
};

const operators = [
  { id: 'staff-1', displayName: 'Sam Cashier', role: 'Cashier' },
  { id: 'manager-1', displayName: 'Mina Manager', role: 'Manager' },
];

function handlers() {
  return {
    onHold: vi.fn(),
    onFire: vi.fn(),
    onSend: vi.fn(),
    onReprint: vi.fn(),
    onServed: vi.fn(),
    onRemake: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
    onMove: vi.fn(),
    onMerge: vi.fn(),
    onClose: vi.fn(),
    onCollectPayment: vi.fn(),
  };
}

const ineligibleDeliveryOrders: [string, Parameters<typeof canCloseDeliveredOrder>[0]][] = [
  ['not delivered', { channel: 'DELIVERY', deliveryStatus: 'OUT_FOR_DELIVERY', settled: true }],
  ['not settled', { channel: 'DELIVERY', deliveryStatus: 'DELIVERED', settled: false }],
  ['missing delivery state', { channel: 'DELIVERY', settled: true }],
  ['missing settlement state', { channel: 'DELIVERY', deliveryStatus: 'DELIVERED' }],
  ['not a delivery', { channel: 'TAKEAWAY', deliveryStatus: 'DELIVERED', settled: true }],
];

describe('OrderTicketPanel', () => {
  it('closes only a settled delivery order that has been delivered', () => {
    expect(
      canCloseDeliveredOrder({
        channel: 'DELIVERY',
        deliveryStatus: 'DELIVERED',
        settled: true,
      })
    ).toBe(true);
  });

  it.each(ineligibleDeliveryOrders)(
    'does not close a delivery order when it is %s',
    (_label, candidate) => {
      expect(canCloseDeliveredOrder(candidate)).toBe(false);
    }
  );

  it('provides 44px touch targets for hold, fire, and void actions', () => {
    render(
      <OrderTicketPanel
        order={order}
        actingOperatorId="staff-1"
        operators={operators}
        pending={false}
        {...handlers()}
      />
    );

    for (const name of ['Hold', 'Fire', 'Void Steak']) {
      const action = screen.getByRole('button', { name });
      expect(action).toHaveClass('h-11');
      expect(action).not.toHaveClass('h-8');
    }
  });

  it('routes hold, fire, and whole-order send actions', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={order}
        actingOperatorId="staff-1"
        operators={operators}
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send whole order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reprint KOT 7' }));

    expect(actions.onHold).toHaveBeenCalledWith(2);
    expect(actions.onFire).toHaveBeenCalledWith(2);
    expect(actions.onSend).toHaveBeenCalledOnce();
    expect(actions.onReprint).toHaveBeenCalledWith('ticket-1');
  });

  it('submits post-prep void approval, disposition, and reason', async () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={order}
        actingOperatorId="staff-1"
        operators={operators}
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    const dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Void reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Guest rejected doneness' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '5678' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Wastage disposition', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'RESTOCK' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }));

    await waitFor(() =>
      expect(actions.onVoid).toHaveBeenCalledWith({
        itemId: 'item-1',
        reason: 'Guest rejected doneness',
        wastageDisposition: 'RESTOCK',
        approving: { staffProfileId: 'manager-1', type: 'PIN', secret: '5678' },
      })
    );
    expect(screen.queryByRole('dialog', { name: 'Void Steak' })).not.toBeInTheDocument();
  });

  it('keeps failed void details open and rejects self approval', async () => {
    const actions = handlers();
    actions.onVoid.mockResolvedValue(false);
    const { rerender } = render(
      <OrderTicketPanel
        order={order}
        actingOperatorId="staff-1"
        operators={operators}
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    let dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Void reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Guest rejected doneness' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '5678' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }));

    await screen.findByText('Void was not completed. Review the error and try again.');
    dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    expect(selectFieldControl(within(dialog).getByLabelText('Void reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('Guest rejected doneness');
    expect(selectFieldControl(within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('manager-1');
    expect(selectFieldControl(within(dialog).getByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('5678');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    rerender(
      <OrderTicketPanel
        order={order}
        actingOperatorId="staff-1"
        operators={operators}
        pending={false}
        {...actions}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Void reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Approval required' },
    });
    expect(within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toHaveTextContent('Sam Cashier');
    fireEvent.change(selectFieldControl(within(dialog).getByLabelText('Manager PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '1234' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }));

    expect(selectFieldControl(within(dialog).getByLabelText('Approving manager', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
    expect(actions.onVoid).toHaveBeenCalledTimes(1);
  });

  it('marks remakes served and hides table actions for takeaway orders', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={{
          ...order,
          channel: 'TAKEAWAY',
          items: [{ ...order.items[0], status: 'REMAKE_REQUESTED' }],
        }}
        actingOperatorId="staff-1"
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark served' }));
    expect(actions.onServed).toHaveBeenCalledWith('item-1');
    expect(screen.queryByText('Move table')).not.toBeInTheDocument();
    expect(screen.queryByText('Merge tables')).not.toBeInTheDocument();
  });

  it('collects payment directly without closing a payment-pending order again', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={{ ...order, status: 'PAYMENT_PENDING' }}
        actingOperatorId="staff-1"
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    expect(actions.onCollectPayment).toHaveBeenCalledOnce();
    expect(actions.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Close order' })).not.toBeInTheDocument();
  });

  it('opens delivery checkout before dispatch without calling close and shows its fee separately', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={{
          ...order,
          channel: 'DELIVERY',
          status: 'OPEN',
          tables: [],
          totals: { ...order.totals, deliveryFee: '4.00' },
        }}
        actingOperatorId="staff-1"
        pending={false}
        {...actions}
      />
    );

    expect(screen.getByText(/Delivery fee 4.00/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    expect(actions.onCollectPayment).toHaveBeenCalledOnce();
    expect(actions.onClose).not.toHaveBeenCalled();
  });

  it('closes a delivered and paid delivery order instead of collecting payment again', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel
        order={{
          ...order,
          channel: 'DELIVERY',
          status: 'PAYMENT_PENDING',
          deliveryStatus: 'DELIVERED',
          settled: true,
          tables: [],
        }}
        actingOperatorId="staff-1"
        pending={false}
        {...actions}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close order' }));
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onCollectPayment).not.toHaveBeenCalled();
  });
});
