import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CounterPaymentRecovery } from './counter-payment-recovery';

describe('uncertain payment review', () => {
  it('keeps cashier and adapter-only methods read-only', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CounterPaymentRecovery
        attempt={{ id: 'attempt', state: 'UNKNOWN', method: 'JAZZCASH', canResolve: false }}
        pending={false}
        onResolve={onResolve}
      />
    );
    expect(screen.getByText(/Only an authorized Owner or Manager/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <CounterPaymentRecovery
        attempt={{ id: 'attempt', state: 'UNKNOWN', method: 'CARD', canResolve: true }}
        pending={false}
        onResolve={onResolve}
      />
    );
    expect(screen.getByText(/certified provider reconciliation/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });
  it('requires a reason and wallet evidence and prevents duplicate confirmation', async () => {
    let finish!: () => void;
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    render(
      <CounterPaymentRecovery
        attempt={{ id: 'attempt', state: 'UNKNOWN', method: 'RAAST', canResolve: true }}
        pending={false}
        settings={{ RAAST: { destination: 'Till', allowReferenceSkip: false } }}
        onResolve={onResolve}
      />
    );
    const confirm = screen.getByRole('button', { name: 'Confirm funds arrived' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for decision'), {
      target: { value: ' Account checked ' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Payer’s name for confirmation'), {
      target: { value: ' Ayesha ' },
    });
    fireEvent.change(
      screen.getByLabelText('Transaction ID · last 4 to 6 digits for confirmation'),
      { target: { value: '001234' } }
    );
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledExactlyOnceWith({
        decision: 'CONFIRM',
        reason: 'Account checked',
        payerName: 'Ayesha',
        providerRef: '001234',
      })
    );
    finish();
  });
  it('permits a reasoned release without bank payer fields', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(
      <CounterPaymentRecovery
        attempt={{ id: 'attempt', state: 'EXPOSED', method: 'BANK_TRANSFER', canResolve: true }}
        pending={false}
        onResolve={onResolve}
      />
    );
    expect(screen.queryByLabelText(/Payer/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason for decision'), {
      target: { value: 'No incoming funds' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Release pending claim' }));
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({ decision: 'RELEASE', reason: 'No incoming funds' })
    );
  });
  it('keeps committed confirmation locked to finishing settlement after a failure', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('Connection lost'));
    render(
      <CounterPaymentRecovery
        attempt={{ id: 'attempt', state: 'CONFIRMED', method: 'JAZZCASH', canResolve: true }}
        pending={false}
        onResolve={onResolve}
      />
    );
    fireEvent.change(screen.getByLabelText('Reason for decision'), {
      target: { value: 'Retry verified funds recording' },
    });
    expect(screen.getByRole('button', { name: 'Release pending claim' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish recording confirmed funds' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep this payment locked');
  });
});
