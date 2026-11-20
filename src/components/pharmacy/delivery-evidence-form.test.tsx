import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DeliveryEvidenceForm } from './delivery-evidence-form';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  invalidate: vi.fn(),
  refundAccess: {} as Record<string, unknown>,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOrdering: {
      deliveryCommand: { useMutation: () => ({ mutateAsync: mocks.command, isPending: false }) },
    },
    pharmacySales: { refundAccess: { useQuery: () => mocks.refundAccess } },
    useUtils: () => ({
      pharmacyOrdering: {
        mine: { invalidate: mocks.invalidate },
        staffQueue: { invalidate: mocks.invalidate },
      },
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refundAccess = { data: { authorized: true } };
  mocks.command.mockResolvedValue({
    replayed: false,
    totals: { collectedMinor: 0, remittedMinor: 0, custodyMinor: 0 },
  });
});

function fill(action: string, currency = 'PKR') {
  render(<DeliveryEvidenceForm branchId="branch-a" orderId="order-a" currency={currency} />);
  fireEvent.change(selectFieldControl(screen.getByLabelText('Evidence action', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: action } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Evidence reference', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'ref' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Operation key (reuse for retry)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'key-1' },
  });
}

it('DEV-647: sends the manager PIN with a physical return and clears it', async () => {
  fill('PHYSICAL_RETURN');
  fireEvent.change(selectFieldControl(screen.getByLabelText(/Open drawer device ID/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'dev-1' } });
  const pin = screen.getByLabelText(/Manager or owner PIN/, { selector: ':not([data-select-field-native][aria-hidden="true"])' });
  expect(pin).toHaveAttribute('type', 'password');
  fireEvent.change(selectFieldControl(pin), { target: { value: '7391' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() =>
    expect(mocks.command).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PHYSICAL_RETURN', managerPin: '7391' })
    )
  );
  expect(selectFieldControl(screen.getByLabelText(/Manager or owner PIN/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
});

it('DEV-647: asks for no PIN on evidence that cannot refund', async () => {
  fill('REFUSED');
  expect(screen.queryByLabelText(/Manager or owner PIN/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
  expect(mocks.command.mock.calls[0]![0]).not.toHaveProperty('managerPin');
});

it.each([
  ['a cashier', { data: { authorized: false } }],
  ['an unknown role while access loads', {}],
  ['a role whose access check failed', { error: new Error('FORBIDDEN') }],
])('DEV-786: hides the refund PIN field from %s', async (_who, access) => {
  mocks.refundAccess = access;
  fill('PHYSICAL_RETURN');
  expect(screen.queryByLabelText(/Manager or owner PIN/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(/needs a manager or owner/);
  fireEvent.change(selectFieldControl(screen.getByLabelText(/Open drawer device ID/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'dev-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
  expect(mocks.command.mock.calls[0]![0]).not.toHaveProperty('managerPin');
});

it.each([
  ['125.50', 12550],
  ['0.05', 5],
  ['1000000.00', 100000000],
  ['40', 4000],
])('sends a collected amount typed as %s rupees as exactly %i minor units', async (raw, minor) => {
  fill('COLLECT');
  fireEvent.change(selectFieldControl(screen.getByLabelText('Actual amount (rupees)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: raw } });
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
  expect(mocks.command.mock.calls[0]![0]).toMatchObject({ action: 'COLLECT', amountMinor: minor });
});

it.each([
  ['125.505', 'Use at most 2 decimal places'],
  ['-10', 'Enter an amount of 0 or more.'],
  ['', 'Enter an amount more than 0'],
  ['0.00', 'Enter an amount more than 0'],
])('refuses %s and records nothing', async (raw, message) => {
  fill('REMIT');
  fireEvent.change(selectFieldControl(screen.getByLabelText('Actual amount (rupees)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: raw } });
  fireEvent.change(selectFieldControl(screen.getByLabelText(/Open drawer device ID/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'dev-1' } });
  fireEvent.submit(
    screen.getByRole('button', { name: 'Record custody evidence' }).closest('form')!
  );
  const field = screen.getByLabelText('Actual amount (rupees)', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
  await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
  expect(field).toHaveAttribute('aria-describedby', 'delivery-amount-error');
  expect(document.getElementById('delivery-amount-error')).toHaveTextContent(message);
  expect(field).toHaveAccessibleDescription(expect.stringContaining(message));
  expect(mocks.command).not.toHaveBeenCalled();
  // Correcting the amount clears the field error.
  fireEvent.change(selectFieldControl(field), { target: { value: '12.50' } });
  expect(field).not.toHaveAttribute('aria-invalid');
  expect(field).not.toHaveAttribute('aria-describedby');
});

it('shows recorded totals as money and never says paisa or rupees for another currency', async () => {
  mocks.command.mockResolvedValue({
    replayed: false,
    totals: { collectedMinor: 12550, remittedMinor: 0, custodyMinor: 12550 },
  });
  fill('CASH_RETURN', 'USD');
  expect(screen.queryByLabelText(/rupees|paisa/i, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Actual amount (USD)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '2.75' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
  expect(mocks.command.mock.calls[0]![0]).toMatchObject({ amountMinor: 275 });
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recorded; collected USD 125.50, remitted USD 0.00, cash still with runner USD 125.50.'
    )
  );
  expect(screen.getByRole('status').textContent).not.toMatch(/minor units|paisa/);
});

it('DEV-943: sends no UTC business date; the server books on the shop day', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-18T19:30:00.000Z') });
  try {
    fill('PHYSICAL_RETURN');
    fireEvent.change(selectFieldControl(screen.getByLabelText(/Open drawer device ID/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'dev-1' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText(/Manager or owner PIN/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '7391' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
    expect(mocks.command.mock.calls[0]![0]).toMatchObject({ deviceId: 'dev-1' });
    expect(mocks.command.mock.calls[0]![0]).not.toHaveProperty('businessDate');
  } finally {
    vi.useRealTimers();
  }
});
