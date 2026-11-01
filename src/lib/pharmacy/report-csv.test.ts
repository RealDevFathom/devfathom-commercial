import { describe, expect, it } from 'vitest';

import {
  branchComparisonCsv,
  branchComparisonTotals,
  csvField,
  expiryAdviceCsv,
  expiryAdviceTotals,
  neutralizeCsvFormula,
  periodSummaryCsv,
  periodSummaryRows,
  sumMinorRecorded,
  sumMinorStrict,
  type BranchComparisonRow,
} from './report-csv';

const context = {
  currency: 'PKR',
  from: '2026-10-01',
  to: '2026-10-07',
  branchScope: 'All available branches',
  generatedAt: new Date('2026-10-08T09:00:00.000Z'),
};
const lines = (csv: string) => {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  return csv.slice(1, -2).split('\r\n');
};
/** The table part of the document: from the column header row to the end. */
const table = (csv: string, header: string) => {
  const all = lines(csv);
  return all.slice(all.indexOf(header));
};

describe('CSV field escaping and formula neutralisation', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1+2', "'+1+2"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['  =1+1', "'  =1+1"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', "'\rCR"],
    ['Paracetamol 500mg', 'Paracetamol 500mg'],
  ])('neutralises %j', (input, expected) => {
    expect(neutralizeCsvFormula(input)).toBe(expected);
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvField('Supplier, Ltd')).toBe('"Supplier, Ltd"');
    expect(csvField('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvField('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvField('a\r\nb')).toBe('"a\r\nb"');
    expect(csvField('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it('keeps numeric and money cells numeric, including negatives, and blanks unavailable values', () => {
    expect(csvField(-42)).toBe('-42');
    expect(csvField({ minor: -1250 })).toBe('-12.50');
    expect(csvField({ minor: 123456 })).toBe('1234.56');
    expect(csvField({ minor: null })).toBe('');
    expect(csvField({ minor: Number.MAX_SAFE_INTEGER + 2 })).toBe('');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('Yes');
  });
});

describe('report totals', () => {
  it('marks a strict money total unavailable when any input is unavailable', () => {
    expect(sumMinorStrict([100, 200, -50])).toBe(250);
    expect(sumMinorStrict([100, null])).toBeNull();
    expect(sumMinorStrict([])).toBe(0);
    expect(sumMinorStrict([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });

  it('sums only recorded lost-demand values', () => {
    expect(sumMinorRecorded([100, null, 50])).toBe(150);
    expect(sumMinorRecorded([null, null])).toBeNull();
  });
});

describe('branch comparison CSV', () => {
  const rows: BranchComparisonRow[] = [
    {
      branchId: 'b1',
      branchName: 'Main',
      salesMinor: 100_000,
      marginMinor: 25_000,
      lostDemandEstimateMinor: 1_200,
      lostDemandRecordedEvents: 3,
      expiryAtRiskMinor: 900,
      khataAgingMinor: 400,
    },
    {
      branchId: 'b2',
      branchName: '+Branch, "North"',
      salesMinor: 50_050,
      marginMinor: null,
      lostDemandEstimateMinor: null,
      lostDemandRecordedEvents: 0,
      expiryAtRiskMinor: 100,
      khataAgingMinor: 0,
    },
  ];
  const header =
    'Branch,Sales (PKR),Margin (PKR),Lost demand estimate (PKR),Lost demand events,Expiry at risk (PKR),Khata overdue (PKR)';

  it('notes currency and range, and ends with a totals row matching the screen totals', () => {
    const csv = branchComparisonCsv({ rows, estimateMethod: 'Recorded values.' }, context);
    const all = lines(csv);
    expect(all[0]).toBe('Report,Pharmacy branch comparison');
    expect(all[1]).toBe(
      'Currency,PKR (current organization setting; historical transaction currency is not verified)'
    );
    expect(all[2]).toBe('Date range,2026-10-01 to 2026-10-07 (inclusive business dates)');
    expect(all[3]).toBe('Branch scope,All available branches');
    expect(table(csv, header)).toEqual([
      header,
      'Main,1000.00,250.00,12.00,3,9.00,4.00',
      `"'+Branch, ""North""",500.50,,,0,1.00,0.00`,
      'Total,1500.50,,12.00,3,10.00,4.00',
    ]);
    expect(branchComparisonTotals(rows)).toEqual({
      salesMinor: 150_050,
      marginMinor: null,
      lostDemandEstimateMinor: 1_200,
      lostDemandRecordedEvents: 3,
      expiryAtRiskMinor: 1_000,
      khataAgingMinor: 400,
    });
  });

  it('labels an unknown currency instead of asserting one', () => {
    const csv = branchComparisonCsv(
      { rows: [], estimateMethod: 'Recorded values.' },
      { ...context, currency: null }
    );
    expect(lines(csv)[1]).toBe(
      'Currency,Currency unknown (no authoritative organization currency is available)'
    );
    expect(lines(csv)).toContain(
      'Branch,Sales (currency unknown),Margin (currency unknown),Lost demand estimate (currency unknown),Lost demand events,Expiry at risk (currency unknown),Khata overdue (currency unknown)'
    );
    expect(lines(csv).at(-1)).toBe('Total,0.00,0.00,,0,0.00,0.00');
  });
});

describe('period summary CSV', () => {
  const metrics = {
    salesMinor: 10_000,
    marginMinor: 2_500,
    cashMinor: 6_000,
    cashVarianceMinor: -150,
    refundsMinor: 0,
    openStockSignals: 4,
    recommendedOrders: 2,
    expiryValueMinor30: null,
    expiryValueMinor90: 700,
    safetyQueue: 1,
  };

  it('carries the on-screen figures in screen order', () => {
    expect(periodSummaryRows(metrics, true).map((row) => row.label)).toEqual([
      'Sales',
      'Gross margin',
      'Cash',
      'Cash variance',
      'Refunds',
      'Open stock signals',
      'Recommended orders',
      'Expiry ≤30d',
      'Expiry ≤90d',
    ]);
    const header = 'Metric,Value (PKR for amounts),Basis';
    const csv = periodSummaryCsv(metrics, {
      ...context,
      branchScope: 'Main',
      branchSelected: true,
    });
    expect(lines(csv)).toContain('Branch scope,Main');
    expect(table(csv, header)).toEqual([
      header,
      'Sales,100.00,Selected branch · ledger source',
      'Gross margin,25.00,Selected branch · ledger source',
      'Cash,60.00,Selected branch · ledger source',
      'Cash variance,-1.50,Selected branch · ledger source',
      'Refunds,0.00,Selected branch · ledger source',
      'Open stock signals,4,Selected branch · ledger source',
      'Recommended orders,2,Selected branch · ledger source',
      'Expiry ≤30d,,Selected branch · ledger source',
      'Expiry ≤90d,7.00,Selected branch · ledger source',
      'Organization-wide safety queue,1,Current snapshot · organization-wide',
    ]);
  });
});

describe('expiry advisor CSV', () => {
  const rows = [
    {
      branchId: 'b1',
      medicineName: 'Insulin "Rapid"',
      batchNumber: '@B-7',
      supplierName: 'Cold Supply',
      classification: 'RETURNABLE',
      coldChain: true,
      onHandUnits: 10,
      valueAtRiskMinor: 12_000,
      expiresAt: new Date('2026-11-15T00:00:00Z'),
    },
    {
      branchId: 'b2',
      medicineName: 'Amoxicillin',
      batchNumber: 'A-1',
      supplierName: 'Supplier',
      classification: 'INSUFFICIENT_HISTORY',
      coldChain: false,
      onHandUnits: 5,
      valueAtRiskMinor: 0,
      expiresAt: new Date('2027-01-02T00:00:00Z'),
    },
  ];
  const header =
    'Medicine,Batch,Branch,Supplier,Classification,Cold chain,Expires on,On hand (units),Value at risk (PKR)';

  it('lists each lot with readable columns and a totals row', () => {
    const csv = expiryAdviceCsv(
      rows,
      [
        { id: 'b1', name: 'Main' },
        { id: 'b2', name: 'North' },
      ],
      context
    );
    expect(table(csv, header)).toEqual([
      header,
      `"Insulin ""Rapid""",'@B-7,Main,Cold Supply,RETURNABLE,Yes,2026-11-15,10,120.00`,
      'Amoxicillin,A-1,North,Supplier,INSUFFICIENT HISTORY,No,2027-01-02,5,0.00',
      'Total,,,,,,,15,120.00',
    ]);
    expect(expiryAdviceTotals(rows)).toEqual({ onHandUnits: 15, valueAtRiskMinor: 12_000 });
  });
});
