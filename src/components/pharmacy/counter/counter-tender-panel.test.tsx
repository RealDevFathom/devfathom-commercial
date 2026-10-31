import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CounterTenderPanel,
  type CounterTenderPanelProps,
  type CounterTenderResult,
} from './counter-tender-panel';

function setup(overrides: Partial<CounterTenderPanelProps> = {}) {
  const props: CounterTenderPanelProps = {
    balanceMinor: 25000,
    state: 'ready',
    blocked: false,
    onRetry: vi.fn(),
    onTender: vi.fn().mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' }),
    ...overrides,
  };
  const view = render(<CounterTenderPanel {...props} />);
  return { ...view, props };
}

function enterCash() {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
}

describe('CounterTenderPanel acknowledgement', () => {
  it.each(['rejected', 'unknown'] as const)('preserves exact cash input on %s', async (status) => {
    const onTender = vi.fn().mockResolvedValue({ status, message: `Payment ${status}.` });
    setup({ onTender });
    enterCash();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(`Payment ${status}.`);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByLabelText('Tender')).toHaveValue('CASH');
    expect(onTender).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'CASH',
        amountMinor: 12550,
        cashReceivedMinor: 20000,
      },
      { amount: '125.50', cashReceived: '200.00' }
    );
    if (status === 'unknown') {
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      expect(screen.getByLabelText('Tender')).toBeDisabled();
    }
  });

  it('awaits acceptance, announces pending, and ignores duplicate activation', async () => {
    let resolve!: (value: CounterTenderResult) => void;
    const onTender = vi.fn(
      () =>
        new Promise<CounterTenderResult>((done) => {
          resolve = done;
        })
    );
    setup({ onTender });
    enterCash();
    const button = screen.getByRole('button', { name: 'Take payment' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onTender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Taking payment… Keep this bill open.');
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    await act(async () => resolve({ status: 'accepted', message: 'Payment recorded.' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Payment recorded.');
  });

  it('treats a thrown callback as unknown and prevents replay', async () => {
    const onTender = vi.fn().mockRejectedValue(new Error('Disconnected'));
    setup({ onTender });
    enterCash();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(/Payment outcome is unknown/);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(onTender).toHaveBeenCalledTimes(1);
  });

  it.each(['CARD', 'WALLET', 'BANK_TRANSFER'])(
    'keeps rejected %s selection and amount',
    async (type) => {
      const onTender = vi
        .fn()
        .mockResolvedValue({ status: 'rejected', message: 'Payment refused.' });
      setup({ onTender });
      fireEvent.change(screen.getByLabelText('Tender'), { target: { value: type } });
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
      fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
      await screen.findByText('Payment refused.');
      expect(screen.getByLabelText('Tender')).toHaveValue(type);
      expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
      expect(onTender).toHaveBeenCalledExactlyOnceWith(
        { type, amountMinor: 12550 },
        { amount: '125.50', cashReceived: '' }
      );
    }
  );
});

describe('CounterTenderPanel bill and interaction states', () => {
  it('restores exact amounts read-only and uses a separate outcome check', async () => {
    const onCheckOutcome = vi
      .fn()
      .mockResolvedValue({ status: 'unknown', message: 'Still unconfirmed.' });
    const { props } = setup({
      state: 'error',
      initialDraft: { type: 'CASH', amount: ' 00125.50 ', cashReceived: '200.00' },
      recoveryOutcome: { status: 'unknown', message: 'Check the saved payment.' },
      onCheckOutcome,
    });
    expect(screen.getByLabelText('Amount')).toHaveValue(' 00125.50 ');
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    const button = screen.getByRole('button', { name: 'Check payment outcome' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(onCheckOutcome).toHaveBeenCalledTimes(1));
    expect(props.onTender).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it('clears recovered input only after an accepted check', async () => {
    const onCheckOutcome = vi
      .fn()
      .mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' });
    setup({
      state: 'stale',
      initialDraft: { type: 'CASH', amount: '125.50', cashReceived: '200.00' },
      onCheckOutcome,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText('Payment recorded.');
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it('preserves recovered inputs and handles a thrown outcome reader', async () => {
    setup({
      state: 'error',
      initialDraft: { type: 'CASH', amount: '125.50', cashReceived: '200.00' },
      onCheckOutcome: vi.fn().mockRejectedValue(new Error('Read failed')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText(/Payment outcome could not be checked/);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });

  it.each(['idle', 'loading', 'error', 'stale', 'unavailable', 'ready'] as const)(
    'does not infer settlement from zero in %s state',
    (state) => {
      setup({ state, balanceMinor: 0 });
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    }
  );

  it('requires an explicit settled state and a known zero balance', () => {
    const { rerender, props } = setup({ state: 'settled', balanceMinor: null });
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    rerender(<CounterTenderPanel {...props} balanceMinor={0} />);
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });

  it('preserves input through a failed read and only enables a known ready bill', () => {
    const { rerender, props } = setup();
    enterCash();
    rerender(<CounterTenderPanel {...props} state="error" error="Access could not be verified." />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onTender).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription(
      /Access could not be verified/
    );
    rerender(<CounterTenderPanel {...props} state="loading" />);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    rerender(<CounterTenderPanel {...props} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled();
  });

  it.each(['100.00', 'abc', '200.001'])('rejects short or invalid entered cash %s', (cash) => {
    const { props } = setup();
    enterCash();
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: cash } });
    expect(screen.getByLabelText('Cash received')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('keeps the safety block across tender types', () => {
    const { props } = setup({ blocked: true });
    enterCash();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'CREDIT' } });
    expect(screen.getByRole('alert')).toHaveTextContent('unresolved safety block');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('uses one native button activation for %s', async (key) => {
    const { props } = setup();
    enterCash();
    const button = screen.getByRole('button', { name: 'Take payment' });
    button.focus();
    fireEvent.keyDown(button, { key });
    fireEvent.keyUp(button, { key });
    // jsdom does not synthesize the browser's native keyboard click.
    fireEvent.click(button);
    await waitFor(() => expect(props.onTender).toHaveBeenCalledTimes(1));
    expect(button).toHaveFocus();
  });
});

describe('family Khata tender', () => {
  const account = {
    id: 'family-a',
    displayName: 'Family A',
    balanceMinor: 500,
    creditLimitMinor: 1000,
  };
  it('blocks over-limit payment until owner password re-entry succeeds', async () => {
    const reauthenticateOwner = vi.fn().mockResolvedValue(undefined);
    const { props } = setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      reauthenticateOwner,
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Owner: authorize limit increase'));
    fireEvent.change(screen.getByLabelText('Owner password (current account)'), {
      target: { value: 'test-only-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    expect(reauthenticateOwner).toHaveBeenCalledWith('test-only-password', '');
    expect(props.onTender).toHaveBeenCalledWith(
      { type: 'KHATA', amountMinor: 25000, familyAccountId: 'family-a', ownerOverride: true },
      { amount: '', cashReceived: '' }
    );
  });
  it('does not dispatch when reauthentication fails', async () => {
    const { props } = setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      reauthenticateOwner: vi.fn().mockRejectedValue(new Error('denied')),
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByLabelText('Owner: authorize limit increase'));
    fireEvent.change(screen.getByLabelText('Owner password (current account)'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(/Owner re-authentication failed/);
    expect(props.onTender).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Owner password (current account)')).toHaveValue('');
  });
  it('allows an exact-limit charge and requests only the selected statement', async () => {
    const printKhataStatement = vi.fn().mockResolvedValue(undefined);
    const { props } = setup({
      balanceMinor: 500,
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      printKhataStatement,
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByRole('button', { name: 'Print Khata statement' }));
    await waitFor(() => expect(printKhataStatement).toHaveBeenCalledWith('family-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    expect(props.onTender).toHaveBeenCalledWith(
      { type: 'KHATA', amountMinor: 500, familyAccountId: 'family-a', ownerOverride: false },
      { amount: '', cashReceived: '' }
    );
  });
});

describe('split tender rows', () => {
  it('records Rs 600 cash then offers the Rs 400 remainder to a customer Khata account', async () => {
    const loadKhataAccounts = vi.fn().mockResolvedValue([
      { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 40000 },
    ]);
    const { props, rerender } = setup({ balanceMinor: 100000, loadKhataAccounts });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '600' } });
    expect(screen.getByText(/Remaining after this tender/)).toHaveTextContent('400.00');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    expect(props.onTender).toHaveBeenNthCalledWith(
      1,
      { type: 'CASH', amountMinor: 60000 },
      { amount: '600', cashReceived: '' }
    );

    const cash = { tenderId: 'cash-a', type: 'CASH', amountMinor: 60000 };
    rerender(<CounterTenderPanel {...props} balanceMinor={40000} tenders={[cash]} />);
    expect(
      within(screen.getByRole('list', { name: 'Recorded tenders' })).getByText('600.00')
    ).toBeInTheDocument();
    expect(screen.getByText(/Tender 2\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    // The account's limit covers only the remainder, not the original sale total.
    expect(screen.queryByText(/exceeds the family credit limit/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(props.onTender).toHaveBeenCalledTimes(2));
    expect(props.onTender).toHaveBeenLastCalledWith(
      { type: 'KHATA', amountMinor: 40000, familyAccountId: 'family-a', ownerOverride: false },
      { amount: '', cashReceived: '' }
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled());
    rerender(
      <CounterTenderPanel
        {...props}
        state="settled"
        balanceMinor={0}
        tenders={[cash, { tenderId: 'credit-a', type: 'CREDIT', amountMinor: 40000 }]}
      />
    );
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByText(/Khata \/ credit · Recorded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(screen.queryByText(/Split payment:/)).not.toBeInTheDocument();
  });

  it('requires a linked customer account and blocks a remainder over the limit', async () => {
    const { props, rerender } = setup({
      balanceMinor: 40000,
      tenders: [{ tenderId: 'cash-a', type: 'CASH', amountMinor: 60000 }],
      loadKhataAccounts: vi.fn().mockResolvedValue([]),
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Link a customer/);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    rerender(
      <CounterTenderPanel
        {...props}
        loadKhataAccounts={vi.fn().mockResolvedValue([
          { id: 'family-a', displayName: 'Family A', balanceMinor: 1, creditLimitMinor: 40000 },
        ])}
      />
    );
    await screen.findByText(/exceeds the family credit limit/);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'unknown'] as const)(
    'keeps earlier rows and the remaining wallet draft when the next payment is %s',
    async (status) => {
      const { props } = setup({
        balanceMinor: 40000,
        tenders: [{ tenderId: 'cash-a', type: 'CASH', amountMinor: 60000 }],
        onTender: vi.fn().mockResolvedValue({ status, message: `Wallet ${status}.` }),
      });
      fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'WALLET' } });
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '400' } });
      fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
      await screen.findByText(`Wallet ${status}.`);
      expect(screen.getByRole('list', { name: 'Recorded tenders' }).children).toHaveLength(1);
      expect(screen.getByLabelText('Amount')).toHaveValue('400');
      expect(props.onTender).toHaveBeenCalledExactlyOnceWith(
        { type: 'WALLET', amountMinor: 40000 },
        { amount: '400', cashReceived: '' }
      );
      if (status === 'unknown') {
        expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      }
    }
  );
});
