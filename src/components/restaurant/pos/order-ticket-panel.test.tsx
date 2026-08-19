import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrderTicketPanel, type OrderDetail } from './order-ticket-panel';

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
  tables: [{ id: 'link-1', tableId: 'table-1', active: true }],
  totals: { subtotal: '24.00', tax: '0.00', serviceCharge: '0.00' },
};

function handlers() {
  return {
    onHold: vi.fn(),
    onFire: vi.fn(),
    onSend: vi.fn(),
    onServed: vi.fn(),
    onRemake: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
    onMove: vi.fn(),
    onMerge: vi.fn(),
    onClose: vi.fn(),
    onCollectPayment: vi.fn(),
  };
}

describe('OrderTicketPanel', () => {
  it('routes hold, fire, and whole-order send actions', () => {
    const actions = handlers();
    render(
      <OrderTicketPanel order={order} actingOperatorId="staff-1" pending={false} {...actions} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send whole order' }));

    expect(actions.onHold).toHaveBeenCalledWith(2);
    expect(actions.onFire).toHaveBeenCalledWith(2);
    expect(actions.onSend).toHaveBeenCalledOnce();
  });

  it('submits post-prep void approval, disposition, and reason', async () => {
    const actions = handlers();
    render(
      <OrderTicketPanel order={order} actingOperatorId="staff-1" pending={false} {...actions} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    const dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(within(dialog).getByLabelText('Void reason'), {
      target: { value: 'Guest rejected doneness' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving manager profile ID'), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Manager PIN'), {
      target: { value: '5678' },
    });
    fireEvent.change(within(dialog).getByLabelText('Wastage disposition'), {
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
      <OrderTicketPanel order={order} actingOperatorId="staff-1" pending={false} {...actions} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    let dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(within(dialog).getByLabelText('Void reason'), {
      target: { value: 'Guest rejected doneness' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving manager profile ID'), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Manager PIN'), {
      target: { value: '5678' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }));

    await screen.findByText('Void was not completed. Review the error and try again.');
    dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    expect(within(dialog).getByLabelText('Void reason')).toHaveValue('Guest rejected doneness');
    expect(within(dialog).getByLabelText('Approving manager profile ID')).toHaveValue('manager-1');
    expect(within(dialog).getByLabelText('Manager PIN')).toHaveValue('5678');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    rerender(
      <OrderTicketPanel order={order} actingOperatorId="staff-1" pending={false} {...actions} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Void Steak' }));
    dialog = screen.getByRole('dialog', { name: 'Void Steak' });
    fireEvent.change(within(dialog).getByLabelText('Void reason'), {
      target: { value: 'Approval required' },
    });
    fireEvent.change(within(dialog).getByLabelText('Approving manager profile ID'), {
      target: { value: 'staff-1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Manager PIN'), {
      target: { value: '1234' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }));

    expect(screen.getByText('The acting operator cannot approve their own void.')).toBeVisible();
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
});
