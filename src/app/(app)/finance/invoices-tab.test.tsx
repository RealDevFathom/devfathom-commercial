import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InvoiceRow } from './invoices-tab';

describe('InvoiceRow', () => {
  it.each([
    { currency: 'PKR', expected: 'Rs 125,000' },
    { currency: 'USD', expected: '$125,000' },
  ])(
    'renders $currency invoice totals with the matching currency symbol',
    ({ currency, expected }) => {
      render(
        <InvoiceRow
          inv={{
            id: 'invoice_1',
            invoiceNumber: 'INV-001',
            status: 'SENT',
            currency,
            total: 125000,
            dueDate: '2026-10-31',
            client: { name: 'Example Client' },
            project: null,
          }}
          onUpdateStatus={vi.fn()}
        />
      );

      expect(screen.getByText(expected)).toBeInTheDocument();
    }
  );
});
