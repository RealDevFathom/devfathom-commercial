import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HostedReceiptView } from './receipt-view';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const receipt = {
  branch: 'Gulberg',
  receiptNumber: 'R-42',
  total: 'PKR 10.00',
  paymentMethod: 'CASH',
  issuedAt: '2026-10-31T12:00:00Z',
  expiresAt: '2026-11-30T12:00:00Z',
  fbrInvoiceNumber: 'FBR-42',
  fbrQrUrl: 'https://fbr.example/42',
};
const json = (body: object, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

it('renders a non-Rx receipt and optional fiscal evidence without asking for a code', async () => {
  const fetchMock = vi.fn().mockResolvedValue(json(receipt));
  vi.stubGlobal('fetch', fetchMock);
  render(<HostedReceiptView token="test-token" />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(await screen.findByText('R-42')).toBeVisible();
  expect(screen.getByText('PKR 10.00')).toBeVisible();
  expect(screen.getByText('FBR-42')).toBeVisible();
  expect(screen.getByRole('link', { name: 'View FBR verification' })).toHaveAttribute(
    'rel',
    'noreferrer'
  );
  expect(screen.queryByLabelText('Six-digit code')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    '/r/pharmacy/test-token',
    expect.objectContaining({
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  );
});

it('submits the code and reads the receipt after the verification cookie is set', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ otpRequired: true }, 401))
    .mockResolvedValueOnce(json({ ok: true }))
    .mockResolvedValueOnce(json(receipt));
  vi.stubGlobal('fetch', fetchMock);
  render(<HostedReceiptView token="rx-token" />);
  const input = await screen.findByLabelText('Six-digit code');
  expect(screen.queryByText('R-42')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View receipt' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));
  expect(await screen.findByText('R-42')).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/r/pharmacy/rx-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"code":"123456"}',
  });
});

it('shows verification progress, retains invalid input, and permits retry', async () => {
  let finish: (value: unknown) => void = () => {};
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ otpRequired: true }, 401))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
  vi.stubGlobal('fetch', fetchMock);
  render(<HostedReceiptView token="rx-token" />);
  const input = await screen.findByLabelText('Six-digit code');
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));
  expect(await screen.findByRole('button', { name: 'Verifying…' })).toBeDisabled();
  expect(input).toBeDisabled();
  finish(json({ error: 'The verification code is invalid or expired.' }, 400));
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid or expired');
  expect(input).toHaveValue('123456');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'View receipt' })).toBeEnabled();
});

it.each([
  { error: 'Receipt link has expired.', status: 410 },
  { error: 'Receipt link is unavailable.', status: 410 },
  { error: 'Receipt service unavailable.', status: 503 },
])('explains unavailable receipts: $error', async ({ error, status }) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error }, status)));
  render(<HostedReceiptView token="unavailable" />);
  expect(await screen.findByRole('alert')).toHaveTextContent(error);
  expect(screen.queryByLabelText('Six-digit code')).not.toBeInTheDocument();
});

it('handles network failure without exposing a blank page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable.')));
  render(<HostedReceiptView token="offline" />);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable.'));
});
