import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InvoiceTotals } from '@/app/(app)/finance/invoices/[id]/print/invoice-totals';

describe('print invoice totals', () => {
  it('shows the original total, partial payment, and remaining balance', () => {
    render(
      <InvoiceTotals
        subtotal={1_000}
        tax={0}
        total={1_000}
        amountPaid={400}
        balance={600}
        currency="USD"
      />
    );

    expect(screen.getByText('Total').nextSibling).toHaveTextContent('$1,000.00');
    expect(screen.getByText('Amount paid').nextSibling).toHaveTextContent('$400.00');
    expect(screen.getByText('Balance due').nextSibling).toHaveTextContent('$600.00');
  });

  it('does not duplicate the total as a balance before any payment', () => {
    render(
      <InvoiceTotals
        subtotal={1_000}
        tax={0}
        total={1_000}
        amountPaid={0}
        balance={1_000}
        currency="USD"
      />
    );

    expect(screen.queryByText('Amount paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
  });
});
