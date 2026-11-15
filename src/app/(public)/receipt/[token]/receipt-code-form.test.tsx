import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { HostedReceiptView } from '@/lib/pharmacy/hosted-receipt-view';

import { ReceiptCodeForm } from './receipt-code-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const receipt: HostedReceiptView = {
  branchName: 'Gulberg Branch',
  receiptNumber: 1042,
  completedAt: '2026-11-15T07:00:00.000Z',
  currency: 'PKR',
  lines: [
    {
      id: 'line-1',
      name: 'Protected item',
      strength: '625 mg',
      quantity: 2,
      saleUnit: 'strip',
      lineTotalMinor: 100_000,
    },
  ],
  tenders: [{ id: 'tender-1', label: 'Cash', amountMinor: 100_000 }],
  totals: { grossMinor: 100_000, discountMinor: 0, netMinor: 100_000 },
};

function reply(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

it('DEV-16: shows items only after a code sent to the number on file is verified', async () => {
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() =>
      reply({ ok: true, message: 'We sent a code to the WhatsApp number on file.' })
    )
    .mockImplementationOnce(() =>
      reply({ ok: false, message: 'That code is not valid. Check it or request a new one.' }, 400)
    )
    .mockImplementationOnce(() => reply({ ok: true, message: 'Code accepted.', receipt }));
  vi.stubGlobal('fetch', fetchMock);
  const { lines, ...summary } = receipt;
  expect(lines).toHaveLength(1);
  render(<ReceiptCodeForm token="0123456789abcdefghjkmnpqrstvwxyz" summary={summary} />);
  // The summary shows at once; no item does.
  expect(screen.getByText('Gulberg Branch')).toBeTruthy();
  expect(screen.queryByText('Protected item')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
  const input = await screen.findByLabelText('Six-digit code');
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
    token: '0123456789abcdefghjkmnpqrstvwxyz',
    action: 'send',
  });
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ referrerPolicy: 'no-referrer' });

  fireEvent.change(input, { target: { value: '12a34-56' } });
  expect((input as HTMLInputElement).value).toBe('123456');
  fireEvent.click(screen.getByRole('button', { name: 'Show my receipt' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'That code is not valid. Check it or request a new one.'
  );
  expect(screen.queryByText('Protected item')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show my receipt' }));
  expect(await screen.findByText('Protected item')).toBeTruthy();
  expect(screen.getAllByText('PKR 1000.00').length).toBeGreaterThan(0);
});
