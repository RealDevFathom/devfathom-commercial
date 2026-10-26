import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InvoiceRow } from './invoices-tab';

describe('InvoiceRow', () => {
  it.each([
    { currency: 'PKR', total: 125000, expected: 'Rs 125,000', unexpected: '$125,000' },
    { currency: 'USD', total: 125000, expected: '$125,000', unexpected: 'Rs 125,000' },
    {
      currency: 'PKR',
      total: '125000.5',
      expected: 'Rs 125,000.5',
      unexpected: '$125,000.5',
    },
    {
      currency: 'USD',
      total: '125000.5',
      expected: '$125,000.5',
      unexpected: 'Rs 125,000.5',
    },
    { currency: 'PKR', total: -125000, expected: '-Rs 125,000', unexpected: '-$125,000' },
    { currency: 'USD', total: 0, expected: '$0', unexpected: 'Rs 0' },
  ])(
    'renders $currency invoice totals with the matching currency symbol',
    ({ currency, total, expected, unexpected }) => {
      render(
        <InvoiceRow
          inv={{
            id: 'invoice_1',
            invoiceNumber: 'INV-001',
            status: 'SENT',
            currency,
            total,
            dueDate: '2026-10-31',
            client: { name: 'Example Client' },
            project: null,
          }}
          onUpdateStatus={vi.fn()}
        />
      );

      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(unexpected)).not.toBeInTheDocument();
    }
  );
});
