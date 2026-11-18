/**
 * DEV-939: every amount typed at the counter (discount, payment amount, cash received, the
 * opening float, both refund amounts and the day-close count) is read by
 * `src/lib/money-input.ts`. Each row records what the counter's own
 * parsers returned before the switch (characterised on develop 05ca8bf), so every change is
 * visible here and in the pull request:
 *
 * - `discount`: the old `amountToMinor` in counter-discount.tsx (7 integer digits at most,
 *   `Math.round(Number(text) * 100)`, refused 0).
 * - `tender`: the old `parseAmountMinor` in counter-tender-panel.tsx, also used by the
 *   open-drawer step (12 integer digits at most).
 * - `shared`: `amountInputToMinor` now, for all of them.
 *
 * `null` means refused, and an empty field was refused (null) by both old parsers too. The
 * refund and day-close readers are recorded in `BEFORE_REFUND_AND_CLOSE` below.
 */
export type Shared = number | 'EMPTY' | 'NEGATIVE' | 'DECIMALS' | 'FORMAT' | 'TOO_LARGE';
export const ROWS: ReadonlyArray<
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
  // The day close's counted-cash limit, either side of it.
  ['21474836.47', null, 2147483647, 2147483647],
  ['21474836.48', null, 2147483648, 2147483648],
];

export const MESSAGES: Record<Exclude<Shared, number | 'EMPTY'>, string> = {
  NEGATIVE: 'Enter an amount of 0 or more.',
  DECIMALS: 'Use at most 2 decimal places, for example 125.50.',
  FORMAT: 'Enter an amount using digits and an optional decimal point, for example 125.50.',
  TOO_LARGE: 'This amount is too large.',
};

/**
 * What the refund and day-close readers returned before the switch (characterised on develop
 * 0c84684), for every input in `ROWS`:
 *
 * - `returnRefund`: "Refund for this return" in counter-return-panel.tsx, trimmed, then
 *   `Math.round(Number(text) * 100)`; a refused entry read as 0.
 * - `directRefund`: "Refund amount" in counter-return-panel.tsx, the same formula on the
 *   untrimmed text; a refused entry read as 0.
 * - `dayClose`: `cashMinor` in day-close-console.tsx, untrimmed, capped at 2,147,483,647; null
 *   when refused.
 *
 * The two refund readers had no digit cap, so the oversize rows read as unsafe integers that the
 * panel's range checks then refused.
 */
export const BEFORE_REFUND_AND_CLOSE: ReadonlyMap<
  string,
  [returnRefund: number, directRefund: number, dayClose: number | null]
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
  [' 12.50 ', [1250, 0, null]],
  ['\t5\n', [500, 0, null]],
  ['10000000', [1000000000, 1000000000, 1000000000]],
  ['999999999999.99', [99999999999999, 99999999999999, null]],
  ['1000000000000', [100000000000000, 100000000000000, null]],
  ['90071992547409.91', [9007199254740991, 9007199254740991, null]],
  ['90071992547409.92', [9007199254740992, 9007199254740992, null]],
  // Above the safe-integer limit: the old float product, not an exact amount.
  ['9007199254740991', [9007199254740991 * 100, 9007199254740991 * 100, null]],
  ['', [0, 0, null]],
  ['   ', [0, 0, null]],
  ['.5', [0, 0, null]],
  ['5.', [0, 0, null]],
  ['1,250.50', [0, 0, null]],
  ['12.345', [0, 0, null]],
  ['1.005', [0, 0, null]],
  ['-1', [0, 0, null]],
  ['-0', [0, 0, null]],
  ['+5', [0, 0, null]],
  ['1 250', [0, 0, null]],
  ['1e3', [0, 0, null]],
  ['0x10', [0, 0, null]],
  ['abc', [0, 0, null]],
  ['NaN', [0, 0, null]],
  ['Infinity', [0, 0, null]],
  ['Rs 100', [0, 0, null]],
  ['12.5.0', [0, 0, null]],
  ['١٢٣', [0, 0, null]],
  ['۱۲۳', [0, 0, null]],
  ['１２３', [0, 0, null]],
  ['१२३', [0, 0, null]],
  ['12٫50', [0, 0, null]],
  ['21474836.47', [2147483647, 2147483647, 2147483647]],
  ['21474836.48', [2147483648, 2147483648, null]],
]);

/** The day close's counted-cash limit, in minor units. */
export const COUNTED_CASH_MAX_MINOR = 2147483647;
