import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import type { HostedReceiptView } from '@/lib/pharmacy/hosted-receipt-view';

import { HostedReceiptCard } from './hosted-receipt-card';

afterEach(cleanup);

const receipt: HostedReceiptView = {
  branchName: 'Gulberg Branch',
  receiptNumber: 1042,
  counterLabel: null,
  offlineReference: null,
  completedAt: '2026-11-15T07:00:00.000Z',
  currency: 'PKR',
  lines: [
    {
      id: 'line-1',
      name: 'Augmentin',
      strength: '625 mg',
      quantity: 2,
      saleUnit: 'strip',
      lineTotalMinor: 100_000,
    },
    {
      id: 'line-2',
      name: 'Calpol',
      strength: null,
      quantity: 1,
      saleUnit: 'pack',
      lineTotalMinor: 20_000,
    },
  ],
  tenders: [{ id: 'tender-1', label: 'Cash', amountMinor: 120_000 }],
  totals: { grossMinor: 120_000, discountMinor: 0, netMinor: 120_000 },
};

it('DEV-16: shows every purchased line with name, strength, quantity and price, like paper', () => {
  render(<HostedReceiptCard receipt={receipt} />);

  const rows = within(screen.getByRole('table', { name: 'Receipt lines' })).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent('Augmentin · 625 mg');
  expect(rows[1]).toHaveTextContent('2 strip');
  expect(rows[1]).toHaveTextContent('PKR 1000.00');
  expect(rows[2]).toHaveTextContent('Calpol');
  expect(rows[2]).toHaveTextContent('1 pack');
  expect(rows[2]).toHaveTextContent('PKR 200.00');
  expect(screen.getByText('Gulberg Branch')).toBeInTheDocument();
  expect(screen.getAllByText('PKR 1200.00').length).toBeGreaterThan(0);
  // No code prompt or form stands between the link holder and the receipt.
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText(/code/i)).toBeNull();
});

it('DEV-637: names the issuing counter and the number printed offline, when there is one', () => {
  render(
    <HostedReceiptCard
      receipt={{
        ...receipt,
        counterLabel: 'Front till',
        offlineReference: 'Printed offline as receipt 7',
      }}
    />
  );
  expect(screen.getByText('Counter')).toBeInTheDocument();
  expect(screen.getByText('Front till')).toBeInTheDocument();
  expect(screen.getByText('Printed offline as receipt 7')).toBeInTheDocument();
});

it('DEV-637: shows no counter or offline rows when the receipt has neither', () => {
  render(<HostedReceiptCard receipt={receipt} />);
  expect(screen.queryByText('Counter')).toBeNull();
  expect(screen.queryByText(/Printed offline/)).toBeNull();
});
