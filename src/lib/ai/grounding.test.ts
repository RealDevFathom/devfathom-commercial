import { describe, expect, it, vi } from 'vitest';
import type { TextStreamPart, ToolSet, UIMessage } from 'ai';

import {
  checkGrounding,
  checkableFigures,
  createAnswerGuardTransform,
  DOSING_REJECTED_TEXT,
  extractFigures,
  GROUNDING_REJECTED_TEXT,
  GroundingEvidence,
} from './grounding';

function evidenceFrom(...outputs: unknown[]) {
  const evidence = new GroundingEvidence();
  for (const output of outputs) evidence.addToolOutput(output);
  return evidence;
}

const grounded = (text: string, evidence: GroundingEvidence) => checkGrounding(text, evidence).ok;

// Realistic tool results, shaped as the number-grounding investigation found them.
const pharmacyClaims = {
  kind: 'answer',
  branches: [{ id: 'br_gulberg_01', name: 'Gulberg' }],
  period: { from: '2026-11-01', to: '2026-11-01' },
  claims: [
    {
      metricKey: 'salesMinor',
      label: 'Sales',
      value: 12_345_600,
      definition: 'Completed sale lines, net of refunds.',
      scope: {
        contract: 'branch',
        branchIds: ['br_gulberg_01'],
        from: '2026-11-01',
        to: '2026-11-01',
      },
      freshness: { asOf: '2026-11-01T18:30:00.000Z' },
      drillThrough: '/pharmacy/reports?branch=br_gulberg_01&from=2026-11-01&to=2026-11-01',
    },
    { metricKey: 'cashVarianceMinor', label: 'Cash variance', value: -45_050 },
    { metricKey: 'openStockSignals', label: 'Open stock signals', value: 17 },
    { metricKey: 'khataAgingMinor', label: 'Khata aging', value: 98_765_00 },
  ],
  instruction:
    'Use only these claims. Every numeric statement must retain its metric definition, scope, freshness, and drill-through link.',
};

const pharmacyLeakage = {
  kind: 'answer',
  currency: null,
  moneyUnit: 'integer_minor',
  facts: [
    { discountMinor: 150_000, writeOffMinor: 25_050, shrinkageMinor: 4_950, totalMinor: 180_000 },
  ],
};

const repeatPurchasing = {
  kind: 'answer',
  horizons: [
    {
      days: 30,
      status: 'known',
      denominator: 412,
      repeated: 137,
      immatureExcluded: 12,
      ratePercent: (137 / 412) * 100,
    },
    {
      days: 60,
      status: 'known',
      denominator: 300,
      repeated: 129,
      immatureExcluded: 40,
      ratePercent: 43,
    },
  ],
};

const restaurantSales = {
  kind: 'answer',
  moneyUnit: 'Decimal major-unit strings in the source ledger currency.',
  currency: { status: 'unknown', code: null },
  metrics: {
    grossSales: { value: '284500.5' },
    netSales: { value: '261230' },
    refunds: { value: '-1200.75' },
    averageCheck: { value: null },
  },
  coverage: { expectedDayCount: 7, closedDayCount: 6, missingClosedDayCount: 1 },
};

const financeSummary = {
  incomeByCurrency: [
    { currency: 'PKR', amount: 1_250_000 },
    { currency: 'USD', amount: 4_820.5 },
  ],
  expenseByCurrency: [{ currency: 'PKR', amount: 312_400 }],
  profitByCurrency: [{ currency: 'PKR', amount: 937_600 }],
  incomeCount: 23,
  invoices: { count: 14 },
  period: { start: new Date('2026-10-01'), end: new Date('2026-10-31') },
};

const taskSearch = {
  count: 3,
  tasks: [
    { id: 'cm3x9k2', title: 'Fix login', dueDate: new Date('2026-11-04'), overdue: false },
    { id: 'cm3x9k3', title: 'Ship invoices', dueDate: new Date('2026-11-01'), overdue: true },
    { id: 'cm3x9k4', title: 'Audit', dueDate: null, overdue: false },
  ],
  checklist: { progress: '3/5' },
};

describe('extractFigures', () => {
  it('reads currency prefixes, separators, decimals, signs and percent', () => {
    const figures = extractFigures('Rs 1,23,456 and PKR 2,500.50, $4,820.5, -45.5 and 12.5%');
    expect(figures.map((figure) => figure.value)).toEqual([123456, 2500.5, 4820.5, 45.5, 12.5]);
    expect(figures.at(-1)?.percent).toBe(true);
    expect(figures[1]!.tolerance).toBeCloseTo(0.005);
  });

  it('applies k, lakh, crore and million scales with their displayed precision', () => {
    const [k, lakh, crore, million, mn] = extractFigures(
      '12k, 1.2 lakh, 3 crore, 1.25 million, 4.2M'
    );
    expect(k).toMatchObject({ value: 12_000, tolerance: 500 });
    expect(lakh).toMatchObject({ value: 120_000, tolerance: 5_000 });
    expect(crore).toMatchObject({ value: 30_000_000 });
    expect(million).toMatchObject({ value: 1_250_000 });
    expect(mn).toMatchObject({ value: 4_200_000 });
  });

  it('skips identifiers, links, dates, times, ordinals and list markers', () => {
    const text = [
      '12. Invoice INV-0042 for Q3 (see [report](/pharmacy/reports?days=30&from=2026-11-01))',
      'Due 2026-11-04T10:00:00Z, at 10:30 am, on 2nd November 2026 or Nov 3, 2026, 02/11/2026, by 5pm',
      'https://example.test/x/999 and the 21st item #42 v2',
    ].join('\n');
    expect(extractFigures(text)).toEqual([]);
  });

  it('treats Urdu digits as ASCII digits', () => {
    expect(extractFigures('فروخت ۱۲۵۰ روپے').map((figure) => figure.value)).toEqual([1250]);
  });

  it('exempts small plain integers and years but not small money or percentages', () => {
    expect(checkableFigures('3 tasks in 2026, 10 people')).toEqual([]);
    expect(checkableFigures('Rs 5 and 5% and 11 tasks').map((figure) => figure.raw)).toEqual([
      'Rs 5',
      '5%',
      '11',
    ]);
  });
});

describe('checkGrounding with realistic tool results', () => {
  it('accepts pharmacy minor-unit claims shown in major units, with and without suffixes', () => {
    const evidence = evidenceFrom(pharmacyClaims);
    expect(grounded("Today's sales at Gulberg were Rs 123,456.", evidence)).toBe(true);
    expect(grounded('Sales were Rs 1,23,456 (about 1.23 lakh).', evidence)).toBe(true);
    expect(grounded('Sales were 12,345,600 in minor units.', evidence)).toBe(true);
    expect(grounded('There are 17 open stock signals.', evidence)).toBe(true);
    expect(grounded('Khata aging is Rs 98,765.', evidence)).toBe(true);
  });

  it('accepts a negative variance stated as a shortfall', () => {
    const evidence = evidenceFrom(pharmacyClaims);
    expect(grounded('The cash variance is -Rs 450.50.', evidence)).toBe(true);
    expect(grounded('Cash was short by Rs 450.5.', evidence)).toBe(true);
  });

  it('rejects an invented or altered pharmacy figure', () => {
    const evidence = evidenceFrom(pharmacyClaims);
    expect(checkGrounding('Sales were Rs 125,000 and 17 signals.', evidence)).toEqual({
      ok: false,
      figures: 2,
      unmatched: 1,
    });
    expect(grounded('Sales were Rs 1.3 lakh.', evidence)).toBe(false);
    expect(grounded('Sales grew 14% on last week.', evidence)).toBe(false);
  });

  it('accepts integer-minor facts marked by moneyUnit', () => {
    const evidence = evidenceFrom(pharmacyLeakage);
    expect(
      grounded(
        'Leakage was Rs 1,800: discounts 1,500, write-offs 250.50, shrinkage 49.50.',
        evidence
      )
    ).toBe(true);
  });

  it('accepts ratePercent floats at displayed precision and as ratios', () => {
    const evidence = evidenceFrom(repeatPurchasing);
    expect(grounded('137 of 412 customers (33.3%) came back within 30 days.', evidence)).toBe(true);
    expect(grounded('The 30-day repeat rate is 33%.', evidence)).toBe(true);
    expect(grounded('That is a ratio of 0.33.', evidence)).toBe(true);
    expect(grounded('60-day repeat was 43% (129 of 300).', evidence)).toBe(true);
    expect(grounded('The 30-day repeat rate is 35%.', evidence)).toBe(false);
  });

  it('accepts restaurant decimal strings, rounded or with suffixes', () => {
    const evidence = evidenceFrom(restaurantSales);
    expect(grounded('Gross sales were 284,500.50 and net sales 261,230.', evidence)).toBe(true);
    expect(grounded('Gross sales were about 284.5k; refunds 1,200.75.', evidence)).toBe(true);
    expect(grounded('Gross sales were 2.85 lakh.', evidence)).toBe(true);
    expect(grounded('6 of 7 days are closed; 1 is missing.', evidence)).toBe(true);
    expect(grounded('Net sales were 270,000.', evidence)).toBe(false);
  });

  it('accepts finance major-unit numbers with currency labels', () => {
    const evidence = evidenceFrom(financeSummary);
    expect(grounded('Income: Rs 1,250,000 and $4,820.50. Expenses Rs 312,400.', evidence)).toBe(
      true
    );
    expect(
      grounded('Profit was Rs 9.38 lakh (PKR 937,600) across 23 income entries.', evidence)
    ).toBe(true);
    expect(grounded('Income was Rs 12.5 lakh, or 1.25 million.', evidence)).toBe(true);
    expect(grounded('Total income was 1,254,820.50.', evidence)).toBe(false);
  });

  it('accepts counts and array lengths and ignores ids and dates', () => {
    const evidence = evidenceFrom(taskSearch);
    expect(grounded('You have 3 matching tasks; task cm3x9k3 was due 2026-11-01.', evidence)).toBe(
      true
    );
    expect(grounded('Checklist progress is 3/5.', evidence)).toBe(true);
    expect(grounded('You have 12 matching tasks.', evidence)).toBe(false);
  });

  it('accepts figures the user typed and rejects text with no evidence at all', () => {
    const evidence = new GroundingEvidence();
    expect(grounded('Your target of Rs 50,000 is noted.', evidence)).toBe(false);
    evidence.addUserText('My target is Rs 50,000 this week');
    expect(grounded('Your target of Rs 50,000 (50k) is noted.', evidence)).toBe(true);
    expect(grounded('Hello! I can help with reports.', new GroundingEvidence())).toBe(true);
  });

  it('uses earlier tool outputs and user text from the conversation, not assistant prose', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Sales for 1,500 orders?' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Sales were Rs 777,777.' },
          {
            type: 'tool-askPharmacyReports',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: pharmacyClaims,
          },
        ],
      },
    ] as unknown as UIMessage[];
    const evidence = new GroundingEvidence();
    evidence.addConversation(messages);
    expect(grounded('1,500 orders, Rs 123,456 in sales.', evidence)).toBe(true);
    expect(grounded('Sales were Rs 777,777.', evidence)).toBe(false);
  });

  it('reads numbers inside returned text such as preformatted labels', () => {
    const evidence = evidenceFrom({ message: 'Created invoice INV-0007 (Rs 50,000)' });
    expect(grounded('Invoice created for Rs 50,000.', evidence)).toBe(true);
  });
});

type Part = TextStreamPart<ToolSet>;

async function runGuard(parts: Part[], evidence = new GroundingEvidence()) {
  const log = vi.fn();
  const transform = createAnswerGuardTransform<ToolSet>(evidence, log)();
  const input = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const out: Part[] = [];
  const reader = input.pipeThrough(transform).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return { out, log };
}

const text = (out: Part[], id = 't1') =>
  out
    .filter(
      (part): part is Extract<Part, { type: 'text-delta' }> =>
        part.type === 'text-delta' && part.id === id
    )
    .map((part) => part.text)
    .join('');

const toolResult = (output: unknown) =>
  ({
    type: 'tool-result',
    toolCallId: 'c1',
    toolName: 'askPharmacyReports',
    input: {},
    output,
  }) as Part;

describe('createAnswerGuardTransform', () => {
  it('releases a grounded block once, keeping start → delta → end order', async () => {
    const { out, log } = await runGuard([
      { type: 'start-step', request: {}, warnings: [] } as unknown as Part,
      toolResult(pharmacyClaims),
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Sales were ' },
      { type: 'text-delta', id: 't1', text: 'Rs 123,456.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' } as unknown as Part,
    ]);
    expect(out.map((part) => part.type)).toEqual([
      'start-step',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
    ]);
    expect(text(out)).toBe('Sales were Rs 123,456.');
    expect(log).not.toHaveBeenCalled();
  });

  it('replaces an ungrounded block and logs counts only', async () => {
    const { out, log } = await runGuard([
      toolResult(pharmacyClaims),
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Sales were Rs 999,999 across 17 signals.' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(text(out)).toBe(GROUNDING_REJECTED_TEXT);
    expect(log).toHaveBeenCalledExactlyOnceWith('ASSISTANT_GROUNDING_REJECTED', {
      figures: 2,
      unmatched: 1,
      evidence: expect.any(Number),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('999');
  });

  it('checks a block against tool results that arrived before it only', async () => {
    const { out } = await runGuard([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Sales were Rs 123,456.' },
      { type: 'text-end', id: 't1' },
      toolResult(pharmacyClaims),
    ]);
    expect(text(out)).toBe(GROUNDING_REJECTED_TEXT);
  });

  it('replaces dosing instructions with the refer-to-pharmacist message', async () => {
    const { out, log } = await runGuard([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Take 2 tablets twice a day after meals.' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(text(out)).toBe(DOSING_REJECTED_TEXT);
    expect(log).toHaveBeenCalledWith('ASSISTANT_DOSING_REJECTED', expect.any(Object));
  });

  it('guards interleaved ids independently', async () => {
    const { out } = await runGuard([
      toolResult(pharmacyClaims),
      { type: 'text-start', id: 'a' },
      { type: 'text-start', id: 'b' },
      { type: 'text-delta', id: 'a', text: 'Sales Rs 123,456.' },
      { type: 'text-delta', id: 'b', text: 'Sales Rs 5,000,000.' },
      { type: 'text-end', id: 'b' },
      { type: 'text-end', id: 'a' },
    ]);
    expect(text(out, 'a')).toBe('Sales Rs 123,456.');
    expect(text(out, 'b')).toBe(GROUNDING_REJECTED_TEXT);
    const order = out.map((part) => `${part.type}:${(part as { id?: string }).id}`);
    expect(order.indexOf('text-start:b')).toBeLessThan(order.indexOf('text-delta:b'));
    expect(order.indexOf('text-delta:b')).toBeLessThan(order.indexOf('text-end:b'));
  });

  it('closes a block left open at finish-step and drops anything sent for it later', async () => {
    const { out } = await runGuard([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Sales were Rs 999,999.' },
      { type: 'finish-step' } as unknown as Part,
      { type: 'text-delta', id: 't1', text: ' Unchecked Rs 1.' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(out.map((part) => part.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
    ]);
    expect(text(out)).toBe(GROUNDING_REJECTED_TEXT);
  });

  it('releases a block still open when the stream ends', async () => {
    const { out } = await runGuard([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'All clear.' },
    ]);
    expect(out.map((part) => part.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(text(out)).toBe('All clear.');
  });

  it('drops text for an id that never started', async () => {
    const { out } = await runGuard([{ type: 'text-delta', id: 'x', text: 'Rs 1,000,000' }]);
    expect(out).toEqual([]);
  });

  it('ignores preliminary tool results as evidence', async () => {
    const { out } = await runGuard([
      { ...toolResult({ value: 4321 }), preliminary: true } as Part,
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Value 4,321.' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(text(out)).toBe(GROUNDING_REJECTED_TEXT);
  });
});
