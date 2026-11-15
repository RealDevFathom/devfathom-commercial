import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CounterKhataPaymentPanel, KhataPaymentForm } from './counter-khata-payment-panel';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  refetch: vi.fn(),
  accounts: {} as Record<string, unknown>,
  drawer: {} as Record<string, unknown>,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      khataPaymentAccounts: { useQuery: () => mocks.accounts },
      drawerStatus: { useQuery: () => mocks.drawer },
      recordKhataPayment: { useMutation: () => ({ mutateAsync: mocks.record }) },
    },
  },
}));

const props = {
  branchId: 'b',
  organizationId: 'o',
  accountId: 'a',
  deviceId: () => 'device-1',
  businessDate: () => new Date('2026-11-15'),
};
const slip = {
  receiptReference: 'KP-0123456789',
  familyAccountId: 'family-1',
  accountName: 'Khan family',
  amountMinor: 1_500,
  tender: 'CASH',
  payerReference: null,
  balanceAfterMinor: 500,
  recordedAt: new Date('2026-11-15T06:00:00.000Z'),
  currency: 'PKR',
  replayed: false,
};

function chooseAccount() {
  fireEvent.click(screen.getByRole('radio', { name: /Khan family/ }));
}
function enterAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Amount received (PKR)'), { target: { value } });
}
const submit = () => screen.getByRole('button', { name: 'Record payment' });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.refetch.mockResolvedValue({});
  mocks.record.mockResolvedValue(slip);
  mocks.accounts = {
    isSuccess: true,
    refetch: mocks.refetch,
    data: [
      {
        id: 'family-1',
        displayName: 'Khan family',
        creditLimitMinor: 10_000,
        phoneLast4: '4321',
        balanceMinor: 2_000,
      },
    ],
  };
  mocks.drawer = { isSuccess: true, data: { openDrawer: { id: 'drawer-1' } } };
});

describe('counter khata payment (DEV-731)', () => {
  it('offers a Khata payment action on the counter', () => {
    render(<CounterKhataPaymentPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    expect(screen.getByRole('dialog', { name: 'Khata payment' })).toBeTruthy();
  });

  it('records cash into the open drawer and shows a printable slip', async () => {
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());

    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    expect(mocks.record).toHaveBeenCalledWith({
      branchId: 'b',
      familyAccountId: 'family-1',
      amountMinor: 1_500,
      tender: 'CASH',
      deviceId: 'device-1',
      businessDate: new Date('2026-11-15'),
      idempotencyKey: expect.stringMatching(/^khata-payment:/),
    });
    expect(await screen.findByText(/Reference KP-0123456789/)).toBeTruthy();
    expect(screen.getByText(/Balance still owed: PKR 5\.00/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print slip' })).toBeTruthy();
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('blocks cash when this counter has no open drawer', () => {
    mocks.drawer = { isSuccess: true, data: { openDrawer: null } };
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('10');
    expect(
      screen.getByText('Open the cash drawer for this counter before taking cash.')
    ).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks an amount above the balance owed', () => {
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('20.01');
    expect(screen.getByText(/The account owes PKR 20\.00/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires a payer reference for a non-cash tender and sends no drawer', async () => {
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('5');
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'RAAST' } });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Transfer or wallet reference'), {
      target: { value: 'TXN-881' },
    });
    fireEvent.click(submit());
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    const call = mocks.record.mock.calls[0]![0];
    expect(call).toMatchObject({ tender: 'RAAST', payerReference: 'TXN-881', amountMinor: 500 });
    expect(call).not.toHaveProperty('deviceId');
  });

  it('holds an uncertain payment and retries it with the same key and details', async () => {
    mocks.record.mockRejectedValueOnce(new Error('Network down'));
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toBeTruthy();

    // Editing the form cannot start a new payment while the first is unconfirmed.
    enterAmount('12');
    expect((submit() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry previous payment' }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
    expect(mocks.record.mock.calls[1]![0]).toEqual(mocks.record.mock.calls[0]![0]);
    expect(mocks.record.mock.calls[1]![0].amountMinor).toBe(1_500);
  });

  it('retries the unconfirmed payment even when the refreshed balance is lower', async () => {
    mocks.record.mockRejectedValueOnce(new Error('Network down'));
    const first = render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('20');
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toBeTruthy();
    first.unmount();

    // The first payment did commit: the account now owes nothing.
    (mocks.accounts.data as { balanceMinor: number }[])[0]!.balanceMinor = 0;
    mocks.record.mockResolvedValueOnce({ ...slip, amountMinor: 2_000, replayed: true });
    render(<KhataPaymentForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry previous payment' }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
    expect(mocks.record.mock.calls[1]![0].idempotencyKey).toBe(
      mocks.record.mock.calls[0]![0].idempotencyKey
    );
    expect(await screen.findByText(/already recorded\. No new money was taken/)).toBeTruthy();
  });

  it('clears the attempt when the server refuses it, since nothing was recorded', async () => {
    mocks.record.mockRejectedValueOnce(
      Object.assign(new Error('PAYMENT_EXCEEDS_BALANCE'), { data: { httpStatus: 400 } })
    );
    render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry previous payment' })).toBeNull();
    expect(localStorage.getItem('pharmacy-khata-payment:o:a:b')).toBeNull();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps non-cash payments available when the counter device id cannot be read', async () => {
    render(
      <KhataPaymentForm
        {...props}
        deviceId={() => {
          throw new Error('storage blocked');
        }}
      />
    );
    chooseAccount();
    enterAmount('5');
    expect(screen.getByText(/cannot take cash/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'BANK_TRANSFER' } });
    fireEvent.change(screen.getByLabelText('Transfer or wallet reference'), {
      target: { value: 'TXN-881' },
    });
    fireEvent.click(submit());
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open while a payment is in flight and resumes the same attempt', async () => {
    let settle: (value: typeof slip) => void = () => {};
    mocks.record.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    render(<CounterKhataPaymentPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Khata payment' })).toBeTruthy();

    settle(slip);
    expect(await screen.findByText(/Reference KP-0123456789/)).toBeTruthy();
  });

  it('reuses the failed attempt key after the dialog is closed and reopened', async () => {
    mocks.record.mockRejectedValueOnce(new Error('Network down'));
    render(<CounterKhataPaymentPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Khata payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry previous payment' }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
    expect(mocks.record.mock.calls[1]![0].idempotencyKey).toBe(
      mocks.record.mock.calls[0]![0].idempotencyKey
    );
  });

  it('replays an unresolved attempt after a page reload instead of taking a new payment', async () => {
    mocks.record.mockRejectedValueOnce(new Error('Network down'));
    const first = render(<KhataPaymentForm {...props} />);
    chooseAccount();
    enterAmount('15');
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toBeTruthy();
    first.unmount();

    render(<KhataPaymentForm {...props} />);
    expect(screen.getByText(/has no\s+confirmed result/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry previous payment' }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
    expect(mocks.record.mock.calls[1]![0].idempotencyKey).toBe(
      mocks.record.mock.calls[0]![0].idempotencyKey
    );
    expect(await screen.findByText(/Reference KP-0123456789/)).toBeTruthy();
    expect(localStorage.getItem('pharmacy-khata-payment:o:a:b')).toBeNull();
  });
});
