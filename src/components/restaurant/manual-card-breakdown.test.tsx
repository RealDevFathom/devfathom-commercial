import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualCardBreakdown } from './manual-card-breakdown';

const totals = {
  count: 1,
  amount: '12.50',
  tipAmount: '1.00',
  refundCount: 1,
  refundAmount: '2.50',
  tipRefundAmount: '0.00',
  netAmount: '10.00',
  netTipAmount: '1.00',
};
describe('ManualCardBreakdown', () => {
  it('shows the server total, net and human cashier name without adding another card total', () => {
    render(
      <ManualCardBreakdown
        summary={{ ...totals, cashiers: [{ ...totals, staffProfileId: 'cashier-1' }] }}
        staff={[{ id: 'cashier-1', displayName: 'Amina' }]}
      />
    );
    expect(screen.getByRole('region', { name: 'Card, confirmed manually' })).toBeVisible();
    expect(screen.getByText('Amina')).toBeVisible();
    expect(screen.getAllByText('10.00')).toHaveLength(2);
    expect(screen.getByText(/Included in Card totals/)).toBeVisible();
  });
  it('distinguishes a historical missing snapshot from an empty manual card day', () => {
    const view = render(<ManualCardBreakdown summary={null} staff={[]} />);
    expect(screen.getByText(/was not recorded/)).toBeVisible();
    view.rerender(
      <ManualCardBreakdown
        summary={{ ...totals, count: 0, amount: '0.00', cashiers: [] }}
        staff={[]}
      />
    );
    expect(screen.getByText('No manually confirmed card activity.')).toBeVisible();
  });
});
