import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MESSAGES,
  ROWS,
  type Shared,
} from '@/components/pharmacy/counter/counter-amount-input.fixtures';
import {
  bankLineAmountMinor,
  financeAmountMinor,
  type FinanceAmount,
} from './finance/typed-amount';
import { moneyFieldMinor, PurchasingValidationError } from './purchasing/_lib/console';
import { TierSettingsForm } from './loyalty/prepaid/forms';

const actions = vi.hoisted(() => ({
  savePrepaid: vi.fn(),
  recordPrepaid: vi.fn(),
  setCustomerPrepaidPin: vi.fn(),
}));
vi.mock('./loyalty/prepaid/actions', () => actions);

/**
 * DEV-942: what the four back-office amount readers returned before they moved onto
 * `src/lib/money-input.ts` (characterised on develop 48f565e), for every input in the counter
 * fixtures:
 *
 * - `finance`: `moneyMinor` in finance/page.tsx, trimmed, then `Math.round(Number(text) * 100)`,
 *   used for posting, both matches and the bank statement line. `null` is NaN or Infinity.
 * - `prepaid`: the tier upfront amount in loyalty/prepaid/forms.tsx, the same formula on the
 *   number field's value. The field blanks text a number field cannot hold (spaces, commas, "+5",
 *   "0x10", other digit systems), which then read as 0.
 * - `purchasing`: `moneyFieldMinor` in purchasing/_lib/console.ts, used for every rupee amount on
 *   the orders, receiving, returns and suppliers screens. `null` is refused with a message.
 */
const BEFORE: ReadonlyMap<
  string,
  [finance: number | null, prepaid: number, purchasing: number | null]
> = new Map([
  ['0', [0, 0, 0]],
  ['0.00', [0, 0, 0]],
  ['0.05', [5, 5, 5]],
  ['0.29', [29, 29, 29]],
  ['1', [100, 100, 100]],
  ['12.5', [1250, 1250, 1250]],
  ['12.50', [1250, 1250, 1250]],
  ['125.50', [12550, 12550, 12550]],
  ['1000', [100000, 100000, 100000]],
  ['1000000.00', [100000000, 100000000, 100000000]],
  ['9999999.99', [999999999, 999999999, 999999999]],
  ['007.50', [750, 750, 750]],
  [' 12.50 ', [1250, 0, 1250]],
  ['\t5\n', [500, 0, 500]],
  ['10000000', [1000000000, 1000000000, 1000000000]],
  ['999999999999.99', [99999999999999, 99999999999999, 99999999999999]],
  ['1000000000000', [100000000000000, 100000000000000, 100000000000000]],
  ['90071992547409.91', [9007199254740991, 9007199254740991, 9007199254740991]],
  // Above the safe-integer limit: not an exact amount any more.
  ['90071992547409.92', [9007199254740992, 9007199254740992, 9007199254740992]],
  ['9007199254740991', [900719925474099100, 900719925474099100, 900719925474099100]],
  ['', [0, 0, null]],
  ['   ', [0, 0, null]],
  ['.5', [50, 50, null]],
  ['5.', [500, 0, null]],
  ['1,250.50', [null, 0, null]],
  ['12.345', [1235, 1235, null]],
  ['1.005', [100, 100, null]],
  ['-1', [-100, -100, null]],
  ['-0', [0, 0, null]],
  ['+5', [500, 0, null]],
  ['1 250', [null, 0, null]],
  ['1e3', [100000, 100000, null]],
  ['0x10', [1600, 0, null]],
  ['abc', [null, 0, null]],
  ['NaN', [null, 0, null]],
  ['Infinity', [null, 0, null]],
  ['Rs 100', [null, 0, null]],
  ['12.5.0', [null, 0, null]],
  ['١٢٣', [null, 0, null]],
  ['۱۲۳', [null, 0, null]],
  ['１２３', [null, 0, null]],
  ['१२३', [null, 0, null]],
  ['12٫50', [null, 0, null]],
  ['21474836.47', [2147483647, 2147483647, 2147483647]],
  ['21474836.48', [2147483648, 2147483648, 2147483648]],
]);

/** Money out on a bank statement line: before (the finance formula) and now. */
const BANK_LINE: ReadonlyArray<[input: string, before: number | null, now: number | Shared]> = [
  ['-12.50', -1250, -1250],
  ['-0.05', -5, -5],
  [' -12.50 ', -1250, -1250],
  ['-1', -100, -100],
  ['-90071992547409.91', -9007199254740991, -9007199254740991],
  ['-90071992547409.92', -9007199254740992, 'TOO_LARGE'],
  ['-0', 0, 0],
  ['-', null, 'EMPTY'],
  ['-.5', -50, 'FORMAT'],
  ['-1e3', -100000, 'FORMAT'],
  ['-12.345', -1234, 'DECIMALS'],
  ['--5', null, 'FORMAT'],
  ['- 5', null, 'FORMAT'],
  ['-1,250', null, 'FORMAT'],
  ['+-5', null, 'FORMAT'],
];

/** Other number literals the old formula read on the finance page, not in the counter fixtures. */
const LITERALS: ReadonlyArray<[input: string, before: number]> = [
  ['0b11', 300],
  ['0o7', 700],
];

// What each screen's server took, so "accepted before" means the amount reached the books.
const financeTook = (minor: number | null) =>
  minor !== null && Number.isInteger(minor) && minor >= 1 && minor <= 999_999_999;
const bankLineTook = (minor: number | null) =>
  minor !== null && Number.isSafeInteger(minor) && minor !== 0;
const prepaidTook = (minor: number) => Number.isInteger(minor) && minor >= 1 && minor <= 2e9;
const purchasingTook = (minor: number | null) => minor !== null && Number.isSafeInteger(minor);

const FINANCE_EMPTY = 'Enter an amount, for example 125.50.';
const BANK_LINE_FORMAT =
  'Enter an amount like 125.50, with a minus sign in front for money out, for example -125.50.';

const readFinance = (amount: FinanceAmount): number | string =>
  amount.status === 'OK' ? amount.minor : `Refused: ${amount.message}`;

function read(reader: () => number): number | string {
  try {
    return reader();
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : 'unknown';
  }
}

describe('DEV-942 back-office typed amounts use the shared reader', () => {
  it('records the old readers for every counter fixture', () => {
    expect([...BEFORE.keys()]).toEqual(ROWS.map(([input]) => input));
    // A frozen copy of the old finance and prepaid formula, kept only to prove the table.
    const legacy = (text: string) => {
      const minor = Math.round(Number(text) * 100);
      return Number.isFinite(minor) ? minor + 0 : null;
    };
    for (const [input, [finance]] of BEFORE)
      expect([input, finance]).toEqual([input, legacy(input.trim())]);
    for (const [input, before] of [...BANK_LINE, ...LITERALS])
      expect([input, before]).toEqual([input, legacy(input.trim())]);
  });

  it.each(LITERALS)('finance and bank lines refuse the number literal %j', (input) => {
    expect(readFinance(financeAmountMinor(input))).toBe(`Refused: ${MESSAGES.FORMAT}`);
    expect(readFinance(bankLineAmountMinor(input))).toBe(`Refused: ${BANK_LINE_FORMAT}`);
    const form = new FormData();
    form.set('freight', input);
    expect(read(() => moneyFieldMinor(form, 'freight', 'Freight'))).toBe(
      `PurchasingValidationError: Freight: ${MESSAGES.FORMAT}`
    );
  });

  it.each(ROWS)('finance reads %j with the shared reader', (input, _d, _t, shared) => {
    expect(readFinance(financeAmountMinor(input))).toEqual(
      typeof shared === 'number'
        ? shared
        : `Refused: ${shared === 'EMPTY' ? FINANCE_EMPTY : MESSAGES[shared]}`
    );
  });

  it.each(ROWS)(
    'a bank statement line reads %j with the shared reader',
    (input, _d, _t, shared) => {
      const expected = input === '-1' ? -100 : input === '-0' ? 0 : shared;
      expect(readFinance(bankLineAmountMinor(input))).toEqual(
        typeof expected === 'number'
          ? expected
          : `Refused: ${
              expected === 'EMPTY'
                ? FINANCE_EMPTY
                : expected === 'FORMAT'
                  ? BANK_LINE_FORMAT
                  : MESSAGES[expected]
            }`
      );
    }
  );

  it.each(BANK_LINE)('a bank statement line reads money out %j', (input, _before, now) => {
    expect(readFinance(bankLineAmountMinor(input))).toEqual(
      typeof now === 'number'
        ? now
        : `Refused: ${
            now === 'EMPTY' ? FINANCE_EMPTY : now === 'FORMAT' ? BANK_LINE_FORMAT : MESSAGES[now]
          }`
    );
  });

  it.each(ROWS)('purchasing reads %j with the shared reader', (input, _d, _t, shared) => {
    const form = new FormData();
    form.set('freight', input);
    expect(read(() => moneyFieldMinor(form, 'freight', 'Freight'))).toEqual(
      typeof shared === 'number'
        ? shared
        : `PurchasingValidationError: Freight: ${
            shared === 'EMPTY' ? 'enter an amount like 1250 or 1250.75.' : MESSAGES[shared]
          }`
    );
  });

  it('keeps the refused purchasing field attached to its input', () => {
    const form = new FormData();
    form.set('freight', '12.345');
    try {
      moneyFieldMinor(form, 'freight', 'Freight');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PurchasingValidationError);
      expect(error).toMatchObject({ field: 'freight' });
    }
  });

  it('changes no amount any old reader sent through to the books', () => {
    // An entry the old reader sent through is now read as the same amount, or refused with a
    // message. It is never read as a different amount.
    const refusedNow = {
      finance: [] as string[],
      bankLine: [] as string[],
      prepaid: [] as string[],
      purchasing: [] as string[],
    };
    const check = (list: string[], input: string, before: number, now: number | string) => {
      if (typeof now === 'string') list.push(input);
      else expect([input, now]).toEqual([input, before]);
    };
    for (const [input, , , shared] of ROWS) {
      const [finance, prepaid, purchasing] = BEFORE.get(input)!;
      if (financeTook(finance))
        check(refusedNow.finance, input, finance!, readFinance(financeAmountMinor(input)));
      if (bankLineTook(finance))
        check(refusedNow.bankLine, input, finance!, readFinance(bankLineAmountMinor(input)));
      if (prepaidTook(prepaid)) check(refusedNow.prepaid, input, prepaid, shared);
      if (purchasingTook(purchasing)) {
        const form = new FormData();
        form.set('freight', input);
        check(
          refusedNow.purchasing,
          input,
          purchasing!,
          read(() => moneyFieldMinor(form, 'freight', 'Freight'))
        );
      }
    }
    for (const [input, before, now] of BANK_LINE)
      if (bankLineTook(before)) check(refusedNow.bankLine, input, before!, now);
    for (const [input, before] of LITERALS) {
      if (financeTook(before))
        check(refusedNow.finance, input, before, readFinance(financeAmountMinor(input)));
      if (bankLineTook(before))
        check(refusedNow.bankLine, input, before, readFinance(bankLineAmountMinor(input)));
    }
    // Every entry whose acceptance changes, as stated in the pull request: shorthand the
    // shared reader refuses (".5", "5.", "+5", "1e3", "0x10", "0b11", "0o7") and a third
    // decimal that the old formula silently rounded.
    expect(refusedNow).toEqual({
      finance: ['.5', '5.', '12.345', '1.005', '+5', '1e3', '0x10', '0b11', '0o7'],
      bankLine: [
        '.5',
        '5.',
        '12.345',
        '1.005',
        '+5',
        '1e3',
        '0x10',
        '-.5',
        '-1e3',
        '-12.345',
        '0b11',
        '0o7',
      ],
      prepaid: ['.5', '12.345', '1.005', '1e3'],
      purchasing: [],
    });
  });
});

describe('DEV-942 prepaid tier upfront amount', () => {
  beforeEach(() => {
    actions.savePrepaid.mockReset();
    actions.savePrepaid.mockResolvedValue({ status: 'saved', message: 'Saved.' });
  });

  function typeAmount(input: string) {
    const view = render(
      <TierSettingsForm
        tiers={[{ name: 'Gold', upfrontMinor: 500000, discountBasisPoints: 500 }]}
        refundable={false}
      />
    );
    const amount = screen.getByLabelText('Upfront amount (PKR)', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    fireEvent.change(selectFieldControl(amount), { target: { value: input } });
    fireEvent.submit(view.container.querySelector('form')!);
    return amount.value;
  }

  it('sends a saved tier amount unchanged', async () => {
    render(
      <TierSettingsForm
        tiers={[{ name: 'Gold', upfrontMinor: 150050, discountBasisPoints: 500 }]}
        refundable={false}
      />
    );
    fireEvent.submit(screen.getByRole('button', { name: 'Save dated settings' }).closest('form')!);
    await waitFor(() => expect(actions.savePrepaid).toHaveBeenCalledTimes(1));
    const form = actions.savePrepaid.mock.calls[0]![1] as FormData;
    expect(JSON.parse(String(form.get('tiers')))).toEqual([
      { name: 'Gold', upfrontMinor: 150050, discountBasisPoints: 500 },
    ]);
  });

  it('clears the amount alert as soon as the amount is corrected', async () => {
    typeAmount('12.345');
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Tier 1 upfront amount: ${MESSAGES.DECIMALS}`
    );
    const amount = screen.getByLabelText('Upfront amount (PKR)', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.change(selectFieldControl(amount), { target: { value: '12.34' } });
    expect(screen.queryByRole('alert')).toBeNull();
    // Breaking it again after a refused save shows the new reason at once.
    fireEvent.change(selectFieldControl(amount), { target: { value: '1e3' } });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Tier 1 upfront amount: ${MESSAGES.FORMAT}`
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.savePrepaid).not.toHaveBeenCalled();
  });

  it('shows no amount alert before a save is tried', () => {
    render(
      <TierSettingsForm
        tiers={[{ name: 'Gold', upfrontMinor: 500000, discountBasisPoints: 500 }]}
        refundable={false}
      />
    );
    fireEvent.change(selectFieldControl(screen.getByLabelText('Upfront amount (PKR)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '1e3' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(LITERALS)('sends nothing for the number literal %j', async (input) => {
    typeAmount(input);
    expect(screen.getByRole('alert')).toHaveTextContent(/^Tier 1 upfront amount: /);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.savePrepaid).not.toHaveBeenCalled();
  });

  it.each(ROWS)('reads %j with the shared reader', async (input, _d, _t, shared) => {
    const held = typeAmount(input);
    // A number field blanks text it cannot hold, so that entry reads as empty.
    const expected: Shared = held === '' ? 'EMPTY' : shared;
    expect(held === '' || held === input).toBe(true);
    if (typeof expected === 'number') {
      await waitFor(() => expect(actions.savePrepaid).toHaveBeenCalledTimes(1));
      const form = actions.savePrepaid.mock.calls[0]![1] as FormData;
      expect(JSON.parse(String(form.get('tiers')))[0].upfrontMinor).toBe(expected);
      return;
    }
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Tier 1 upfront amount: ${
        expected === 'EMPTY' ? 'Enter an amount, for example 5000.' : MESSAGES[expected]
      }`
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.savePrepaid).not.toHaveBeenCalled();
  });
});
