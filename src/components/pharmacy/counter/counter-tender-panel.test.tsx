import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import {
  CounterTenderPanel,
  type CounterTenderPanelProps,
  type CounterTenderResult,
} from './counter-tender-panel';

function Harness(props: CounterTenderPanelProps) {
  const [prepared, setPrepared] = useState(props.preparedCollection ?? null);
  return (
    <CounterTenderPanel
      {...props}
      preparedCollection={prepared}
      onPrepareCollection={async (input, draft) => {
        const ready = await props.onPrepareCollection!(input, draft);
        if (ready) setPrepared(input);
        return ready;
      }}
    />
  );
}
async function prepare() {
  fireEvent.click(screen.getByRole('button', { name: 'Prepare payment' }));
  await screen.findByText('Payment prepared. Check that funds arrived before marking received.');
}
function setup(overrides: Partial<CounterTenderPanelProps> = {}) {
  const props: CounterTenderPanelProps = {
    balanceMinor: 25000,
    state: 'ready',
    blocked: false,
    onRetry: vi.fn(),
    onPrepareCollection: vi.fn().mockResolvedValue(true),
    onTender: vi.fn().mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' }),
    ...overrides,
  };
  const view = render(<Harness {...props} />);
  return { ...view, props };
}

function enterCash() {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
}

describe('DEV-618 payment panel', () => {
  it('shows payment methods even when a wallet is not configured', () => {
    setup();
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('250.00');
    expect(screen.getByText('PKR')).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription(
      /Leave blank to pay the balance due. Enter a smaller amount to split payment across tenders./
    );
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      'CASH',
      'CARD',
      'WALLET',
      'BANK_TRANSFER',
      'KHATA',
      'RAAST',
      'JAZZCASH',
      'EASYPAISA',
    ]);
  });

  it.each(['CARD', 'WALLET'])('does not offer a manual %s payment', (type) => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: type } });
    expect(screen.getByText(/needs an online certified payment provider/)).toBeVisible();
    expect(screen.queryByLabelText('Approval code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('keeps split payments available after the parent supplies the remaining balance', async () => {
    const { props, rerender } = setup();
    enterCash();
    expect(screen.getByText('Change').parentElement).toHaveTextContent('74.50');
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    await screen.findByText('Payment recorded.');
    rerender(<Harness {...props} balanceMinor={12450} />);
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('124.50');
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'BANK_TRANSFER' } });
    await prepare();
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
    const button = screen.getByRole('button', { name: /^(Take payment|Mark received)$/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.onTender).not.toHaveBeenCalled();
  });
});

describe('#710 Raast / wallet counter controls', () => {
  it('blocks a wallet with neither destination nor QR and explains how to set it up', () => {
    const { props } = setup({
      manualSettings: { JAZZCASH: { destination: '', allowReferenceSkip: false } },
    });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'JAZZCASH' } });
    expect(screen.getByText(/This method is not set up/)).toBeVisible();
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
  });
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
      await prepare();
      expect(screen.getByAltText(`${type} merchant QR`)).toBeVisible();
      expect(screen.getByText('PKR 250.00')).toBeVisible();
      expect(screen.getByText('PK00MERCHANT')).toBeVisible();
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
      fireEvent.change(screen.getByLabelText('Transaction ID · last 4 to 6 digits'), {
        target: { value: '123' },
      });
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Transaction ID · last 4 to 6 digits'), {
        target: { value: '1234567' },
      });
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Transaction ID · last 4 to 6 digits'), {
        target: { value: '12ab' },
      });
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Transaction ID · last 4 to 6 digits'), {
        target: { value: '001234' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
    await prepare();
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
    fireEvent.click(screen.getByLabelText('Skip reference under branch policy'));
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
      setup(state);
      fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'RAAST' } });
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    }
  );
});

describe('CounterTenderPanel acknowledgement', () => {
  it.each(['rejected', 'unknown'] as const)('preserves exact cash input on %s', async (status) => {
    const onTender = vi.fn().mockResolvedValue({ status, message: `Payment ${status}.` });
    setup({ onTender });
    enterCash();
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
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
    const button = screen.getByRole('button', { name: /^(Take payment|Mark received)$/ });
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
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    await screen.findByText(/Payment outcome is unknown/);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    expect(onTender).toHaveBeenCalledTimes(1);
  });

  it.each(['BANK_TRANSFER'])('keeps rejected %s selection and amount', async (type) => {
    const onTender = vi.fn().mockResolvedValue({ status: 'rejected', message: 'Payment refused.' });
    setup({ onTender });
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: type } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    await prepare();
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    await screen.findByText('Payment refused.');
    expect(screen.getByLabelText('Tender')).toHaveValue(type);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(onTender).toHaveBeenCalledExactlyOnceWith(
      { type, amountMinor: 12550 },
      { amount: '125.50', cashReceived: '' }
    );
  });
});

describe('CounterTenderPanel bill and interaction states', () => {
  it('shows a qualified last known balance while an uncertain payment stays locked', () => {
    const { props } = setup({
      state: 'error',
      balanceMinor: 29400,
      recoveryOutcome: { status: 'unknown', message: 'Check the saved payment.' },
      onCheckOutcome: vi.fn(),
    });
    expect(screen.getByText('Last known balance').parentElement).toHaveTextContent('294.00');
    expect(screen.getByText(/balance may have changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('does not invent a balance when an uncertain payment has no known balance', () => {
    setup({
      balanceMinor: null,
      recoveryOutcome: { status: 'unknown', message: 'Check payment.' },
    });
    expect(screen.getByText('Balance due').parentElement).toHaveTextContent('Unavailable');
    expect(screen.queryByText('Last known balance')).not.toBeInTheDocument();
  });

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
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
  });

  it.each(['idle', 'loading', 'error', 'stale', 'unavailable', 'ready'] as const)(
    'does not infer settlement from zero in %s state',
    (state) => {
      setup({ state, balanceMinor: 0 });
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    }
  );

  it('requires an explicit settled state and a known zero balance', () => {
    const { rerender, props } = setup({ state: 'settled', balanceMinor: null });
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    rerender(<Harness {...props} balanceMinor={0} />);
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
  });

  it('preserves input through a failed read and only enables a known ready bill', () => {
    const { rerender, props } = setup();
    enterCash();
    rerender(<Harness {...props} state="error" error="Access could not be verified." />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onTender).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription(
      /Access could not be verified/
    );
    rerender(<Harness {...props} state="loading" />);
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    rerender(<Harness {...props} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeEnabled();
  });

  it.each(['100.00', 'abc', '200.001'])('rejects short or invalid entered cash %s', (cash) => {
    const { props } = setup();
    enterCash();
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: cash } });
    expect(screen.getByLabelText('Cash received')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it('keeps the safety block across tender types', () => {
    const { props } = setup({ blocked: true });
    enterCash();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'BANK_TRANSFER' } });
    expect(screen.getByText('Payment locked')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('unresolved safety block');
    const button = screen.getByRole('button', { name: /^(Take payment|Mark received)$/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Payment locked.*unresolved safety block/);
    fireEvent.click(button);
    expect(props.onTender).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('uses one native button activation for %s', async (key) => {
    const { props } = setup();
    enterCash();
    const button = screen.getByRole('button', { name: /^(Take payment|Mark received)$/ });
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
    expect(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Owner: authorize limit increase'));
    fireEvent.change(screen.getByLabelText('Owner password (current account)'), {
      target: { value: 'test-only-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /^(Take payment|Mark received)$/ }));
    await screen.findByText('Payment recorded.');
    expect(props.onTender).toHaveBeenCalledWith(
      { type: 'KHATA', amountMinor: 500, familyAccountId: 'family-a', ownerOverride: false },
      { amount: '', cashReceived: '' }
    );
  });
});
