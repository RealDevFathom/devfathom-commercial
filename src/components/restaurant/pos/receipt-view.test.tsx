import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReceiptView } from './receipt-view';
import type { TerminalRequest } from './checkout-panel';

describe('ReceiptView', () => {
  it('renders settled receipt items, totals, tender, tip, and change', async () => {
    const request: TerminalRequest = async <T,>() =>
      ({
        billId: 'bill-1',
        orderNumber: 42,
        channel: 'DINE_IN',
        branchName: 'Central',
        businessDate: '2026-08-19',
        receiptNumber: 1042,
        settledAt: '2026-08-19T12:00:00.000Z',
        splitKind: 'NONE',
        lines: [
          {
            id: 'line-1',
            name: 'Steak',
            quantity: 1,
            unitPrice: '24.00',
            lineSubtotal: '24.00',
            compAmount: '0.00',
            lineTotal: '24.00',
          },
        ],
        tenders: [
          {
            id: 'tender-1',
            type: 'CARD',
            amount: '19.00',
            tipAmount: '2.00',
            changeGiven: null,
          },
          {
            id: 'tender-2',
            type: 'CASH',
            amount: '5.00',
            tipAmount: '0.00',
            changeGiven: '4.00',
          },
        ],
        totals: {
          subtotal: '24.00',
          taxTotal: '0.00',
          serviceChargeTotal: '0.00',
          deliveryFeeTotal: '4.00',
          compTotal: '0.00',
          discountTotal: '0.50',
          roundingAdjustment: '0.00',
          grandTotal: '24.00',
        },
      }) as T;

    render(<ReceiptView billId="bill-1" request={request} />);

    expect(await screen.findByLabelText('Receipt 1042')).toBeVisible();
    expect(screen.getByText('1 × Steak')).toBeVisible();
    expect(screen.getByText('Tip')).toBeVisible();
    expect(screen.getByText('2.00')).toBeVisible();
    expect(screen.getByText('Change')).toBeVisible();
    expect(screen.getByText('Delivery fee')).toBeVisible();
    const discountRow = screen.getByText('Discount').closest('div');
    expect(discountRow).not.toBeNull();
    expect(within(discountRow!).getByText('0.50')).toBeVisible();
    expect(screen.getAllByText('4.00')).toHaveLength(2);
    expect(screen.getAllByText('24.00').length).toBeGreaterThan(0);
  });
});
