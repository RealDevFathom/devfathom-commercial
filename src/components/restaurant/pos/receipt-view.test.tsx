import { render, screen } from '@testing-library/react';
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
    expect(screen.getAllByText('4.00')).toHaveLength(2);
    expect(screen.getAllByText('24.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('Loyalty balance')).not.toBeInTheDocument();
  });

  it('shows the customer wallet balance and points earned on this sale', async () => {
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
            name: 'Karahi',
            quantity: 1,
            unitPrice: '1000.00',
            lineSubtotal: '1000.00',
            compAmount: '0.00',
            lineTotal: '1000.00',
          },
        ],
        tenders: [
          {
            id: 'tender-1',
            type: 'CASH',
            amount: '1000.00',
            tipAmount: '0.00',
            changeGiven: null,
          },
        ],
        totals: {
          subtotal: '1000.00',
          taxTotal: '0.00',
          serviceChargeTotal: '0.00',
          deliveryFeeTotal: '0.00',
          compTotal: '0.00',
          roundingAdjustment: '0.00',
          grandTotal: '1000.00',
        },
        loyalty: {
          pointsBalance: 128,
          pointsEarned: 12,
          pointsPerPkr: '1',
          balancePkr: '64.00',
        },
      }) as T;

    render(<ReceiptView billId="bill-1" request={request} />);

    expect(await screen.findByText('Loyalty balance')).toBeVisible();
    expect(screen.getByText('128 points')).toBeVisible();
    expect(screen.getByText('Wallet value')).toBeVisible();
    expect(screen.getByText('64.00')).toBeVisible();
    expect(screen.getByText('Earned this sale')).toBeVisible();
    expect(screen.getByText('12 points')).toBeVisible();
  });
});
