import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('DEV-618 payment panel', () => {
  it('shows the balance, split-payment guidance, and every tender option', () => {
    setup({ manualSettings: {} });
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('250.00');
    expect(screen.getByText('PKR')).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription(
      /Leave blank to pay the balance due. Enter a smaller amount to split payment across tenders./
    );
    // DEV-713: no generic Wallet or legacy Credit; wallets appear once enabled.
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      'CASH',
      'CARD',
      'BANK_TRANSFER',
      'KHATA',
    ]);
  });

  it('DEV-713 offers only the wallets this branch has enabled', () => {
    setup({ manualSettings: { JAZZCASH: { destination: '', allowReferenceSkip: false } } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Cash',
      'Card',
      'Bank transfer',
      'Khata / credit',
      'JazzCash',
    ]);
  });

  it('keeps split payments available after the parent supplies the remaining balance', async () => {
    const { props, rerender } = setup();
    enterCash();
    expect(screen.getByText('Change').parentElement).toHaveTextContent('74.50');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    rerender(<CounterTenderPanel {...props} balanceMinor={12450} />);
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('124.50');
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'BANK_TRANSFER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenNthCalledWith(
        2,
        { type: 'BANK_TRANSFER', amountMinor: 12450 },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('retains parent permission and busy-state locks', () => {
    const { props } = setup({ disabled: true });
    expect(screen.getByLabelText('Tender')).toBeDisabled();
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(screen.getByLabelText('Cash received')).toBeDisabled();
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.onTender).not.toHaveBeenCalled();
  });
});

describe('#710 Raast / wallet counter controls', () => {
  it.each(['RAAST', 'JAZZCASH', 'EASYPAISA'])(
    'shows %s merchant details and requires payer plus reference',
    async (type) => {
      const onTender = vi
        .fn()
        .mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' });
      setup({
        onTender,
        manualSettings: {
          [type]: {
            destination: 'PK00MERCHANT',
            qrImageDataUrl: 'data:image/png;base64,aGVsbG8=',
            allowReferenceSkip: false,
          },
        },
      });
      fireEvent.change(screen.getByLabelText('Tender'), { target: { value: type } });
      expect(screen.getByAltText(`${type} merchant QR`)).toBeVisible();
      expect(screen.getByText('PKR 250.00')).toBeVisible();
      expect(screen.getByText('PK00MERCHANT')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
      fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
        target: { value: '123' },
      });
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
        target: { value: '001234' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
      await waitFor(() =>
        expect(onTender).toHaveBeenCalledWith(
          { type, amountMinor: 25000, payerName: 'Ayesha', providerRef: '001234' },
          { amount: '', cashReceived: '' }
        )
      );
    }
  );
  it('shows an explicit skip only when branch policy allows it', async () => {
    const { props } = setup({
      manualSettings: { RAAST: { destination: 'Till 123', allowReferenceSkip: true } },
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'RAAST' } });
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
    fireEvent.click(screen.getByLabelText('Skip reference under branch policy'));
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'RAAST', amountMinor: 25000, payerName: 'Ayesha', referenceSkipped: true },
        expect.anything()
      )
    );
  });
  it('DEV-713 takes an enabled wallet with no merchant details on file', async () => {
    const { props } = setup({
      manualSettings: { EASYPAISA: { destination: '', allowReferenceSkip: false } },
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'EASYPAISA' } });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/you are recorded as the person who confirmed it/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Bilal' } });
    fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
      target: { value: '9876' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'EASYPAISA', amountMinor: 25000, payerName: 'Bilal', providerRef: '9876' },
        expect.anything()
      )
    );
  });
  it.each([{ manualSettingsLoading: true }, { manualSettingsError: true }, {}])(
    'fails closed for unavailable merchant settings (%j)',
    (state) => {
      const settings = { RAAST: { destination: '', allowReferenceSkip: false } };
      const { unmount } = setup({
        ...state,
        manualSettings:
          'manualSettingsLoading' in state || 'manualSettingsError' in state ? settings : undefined,
      });
      // DEV-713: no wallet is offered until loaded settings show it is enabled.
      const values = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
      for (const wallet of ['RAAST', 'JAZZCASH', 'EASYPAISA']) expect(values).not.toContain(wallet);
      unmount();
      // A restored wallet attempt stays visible but cannot be paid.
      setup({ ...state, initialDraft: { type: 'RAAST', amount: '', cashReceived: '' } });
      expect(screen.getByLabelText('Tender')).toHaveValue('RAAST');
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    }
  );
});

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

  it('keeps cash change prominent after acceptance until the next bill mounts', async () => {
    const { rerender, props } = setup({ balanceMinor: 5000 });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));

    await screen.findByText('Payment recorded.');
    rerender(<CounterTenderPanel {...props} balanceMinor={0} state="settled" />);

    expect(screen.getByText('Change due').parentElement).toHaveTextContent('50.00');
    expect(screen.getByText('Change due').parentElement?.parentElement).toHaveTextContent('PKR');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');

    rerender(<CounterTenderPanel key="next-bill" {...props} />);
    expect(screen.queryByText('Change due')).not.toBeInTheDocument();
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

  it.each(['BANK_TRANSFER'])('keeps rejected %s selection and amount', async (type) => {
    const onTender = vi.fn().mockResolvedValue({ status: 'rejected', message: 'Payment refused.' });
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
  });
});

describe('DEV-713 manual card tender', () => {
  it('takes a terminal card with reference and approval code, no provider wording', async () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'CARD' } });
    expect(screen.queryByText(/certified payment provider/)).not.toBeInTheDocument();
    expect(screen.getByText(/recorded as the person who confirmed this payment/)).toBeVisible();
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Card last 4 digits or terminal reference'), {
      target: { value: '4242' },
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A' } });
    expect(screen.getByLabelText('Approval code')).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A1B2C3' } });
    fireEvent.click(button);
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledExactlyOnceWith(
        { type: 'CARD', amountMinor: 25000, providerRef: '4242', approvalCode: 'A1B2C3' },
        { amount: '', cashReceived: '' }
      )
    );
    await screen.findByText('Payment recorded.');
    expect(screen.getByLabelText('Approval code')).toHaveValue('');
  });

  it('keeps a rejected card selection, amount and slip details', async () => {
    const onTender = vi.fn().mockResolvedValue({ status: 'rejected', message: 'Payment refused.' });
    setup({ onTender });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'CARD' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.change(screen.getByLabelText('Card last 4 digits or terminal reference'), {
      target: { value: 'RRN123456' },
    });
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: '0042' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment refused.');
    expect(screen.getByLabelText('Tender')).toHaveValue('CARD');
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Approval code')).toHaveValue('0042');
    expect(onTender).toHaveBeenCalledExactlyOnceWith(
      { type: 'CARD', amountMinor: 12550, providerRef: 'RRN123456', approvalCode: '0042' },
      { amount: '125.50', cashReceived: '' }
    );
  });

  it('still shows a restored generic wallet attempt so it can be checked', () => {
    setup({ state: 'error', initialDraft: { type: 'WALLET', amount: '10.00', cashReceived: '' } });
    expect(screen.getByLabelText('Tender')).toHaveValue('WALLET');
  });
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
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    expect(screen.getByLabelText('Tender')).toHaveValue('KHATA');
    expect(screen.getByText('Payment locked')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('unresolved safety block');
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Payment locked.*unresolved safety block/);
    fireEvent.click(button);
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

it.each(['rejected', 'unknown'] as const)(
  'does not claim change for a %s payment',
  async (status) => {
    setup({
      balanceMinor: 5000,
      onTender: vi.fn().mockResolvedValue({ status, message: 'Not confirmed.' }),
    });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Not confirmed.');
    expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
  }
);
it('uses the receipt total for split payments without adding repeated acknowledgements', async () => {
  const { props, rerender } = setup({ balanceMinor: 5000 });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.00' } });
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '50.00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
  await screen.findByText('Payment recorded.');
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('25.00');
  rerender(<CounterTenderPanel {...props} balanceMinor={2500} />);
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '50.00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
  await waitFor(() => expect(props.onTender).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('25.00');
  rerender(
    <CounterTenderPanel {...props} balanceMinor={0} state="settled" confirmedChangeMinor={5000} />
  );
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
  rerender(
    <CounterTenderPanel {...props} balanceMinor={0} state="settled" confirmedChangeMinor={0} />
  );
  expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
});
it('retains change after recovering an accepted cash payment without replaying it', async () => {
  const { props } = setup({
    state: 'stale',
    initialDraft: { type: 'CASH', amount: '50.00', cashReceived: '100.00' },
    onCheckOutcome: vi
      .fn()
      .mockResolvedValue({ status: 'accepted', message: 'Recovered.', changeMinor: 5000 }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
  await screen.findByText('Recovered.');
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
  expect(props.onTender).not.toHaveBeenCalled();
});
it.each([0, null, 2500])(
  'uses saved tender change when recovering a blank amount with current balance %s',
  async (balanceMinor) => {
    const { props } = setup({
      state: 'stale',
      balanceMinor,
      initialDraft: { type: 'CASH', amount: '', cashReceived: '100.00' },
      onCheckOutcome: vi
        .fn()
        .mockResolvedValue({ status: 'accepted', message: 'Recovered.', changeMinor: 5000 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText('Recovered.');
    expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    expect(props.onTender).not.toHaveBeenCalled();
  }
);
it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'withholds an invalid or zero confirmed change of %s',
  (confirmedChangeMinor) => {
    setup({ confirmedChangeMinor });
    expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
  }
);
