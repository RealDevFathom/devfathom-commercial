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

const TENDER_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  KHATA: 'Khata',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
  RAAST: 'Raast',
  WALLET: 'Wallet',
  CREDIT: 'Credit (legacy)',
};

function tenderButtons() {
  return within(screen.getByRole('group', { name: 'Payment method' })).getAllByRole('button');
}

function tenderButton(type: string) {
  return within(screen.getByRole('group', { name: 'Payment method' })).getByRole('button', {
    name: TENDER_LABELS[type],
  });
}

function chooseTender(type: string) {
  fireEvent.click(tenderButton(type));
}

function enterCash() {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
}

describe('DEV-618 payment panel', () => {
  it('shows the balance, split-payment guidance, and every tender option', () => {
    setup();
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('250.00');
    expect(screen.getByText('PKR')).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription(
      /Leave blank to pay the balance due. Enter a smaller amount to split payment across payment methods./
    );
    expect(tenderButtons().map((button) => button.textContent)).toEqual([
      'Cash',
      'Card',
      'Bank transfer',
      'Khata',
    ]);
    expect(tenderButton('CASH')).toHaveAttribute('aria-pressed', 'true');
    expect(tenderButton('CARD')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('combobox', { name: 'Payment method' })).not.toBeInTheDocument();
  });

  it('keeps split payments available after the parent supplies the remaining balance', async () => {
    const { props, rerender } = setup();
    enterCash();
    expect(screen.getByText('Change').parentElement).toHaveTextContent('74.50');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    rerender(<CounterTenderPanel {...props} balanceMinor={12450} />);
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('124.50');
    chooseTender('BANK_TRANSFER');
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
    for (const button of tenderButtons()) expect(button).toBeDisabled();
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(screen.getByLabelText('Cash received')).toBeDisabled();
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.onTender).not.toHaveBeenCalled();
  });
});

describe('DEV-714 tender buttons', () => {
  it('offers a wallet button only when the branch has its merchant details', () => {
    setup({
      manualSettings: {
        JAZZCASH: { destination: 'Till 1', allowReferenceSkip: false },
        RAAST: { destination: 'PK00MERCHANT', allowReferenceSkip: false },
      },
    });
    expect(tenderButtons().map((button) => button.textContent)).toEqual([
      'Cash',
      'Card',
      'Bank transfer',
      'Khata',
      'JazzCash',
      'Raast',
    ]);
    expect(screen.queryByRole('button', { name: 'Wallet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Easypaisa' })).not.toBeInTheDocument();
  });

  it('switches tender on click and clears the previous wallet capture', () => {
    setup({
      manualSettings: {
        JAZZCASH: { destination: 'Till 1', allowReferenceSkip: false },
        RAAST: { destination: 'PK00MERCHANT', allowReferenceSkip: false },
      },
    });
    chooseTender('JAZZCASH');
    expect(tenderButton('JAZZCASH')).toHaveAttribute('aria-pressed', 'true');
    expect(tenderButton('CASH')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText('Cash received')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
    chooseTender('RAAST');
    expect(screen.getByLabelText('Payer’s name')).toHaveValue('');
    chooseTender('CASH');
    expect(screen.getByLabelText('Cash received')).toBeVisible();
  });

  it('says why wallets are hidden when merchant details fail to load', () => {
    const onReloadManualSettings = vi.fn();
    setup({ manualSettingsError: true, onReloadManualSettings });
    expect(tenderButtons()).toHaveLength(4);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Wallet merchant details could not be loaded'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload merchant details' }));
    expect(onReloadManualSettings).toHaveBeenCalledTimes(1);
  });

  it('hides cached wallet buttons once a merchant-details reload fails', () => {
    const manualSettings = {
      JAZZCASH: { destination: 'Till 1', allowReferenceSkip: false },
    };
    const { props, rerender } = setup({ manualSettings });
    expect(tenderButton('JAZZCASH')).toBeVisible();
    rerender(<CounterTenderPanel {...props} manualSettingsError />);
    expect(screen.queryByRole('button', { name: 'JazzCash' })).not.toBeInTheDocument();
    expect(tenderButtons()).toHaveLength(4);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Wallet merchant details could not be loaded'
    );
  });

  it('still renders a restored Wallet attempt so it can be resolved', () => {
    setup({ initialDraft: { type: 'WALLET', amount: '', cashReceived: '' } });
    expect(tenderButton('WALLET')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/A payment provider must be connected/)).toBeVisible();
  });

  it('flags only the Cash button when the drawer is closed and keeps other tenders usable', async () => {
    const { props } = setup({ drawerOpen: false });
    const message = 'Open the cash drawer to take cash. Other tenders do not need the drawer.';
    expect(tenderButton('CASH')).toHaveAccessibleDescription(message);
    for (const type of ['CARD', 'BANK_TRANSFER', 'KHATA'])
      expect(tenderButton(type)).not.toHaveAccessibleDescription();
    expect(screen.getAllByText(message)).toHaveLength(1);
    enterCash();
    const take = screen.getByRole('button', { name: 'Take payment' });
    expect(take).toBeDisabled();
    expect(take).toHaveAccessibleDescription(new RegExp(message));
    fireEvent.click(take);
    expect(props.onTender).not.toHaveBeenCalled();

    chooseTender('BANK_TRANSFER');
    expect(take).toBeEnabled();
    expect(take).not.toHaveAccessibleDescription(new RegExp(message));
    fireEvent.click(take);
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'BANK_TRANSFER', amountMinor: 12550 },
        { amount: '125.50', cashReceived: '' }
      )
    );
  });

  it.each([true, undefined])('shows no drawer message when the drawer is %s', (drawerOpen) => {
    setup({ drawerOpen });
    expect(tenderButton('CASH')).not.toHaveAccessibleDescription();
    enterCash();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled();
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
      chooseTender(type);
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
    chooseTender('RAAST');
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
  it.each([{ manualSettingsLoading: true }, { manualSettingsError: true }, {}])(
    'fails closed for unavailable merchant settings (%j)',
    (state) => {
      setup({ ...state, initialDraft: { type: 'RAAST', amount: '', cashReceived: '' } });
      expect(tenderButton('RAAST')).toHaveAttribute('aria-pressed', 'true');
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
    expect(tenderButton('CASH')).toHaveAttribute('aria-pressed', 'true');
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
      for (const button of tenderButtons()) expect(button).toBeDisabled();
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
    // DEV-499: the typed 200.00 is cleared; the field follows the balance due again.
    expect(screen.getByLabelText('Cash received')).toHaveValue('250.00');
    expect(screen.getByRole('status')).toHaveTextContent('Payment recorded.');
  });

  it('DEV-641: says a queued payment waits for the connection', async () => {
    let resolve!: (value: CounterTenderResult) => void;
    const onTender = vi.fn(
      () =>
        new Promise<CounterTenderResult>((done) => {
          resolve = done;
        })
    );
    const { props, rerender } = setup({ onTender, queued: true });
    expect(screen.getByRole('status')).not.toHaveTextContent(/Offline/);
    enterCash();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline — this payment will be sent when the connection returns. Keep this bill open and do not take the money again.'
    );
    rerender(<CounterTenderPanel {...props} onTender={onTender} queued={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Taking payment… Keep this bill open.');
    await act(async () => resolve({ status: 'accepted', message: 'Payment recorded.' }));
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

  // DEV-713: CARD now needs slip details; see the manual card tender tests.
  it.each(['BANK_TRANSFER'])('keeps rejected %s selection and amount', async (type) => {
    const onTender = vi.fn().mockResolvedValue({ status: 'rejected', message: 'Payment refused.' });
    setup({ onTender });
    chooseTender(type);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment refused.');
    expect(tenderButton(type)).toHaveAttribute('aria-pressed', 'true');
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
    chooseTender('CARD');
    expect(screen.queryByText(/A payment provider must be connected/)).not.toBeInTheDocument();
    expect(screen.getByText(/recorded as the person who confirmed this payment/)).toBeVisible();
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    const reference = screen.getByLabelText('Card last 4 digits or terminal reference');
    fireEvent.change(reference, { target: { value: '4242' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A' } });
    expect(screen.getByLabelText('Approval code')).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A1B2C3' } });
    // A full card number is refused before any payment is sent.
    fireEvent.change(reference, { target: { value: '4242424242424242' } });
    expect(reference).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();
    fireEvent.change(reference, { target: { value: '4242' } });
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
    chooseTender('CARD');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.change(screen.getByLabelText('Card last 4 digits or terminal reference'), {
      target: { value: 'RRN123456' },
    });
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: '0042' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment refused.');
    expect(tenderButton('CARD')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Approval code')).toHaveValue('0042');
    expect(onTender).toHaveBeenCalledExactlyOnceWith(
      { type: 'CARD', amountMinor: 12550, providerRef: 'RRN123456', approvalCode: '0042' },
      { amount: '125.50', cashReceived: '' }
    );
  });

  it('clears card slip details when another tender is chosen', () => {
    setup();
    chooseTender('CARD');
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A1B2' } });
    chooseTender('BANK_TRANSFER');
    chooseTender('CARD');
    expect(screen.getByLabelText('Approval code')).toHaveValue('');
  });
});

describe('DEV-713 wallet is its own tender, separate from card', () => {
  it('shows enabled wallets in their own Wallet group, apart from Card', () => {
    setup({
      manualSettings: {
        JAZZCASH: { destination: '', allowReferenceSkip: false },
        RAAST: { destination: '', allowReferenceSkip: false },
      },
    });
    const wallet = screen.getByRole('group', { name: 'Wallet' });
    expect(
      within(wallet)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['JazzCash', 'Raast']);
    expect(within(wallet).queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
    chooseTender('CARD');
    expect(
      screen.getByText(/Take JazzCash, Easypaisa or Raast under Wallet, not Card/)
    ).toBeVisible();
    expect(screen.queryByText(/wallet tap/)).not.toBeInTheDocument();
    chooseTender('JAZZCASH');
    expect(screen.queryByLabelText('Approval code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Transaction ID (last 4–6 digits)')).toBeVisible();
  });

  it('shows no Wallet group when the branch has enabled no wallet', () => {
    setup({ manualSettings: {} });
    expect(screen.queryByRole('group', { name: 'Wallet' })).not.toBeInTheDocument();
  });
});

describe('DEV-713 wallets enabled without merchant details', () => {
  it('takes an enabled wallet with no IBAN, till number or QR on file', async () => {
    const { props } = setup({
      manualSettings: { EASYPAISA: { destination: '', allowReferenceSkip: false } },
    });
    chooseTender('EASYPAISA');
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

  it('offers no wallet button while merchant settings are still loading', () => {
    setup({
      manualSettingsLoading: true,
      manualSettings: { RAAST: { destination: '', allowReferenceSkip: false } },
    });
    expect(tenderButtons().map((button) => button.textContent)).toEqual([
      'Cash',
      'Card',
      'Bank transfer',
      'Khata',
    ]);
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
    chooseTender('KHATA');
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
  it('blocks over-limit payment until an owner or manager gives a reason and re-enters their password', async () => {
    const reauthenticateOwner = vi.fn().mockResolvedValue(undefined);
    const { props } = setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      reauthenticateOwner,
    });
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    const take = screen.getByRole('button', { name: 'Take payment' });
    expect(take).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Owner or manager: authorize limit increase'));
    fireEvent.click(screen.getByLabelText('I am the only owner or manager: re-enter my password'));
    fireEvent.change(screen.getByLabelText('Your password (current account)'), {
      target: { value: 'test-only-password' },
    });
    // DEV-290: the reason is required before the approval can be sent.
    expect(take).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
      target: { value: '   ' },
    });
    expect(take).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
      target: { value: '  Regular family, paying Friday ' },
    });
    expect(take).toBeEnabled();
    fireEvent.click(take);
    await screen.findByText('Payment recorded.');
    expect(reauthenticateOwner).toHaveBeenCalledWith('test-only-password', '');
    expect(props.onTender).toHaveBeenCalledWith(
      {
        type: 'KHATA',
        amountMinor: 25000,
        familyAccountId: 'family-a',
        ownerOverride: true,
        overrideReason: 'Regular family, paying Friday',
      },
      { amount: '', cashReceived: '' }
    );
  });
  it('does not dispatch when reauthentication fails', async () => {
    const { props } = setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      reauthenticateOwner: vi.fn().mockRejectedValue(new Error('denied')),
    });
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByLabelText('Owner or manager: authorize limit increase'));
    fireEvent.click(screen.getByLabelText('I am the only owner or manager: re-enter my password'));
    fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
      target: { value: 'Paying on Friday' },
    });
    fireEvent.change(screen.getByLabelText('Your password (current account)'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(/Owner or manager re-authentication failed/);
    expect(props.onTender).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your password (current account)')).toHaveValue('');
    // The reason is kept so a retry does not lose it.
    expect(screen.getByLabelText('Reason for exceeding the limit')).toHaveValue('Paying on Friday');
  });
  it('DEV-290: a manager approves at the till with their own PIN, which is never kept', async () => {
    const reauthenticateOwner = vi.fn();
    const loadKhataApprovers = vi
      .fn()
      .mockResolvedValue([{ id: 'staff-manager', name: 'Manager Sana', self: false }]);
    const { props } = setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      reauthenticateOwner,
      loadKhataApprovers,
    });
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    const take = screen.getByRole('button', { name: 'Take payment' });
    fireEvent.click(screen.getByLabelText('Owner or manager: authorize limit increase'));
    // The till's PIN approval is the default method.
    expect(screen.getByLabelText('Manager or owner PIN at this till')).toBeChecked();
    expect(screen.queryByLabelText('Your password (current account)')).not.toBeInTheDocument();
    await screen.findByRole('option', { name: 'Manager Sana' });
    expect(loadKhataApprovers).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
      target: { value: 'Paying on Friday' },
    });
    expect(screen.getByLabelText('Approver PIN')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approving manager or owner'), {
      target: { value: 'staff-manager' },
    });
    fireEvent.change(screen.getByLabelText('Approver PIN'), { target: { value: '12a' } });
    expect(screen.getByLabelText('Approver PIN')).toHaveValue('12');
    expect(take).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approver PIN'), { target: { value: '2468' } });
    expect(take).toBeEnabled();
    fireEvent.click(take);
    await screen.findByText('Payment recorded.');
    expect(reauthenticateOwner).not.toHaveBeenCalled();
    expect(props.onTender).toHaveBeenCalledWith(
      {
        type: 'KHATA',
        amountMinor: 25000,
        familyAccountId: 'family-a',
        ownerOverride: true,
        overrideReason: 'Paying on Friday',
        overLimitApproval: { staffProfileId: 'staff-manager', pin: '2468' },
      },
      { amount: '', cashReceived: '' }
    );
    expect(screen.getByLabelText('Approver PIN')).toHaveValue('');
  });
  it('DEV-290: offers a solo owner their own profile and explains a missing approver', async () => {
    const loadKhataApprovers = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'staff-owner', name: 'Owner Ali', self: true }])
      .mockResolvedValueOnce([]);
    setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      loadKhataApprovers,
    });
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    const override = screen.getByLabelText('Owner or manager: authorize limit increase');
    fireEvent.click(override);
    await screen.findByRole('option', { name: 'Owner Ali (you)' });
    // Without a password transport the till offers only the PIN method.
    expect(
      screen.queryByLabelText('I am the only owner or manager: re-enter my password')
    ).not.toBeInTheDocument();
    fireEvent.click(override);
    fireEvent.click(override);
    await screen.findByText(/No manager or owner has an active staff PIN/);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });
  it('allows an exact-limit charge and requests only the selected statement', async () => {
    const printKhataStatement = vi.fn().mockResolvedValue(undefined);
    const { props } = setup({
      balanceMinor: 500,
      loadKhataAccounts: vi.fn().mockResolvedValue([account]),
      printKhataStatement,
    });
    chooseTender('KHATA');
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

describe('DEV-716 inline Khata signup', () => {
  it('signs up a new customer with name, phone and consent, then reloads accounts', async () => {
    const account = {
      id: 'family-new',
      displayName: 'Ayesha',
      creditLimitMinor: 0,
      balanceMinor: 0,
    };
    const loadKhataAccounts = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([account]);
    const signUpKhata = vi.fn().mockResolvedValue(undefined);
    setup({ loadKhataAccounts, signUpKhata });
    chooseTender('KHATA');
    const open = await screen.findByRole('button', { name: 'Open Khata account' });
    expect(screen.getByText(/The credit limit starts at/)).toHaveTextContent('0.00');

    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: ' Ayesha ' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0300 1234567' } });
    expect(open).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText('Customer consents to a Khata account and loyalty record')
    );
    expect(open).toBeEnabled();
    fireEvent.click(open);

    await waitFor(() =>
      expect(signUpKhata).toHaveBeenCalledExactlyOnceWith({
        displayName: 'Ayesha',
        phone: '0300 1234567',
        consentGranted: true,
      })
    );
    await waitFor(() => expect(loadKhataAccounts).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('option', { name: 'Ayesha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Khata account' })).not.toBeInTheDocument();
  });

  it('offers the selected counter patient as payer without re-asking name and phone', async () => {
    const signUpKhata = vi.fn().mockResolvedValue(undefined);
    setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([]),
      signUpKhata,
      khataSignupPatient: { patientId: 'patient-a', displayName: 'Bilal' },
    });
    chooseTender('KHATA');
    await screen.findByText('Payer: Bilal');
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByLabelText('Customer consents to a Khata account and loyalty record')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Khata account' }));
    await waitFor(() =>
      expect(signUpKhata).toHaveBeenCalledExactlyOnceWith({
        patientId: 'patient-a',
        displayName: 'Bilal',
        consentGranted: true,
      })
    );
  });

  it('shows a failure and keeps the form when signup is refused', async () => {
    const signUpKhata = vi
      .fn()
      .mockRejectedValue(new Error('This bill is no longer open for payment.'));
    setup({
      loadKhataAccounts: vi.fn().mockResolvedValue([]),
      signUpKhata,
      khataSignupPatient: { patientId: 'patient-a', displayName: 'Bilal' },
    });
    chooseTender('KHATA');
    await screen.findByText('Payer: Bilal');
    fireEvent.click(
      screen.getByLabelText('Customer consents to a Khata account and loyalty record')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Khata account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This bill is no longer open for payment.'
    );
    expect(screen.getByRole('button', { name: 'Open Khata account' })).toBeInTheDocument();
  });

  it('clears the consent tick when the payer changes', async () => {
    const props = {
      loadKhataAccounts: vi.fn().mockResolvedValue([]),
      signUpKhata: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender, props: all } = setup({
      ...props,
      khataSignupPatient: { patientId: 'patient-a', displayName: 'Bilal' },
    });
    chooseTender('KHATA');
    await screen.findByText('Payer: Bilal');
    const consent = () =>
      screen.getByLabelText('Customer consents to a Khata account and loyalty record');
    fireEvent.click(consent());
    expect(consent()).toBeChecked();
    rerender(
      <CounterTenderPanel
        {...all}
        khataSignupPatient={{ patientId: 'patient-b', displayName: 'Sana' }}
      />
    );
    await screen.findByText('Payer: Sana');
    expect(consent()).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Open Khata account' })).toBeDisabled();
  });
});

describe('#708 Sindh cash memo buyer name', () => {
  it('validates the buyer before entering payment recovery and allows correction', async () => {
    const { props } = setup({ cashMemo: true });
    const buyer = screen.getByLabelText('Buyer name (cash memo, optional)');
    fireEvent.change(buyer, { target: { value: '<invalid>' } });
    expect(buyer).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
    fireEvent.change(buyer, { target: { value: 'Synthetic Buyer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'CASH', amountMinor: 25000, buyerName: 'Synthetic Buyer' },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('offers no buyer field outside Sindh and sends no buyer name', async () => {
    const { props } = setup({
      khataSignupPatient: { patientId: 'patient-a', displayName: 'Bilal' },
    });
    expect(screen.queryByLabelText('Buyer name (cash memo, optional)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'CASH', amountMinor: 25000 },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('fills the buyer from the selected patient and sends the typed name at tender', async () => {
    const { props } = setup({
      cashMemo: true,
      khataSignupPatient: { patientId: 'patient-a', displayName: 'Bilal Ahmed' },
    });
    const buyer = screen.getByLabelText('Buyer name (cash memo, optional)');
    expect(buyer).toHaveValue('Bilal Ahmed');
    fireEvent.change(buyer, { target: { value: '  Ayesha Khan ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'CASH', amountMinor: 25000, buyerName: 'Ayesha Khan' },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('limits a long selected patient name to the 100 characters a tender accepts', async () => {
    const longName = `${'A'.repeat(99)}BC${'D'.repeat(99)}`;
    const { props } = setup({
      cashMemo: true,
      khataSignupPatient: { patientId: 'patient-a', displayName: longName },
    });
    expect(screen.getByLabelText('Buyer name (cash memo, optional)')).toHaveValue(
      `${'A'.repeat(99)}B`
    );
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'CASH', amountMinor: 25000, buyerName: `${'A'.repeat(99)}B` },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('lets a walk-in pay without a buyer name', async () => {
    const { props } = setup({ cashMemo: true });
    expect(screen.getByLabelText('Buyer name (cash memo, optional)')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledWith(
        { type: 'CASH', amountMinor: 25000 },
        { amount: '', cashReceived: '' }
      )
    );
  });
});

describe('#722 split tender rows', () => {
  it('takes Rs 600 cash, then offers the Rs 400 remainder to a Khata account within its limit', async () => {
    const loadKhataAccounts = vi
      .fn()
      .mockResolvedValue([
        { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 40000 },
      ]);
    const { props, rerender } = setup({ balanceMinor: 100000, loadKhataAccounts });
    expect(screen.queryByLabelText('Recorded tenders')).not.toBeInTheDocument();
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
    const rows = within(screen.getByRole('list', { name: 'Recorded tenders' }));
    expect(rows.getByRole('listitem')).toHaveTextContent(/1\. Cash · Recorded\s*600\.00/);
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    // The limit is checked against this row's remainder, not the whole bill.
    expect(screen.queryByText(/exceeds the family credit limit/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '300' } });
    expect(screen.getByText(/Tender 2\. Remaining after this/)).toHaveTextContent('100.00');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '' } });
    expect(screen.queryByText(/Remaining after this tender/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(props.onTender).toHaveBeenCalledTimes(2));
    expect(props.onTender).toHaveBeenLastCalledWith(
      { type: 'KHATA', amountMinor: 40000, familyAccountId: 'family-a', ownerOverride: false },
      { amount: '', cashReceived: '' }
    );

    rerender(
      <CounterTenderPanel
        {...props}
        state="settled"
        balanceMinor={0}
        tenders={[cash, { tenderId: 'credit-a', type: 'CREDIT', amountMinor: 40000 }]}
      />
    );
    expect(screen.getByText('Settled')).toBeInTheDocument();
    const settled = within(screen.getByRole('list', { name: 'Recorded tenders' }));
    expect(settled.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      '1. Cash · Recorded600.00',
      '2. Khata · Recorded400.00',
    ]);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });

  it('blocks a Khata remainder over the account limit without an owner override', async () => {
    const { props } = setup({
      balanceMinor: 40000,
      tenders: [{ tenderId: 'cash-a', type: 'CASH', amountMinor: 60000 }],
      loadKhataAccounts: vi
        .fn()
        .mockResolvedValue([
          { id: 'family-a', displayName: 'Family A', balanceMinor: 1, creditLimitMinor: 40000 },
        ]),
    });
    chooseTender('KHATA');
    await screen.findByText(/exceeds the family credit limit/);
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
  });
});

describe('DEV-499 tender speed', () => {
  it('prefills exact cash and takes it with Enter on the panel F9 focuses', async () => {
    const { props } = setup();
    const cash = screen.getByLabelText('Cash received');
    expect(cash).toHaveValue('250.00');
    expect(screen.getByText('Change').parentElement).toHaveTextContent('0.00');
    // A split amount moves the prefill with it until the cashier types cash.
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    expect(cash).toHaveValue('125.50');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '' } });
    const panel = cash.closest('[tabindex="-1"]') as HTMLElement;
    panel.focus();
    fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledExactlyOnceWith(
        { type: 'CASH', amountMinor: 25000 },
        { amount: '', cashReceived: '' }
      )
    );
  });

  it('sets Cash received from quick-cash buttons and shows the change', async () => {
    const { props } = setup({ balanceMinor: 70000 });
    const quick = within(screen.getByRole('group', { name: 'Quick cash' }));
    expect(quick.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Exact',
      '500',
      '1000',
      '5000',
    ]);
    // A note smaller than the amount due cannot pay it.
    expect(quick.getByRole('button', { name: '500' })).toBeDisabled();
    fireEvent.click(quick.getByRole('button', { name: '1000' }));
    expect(screen.getByLabelText('Cash received')).toHaveValue('1000.00');
    expect(screen.getByText('Change').parentElement).toHaveTextContent('300.00');
    fireEvent.click(quick.getByRole('button', { name: '5000' }));
    expect(screen.getByText('Change').parentElement).toHaveTextContent('4300.00');
    fireEvent.click(quick.getByRole('button', { name: 'Exact' }));
    expect(screen.getByLabelText('Cash received')).toHaveValue('700.00');
    fireEvent.click(quick.getByRole('button', { name: '1000' }));
    fireEvent.keyDown(screen.getByLabelText('Cash received'), { key: 'Enter' });
    await waitFor(() =>
      expect(props.onTender).toHaveBeenCalledExactlyOnceWith(
        { type: 'CASH', amountMinor: 70000, cashReceivedMinor: 100000 },
        { amount: '', cashReceived: '1000.00' }
      )
    );
  });

  it('does not prefill or offer quick cash on a locked bill, and Enter on a button does not pay', () => {
    const { props } = setup({ disabled: true });
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    for (const button of within(screen.getByRole('group', { name: 'Quick cash' })).getAllByRole(
      'button'
    ))
      expect(button).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Cash received'), { key: 'Enter' });
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('keeps Enter on a tender button for the button, not for payment', () => {
    const { props } = setup();
    fireEvent.keyDown(tenderButton('CARD'), { key: 'Enter' });
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('never offers legacy Credit, and names each wallet provider on its own button', () => {
    setup({
      manualSettings: {
        RAAST: { destination: '', allowReferenceSkip: false },
        JAZZCASH: { destination: '', allowReferenceSkip: false },
        EASYPAISA: { destination: '', allowReferenceSkip: false },
      },
    });
    expect(tenderButtons().map((button) => button.textContent)).toEqual([
      'Cash',
      'Card',
      'Bank transfer',
      'Khata',
      'JazzCash',
      'Easypaisa',
      'Raast',
    ]);
    expect(screen.queryByText(/Credit/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it.each(['RAAST', 'JAZZCASH', 'EASYPAISA'])(
    'takes %s in three steps: provider, transaction ID, Enter',
    async (type) => {
      const { props } = setup({
        manualSettings: { [type]: { destination: 'Till 123', allowReferenceSkip: false } },
        khataSignupPatient: { patientId: 'patient-a', displayName: 'Ayesha Khan' },
      });
      chooseTender(type);
      const reference = screen.getByLabelText('Transaction ID (last 4–6 digits)');
      expect(reference).toHaveFocus();
      expect(screen.getByLabelText('Payer’s name')).toHaveValue('Ayesha Khan');
      fireEvent.change(reference, { target: { value: '1234' } });
      fireEvent.keyDown(reference, { key: 'Enter' });
      await waitFor(() =>
        expect(props.onTender).toHaveBeenCalledExactlyOnceWith(
          { type, amountMinor: 25000, payerName: 'Ayesha Khan', providerRef: '1234' },
          { amount: '', cashReceived: '' }
        )
      );
    }
  );

  it('asks for the wallet payer first when the bill has no patient', () => {
    const { props } = setup({
      manualSettings: { RAAST: { destination: 'Till 123', allowReferenceSkip: false } },
    });
    chooseTender('RAAST');
    const payer = screen.getByLabelText('Payer’s name');
    expect(payer).toHaveValue('');
    expect(payer).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
      target: { value: '1234' },
    });
    fireEvent.keyDown(payer, { key: 'Enter' });
    expect(props.onTender).not.toHaveBeenCalled();
  });
});

describe('DEV-41 disabled payment explanations', () => {
  it.each([
    [{ disabled: true }, /Wait for the current counter action/],
    [{ balanceMinor: null }, /Refresh the bill/],
    [{ state: 'settled' as const, balanceMinor: 0 }, /already paid/],
    [{ blocked: true }, /Resolve the safety block/],
  ])('explains the payment lock %j', (props, reason) => {
    setup(props);
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
    expect(screen.getByText(reason)).toBeVisible();
  });

  it('explains missing card slip details until they are entered', () => {
    setup();
    chooseTender('CARD');
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Enter the card reference and approval code/);
  });

  it('explains missing manual payment details until they are valid', () => {
    setup({ manualSettings: { RAAST: { destination: 'merchant', allowReferenceSkip: false } } });
    chooseTender('RAAST');
    const button = screen.getByRole('button', { name: 'Take payment' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Enter the payer/);
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Customer' } });
    fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
      target: { value: '1234' },
    });
    expect(button).toBeEnabled();
    expect(screen.queryByText(/Enter the payer/)).not.toBeInTheDocument();
  });
});
