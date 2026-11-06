import { browserUuid } from '@/lib/browser-uuid';
import { FinancialStatements } from './financial-statements';
import { Suspense } from 'react';
import { MarginComparisonSection } from './margin-comparison';
import { LedgerReportsSection, LedgerReportsLoading } from './ledger-reports';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, unstable_rethrow } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { ManualPaymentSettingsPanel } from '@/components/pharmacy/counter/manual-payment-settings-panel';
import { StatusPill } from '@/components/ui/status-pill';
import { pharmacyActionErrorMessage } from '@/lib/pharmacy/action-error-message';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy finance' };
const route = '/pharmacy/finance';
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const moneyMinor = (data: FormData, key: string) => Math.round(Number(field(data, key)) * 100);
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
const money = (minor: number) =>
  `PKR ${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`;
const dated = (value: Date | string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' }).format(new Date(value));
const destination = (branchId: string, notice: string, kind: 'success' | 'error' = 'success') =>
  `${route}?${new URLSearchParams({ branch: branchId, notice, kind })}`;

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

export default async function PharmacyFinancePage({
  searchParams,
}: {
  searchParams: Promise<{
    branch?: string;
    notice?: string;
    kind?: string;
    marginFrom?: string;
    marginTo?: string;
    ledgerFrom?: string;
    ledgerTo?: string;
    ledgerAt?: string;
    ledgerBy?: string;
    journalPage?: string;
    apOffset?: string;
    apPaymentOffset?: string;
  }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  if (!ctx?.session?.user || ctx.session.user.role !== 'ADMIN') {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Finance"
          description="Bookkeeping, reconciliation, close, and tax profile controls."
        />
        <SectionCard title="Permission required">
          <p className="text-sm text-text-muted">
            An organization administrator must perform financial postings and approve tax versions.
          </p>
        </SectionCard>
      </main>
    );
  }
  const organizationId = ctx.entitlements.organizationId;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const branch = branches.find((item) => item.id === query.branch) ?? branches[0] ?? null;
  if (!branch) {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Finance"
          description="Bookkeeping, reconciliation, close, and tax profile controls."
        />
        <SectionCard title="Create an active branch first">
          <p className="text-sm text-text-muted">
            Finish pharmacy onboarding before recording branch finance.
          </p>
        </SectionCard>
      </main>
    );
  }
  const caller = pharmacyFinanceRouter.createCaller(ctx);
  let workspace: Awaited<ReturnType<typeof caller.workspace>>;
  let nativeAp: Awaited<ReturnType<typeof caller.expenseAging>> | null = null;
  let expenseSuppliers: Awaited<ReturnType<typeof caller.expenseSuppliers>> | null = null;
  let expenseSettlements: Awaited<ReturnType<typeof caller.expenseSettlements>> | null = null;
  const pageOffset = (value?: string) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  const apOffset = pageOffset(query.apOffset);
  const apPaymentOffset = pageOffset(query.apPaymentOffset);
  const apPageLink = (key: 'apOffset' | 'apPaymentOffset', offset: number) => {
    const params = new URLSearchParams({ branch: branch.id });
    for (const name of ['ledgerFrom', 'ledgerTo', 'ledgerAt', 'ledgerBy', 'marginFrom', 'marginTo', 'journalPage', 'apOffset', 'apPaymentOffset'] as const) {
      if (query[name] !== undefined) params.set(name, query[name]);
    }
    params.set(key, String(offset));
    return `${route}?${params}`;
  };
  try {
    workspace = await caller.workspace({ branchId: branch.id });
  } catch {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Finance"
          description="Bookkeeping, reconciliation, close, and tax profile controls."
        />
        <SectionCard title="Finance could not load">
          <p className="text-sm text-text-muted">
            Refresh the page. No financial data was changed.
          </p>
        </SectionCard>
      </main>
    );
  }

  // An optional AP reader must not replace the established Finance workspace.
  // Omit asOf for a current snapshot anchored to the database clock.
  try {
    nativeAp = await caller.expenseAging({ branchId: branch.id, format: 'CSV', limit: 200, ...(apOffset ? { offset: apOffset } : {}) });
  } catch (error) {
    unstable_rethrow(error);
  }
  try {
    expenseSuppliers = await caller.expenseSuppliers({ branchId: branch.id });
  } catch (error) {
    unstable_rethrow(error);
  }
  try {
    expenseSettlements = await caller.expenseSettlements({ branchId: branch.id, offset: apPaymentOffset });
  } catch (error) {
    unstable_rethrow(error);
  }

  async function perform(data: FormData) {
    'use server';
    const branchId = field(data, 'branchId');
    const action = field(data, 'action');
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user || actionCtx.session.user.role !== 'ADMIN')
        throw new Error('Administrator access is required.');
      const actionCaller = pharmacyFinanceRouter.createCaller(actionCtx);
      if (action === 'void-expense-invoice' || action === 'reverse-expense-settlement') {
        if (field(data, 'confirmed') !== 'yes') throw new Error('Confirm the correction.');
        const correction = {
          branchId, reason: field(data, 'reason'), at: new Date(), idempotencyKey: browserUuid(),
        };
        if (action === 'void-expense-invoice') {
          await actionCaller.voidExpenseInvoice({ ...correction, invoiceId: field(data, 'invoiceId') });
          redirect(destination(branchId, 'Invoice voided with an additive journal reversal.'));
        }
        await actionCaller.reverseExpenseSettlement({ ...correction, settlementId: field(data, 'settlementId') });
        redirect(destination(branchId, 'Invoice payment reversed. The original payment remains in the audit trail.'));
      }
      if (action === 'create-expense-invoice') {
        const amountMinor = moneyMinor(data, 'amount');
        await actionCaller.createExpenseInvoice({
          branchId,
          supplierId: field(data, 'supplierId'),
          supplierInvoiceRef: field(data, 'supplierInvoiceRef'),
          description: field(data, 'description'),
          issuedAt: new Date(`${field(data, 'issuedAt')}T12:00:00Z`),
          dueAt: new Date(`${field(data, 'dueAt')}T12:00:00Z`),
          amountMinor,
          idempotencyKey: browserUuid(),
          lines: [{ description: field(data, 'description'), amountMinor }],
        });
        redirect(destination(branchId, 'Supplier expense invoice posted to accounts payable.'));
      }
      if (action === 'settle-expense-invoice') {
        await actionCaller.settleExpenseInvoice({
          branchId,
          invoiceId: field(data, 'invoiceId'),
          amountMinor: moneyMinor(data, 'amount'),
          occurredAt: new Date(`${field(data, 'occurredAt')}T12:00:00Z`),
          reference: field(data, 'reference'),
          idempotencyKey: browserUuid(),
          fundingAccount: field(data, 'fundingAccount') === 'CASH' ? 'CASH' : 'BANK',
        });
        redirect(destination(branchId, 'Invoice payment posted and allocated.'));
      }
      if (action === 'post') {
        const kind = field(data, 'transactionKind') as
          | 'SUPPLIER_PAYMENT'
          | 'CUSTOMER_RECEIPT'
          | 'EXPENSE'
          | 'PETTY_CASH'
          | 'BANK_DEPOSIT'
          | 'SETTLEMENT'
          | 'VOUCHER'
          | 'CHEQUE';
        await actionCaller.post({
          branchId,
          reference: field(data, 'reference'),
          kind,
          amountMinor: moneyMinor(data, 'amount'),
          occurredAt: new Date(`${field(data, 'occurredAt')}T12:00:00Z`),
          idempotencyKey: browserUuid(),
          counterpartyName: field(data, 'counterpartyName') || undefined,
          memo: field(data, 'memo') || undefined,
          bankReference: field(data, 'bankReference') || undefined,
          chequeNumber: field(data, 'chequeNumber') || undefined,
          chequeDueAt: field(data, 'chequeDueAt')
            ? new Date(`${field(data, 'chequeDueAt')}T12:00:00Z`)
            : undefined,
          fundingAccount: field(data, 'fundingAccount') === 'CASH' ? 'CASH' : 'BANK',
          allocations: [],
        });
        redirect(destination(branchId, 'Transaction posted and journal balanced.'));
      }
      if (action === 'reverse') {
        await actionCaller.reverse({
          branchId,
          transactionId: field(data, 'transactionId'),
          reason: field(data, 'reason'),
          at: new Date(),
          idempotencyKey: browserUuid(),
        });
        redirect(
          destination(branchId, 'Reversal posted. The original entry remains in the audit trail.')
        );
      }
      if (action === 'close') {
        await actionCaller.closePeriod({
          branchId,
          startsAt: new Date(`${field(data, 'startsAt')}T00:00:00Z`),
          endsAt: new Date(`${field(data, 'endsAt')}T00:00:00Z`),
        });
        redirect(destination(branchId, 'Period closed. Posting into that range is now blocked.'));
      }
      if (action === 'reopen') {
        await actionCaller.reopenPeriod({
          branchId,
          periodId: field(data, 'periodId'),
          reason: field(data, 'reason'),
        });
        redirect(destination(branchId, 'Period reopened with approval evidence.'));
      }
      if (action === 'bank-line') {
        await actionCaller.importBankLine({
          branchId,
          statementRef: field(data, 'statementRef'),
          lineReference: field(data, 'lineReference'),
          bookedAt: new Date(`${field(data, 'bookedAt')}T12:00:00Z`),
          amountMinor: moneyMinor(data, 'amount'),
          description: field(data, 'description'),
        });
        redirect(destination(branchId, 'Bank statement line added for matching.'));
      }
      if (action === 'reconcile') {
        await actionCaller.reconcile({
          branchId,
          statementLineId: field(data, 'statementLineId'),
          transactionId: field(data, 'transactionId'),
          amountMinor: moneyMinor(data, 'amount'),
        });
        redirect(destination(branchId, 'Bank line matched to the selected transaction.'));
      }
      if (action === 'reconcile-settlement') {
        await actionCaller.reconcile({
          branchId, statementLineId: field(data, 'statementLineId'),
          settlementBatchId: field(data, 'settlementBatchId'), amountMinor: moneyMinor(data, 'amount'),
        });
        redirect(destination(branchId, 'Statement matched to POS settlement receipts.'));
      }
      if (action === 'settlement-batch') {
        await actionCaller.createSettlementBatch({
          branchId,
          reference: field(data, 'reference'),
          provider: field(data, 'provider'),
          tenderType: field(data, 'tenderType') as 'CARD' | 'WALLET' | 'BANK_TRANSFER' | 'RAAST' | 'JAZZCASH' | 'EASYPAISA',
          businessDate: new Date(`${field(data, 'businessDate')}T12:00:00Z`),
          tenderIds: data.getAll('tenderIds').map(String),
        });
        redirect(destination(branchId, 'POS tenders grouped into a settlement batch.'));
      }
      if (action === 'tax') {
        const common = {
          priceMode: field(data, 'priceMode') as 'INCLUSIVE' | 'EXCLUSIVE',
          rate: field(data, 'rate'),
          roundingScale: 2,
          sroReference: field(data, 'sroReference') || undefined,
        };
        await actionCaller.publishTaxProfile({
          branchId,
          name: field(data, 'profileName'),
          effectiveFrom: new Date(`${field(data, 'effectiveFrom')}T00:00:00Z`),
          effectiveTo: field(data, 'effectiveTo')
            ? new Date(`${field(data, 'effectiveTo')}T00:00:00Z`)
            : undefined,
          approvalReference: field(data, 'approvalReference'),
          idempotencyKey: browserUuid(),
          rules: [
            { productClass: 'MEDICINE', pctHsCode: field(data, 'medicineHs'), ...common },
            { productClass: 'FRONT_SHOP', pctHsCode: field(data, 'frontShopHs'), ...common },
          ],
        });
        redirect(destination(branchId, 'Approved tax profile version published.'));
      }
      throw new Error('Choose a supported action.');
    } catch (error) {
      // Preserve Next.js control-flow errors without trusting a user/provider-controlled
      // `digest` property as proof that an arbitrary thrown value is a framework error.
      unstable_rethrow(error);
      redirect(destination(branchId || branch.id, pharmacyActionErrorMessage('finance'), 'error'));
    }
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // Shared UTC [from, to) posting window includes today; valuation stays independent.
  const ledgerFrom =
    query.ledgerFrom ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const ledgerTo =
    query.ledgerTo ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Finance"
        description="Post and allocate money, reconcile the bank, control periods, and publish approved tax versions."
        actions={
          <Link
            href={`/pharmacy/accounts/balance-sheet?${new URLSearchParams({ branch: branch.id })}`}
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            Balance sheet
          </Link>
        }
      />
      <Suspense fallback={<LedgerReportsLoading />}>
        <FinancialStatements
          caller={caller}
          branchId={branch.id}
          from={ledgerFrom}
          to={ledgerTo}
          page={query.journalPage}
        />
      </Suspense>
      <Suspense
        key={[branch.id, ledgerFrom, ledgerTo, query.ledgerAt, query.ledgerBy].join(':')}
        fallback={<LedgerReportsLoading />}
      >
        <LedgerReportsSection
          caller={caller}
          branch={branch}
          from={ledgerFrom}
          to={ledgerTo}
          at={query.ledgerAt}
          by={query.ledgerBy}
          marginFrom={query.marginFrom}
          marginTo={query.marginTo}
        />
      </Suspense>
      <Suspense
        fallback={
          <SectionCard title="Gross-margin comparison" titleLevel={2}>
            <p role="status">Loading posted ledger comparison…</p>
          </SectionCard>
        }
      >
        <MarginComparisonSection
          caller={caller}
          branch={branch}
          from={query.marginFrom}
          to={query.marginTo}
          ledgerFrom={query.ledgerFrom}
          ledgerTo={query.ledgerTo}
          ledgerAt={query.ledgerAt}
          ledgerBy={query.ledgerBy}
        />
      </Suspense>
      {query.notice ? (
        <div
          role={query.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-[var(--radius-sm)] border p-4 text-sm ${query.kind === 'error' ? 'border-destructive bg-destructive-subtle text-destructive-foreground' : 'border-success bg-success-subtle text-success-foreground'}`}
        >
          {query.notice}
        </div>
      ) : null}
      <SectionCard title="Working branch" eyebrow="Organization scope">
        <form method="get" className="flex flex-wrap items-end gap-3">
          {(
            ['ledgerFrom', 'ledgerTo', 'ledgerAt', 'ledgerBy', 'marginFrom', 'marginTo'] as const
          ).map((key) =>
            query[key] ? <input key={key} type="hidden" name={key} value={query[key]} /> : null
          )}
          <label className="min-w-64 text-sm text-text-body">
            Branch
            <select className={inputClass} name="branch" defaultValue={branch.id}>
              {branches.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Switch branch
          </Button>
        </form>
      </SectionCard>
      <SectionCard title="Non-stock supplier invoices" eyebrow="Native accounts payable">
        <div className="grid gap-5 xl:grid-cols-2">
          <form action={perform} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <input type="hidden" name="action" value="create-expense-invoice" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="min-w-0 text-sm text-text-body">
              Supplier
              <select className={inputClass} name="supplierId" required defaultValue="" disabled={!expenseSuppliers?.length} aria-describedby="expense-supplier-help">
                <option value="" disabled>Select a supplier</option>
                {expenseSuppliers?.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
            <label className="text-sm">Supplier invoice reference<Input className="mt-1 min-h-11" name="supplierInvoiceRef" required /></label>
            <p id="expense-supplier-help" className="text-sm text-text-muted sm:col-span-2" role={expenseSuppliers === null ? 'alert' : undefined}>
              {expenseSuppliers === null ? 'Suppliers could not load. Refresh the page to try again.' : expenseSuppliers.length ? 'Choose an active, authorized supplier.' : 'Add and authorize a supplier in Purchasing before posting an invoice.'}
            </p>
            <label className="text-sm sm:col-span-2">Expense description<Input className="mt-1 min-h-11" name="description" required /></label>
            <label className="text-sm">Invoice date<Input className="mt-1 min-h-11" name="issuedAt" type="date" required /></label>
            <label className="text-sm">Due date<Input className="mt-1 min-h-11" name="dueAt" type="date" required /></label>
            <label className="text-sm">Amount (PKR)<Input className="mt-1 min-h-11" name="amount" type="number" min="0.01" step="0.01" required /></label>
            <Button type="submit" disabled={!expenseSuppliers?.length} className="min-h-11 self-end">Post invoice</Button>
          </form>
          {nativeAp ? <form action={perform} className="grid min-w-0 content-start gap-3 sm:grid-cols-2">
            <input type="hidden" name="action" value="settle-expense-invoice" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm sm:col-span-2">Open invoice<select className={inputClass} name="invoiceId" required disabled={!nativeAp.rows.length}>{nativeAp.rows.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.supplierInvoiceRef} · {money(invoice.outstandingMinor)}</option>)}</select></label>
            <label className="text-sm">Payment reference<Input className="mt-1 min-h-11" name="reference" required /></label>
            <label className="text-sm">Amount (PKR)<Input className="mt-1 min-h-11" name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label className="text-sm">Payment date<Input className="mt-1 min-h-11" name="occurredAt" type="date" defaultValue={today} required /></label>
            <label className="text-sm">Pay from<select className={inputClass} name="fundingAccount"><option value="BANK">Bank</option><option value="CASH">Cash</option></select></label>
            <Button type="submit" disabled={!nativeAp.rows.length} className="min-h-11 sm:col-span-2">Pay selected invoice</Button>
          </form> : <p role="alert" className="text-sm text-text-muted">Supplier aging could not load. Refresh the page to view balances and pay invoices. No financial data was changed.</p>}
        </div>
        {nativeAp ? <>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-text-muted">Native non-stock invoices only · all unpaid balances, oldest due first · up to {nativeAp.bounds.maxRows} rows per page</p>
          {'csv' in nativeAp ? <a className="text-sm font-medium text-link underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" download="native-ap-aging.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(nativeAp.csv)}`}>Download this page as CSV</a> : null}
        </div>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Due date</TableHead><TableHead className="text-right">Outstanding</TableHead><TableHead className="text-right">Days past due</TableHead></TableRow></TableHeader>
            <TableBody>
              {nativeAp.rows.map((invoice) => <TableRow key={invoice.id}><TableCell className="font-medium">{invoice.supplierInvoiceRef}</TableCell><TableCell>{dated(invoice.dueAt)}</TableCell><TableCell className="text-right tabular-nums">{money(invoice.outstandingMinor)}</TableCell><TableCell className="text-right tabular-nums">{invoice.daysPastDue}</TableCell></TableRow>)}
              {!nativeAp.rows.length ? <TableRow><TableCell colSpan={4} className="text-center text-text-muted">No open native supplier invoices. Post an invoice to record a payable.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </div>
        <nav aria-label="Supplier invoice pages" className="mt-4 flex flex-wrap gap-4 text-sm">
          {apOffset > 0 ? <a className="underline focus-visible:ring-2 focus-visible:ring-ring" href={apPageLink('apOffset', Math.max(0, apOffset - 200))}>Previous invoices</a> : null}
          {nativeAp.pagination.hasMore ? <a className="underline focus-visible:ring-2 focus-visible:ring-ring" href={apPageLink('apOffset', nativeAp.pagination.nextOffset!)}>Next invoices</a> : null}
        </nav>
        <details className="mt-5 border-t border-border-subtle pt-4">
          <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">Void an unpaid invoice</summary>
          <p className="mt-3 text-sm text-text-muted">Reverse all payments first. Voiding reverses the accrual and keeps its history.</p>
          <form action={perform} className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
            <input type="hidden" name="action" value="void-expense-invoice" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm">Invoice<select className={inputClass} name="invoiceId" required disabled={!nativeAp.rows.length}>{nativeAp.rows.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.supplierInvoiceRef}</option>)}</select></label>
            <label className="text-sm">Reason<Input name="reason" className="mt-1 min-h-11" required /></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="confirmed" value="yes" required />I confirm this invoice should be voided.</label>
            <Button type="submit" variant="destructive" className="min-h-11" disabled={!nativeAp.rows.length}>Void selected invoice</Button>
          </form>
        </details>
        </> : null}
        <details className="mt-5 border-t border-border-subtle pt-4">
          <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">Reverse an invoice payment</summary>
          {expenseSettlements ? <>
            <p className="mt-3 text-sm text-text-muted">Posted native payments include payments on fully paid invoices. Reversing a payment restores the payable and preserves the original entry.</p>
            <form action={perform} className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
              <input type="hidden" name="action" value="reverse-expense-settlement" />
              <input type="hidden" name="branchId" value={branch.id} />
              <label className="text-sm">Payment<select className={inputClass} name="settlementId" required disabled={!expenseSettlements.rows.length}>{expenseSettlements.rows.map(payment => <option key={payment.id} value={payment.id}>{payment.invoice.supplierInvoiceRef} · {payment.reference} · {money(payment.amountMinor)}</option>)}</select></label>
              <label className="text-sm">Reason<Input name="reason" className="mt-1 min-h-11" required /></label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="confirmed" value="yes" required />I confirm this payment should be reversed.</label>
              <Button type="submit" variant="destructive" className="min-h-11" disabled={!expenseSettlements.rows.length}>Reverse selected payment</Button>
            </form>
            {!expenseSettlements.rows.length ? <p className="mt-3 text-sm text-text-muted">No posted native payments on this page.</p> : null}
            <nav aria-label="Invoice payment pages" className="mt-4 flex flex-wrap gap-4 text-sm">
              {apPaymentOffset > 0 ? <a className="underline focus-visible:ring-2 focus-visible:ring-ring" href={apPageLink('apPaymentOffset', Math.max(0, apPaymentOffset - 50))}>Previous payments</a> : null}
              {expenseSettlements.hasMore ? <a className="underline focus-visible:ring-2 focus-visible:ring-ring" href={apPageLink('apPaymentOffset', apPaymentOffset + 50)}>Next payments</a> : null}
            </nav>
          </> : <p role="alert" className="mt-3 text-sm text-text-muted">Invoice payments could not load. Refresh the page to try again.</p>}
        </details>
      </SectionCard>
      <ManualPaymentSettingsPanel key={branch.id} branchId={branch.id} />
      <SectionCard title="Create POS settlement batch" eyebrow="Card · Raast · wallet · bank transfer">
        {workspace.settlementCandidates.length ? (
          <form action={perform} className="grid gap-4 md:grid-cols-3">
            <input type="hidden" name="action" value="settlement-batch" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm text-text-body">
              Batch reference
              <Input
                className="mt-1 min-h-11"
                name="reference"
                required
                placeholder="SET-2026-001"
              />
            </label>
            <label className="text-sm text-text-body">
              Provider
              <Input
                className="mt-1 min-h-11"
                name="provider"
                required
                placeholder="Bank or wallet provider"
              />
            </label>
            <label className="text-sm text-text-body">
              Business date
              <Input
                className="mt-1 min-h-11"
                name="businessDate"
                type="date"
                required
                defaultValue={today}
              />
            </label>
            <label className="text-sm text-text-body">
              Tender type
              <select className={inputClass} name="tenderType">
                <option value="CARD">Card</option>
                <option value="WALLET">Wallet</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="RAAST">Raast</option>
                <option value="JAZZCASH">JazzCash</option>
                <option value="EASYPAISA">Easypaisa</option>
              </select>
            </label>
            <fieldset className="space-y-2 md:col-span-2">
              <legend className="text-sm text-text-body">Unsettled POS tenders</legend>
              {workspace.settlementCandidates.map((tender) => (
                <label
                  className="flex min-h-11 items-center gap-3 rounded-[var(--radius-sm)] border border-border-subtle px-3 text-sm"
                  key={tender.id}
                >
                  <input name="tenderIds" type="checkbox" value={tender.id} />
                  <span>
                    Receipt {tender.sale.receiptNumber ?? 'pending'} · {label(tender.type)} ·{' '}
                    {tender.provider ?? 'Direct'} · {money(tender.amountMinor)}
                    {tender.payerName ? ` · ${tender.payerName}` : ''}
                    {tender.providerRef ? ` · Ref ${tender.providerRef}` : tender.referenceSkipped ? ' · Reference skipped' : ''}
                  </span>
                </label>
              ))}
            </fieldset>
            <Button className="md:col-span-3" type="submit">
              Create settlement batch
            </Button>
          </form>
        ) : (
          <p className="text-sm text-text-muted">
            No unsettled electronic POS tenders. Card, wallet, or bank-transfer sales appear here
            automatically.
          </p>
        )}
        {workspace.settlementBatches.length ? (
          <div className="mt-5 space-y-2">
            {workspace.settlementBatches.map((batch) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={batch.id}
              >
                <span className="text-sm text-text-strong">
                  {batch.reference} · {batch.provider} · {batch.tenders.length} tenders
                </span>
                <span className="tabular-nums text-sm text-text-muted">
                  {money(batch.expectedMinor)}
                  {' '}· Matched {money(batch.settledMinor ?? 0)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </SectionCard>
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Record money movement" eyebrow="FIN-02">
          <form action={perform} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="action" value="post" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm text-text-body">
              Workflow
              <select className={inputClass} name="transactionKind" required>
                {[
                  'SUPPLIER_PAYMENT',
                  'CUSTOMER_RECEIPT',
                  'EXPENSE',
                  'PETTY_CASH',
                  'BANK_DEPOSIT',
                  'SETTLEMENT',
                  'VOUCHER',
                  'CHEQUE',
                ].map((kind) => (
                  <option key={kind} value={kind}>
                    {label(kind)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              Reference
              <Input
                className="mt-1 min-h-11"
                name="reference"
                required
                placeholder="PV-2026-001"
              />
            </label>
            <label className="text-sm text-text-body">
              Amount (PKR)
              <Input
                className="mt-1 min-h-11"
                name="amount"
                required
                type="number"
                min="0.01"
                step="0.01"
              />
            </label>
            <label className="text-sm text-text-body">
              Posting date
              <Input
                className="mt-1 min-h-11"
                name="occurredAt"
                required
                type="date"
                defaultValue={today}
              />
            </label>
            <label className="text-sm text-text-body">
              Counterparty name
              <Input
                className="mt-1 min-h-11"
                name="counterpartyName"
                placeholder="Supplier or customer"
              />
            </label>
            <label className="text-sm text-text-body">
              Pay from / receive into
              <select className={inputClass} name="fundingAccount">
                <option value="BANK">Bank</option>
                <option value="CASH">Cash / petty cash</option>
              </select>
            </label>
            <label className="text-sm text-text-body">
              Bank reference
              <Input className="mt-1 min-h-11" name="bankReference" />
            </label>
            <label className="text-sm text-text-body">
              Cheque number (cheque only)
              <Input className="mt-1 min-h-11" name="chequeNumber" />
            </label>
            <label className="text-sm text-text-body">
              Cheque due date
              <Input className="mt-1 min-h-11" name="chequeDueAt" type="date" />
            </label>
            <label className="text-sm text-text-body sm:col-span-2">
              Memo
              <Input className="mt-1 min-h-11" name="memo" />
            </label>
            <Button className="sm:col-span-2" type="submit">
              Post transaction
            </Button>
          </form>
        </SectionCard>
        <SectionCard title="Close accounting period" eyebrow="Controlled close">
          <form action={perform} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="action" value="close" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm text-text-body">
              Period starts
              <Input className="mt-1 min-h-11" type="date" name="startsAt" required />
            </label>
            <label className="text-sm text-text-body">
              Period ends (exclusive)
              <Input className="mt-1 min-h-11" type="date" name="endsAt" required />
            </label>
            <Button className="sm:col-span-2" type="submit" variant="destructive">
              Close period
            </Button>
          </form>
          <div className="mt-5 space-y-3">
            {workspace.periods.length ? (
              workspace.periods.map((period) => (
                <div
                  key={period.id}
                  className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-text-strong">
                      {dated(period.startsAt)} – {dated(period.endsAt)}
                    </span>
                    <StatusPill
                      status={label(period.status)}
                      tone={period.status === 'CLOSED' ? 'warning' : 'success'}
                    />
                  </div>
                  {period.status === 'CLOSED' ? (
                    <form action={perform} className="mt-3 flex flex-wrap gap-2">
                      <input type="hidden" name="action" value="reopen" />
                      <input type="hidden" name="branchId" value={branch.id} />
                      <input type="hidden" name="periodId" value={period.id} />
                      <Input
                        className="min-h-11 flex-1"
                        name="reason"
                        required
                        placeholder="Reason for controlled reopen"
                      />
                      <Button type="submit" variant="secondary">
                        Reopen
                      </Button>
                    </form>
                  ) : (
                    <p className="mt-2 text-xs text-text-muted">Reopened: {period.reopenReason}</p>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm text-text-muted">
                No closed periods yet. Close a completed date range to prevent back-posting.
              </p>
            )}
          </div>
        </SectionCard>
      </div>
      <SectionCard title="Recent transactions" eyebrow="Balanced shared journal">
        <div className="overflow-x-auto">
          {workspace.transactions.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Counterparty</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.transactions.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.reference}</TableCell>
                    <TableCell>{label(item.kind)}</TableCell>
                    <TableCell>{item.counterpartyName ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.amountMinor)}
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        status={label(item.status)}
                        tone={
                          item.status === 'POSTED'
                            ? 'success'
                            : item.status === 'REVERSED'
                              ? 'danger'
                              : 'warning'
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {item.status === 'POSTED' ? (
                        <form action={perform} className="flex min-w-72 gap-2">
                          <input type="hidden" name="action" value="reverse" />
                          <input type="hidden" name="branchId" value={branch.id} />
                          <input type="hidden" name="transactionId" value={item.id} />
                          <Input
                            className="min-h-11"
                            name="reason"
                            required
                            placeholder="Reversal reason"
                          />
                          <Button type="submit" variant="destructive">
                            Reverse
                          </Button>
                        </form>
                      ) : (
                        'Audit retained'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-5 text-sm text-text-muted">
              No transactions yet. Use “Record money movement” to post the first balanced entry.
            </p>
          )}
        </div>
      </SectionCard>
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Bank reconciliation" eyebrow="Statement matching">
          {workspace.bankLines.some((line) => line.status === 'UNMATCHED') && workspace.settlementBatches.some((batch) => (batch.settledMinor ?? 0) < batch.expectedMinor) ? (
            <form action={perform} className="mb-5 grid gap-3">
              <input type="hidden" name="action" value="reconcile-settlement" />
              <input type="hidden" name="branchId" value={branch.id} />
              <label className="text-sm">Bank or wallet statement line
                <select className={inputClass} name="statementLineId" required>
                  {workspace.bankLines.filter((line) => line.status === 'UNMATCHED' && line.amountMinor > 0).map((line) => (
                    <option key={line.id} value={line.id}>{line.lineReference} · {money(line.amountMinor)}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">POS settlement batch
                <select className={inputClass} name="settlementBatchId" required>
                  {workspace.settlementBatches.filter((batch) => (batch.settledMinor ?? 0) < batch.expectedMinor).map((batch) => (
                    <option key={batch.id} value={batch.id}>{batch.reference} · {label(batch.tenderType)} · Expected {money(batch.expectedMinor)} · Remaining {money(batch.expectedMinor - (batch.settledMinor ?? 0))}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">Amount to match (PKR)
                <Input className="mt-1 min-h-11" name="amount" type="number" min="0.01" step="0.01" required />
              </label>
              <Button type="submit">Match POS settlement to statement</Button>
            </form>
          ) : null}
          <form action={perform} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="action" value="bank-line" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm">
              Statement reference
              <Input className="mt-1 min-h-11" name="statementRef" required />
            </label>
            <label className="text-sm">
              Line reference
              <Input className="mt-1 min-h-11" name="lineReference" required />
            </label>
            <label className="text-sm">
              Booked date
              <Input className="mt-1 min-h-11" name="bookedAt" type="date" required />
            </label>
            <label className="text-sm">
              Amount (PKR)
              <Input className="mt-1 min-h-11" name="amount" type="number" step="0.01" required />
            </label>
            <label className="text-sm sm:col-span-2">
              Bank description
              <Input className="mt-1 min-h-11" name="description" required />
            </label>
            <Button type="submit" variant="secondary" className="sm:col-span-2">
              Add statement line
            </Button>
          </form>
          {workspace.bankLines.length &&
          workspace.transactions.filter((t) => t.status === 'POSTED').length ? (
            <form action={perform} className="mt-5 grid gap-3">
              <input type="hidden" name="action" value="reconcile" />
              <input type="hidden" name="branchId" value={branch.id} />
              <label className="text-sm">
                Unmatched bank line
                <select className={inputClass} name="statementLineId">
                  {workspace.bankLines
                    .filter((line) => line.status === 'UNMATCHED')
                    .map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.lineReference} · {money(Math.abs(line.amountMinor))}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-sm">
                Posted transaction
                <select className={inputClass} name="transactionId">
                  {workspace.transactions
                    .filter((t) => t.status === 'POSTED')
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.reference} · {money(t.amountMinor)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-sm">
                Amount to match
                <Input
                  className="mt-1 min-h-11"
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
              <Button type="submit">Match selected records</Button>
            </form>
          ) : (
            <p className="mt-5 text-sm text-text-muted">
              Add a statement line and post a transaction before matching.
            </p>
          )}
        </SectionCard>
        <SectionCard title="Publish tax profile" eyebrow="FIN-04 · Accountant approval">
          <a
            href={`/pharmacy/accounts/tax-profile-review?${new URLSearchParams({ branch: branch.id })}`}
            className="mb-5 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Review recorded tax profile versions
          </a>
          <form action={perform} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="action" value="tax" />
            <input type="hidden" name="branchId" value={branch.id} />
            <label className="text-sm">
              Profile name
              <Input className="mt-1 min-h-11" name="profileName" required />
            </label>
            <label className="text-sm">
              Accountant approval reference
              <Input className="mt-1 min-h-11" name="approvalReference" required />
            </label>
            <label className="text-sm">
              Effective from
              <Input className="mt-1 min-h-11" name="effectiveFrom" type="date" required />
            </label>
            <label className="text-sm">
              Effective to (optional)
              <Input className="mt-1 min-h-11" name="effectiveTo" type="date" />
            </label>
            <label className="text-sm">
              Medicine PCT / HS code
              <Input className="mt-1 min-h-11" name="medicineHs" required />
            </label>
            <label className="text-sm">
              Front-shop PCT / HS code
              <Input className="mt-1 min-h-11" name="frontShopHs" required />
            </label>
            <label className="text-sm">
              Rate (0–1)
              <Input className="mt-1 min-h-11" name="rate" required placeholder="0.18" />
            </label>
            <label className="text-sm">
              Price mode
              <select className={inputClass} name="priceMode">
                <option value="INCLUSIVE">Tax inclusive</option>
                <option value="EXCLUSIVE">Tax exclusive</option>
              </select>
            </label>
            <label className="text-sm sm:col-span-2">
              SRO reference (always provisional)
              <Input className="mt-1 min-h-11" name="sroReference" />
              <span className="mt-1 block text-xs text-text-muted">
                Verify against the final gazette before operational use.
              </span>
            </label>
            <Button type="submit" className="sm:col-span-2">
              Publish approved version
            </Button>
          </form>
          <div className="mt-5 space-y-2">
            {workspace.taxProfiles.length ? (
              workspace.taxProfiles.map((profile) => (
                <div
                  key={profile.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border-subtle p-3"
                >
                  <span className="text-sm text-text-strong">
                    v{profile.versionNumber} · {profile.name} · {dated(profile.effectiveFrom)}
                  </span>
                  <StatusPill
                    status={label(profile.status)}
                    tone={profile.status === 'PUBLISHED' ? 'success' : 'neutral'}
                  />
                </div>
              ))
            ) : (
              <p className="text-sm text-text-muted">
                No tax profile is active. Publish an accountant-approved, effective-dated version
                before taxable sales.
              </p>
            )}
          </div>
        </SectionCard>
      </div>
    </main>
  );
}
