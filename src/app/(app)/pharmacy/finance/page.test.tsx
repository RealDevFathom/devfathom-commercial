import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PharmacyFinancePage from './page';
import { MarginComparisonSection } from './margin-comparison';
import { LedgerReportsSection } from './ledger-reports';
import { SectionCard } from '@/components/ui/section-card';
import { FinancialStatements } from './financial-statements';
import { PageHeader } from '@/components/ui/page-header';

vi.mock('@/components/pharmacy/counter/manual-payment-settings-panel', () => ({
  ManualPaymentSettingsPanel: () => null,
}));

const mocks = vi.hoisted(() => ({
  financialStatements: vi.fn(),
  expenseAging: vi.fn(),
  expenseSuppliers: vi.fn(),
  expenseSettlements: vi.fn(),
  voidExpenseInvoice: vi.fn(),
  reverseExpenseSettlement: vi.fn(),
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
  mocks.expenseAging.mockResolvedValue({
    asOf: new Date(), from: new Date(), retrievedAt: new Date(),
    bounds: { maxRows: 200, maxWindowDays: 366 }, pagination: { offset: 0, limit: 200, hasMore: false, nextOffset: null }, rows: [], csv: '',
  });
  mocks.expenseSuppliers.mockResolvedValue([{ id: 'supplier-1', name: 'City Utilities' }]);
  mocks.expenseSettlements.mockResolvedValue({ rows: [], hasMore: false });
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

function nativeApHtml(tree: ReactNode) {
  let section: ReactElement | undefined;
  function visit(node: ReactNode) {
    Children.forEach(node, child => {
      if (!isValidElement<{ title?: string; children?: ReactNode }>(child)) return;
      if (child.type === SectionCard && child.props.title === 'Non-stock supplier invoices') section = child;
      else visit(child.props.children);
    });
  }
  visit(tree);
  if (!section) throw new Error('Expected native AP section');
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(section);
  return container;
}

function financeAction(tree: ReactNode) {
  let action: ((data: FormData) => Promise<void>) | undefined;
  function visit(node: ReactNode) {
    Children.forEach(node, child => {
      if (!isValidElement<{ children?: ReactNode; action?: unknown }>(child)) return;
      if (child.type === 'form' && typeof child.props.action === 'function') {
        action = child.props.action as (data: FormData) => Promise<void>;
      } else visit(child.props.children);
    });
  }
  visit(tree);
  if (!action) throw new Error('Expected Finance server action');
  return action;
}

describe('native AP isolation and supplier selection', () => {
  it.each([
    { action: 'void-expense-invoice', id: 'invoiceId', value: 'invoice-1', mutation: mocks.voidExpenseInvoice },
    { action: 'reverse-expense-settlement', id: 'settlementId', value: 'settlement-1', mutation: mocks.reverseExpenseSettlement },
  ])('requires confirmation and routes $action through the native mutation', async ({ action, id, value, mutation }) => {
    const perform = financeAction(await PharmacyFinancePage({ searchParams: Promise.resolve({}) }));
    const data = new FormData();
    for (const [key, field] of Object.entries({ action, branchId: 'branch_1', [id]: value, reason: 'Duplicate posting' })) data.set(key, field);
    await expect(perform(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(mutation).not.toHaveBeenCalled();
    data.set('confirmed', 'yes');
    await expect(perform(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(mutation).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch_1', [id]: value, reason: 'Duplicate posting', at: expect.any(Date), idempotencyKey: expect.any(String),
    });
  });

  it('offers later invoice and payment pages while preserving branch and ledger filters', async () => {
    mocks.expenseAging.mockResolvedValue({
      asOf: new Date(), retrievedAt: new Date(), from: null, bounds: { maxRows: 200, maxWindowDays: 366 }, csv: '',
      pagination: { offset: 200, limit: 200, hasMore: true, nextOffset: 400 },
      rows: [{ id: 'later-invoice', supplierInvoiceRef: 'LATER', dueAt: new Date(), outstandingMinor: 500, daysPastDue: 0 }],
    });
    mocks.expenseSettlements.mockResolvedValue({ rows: [{ id: 'paid-settlement', reference: 'PAY', amountMinor: 100, invoice: { supplierInvoiceRef: 'PAID' } }], hasMore: true });
    const tree = await PharmacyFinancePage({ searchParams: Promise.resolve({ branch: 'branch_2', apOffset: '200', apPaymentOffset: '50', ledgerFrom: '2026-08-01' }) });
    expect(mocks.expenseAging).toHaveBeenCalledWith({ branchId: 'branch_2', format: 'CSV', limit: 200, offset: 200 });
    expect(mocks.expenseSettlements).toHaveBeenCalledWith({ branchId: 'branch_2', offset: 50 });
    const html = nativeApHtml(tree);
    const next = html.querySelector('[aria-label="Supplier invoice pages"] a:last-child');
    const params = new URL(next!.getAttribute('href')!, 'https://tenant.test').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ branch: 'branch_2', apOffset: '400', ledgerFrom: '2026-08-01' });
    expect(html.querySelector('select[name="invoiceId"] option[value="later-invoice"]')).not.toBeNull();
    expect(html.querySelector('select[name="settlementId"] option[value="paid-settlement"]')?.textContent).toContain('PAID');
    for (const action of ['void-expense-invoice', 'reverse-expense-settlement']) {
      const form = html.querySelector(`input[value="${action}"]`)?.closest('form');
      expect(form?.querySelector('input[name="reason"]')?.hasAttribute('required')).toBe(true);
      expect(form?.querySelector('input[name="confirmed"]')?.hasAttribute('required')).toBe(true);
    }
  });

  it('disables reversal when no posted payments exist and shows a read failure', async () => {
    let html = nativeApHtml(await PharmacyFinancePage({ searchParams: Promise.resolve({}) }));
    expect(html.querySelector('select[name="settlementId"]')?.hasAttribute('disabled')).toBe(true);
    mocks.expenseSettlements.mockRejectedValue(new Error('unavailable'));
    html = nativeApHtml(await PharmacyFinancePage({ searchParams: Promise.resolve({}) }));
    expect(html.textContent).toContain('Invoice payments could not load');
    expect(html.querySelector('select[name="settlementId"]')).toBeNull();
  });

  it('retains all existing Finance sections when the aging reader fails', async () => {
    mocks.expenseAging.mockRejectedValue(new Error('clock skew or database failure'));
    const tree = await PharmacyFinancePage({ searchParams: Promise.resolve({}) });
    expect(sectionProps(tree, LedgerReportsSection).branch.id).toBe('branch_1');
    expect(sectionProps(tree, FinancialStatements).branchId).toBe('branch_1');
    expect(sectionProps(tree, MarginComparisonSection).branch.id).toBe('branch_1');
    const html = nativeApHtml(tree);
    expect(html.querySelector('[role="alert"]')?.textContent).toContain('Supplier aging could not load');
    expect(html.querySelector('[name="supplierId"] option[value="supplier-1"]')?.textContent).toBe('City Utilities');
    expect(html.querySelector('[name="invoiceId"]')).toBeNull();
  });

  it('uses authorized supplier names and requests a database-clock snapshot with no age cutoff', async () => {
    mocks.expenseAging.mockResolvedValue({
      asOf: new Date(), retrievedAt: new Date(), from: new Date(), bounds: { maxRows: 200, maxWindowDays: 366 }, pagination: { offset: 0, limit: 200, hasMore: false, nextOffset: null }, csv: '',
      rows: [{ id: 'old-invoice', supplierInvoiceRef: 'OLD-2025', dueAt: new Date('2025-02-01Z'), outstandingMinor: 500, daysPastDue: 588 }],
    });
    const tree = await PharmacyFinancePage({ searchParams: Promise.resolve({ branch: 'branch_2' }) });
    expect(mocks.expenseAging).toHaveBeenCalledWith({ branchId: 'branch_2', format: 'CSV', limit: 200 });
    expect(mocks.expenseSuppliers).toHaveBeenCalledWith({ branchId: 'branch_2' });
    const html = nativeApHtml(tree);
    expect(html.querySelector('input[name="supplierId"]')).toBeNull();
    expect(html.querySelector('select[name="supplierId"] option[value="supplier-1"]')?.textContent).toBe('City Utilities');
    expect(html.querySelector('select[name="invoiceId"] option[value="old-invoice"]')?.textContent).toContain('OLD-2025');
  });

  it.each([null, []])('keeps Finance usable and disables invoice creation when supplier choices are %j', async suppliers => {
    if (suppliers === null) mocks.expenseSuppliers.mockRejectedValue(new Error('unavailable'));
    else mocks.expenseSuppliers.mockResolvedValue(suppliers);
    const tree = await PharmacyFinancePage({ searchParams: Promise.resolve({}) });
    expect(sectionProps(tree, LedgerReportsSection).branch.id).toBe('branch_1');
    const html = nativeApHtml(tree);
    expect(html.querySelector('select[name="supplierId"]')?.hasAttribute('disabled')).toBe(true);
    const createForm = html.querySelector('[value="create-expense-invoice"]')?.closest('form');
    expect(createForm?.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(html.querySelector('#expense-supplier-help')?.textContent).toContain(suppliers === null ? 'could not load' : 'Add and authorize');
  });
});
