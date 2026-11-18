import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialStatements, statementDayStart } from './financial-statements';
import { LedgerReportsSection, TrueProfitSection, ledgerDayStart } from './ledger-reports';

/**
 * DEV-722: Finance ledger and statement dates are the organisation's days. The readers' contract
 * (ISO instants, [from, to)) is unchanged: for a UTC organisation the query is byte-for-byte what
 * it was, and a Karachi business day sends exactly the UTC instants that bound that day.
 */
const branch = { id: 'branch_1', name: 'Main' };
const KARACHI = 'Asia/Karachi';
// Karachi is UTC+5 all year: its 1 Aug runs from 31 Jul 19:00 UTC to 1 Aug 19:00 UTC.
const karachiDay = (day: string) => new Date(`${day}T00:00:00+05:00`).toISOString();

function ledgerCaller() {
  const failing = () => vi.fn().mockRejectedValue(new Error('window captured'));
  return { perpetualValuation: failing(), grossMargin: failing(), leakageReport: failing() };
}

function html(markup: string) {
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('ledger reports on the organisation clock', () => {
  const days = { from: '2026-08-01', to: '2026-08-02', at: '2026-08-01' };

  it.each([undefined, null, 'UTC'])(
    'sends the same query as before for a UTC organisation (%s)',
    async (timeZone) => {
      const caller = ledgerCaller();
      await LedgerReportsSection({ caller: caller as never, branch, ...days, timeZone });
      const period = {
        branchId: 'branch_1',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
      };
      expect(caller.grossMargin).toHaveBeenCalledWith({ ...period, by: 'batch' });
      expect(caller.leakageReport).toHaveBeenCalledWith(period);
      expect(caller.perpetualValuation).toHaveBeenCalledWith({
        branchId: 'branch_1',
        at: '2026-08-01T00:00:00.000Z',
      });
    }
  );

  it('sends the UTC instants of the Karachi business day for the same picked days', async () => {
    const caller = ledgerCaller();
    const view = html(
      renderToStaticMarkup(
        await LedgerReportsSection({ caller: caller as never, branch, ...days, timeZone: KARACHI })
      )
    );
    const period = {
      branchId: 'branch_1',
      from: '2026-07-31T19:00:00.000Z',
      to: '2026-08-01T19:00:00.000Z',
    };
    // Equal to the equivalent UTC window a UTC caller would have had to type by hand.
    expect(period).toEqual({
      branchId: 'branch_1',
      from: karachiDay('2026-08-01'),
      to: karachiDay('2026-08-02'),
    });
    expect(caller.grossMargin).toHaveBeenCalledWith({ ...period, by: 'batch' });
    expect(caller.leakageReport).toHaveBeenCalledWith(period);
    expect(caller.perpetualValuation).toHaveBeenCalledWith({
      branchId: 'branch_1',
      at: karachiDay('2026-08-01'),
    });
    expect(view.querySelector('label')?.textContent).toContain('Period start (midnight, PKT)');
    expect(view.textContent).toContain('Period end (midnight, PKT, not included)');
    expect(view.textContent).toContain('Stock value at (midnight, PKT)');
    expect(view.textContent).not.toMatch(/\bUTC\b|exclusive/);
  });

  it('puts a 00:30 Karachi sale on the Karachi day, not the UTC one', async () => {
    // 00:30 on 1 Aug in Karachi is 19:30 UTC on 31 Jul.
    const sale = new Date('2026-07-31T19:30:00Z');
    const window = async (from: string, to: string) => {
      const caller = ledgerCaller();
      await LedgerReportsSection({
        caller: caller as never,
        branch,
        from,
        to,
        at: '2026-08-01',
        timeZone: KARACHI,
      });
      const input = caller.leakageReport.mock.calls[0]![0] as { from: string; to: string };
      return sale >= new Date(input.from) && sale < new Date(input.to);
    };
    expect(await window('2026-08-01', '2026-08-02')).toBe(true);
    expect(await window('2026-07-31', '2026-08-01')).toBe(false);
  });

  it('defaults to the Karachi today at 00:30 local and lets it be the valuation day', async () => {
    vi.setSystemTime(new Date('2026-07-31T19:30:00Z'));
    const caller = ledgerCaller();
    const view = html(
      renderToStaticMarkup(
        await LedgerReportsSection({ caller: caller as never, branch, timeZone: KARACHI })
      )
    );
    const at = view.querySelector<HTMLInputElement>('input[name="ledgerAt"]')!;
    expect(at.getAttribute('value')).toBe('2026-08-01');
    expect(at.getAttribute('max')).toBe('2026-08-01');
    expect(view.querySelector('input[name="ledgerFrom"]')?.getAttribute('value')).toBe(
      '2026-07-02'
    );
    expect(view.querySelector('#ledger-filter-error')).toBeNull();
    expect(caller.perpetualValuation).toHaveBeenCalledWith({
      branchId: 'branch_1',
      at: '2026-07-31T19:00:00.000Z',
    });
  });

  it('still refuses a valuation day that starts after now on the organisation clock', async () => {
    vi.setSystemTime(new Date('2026-07-31T18:30:00Z')); // 23:30 on 31 Jul in Karachi
    const caller = ledgerCaller();
    const view = html(
      renderToStaticMarkup(
        await LedgerReportsSection({
          caller: caller as never,
          branch,
          ...days,
          timeZone: KARACHI,
        })
      )
    );
    expect(view.querySelector('#ledger-filter-error')).not.toBeNull();
    expect(caller.perpetualValuation).not.toHaveBeenCalled();
  });
});

describe('true profit on the organisation clock', () => {
  it.each([
    [undefined, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'],
    [KARACHI, karachiDay('2026-08-01'), karachiDay('2026-08-02')],
  ])('sends the reader the day starts for %s', async (timeZone, from, to) => {
    const trueProfit = vi.fn().mockRejectedValue(new Error('window captured'));
    const view = html(
      renderToStaticMarkup(
        await TrueProfitSection({
          caller: { trueProfit } as never,
          branch,
          from: '2026-08-01',
          to: '2026-08-02',
          timeZone,
        })
      )
    );
    expect(trueProfit).toHaveBeenCalledWith({ branchId: 'branch_1', from, to, by: 'item' });
    expect(view.textContent).not.toMatch(/exclusive/);
    // A UTC organisation's own zone is UTC; a Karachi one never reads UTC.
    if (timeZone) expect(view.textContent).toContain('PKT time');
    if (timeZone) expect(view.textContent).not.toMatch(/\bUTC\b/);
  });
});

describe('financial statements on the organisation clock', () => {
  function statementsCaller() {
    return { financialStatements: vi.fn().mockRejectedValue(new Error('window captured')) };
  }

  it.each([undefined, 'UTC'])(
    'sends the same query string as before for a UTC organisation (%s)',
    async (timeZone) => {
      const caller = statementsCaller();
      await FinancialStatements({
        caller: caller as never,
        branchId: 'branch_1',
        from: '2026-08-01',
        to: '2026-08-02',
        timeZone,
      });
      expect(caller.financialStatements).toHaveBeenCalledWith({
        branchId: 'branch_1',
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-02T00:00:00Z',
        page: 1,
      });
    }
  );

  it('sends the UTC instants of the Karachi business day, in the same string form', async () => {
    const caller = statementsCaller();
    await FinancialStatements({
      caller: caller as never,
      branchId: 'branch_1',
      from: '2026-08-01',
      to: '2026-08-02',
      timeZone: KARACHI,
    });
    const input = caller.financialStatements.mock.calls[0]![0];
    expect(input).toEqual({
      branchId: 'branch_1',
      from: '2026-07-31T19:00:00Z',
      to: '2026-08-01T19:00:00Z',
      page: 1,
    });
    expect(new Date(input.from).toISOString()).toBe(karachiDay('2026-08-01'));
    // 00:30 on 1 Aug in Karachi is inside that day's window.
    const sale = new Date('2026-07-31T19:30:00Z');
    expect(sale >= new Date(input.from) && sale < new Date(input.to)).toBe(true);
  });

  it('labels the dates on the organisation clock and defaults to its today', async () => {
    vi.setSystemTime(new Date('2026-07-31T19:30:00Z')); // 00:30 on 1 Aug in Karachi
    const caller = statementsCaller();
    const view = html(
      renderToStaticMarkup(
        await FinancialStatements({
          caller: {
            financialStatements: async (input: unknown) => {
              caller.financialStatements(input);
              return {
                accounts: [],
                cashflow: [],
                profitAndLoss: [],
                page: 1,
                journalCount: 0,
                freshness: { retrievedAt: new Date('2026-07-31T19:30:00Z') },
                definition: 'Posted entries only.',
                journal: [],
              };
            },
          } as never,
          branchId: 'branch_1',
          timeZone: KARACHI,
        })
      )
    );
    expect(caller.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch_1',
      from: '2026-07-01T19:00:00Z',
      to: '2026-08-01T19:00:00Z',
      page: 1,
    });
    expect(view.textContent).toContain('From (midnight, PKT)');
    expect(view.textContent).toContain('Until (midnight, PKT, not included)');
    expect(view.textContent).toContain('Retrieved 1 Aug 2026, 12:30 AM PKT');
    expect(view.textContent).not.toMatch(/\bUTC\b/);
  });

  it('passes a day that is not on the calendar through unchanged, for the reader to refuse', () => {
    expect(statementDayStart('2026-02-30', KARACHI)).toBe('2026-02-30T00:00:00Z');
    expect(statementDayStart('not-a-day', KARACHI)).toBe('not-a-dayT00:00:00Z');
    expect(statementDayStart('2026-08-01', null)).toBe('2026-08-01T00:00:00Z');
    expect(ledgerDayStart('2026-08-01', KARACHI)).toBe('2026-07-31T19:00:00.000Z');
  });
});
