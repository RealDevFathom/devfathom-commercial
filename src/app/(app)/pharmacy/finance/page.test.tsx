import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PharmacyFinancePage from './page';
import { MarginComparisonSection } from './margin-comparison';
import { LedgerReportsSection } from './ledger-reports';
import { FinancialStatements } from './financial-statements';
import { PageHeader } from '@/components/ui/page-header';

vi.mock('@/components/pharmacy/counter/manual-payment-settings-panel', () => ({
  ManualPaymentSettingsPanel: () => null,
}));
vi.mock('@/components/pharmacy/counter/khata-reminder-settings-panel', () => ({
  KhataReminderSettingsPanel: () => null,
}));
vi.mock('@/components/pharmacy/counter/discount-maximum-panel', () => ({
  DiscountMaximumPanel: () => null,
}));

const mocks = vi.hoisted(() => ({
  financialStatements: vi.fn(),
  branches: vi.fn(),
  workspace: vi.fn(),
  marginComparison: vi.fn(),
  perpetualValuation: vi.fn(),
  grossMargin: vi.fn(),
  leakageReport: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn().mockResolvedValue({ session: { user: { role: 'ADMIN' } } }),
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn().mockImplementation(async () => ({
    session: { user: { role: 'ADMIN' } },
    entitlements: { organizationId: 'organization_1' },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  })),
}));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => mocks },
}));

type Query = Awaited<Parameters<typeof PharmacyFinancePage>[0]['searchParams']>;

function sectionProps<P>(tree: ReactNode, component: (props: P) => unknown): P {
  let found: ReactElement<P> | undefined;
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (!isValidElement<{ children?: ReactNode }>(child)) return;
      if (child.type === component) found = child as ReactElement<P>;
      else visit(child.props.children);
    });
  }
  visit(tree);
  if (!found) throw new Error('Expected finance section in parent page');
  return found.props;
}

function getForm(element: ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  const form = container.querySelector('form');
  if (!form) throw new Error('Expected GET form');
  expect(form.method).toBe('get');
  expect(form.getAttribute('action')).toBe('/pharmacy/finance');
  return form;
}

function submit(form: HTMLFormElement): Query {
  const params = new URLSearchParams();
  new FormData(form).forEach((value, key) => params.append(key, String(value)));
  return Object.fromEntries(new URLSearchParams(params.toString()));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([
    { id: 'branch_1', name: 'Main' },
    { id: 'branch_2', name: 'Second authorized branch' },
  ]);
  mocks.workspace.mockResolvedValue({
    settlementCandidates: [],
    settlementBatches: [],
    transactions: [],
    bankLines: [],
    taxProfiles: [],
    periods: [],
  });
  for (const reader of [
    mocks.marginComparison,
    mocks.perpetualValuation,
    mocks.grossMargin,
    mocks.leakageReport,
  ])
    reader.mockRejectedValue({ code: 'FORBIDDEN' });
});
afterEach(() => vi.useRealTimers());

it('links the selected finance branch to its balance sheet', async () => {
  const tree = await PharmacyFinancePage({
    searchParams: Promise.resolve({ branch: 'branch_2' }),
  });
  const header = sectionProps(tree, PageHeader);
  const html = renderToStaticMarkup(header.actions as ReactElement);

  expect(html).toContain('/pharmacy/accounts/balance-sheet?branch=branch_2');
  expect(html).toContain('Balance sheet');
});

describe('finance parent GET filter round-trip', () => {
  const ledger = {
    ledgerFrom: '2026-08-01',
    ledgerTo: '2026-08-22',
    ledgerAt: '2026-09-05',
    ledgerBy: 'product',
  };

  it.each([
    {
      name: 'explicit filters and selected authorized branch',
      query: { ...ledger, branch: 'branch_2' },
      invalid: false,
    },
    {
      name: 'missing filters and unauthorized branch fallback',
      query: { branch: 'outside-organization' },
      invalid: false,
    },
    {
      name: 'partial filters',
      query: { ledgerBy: 'line', ledgerAt: '2026-09-01' },
      invalid: false,
    },
    {
      name: 'impossible calendar date',
      query: { ...ledger, ledgerFrom: '2026-02-30' },
      invalid: true,
    },
    { name: 'reversed period', query: { ...ledger, ledgerTo: '2026-07-01' }, invalid: true },
    {
      name: 'future valuation cutoff',
      query: { ...ledger, ledgerAt: '2026-09-13' },
      invalid: true,
    },
    { name: 'invalid grouping', query: { ...ledger, ledgerBy: 'unlisted' }, invalid: true },
    {
      name: 'empty filters remain invalid',
      query: { ledgerFrom: '', ledgerTo: '', ledgerAt: '', ledgerBy: '' },
      invalid: true,
    },
  ])('preserves existing semantics for $name', async ({ query, invalid }) => {
    const initial = await PharmacyFinancePage({
      searchParams: Promise.resolve({
        ...query,
        marginFrom: '2026-09-01',
        marginTo: '2026-09-03',
        notice: 'do not forward',
        kind: 'error',
        arbitrary: 'do not forward',
      }),
    });
    const ledgerBefore = sectionProps(initial, LedgerReportsSection);
    const beforeHtml = renderToStaticMarkup(await LedgerReportsSection(ledgerBefore));
    const readerCalls = [mocks.perpetualValuation, mocks.grossMargin, mocks.leakageReport].map(
      (reader) => [...reader.mock.calls]
    );
    const form = getForm(
      await MarginComparisonSection(sectionProps(initial, MarginComparisonSection))
    );
    for (const [name, value] of Object.entries({
      marginFrom: '2026-09-04',
      marginTo: '2026-09-06',
    }))
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    const submitted = submit(form);
    const expectedBranch = query.branch === 'branch_2' ? 'branch_2' : 'branch_1';
    const expectedLedger = { ...query } as Query;
    delete expectedLedger.branch;
    expect(submitted).toEqual({
      ...expectedLedger,
      branch: expectedBranch,
      marginFrom: '2026-09-04',
      marginTo: '2026-09-06',
    });
    for (const name of Object.keys(expectedLedger))
      expect((form.elements.namedItem(name) as HTMLInputElement).type).toBe('hidden');

    const next = await PharmacyFinancePage({ searchParams: Promise.resolve(submitted) });
    const ledgerAfter = sectionProps(next, LedgerReportsSection);
    expect({
      ...ledgerAfter,
      marginFrom: ledgerBefore.marginFrom,
      marginTo: ledgerBefore.marginTo,
    }).toEqual(ledgerBefore);
    for (const reader of [mocks.perpetualValuation, mocks.grossMargin, mocks.leakageReport])
      reader.mockClear();
    const afterElement = await LedgerReportsSection(ledgerAfter);
    const afterHtml = renderToStaticMarkup(afterElement);
    expect(afterHtml.includes('id="ledger-filter-error"')).toBe(invalid);
    expect(beforeHtml.includes('id="ledger-filter-error"')).toBe(invalid);
    [mocks.perpetualValuation, mocks.grossMargin, mocks.leakageReport].forEach((reader, index) => {
      expect(reader.mock.calls).toEqual(readerCalls[index]);
      expect(reader).toHaveBeenCalledTimes(invalid ? 0 : 1);
    });
    if (!invalid) {
      expect(mocks.grossMargin).toHaveBeenCalledWith({
        branchId: expectedBranch,
        from: `${submitted.ledgerFrom ?? '2026-08-13'}T00:00:00.000Z`,
        to: `${submitted.ledgerTo ?? '2026-09-13'}T00:00:00.000Z`,
        by: submitted.ledgerBy ?? 'batch',
      });
      expect(mocks.perpetualValuation).toHaveBeenCalledWith({
        branchId: expectedBranch,
        at: `${submitted.ledgerAt ?? '2026-09-12'}T00:00:00.000Z`,
      });
    }
    await MarginComparisonSection(sectionProps(next, MarginComparisonSection));
    expect(mocks.marginComparison).toHaveBeenLastCalledWith({
      branchId: expectedBranch,
      from: '2026-09-04T00:00:00Z',
      to: '2026-09-06T00:00:00Z',
    });
    // The already-working ledger-to-comparison direction retains the chosen dates too.
    expect(submit(getForm(afterElement))).toMatchObject({
      branch: expectedBranch,
      marginFrom: '2026-09-04',
      marginTo: '2026-09-06',
    });
  });
});

describe('shared Finance posting window', () => {
  it.each([
    [{}, '2026-08-13', '2026-09-13'],
    [{ ledgerFrom: '2026-09-01' }, '2026-09-01', '2026-09-13'],
    [{ ledgerTo: '2026-09-10' }, '2026-08-13', '2026-09-10'],
    [{ ledgerFrom: '2026-08-20', ledgerTo: '2026-09-02' }, '2026-08-20', '2026-09-02'],
  ] as const)('passes one UTC interval to both readers for %j', async (query, from, to) => {
    // Simulated reader boundary, not database/posting proof.
    const posting = new Date('2026-09-12T12:00:00Z');
    const included: boolean[] = [];
    const readWindow = async (window: { from: string; to: string }) => {
      included.push(posting >= new Date(window.from) && posting < new Date(window.to));
      throw new Error('Fixture boundary captured');
    };
    mocks.financialStatements.mockImplementation(readWindow);
    mocks.grossMargin.mockImplementation(readWindow);
    const tree = await PharmacyFinancePage({ searchParams: Promise.resolve(query) });
    const statements = sectionProps(tree, FinancialStatements);
    const ledger = sectionProps(tree, LedgerReportsSection);
    expect({ from: statements.from, to: statements.to }).toEqual({ from, to });
    expect({ from: ledger.from, to: ledger.to }).toEqual({ from, to });
    await FinancialStatements(statements);
    await LedgerReportsSection(ledger);
    expect(included).toEqual([to === '2026-09-13', to === '2026-09-13']);
    const windows = [mocks.financialStatements, mocks.grossMargin].map((reader) => {
      const input = reader.mock.calls[0][0];
      return [new Date(input.from).toISOString(), new Date(input.to).toISOString()];
    });
    expect(windows[0]).toEqual(windows[1]);
    expect(mocks.perpetualValuation).toHaveBeenCalledWith({
      branchId: 'branch_1',
      at: '2026-09-12T00:00:00.000Z',
    });
  });
});

describe('DEV-103 native AP payments in recent transactions', () => {
  it('offers no generic reverse for an invoice-directed supplier payment', async () => {
    const posted = {
      id: 'txn_generic',
      reference: 'PAY-GENERIC',
      kind: 'SUPPLIER_PAYMENT',
      counterpartyName: 'Distributor',
      amountMinor: 1_000,
      status: 'POSTED',
      idempotencyKey: 'browser-uuid-1',
    };
    mocks.workspace.mockResolvedValue({
      settlementCandidates: [],
      settlementBatches: [],
      bankLines: [],
      taxProfiles: [],
      periods: [],
      transactions: [
        posted,
        {
          ...posted,
          id: 'txn_native',
          reference: 'PAY-NATIVE',
          idempotencyKey: 'ap-invoice-payment:pay-command-0001',
        },
      ],
    });
    const html = renderToStaticMarkup(
      (await PharmacyFinancePage({
        searchParams: Promise.resolve({ branch: 'branch_1' }),
      })) as ReactElement
    );
    const rows = html.split('<tr').filter((row) => row.includes('PAY-'));
    const generic = rows.find((row) => row.includes('PAY-GENERIC'))!;
    const native = rows.find((row) => row.includes('PAY-NATIVE'))!;
    expect(generic).toContain('value="txn_generic"');
    expect(native).not.toContain('value="txn_native"');
    expect(native).toContain('reverse it through the invoice settlement');
  });
});
