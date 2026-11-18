import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { amountInputToMinor } from '@/lib/money-input';
import { counterDiscountMinor, CounterDiscountEntry } from './counter-discount';
import { CounterOpenDrawerStep } from './counter-open-drawer-step';
import { CounterTenderPanel } from './counter-tender-panel';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      discountMaximum: {
        useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
      },
    },
  },
}));

/**
 * DEV-939: every amount typed at the counter (discount, payment amount, cash received and the
 * opening float) is read by `src/lib/money-input.ts`. Each row records what the counter's own
 * parsers returned before the switch (characterised on develop 05ca8bf), so every change is
 * visible here and in the pull request:
 *
 * - `discount`: the old `amountToMinor` in counter-discount.tsx (7 integer digits at most,
 *   `Math.round(Number(text) * 100)`, refused 0).
 * - `tender`: the old `parseAmountMinor` in counter-tender-panel.tsx, also used by the
 *   open-drawer step (12 integer digits at most).
 * - `shared`: `amountInputToMinor` now, for all of them.
 *
 * `null` means refused, and an empty field was refused (null) by both old parsers too.
 */
type Shared = number | 'EMPTY' | 'NEGATIVE' | 'DECIMALS' | 'FORMAT' | 'TOO_LARGE';
const ROWS: ReadonlyArray<
  [input: string, discount: number | null, tender: number | null, shared: Shared]
> = [
  ['0', null, 0, 0],
  ['0.00', null, 0, 0],
  ['0.05', 5, 5, 5],
  ['0.29', 29, 29, 29],
  ['1', 100, 100, 100],
  ['12.5', 1250, 1250, 1250],
  ['12.50', 1250, 1250, 1250],
  ['125.50', 12550, 12550, 12550],
  ['1000', 100000, 100000, 100000],
  ['1000000.00', 100000000, 100000000, 100000000],
  ['9999999.99', 999999999, 999999999, 999999999],
  ['007.50', 750, 750, 750],
  [' 12.50 ', 1250, 1250, 1250],
  ['\t5\n', 500, 500, 500],
  // Larger than the old discount box allowed; the server still refuses a discount above the line.
  ['10000000', null, 1000000000, 1000000000],
  ['999999999999.99', null, 99999999999999, 99999999999999],
  // Larger than the old payment box allowed, but still an exact safe integer.
  ['1000000000000', null, null, 100000000000000],
  ['90071992547409.91', null, null, Number.MAX_SAFE_INTEGER],
  ['90071992547409.92', null, null, 'TOO_LARGE'],
  ['9007199254740991', null, null, 'TOO_LARGE'],
  ['', null, null, 'EMPTY'],
  ['   ', null, null, 'EMPTY'],
  ['.5', null, null, 'FORMAT'],
  ['5.', null, null, 'FORMAT'],
  ['1,250.50', null, null, 'FORMAT'],
  ['12.345', null, null, 'DECIMALS'],
  ['1.005', null, null, 'DECIMALS'],
  ['-1', null, null, 'NEGATIVE'],
  ['-0', null, null, 'NEGATIVE'],
  ['+5', null, null, 'FORMAT'],
  ['1 250', null, null, 'FORMAT'],
  ['1e3', null, null, 'FORMAT'],
  ['0x10', null, null, 'FORMAT'],
  ['abc', null, null, 'FORMAT'],
  ['NaN', null, null, 'FORMAT'],
  ['Infinity', null, null, 'FORMAT'],
  ['Rs 100', null, null, 'FORMAT'],
  ['12.5.0', null, null, 'FORMAT'],
  ['١٢٣', null, null, 'FORMAT'],
  ['۱۲۳', null, null, 'FORMAT'],
  ['１２３', null, null, 'FORMAT'],
  ['१२३', null, null, 'FORMAT'],
  ['12٫50', null, null, 'FORMAT'],
];

const MESSAGES: Record<Exclude<Shared, number | 'EMPTY'>, string> = {
  NEGATIVE: 'Enter an amount of 0 or more.',
  DECIMALS: 'Use at most 2 decimal places, for example 125.50.',
  FORMAT: 'Enter an amount using digits and an optional decimal point, for example 125.50.',
  TOO_LARGE: 'This amount is too large.',
};

describe('DEV-939 one typed-amount reader at the counter', () => {
  it.each(ROWS)('reads %j the same way everywhere', (input, _discount, _tender, shared) => {
    const result = amountInputToMinor(input);
    if (typeof shared === 'number') expect(result).toEqual({ status: 'OK', minor: shared });
    else if (shared === 'EMPTY') expect(result).toEqual({ status: 'EMPTY' });
    else expect(result).toEqual({ status: 'INVALID', reason: shared });
  });

  it('changes no amount either old parser accepted', () => {
    for (const [input, discount, tender, shared] of ROWS) {
      if (discount !== null) expect([input, shared]).toEqual([input, discount]);
      if (tender !== null) expect([input, shared]).toEqual([input, tender]);
    }
  });

  it('matches the old float-based discount reader on every two-decimal amount it took', () => {
    // A frozen copy of the old discount formula, kept only to prove nothing it accepted changes.
    const legacyDiscount = (text: string) => Math.round(Number(text) * 100);
    for (const major of [0, 1, 2, 9, 10, 19, 99, 100, 255, 1000, 4095, 99999, 1234567, 9999999]) {
      for (let cents = 0; cents < 100; cents += 1) {
        const two = `${major}.${String(cents).padStart(2, '0')}`;
        expect(amountInputToMinor(two)).toEqual({ status: 'OK', minor: legacyDiscount(two) });
      }
      for (let tenth = 0; tenth < 10; tenth += 1) {
        const one = `${major}.${tenth}`;
        expect(amountInputToMinor(one)).toEqual({ status: 'OK', minor: legacyDiscount(one) });
      }
    }
  });

  it('keeps the percentage discount rounding down, as before', () => {
    expect(counterDiscountMinor({ kind: 'PERCENT', bps: 333 }, 1001)).toBe(33);
    expect(counterDiscountMinor({ kind: 'PERCENT', bps: 1250 }, 999)).toBe(124);
    expect(counterDiscountMinor({ kind: 'PERCENT', bps: 10000 }, 25050)).toBe(25050);
    expect(counterDiscountMinor({ kind: 'AMOUNT', minor: 2550 }, 100)).toBe(2550);
  });

  describe('discount box', () => {
    it.each(ROWS)('sends the discount for %j', (input, _discount, _tender, shared) => {
      const onHold = vi.fn();
      render(
        <CounterDiscountEntry
          branchId="branch-a"
          held={null}
          disabled={false}
          onHold={onHold}
          onClear={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Amount (Rs)' }));
      fireEvent.change(screen.getByLabelText('Discount (Rs)'), { target: { value: input } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply to next item' }));
      if (typeof shared === 'number' && shared > 0) {
        expect(onHold).toHaveBeenCalledExactlyOnceWith({ kind: 'AMOUNT', minor: shared });
        return;
      }
      expect(onHold).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        typeof shared === 'number' || shared === 'EMPTY'
          ? 'Enter an amount in rupees above 0, with at most two decimal places.'
          : MESSAGES[shared]
      );
      expect(screen.getByLabelText('Discount (Rs)')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('payment box', () => {
    function renderTender() {
      const onTender = vi
        .fn()
        .mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' });
      render(
        <CounterTenderPanel
          balanceMinor={Number.MAX_SAFE_INTEGER}
          state="ready"
          blocked={false}
          onRetry={vi.fn()}
          onTender={onTender}
        />
      );
      return onTender;
    }

    it.each(ROWS.filter(([, , , shared]) => shared !== 'EMPTY'))(
      'sends the tender amount and cash received for %j',
      async (input, _discount, _tender, shared) => {
        const onTender = renderTender();
        if (typeof shared === 'number' && shared > 0) {
          // Cash first, cleared then typed over the prefilled balance, so it is the cashier's own
          // figure even when it reads the same as the prefill.
          const cash = screen.getByLabelText<HTMLInputElement>('Cash received');
          fireEvent.change(cash, { target: { value: '' } });
          fireEvent.change(cash, { target: { value: input } });
          const amount = screen.getByLabelText<HTMLInputElement>('Amount');
          fireEvent.change(amount, { target: { value: input } });
          fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
          await waitFor(() =>
            expect(onTender).toHaveBeenCalledExactlyOnceWith(
              { type: 'CASH', amountMinor: shared, cashReceivedMinor: shared },
              // The draft keeps the text as the field holds it (a text input drops newlines).
              { amount: amount.value, cashReceived: cash.value }
            )
          );
          return;
        }
        fireEvent.change(screen.getByLabelText('Amount'), { target: { value: input } });
        expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
        expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
        expect(document.getElementById('tender-amount-error')).toHaveTextContent(
          typeof shared === 'number'
            ? 'Enter an amount between 0.01 and the balance due.'
            : MESSAGES[shared as keyof typeof MESSAGES]
        );
        expect(onTender).not.toHaveBeenCalled();
      }
    );

    it.each(ROWS.filter(([, , , shared]) => typeof shared === 'string' && shared !== 'EMPTY'))(
      'refuses %j as cash received with a plain message',
      (input, _discount, _tender, shared) => {
        const onTender = renderTender();
        fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
        fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: input } });
        expect(screen.getByLabelText('Cash received')).toHaveAttribute('aria-invalid', 'true');
        expect(document.getElementById('tender-cash-error')).toHaveTextContent(
          MESSAGES[shared as keyof typeof MESSAGES]
        );
        expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
        expect(onTender).not.toHaveBeenCalled();
      }
    );

    it('still pays the balance due when the amount is left blank', async () => {
      const onTender = vi
        .fn()
        .mockResolvedValue({ status: 'accepted', message: 'Payment recorded.' });
      render(
        <CounterTenderPanel
          balanceMinor={12550}
          state="ready"
          blocked={false}
          onRetry={vi.fn()}
          onTender={onTender}
        />
      );
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '   ' } });
      fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
      fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
      await waitFor(() =>
        expect(onTender).toHaveBeenCalledExactlyOnceWith(
          { type: 'CASH', amountMinor: 12550, cashReceivedMinor: 20000 },
          { amount: '   ', cashReceived: '200.00' }
        )
      );
    });
  });

  describe('opening float', () => {
    it.each(ROWS)('sends the opening float for %j', (input, _discount, _tender, shared) => {
      const onOpen = vi.fn();
      render(<CounterOpenDrawerStep disabled={false} canDeclareFloat onOpen={onOpen} />);
      fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: input } });
      fireEvent.submit(
        screen.getByRole('form', { name: 'Open the cash drawer to start the shift' })
      );
      if (typeof shared === 'number') {
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(shared, undefined);
        return;
      }
      expect(onOpen).not.toHaveBeenCalled();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'Enter the opening cash, for example 5000 or 0 for an empty drawer.'
      );
      if (shared !== 'EMPTY') expect(alert).toHaveTextContent(MESSAGES[shared]);
      expect(screen.getByLabelText('Opening cash')).toHaveAttribute('aria-invalid', 'true');
    });
  });
});
