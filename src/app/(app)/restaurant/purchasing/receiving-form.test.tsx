import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

import { ReceivingForm, type ReceivingState } from './receiving-form';

const key = '73c7817c-75b1-43e8-a980-1fdce08b26b0';
const lines = [
  { id: 'a', name: 'Flour', unitCost: '12.50' },
  { id: 'b', name: 'Rice', unitCost: '9' },
];
const initial = (): ReceivingState => ({
  status: 'idle',
  message: '',
  idempotencyKey: key,
  errors: {},
  values: Object.fromEntries([
    ['reference', ''],
    ...lines.flatMap((line) =>
      Object.entries({
        receivedQuantity: '0',
        unitCost: line.unitCost,
        batchCode: '',
        expiryDate: '',
        discrepancyKind: '',
        discrepancyNote: '',
      }).map(([name, value]) => [`${name}:${line.id}`, value])
    ),
  ]),
});

function submittedState(form: FormData, status: ReceivingState['status']): ReceivingState {
  return {
    status,
    message: 'Your entries are preserved.',
    errors: {},
    idempotencyKey: String(form.get('idempotencyKey')),
    values: Object.fromEntries(
      Object.keys(initial().values).map((name) => [name, String(form.get(name) ?? '')])
    ),
  };
}

function fillReceipt() {
  for (const [index, line] of lines.entries()) {
    const group = within(screen.getByRole('group', { name: line.name }));
    for (const [label, value] of Object.entries({
      'Received quantity': String(index + 2),
      'Unit cost': '13.75',
      Batch: `B-${line.id}`,
      Expiry: '2027-04-05',
      'Discrepancy kind': 'DAMAGED',
      'Discrepancy note': `Note ${line.id}`,
    }))
      fireEvent.change(group.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText('Receipt reference'), {
    target: { value: 'REF & details' },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('ReceivingForm recovery', () => {
  it('keeps all entered lines and reference after field validation; labels the exact error', async () => {
    const action = vi.fn(async (_previous: ReceivingState, form: FormData) => ({
      ...submittedState(form, 'invalid'),
      errors: { 'receivedQuantity:a': 'Enter a positive quantity.' },
    }));
    const { container } = render(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive
        initialState={initial()}
        action={action}
      />
    );
    fillReceipt();
    fireEvent.change(
      within(screen.getByRole('group', { name: 'Flour' })).getByLabelText('Received quantity'),
      { target: { value: 'bad' } }
    );
    const form = screen.getByRole('form', { name: 'Receive stock' }) as HTMLFormElement;
    const before = Object.fromEntries(new FormData(form));
    fireEvent.submit(form);
    await screen.findByRole('alert');
    for (const line of lines) {
      expect(
        within(screen.getByRole('group', { name: line.name })).getByLabelText('Discrepancy kind')
      ).toHaveValue('DAMAGED');
    }
    expect(action.mock.calls[0][1].get('discrepancyKind:a')).toBe('DAMAGED');
    expect((await action.mock.results[0].value).values['discrepancyKind:a']).toBe('DAMAGED');
    expect(Object.fromEntries(new FormData(form))).toEqual(before);
    const bad = container.querySelector('[name="receivedQuantity:a"]');
    expect(bad).toHaveAttribute('aria-invalid', 'true');
    expect(bad).toHaveAccessibleDescription('Enter a positive quantity.');
    // The alert is focused from an effect after it is in the document.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('blocks duplicate submits while the action is pending', async () => {
    let finish!: (state: ReceivingState) => void;
    const action = vi.fn(
      () =>
        new Promise<ReceivingState>((resolve) => {
          finish = resolve;
        })
    );
    render(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive
        initialState={initial()}
        action={action}
      />
    );
    fillReceipt();
    const form = screen.getByRole('form', { name: 'Receive stock' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole('button', { name: 'Receiving…' })).toBeDisabled();
    expect(screen.getByLabelText('Receipt reference')).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...initial(), status: 'rejected', message: 'Retry later.' }));
    expect(screen.getByRole('button', { name: 'Receive purchase order' })).toBeEnabled();
  });

  it.each(['returned uncertainty', 'lost response'])(
    'preserves and locks intent after %s, then explicitly retries the same payload',
    async (kind) => {
      const action = vi.fn(async (_previous: ReceivingState, form: FormData) => {
        if (kind === 'lost response') throw new Error('transport unavailable');
        return submittedState(form, 'uncertain');
      });
      render(
        <ReceivingForm
          purchaseOrderId="order-1"
          lines={lines}
          canReceive
          initialState={initial()}
          action={action}
        />
      );
      fillReceipt();
      const form = screen.getByRole('form', { name: 'Receive stock' }) as HTMLFormElement;
      const before = Object.fromEntries(new FormData(form));
      fireEvent.submit(form);
      await screen.findByRole('button', { name: 'Retry same receipt' });
      for (const line of lines) {
        expect(
          within(screen.getByRole('group', { name: line.name })).getByLabelText('Discrepancy kind')
        ).toHaveValue('DAMAGED');
      }
      expect(Object.fromEntries(new FormData(form))).toEqual(before);
      expect(screen.getByLabelText('Receipt reference')).toHaveAttribute('readonly');
      expect(screen.getAllByLabelText('Discrepancy kind')[0]).toBeDisabled();
      const history = screen.getByRole('link', { name: 'Check receipt history (new tab)' });
      expect(history).toHaveAttribute('target', '_blank');
      expect(history).toHaveAttribute(
        'href',
        '/restaurant/purchasing?selected=order-1#receipt-history'
      );
      fireEvent.submit(form);
      await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      expect(Object.fromEntries(action.mock.calls[0][1])).toEqual(
        Object.fromEntries(action.mock.calls[1][1])
      );
      expect(mocks.replace).not.toHaveBeenCalled();
    }
  );

  it('clears confirmed success, blocks further posting and opens the posted receipt without draft fields in URLs', async () => {
    const action = vi.fn(async (): Promise<ReceivingState> => ({
      status: 'success',
      message: 'Receipt posted.',
      errors: {},
      values: {},
      idempotencyKey: '',
      receiptId: 'receipt-1',
    }));
    render(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive
        initialState={initial()}
        action={action}
      />
    );
    fillReceipt();
    const form = screen.getByRole('form', { name: 'Receive stock' });
    fireEvent.submit(form);
    await screen.findByRole('status');
    expect(screen.queryByLabelText('Receipt reference')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Receive purchase order' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View posted receipt' })).toHaveAttribute(
      'href',
      '#receipt-receipt-1'
    );
    expect(mocks.replace).toHaveBeenCalledWith(
      '/restaurant/purchasing?selected=order-1&notice=Receipt+posted.&kind=success#receipt-receipt-1'
    );
    expect(JSON.stringify(mocks.replace.mock.calls)).not.toContain(key);
    expect(JSON.stringify(mocks.replace.mock.calls)).not.toContain('REF');
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the action when receiving permission is denied', async () => {
    const action = vi.fn();
    render(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive={false}
        initialState={initial()}
        action={action}
      />
    );
    expect(screen.getByRole('button', { name: 'Receive purchase order' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Receive stock' }));
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps the bound action and key across a background refresh of the same order', async () => {
    const action = vi.fn(async (_previous: ReceivingState, form: FormData) =>
      submittedState(form, 'uncertain')
    );
    const replacement = vi.fn();
    const { rerender } = render(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive
        initialState={initial()}
        action={action}
      />
    );
    fillReceipt();
    fireEvent.submit(screen.getByRole('form', { name: 'Receive stock' }));
    await screen.findByRole('button', { name: 'Retry same receipt' });
    rerender(
      <ReceivingForm
        purchaseOrderId="order-1"
        lines={lines}
        canReceive
        initialState={{ ...initial(), idempotencyKey: 'fresh-render-key' }}
        action={replacement}
      />
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Receive stock' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[1][1].get('idempotencyKey')).toBe(key);
    expect(replacement).not.toHaveBeenCalled();
  });
});
