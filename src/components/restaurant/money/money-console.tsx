'use client';

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type BillPage = RouterOutputs['restaurantBills']['listBills'];
type BillDetail = NonNullable<RouterOutputs['restaurantBills']['getBill']>;
type TenderPage = RouterOutputs['restaurantPayments']['listTenders'];
type RefundPage = RouterOutputs['restaurantPayments']['listRefunds'];
type TenderTotals = RouterOutputs['restaurantPayments']['getTenderTypeTotals'];
type PaymentDetail = RouterOutputs['restaurantPayments']['getPayment'];
type DrawerPage = RouterOutputs['restaurantCash']['listDrawerSessions'];
type DrawerDetail = RouterOutputs['restaurantCash']['getDrawerSession'];
type ClosePage = RouterOutputs['restaurantCash']['listDailyCloses'];
type CloseDetail = RouterOutputs['restaurantCash']['getDailyClose'];
type MoneyTab = 'bills' | 'payments' | 'drawers' | 'daily-close';
type UiError = { message: string; data?: { code?: string } | null };
type ReadQuery<T> = {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
};
type CursorHistory = Array<string | undefined>;
type CursorPagination = {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const instantFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function Field({
  label,
  children,
  description,
}: {
  label: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {description ? <span className="block text-xs text-text-muted">{description}</span> : null}
    </label>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function ErrorState({
  error,
  retry,
  subject,
}: {
  error: unknown;
  retry: () => void;
  subject: string;
}) {
  const value = error as UiError | null;
  const denied = value?.data?.code === 'FORBIDDEN' || value?.data?.code === 'UNAUTHORIZED';
  return (
    <div className="space-y-3 rounded-md border border-border-default p-5" role="alert">
      <StatusPill status={denied ? 'Permission denied' : 'Read failed'} tone="danger" />
      <div>
        <p className="font-medium text-text-strong">
          {denied ? 'Money access denied' : 'Could not load ' + subject}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {denied
            ? 'Your role does not include money:read for this restaurant.'
            : value?.message || 'The read failed without changing any ledger data.'}
        </p>
      </div>
      {!denied ? (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={labelClass}>{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-strong">{value ?? '—'}</dd>
    </div>
  );
}

function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_[data-slot=table-container]]:overflow-visible"
    >
      {children}
    </div>
  );
}

function CursorControls({
  label,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: CursorPagination & { label: string }) {
  return (
    <nav aria-label={label + ' pagination'} className="mt-4 flex justify-end gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={'Previous ' + label + ' page'}
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        Previous
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={'Next ' + label + ' page'}
        disabled={!hasNext}
        onClick={onNext}
      >
        Next
      </Button>
    </nav>
  );
}

function advanceCursor(
  nextCursor: string | null | undefined,
  cursor: string | undefined,
  setCursor: Dispatch<SetStateAction<string | undefined>>,
  setHistory: Dispatch<SetStateAction<CursorHistory>>,
  clearSelection: () => void
) {
  if (!nextCursor) return;
  setHistory((history) => [...history, cursor]);
  setCursor(nextCursor);
  clearSelection();
}

function retreatCursor(
  history: CursorHistory,
  setCursor: Dispatch<SetStateAction<string | undefined>>,
  setHistory: Dispatch<SetStateAction<CursorHistory>>,
  clearSelection: () => void
) {
  if (history.length === 0) return;
  setCursor(history.at(-1));
  setHistory((values) => values.slice(0, -1));
  clearSelection();
}

function tone(status: string): StatusTone {
  if (['SETTLED', 'CAPTURED', 'CLOSED', 'APPROVED', 'COMPLETED'].includes(status)) return 'success';
  if (['OPEN', 'AUTHORIZED', 'PENDING', 'PARTIALLY_REFUNDED'].includes(status)) return 'info';
  if (['VOID', 'VOIDED', 'DECLINED', 'FAILED', 'REFUNDED'].includes(status)) return 'danger';
  if (status === 'CORRECTION' || status === 'TIP') return 'warning';
  return 'neutral';
}

function label(value: string | null | undefined) {
  return value ? value.replaceAll('_', ' ') : '—';
}

function instant(value: Date | string | null | undefined) {
  return value ? instantFormat.format(new Date(value)) : '—';
}

export function MoneyConsole() {
  const entitlements = useEntitlements();
  const posModule = entitlements.modules.find((module) => module.key === 'restaurant-pos');
  const posEnabled = posModule?.enabled ?? entitlements.enabledModules.includes('restaurant-pos');
  const [branchId, setBranchId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [tab, setTab] = useState<MoneyTab>('bills');
  const [selectedBillId, setSelectedBillId] = useState('');
  const [selectedPaymentId, setSelectedPaymentId] = useState('');
  const [selectedDrawerId, setSelectedDrawerId] = useState('');
  const [selectedCloseId, setSelectedCloseId] = useState('');
  const [billCursor, setBillCursor] = useState<string>();
  const [billHistory, setBillHistory] = useState<CursorHistory>([]);
  const [tenderCursor, setTenderCursor] = useState<string>();
  const [tenderHistory, setTenderHistory] = useState<CursorHistory>([]);
  const [refundCursor, setRefundCursor] = useState<string>();
  const [refundHistory, setRefundHistory] = useState<CursorHistory>([]);
  const [drawerCursor, setDrawerCursor] = useState<string>();
  const [drawerHistory, setDrawerHistory] = useState<CursorHistory>([]);

  const normalizedBranchId = branchId.trim();
  const branchEnabled = posEnabled && normalizedBranchId.length > 0;
  const billsEnabled = branchEnabled && tab === 'bills';
  const paymentsEnabled = branchEnabled && tab === 'payments';
  const drawersEnabled = branchEnabled && tab === 'drawers';
  const closesEnabled = branchEnabled && tab === 'daily-close';
  const listInput = {
    branchId: normalizedBranchId,
    ...(businessDate ? { businessDate } : {}),
    limit: 100,
  };

  const billsQuery = trpc.restaurantBills.listBills.useQuery(
    { ...listInput, ...(billCursor ? { cursor: billCursor } : {}) },
    {
      enabled: billsEnabled,
    }
  );
  const billQuery = trpc.restaurantBills.getBill.useQuery(
    { billId: selectedBillId },
    { enabled: billsEnabled && selectedBillId.length > 0 }
  );
  const tendersQuery = trpc.restaurantPayments.listTenders.useQuery(
    { ...listInput, ...(tenderCursor ? { cursor: tenderCursor } : {}) },
    {
      enabled: paymentsEnabled,
    }
  );
  const refundsQuery = trpc.restaurantPayments.listRefunds.useQuery(
    { ...listInput, ...(refundCursor ? { cursor: refundCursor } : {}) },
    {
      enabled: paymentsEnabled,
    }
  );
  const tenderTotalsQuery = trpc.restaurantPayments.getTenderTypeTotals.useQuery(
    {
      branchId: normalizedBranchId,
      businessDate: businessDate || '1970-01-01',
    },
    { enabled: paymentsEnabled && businessDate.length > 0 }
  );
  const paymentQuery = trpc.restaurantPayments.getPayment.useQuery(
    { paymentId: selectedPaymentId },
    { enabled: paymentsEnabled && selectedPaymentId.length > 0 }
  );
  const drawersQuery = trpc.restaurantCash.listDrawerSessions.useQuery(
    { ...listInput, ...(drawerCursor ? { cursor: drawerCursor } : {}) },
    {
      enabled: drawersEnabled,
    }
  );
  const drawerQuery = trpc.restaurantCash.getDrawerSession.useQuery(
    { drawerSessionId: selectedDrawerId },
    { enabled: drawersEnabled && selectedDrawerId.length > 0 }
  );
  const closesQuery = trpc.restaurantCash.listDailyCloses.useQuery(
    {
      branchId: normalizedBranchId,
      ...(businessDate ? { from: businessDate, to: businessDate } : {}),
    },
    { enabled: closesEnabled }
  );
  const closeQuery = trpc.restaurantCash.getDailyClose.useQuery(
    { dailyCloseId: selectedCloseId },
    { enabled: closesEnabled && selectedCloseId.length > 0 }
  );

  const resetSelections = () => {
    setSelectedBillId('');
    setSelectedPaymentId('');
    setSelectedDrawerId('');
    setSelectedCloseId('');
  };
  const resetCursors = () => {
    setBillCursor(undefined);
    setBillHistory([]);
    setTenderCursor(undefined);
    setTenderHistory([]);
    setRefundCursor(undefined);
    setRefundHistory([]);
    setDrawerCursor(undefined);
    setDrawerHistory([]);
  };
  const updateBranch = (value: string) => {
    setBranchId(value);
    resetSelections();
    resetCursors();
  };
  const updateBusinessDate = (value: string) => {
    setBusinessDate(value);
    resetSelections();
    resetCursors();
  };
  const updateTab = (value: string) => {
    setTab(value as MoneyTab);
    resetSelections();
    resetCursors();
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Money"
        description="Review immutable bills, payment events, drawer movements, and daily-close corrections."
      />

      <SectionCard eyebrow="Money ledger" title="Filters">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Branch ID" description="Required before any money read runs.">
            <Input
              aria-label="Branch ID"
              value={branchId}
              onChange={(event) => updateBranch(event.target.value)}
              placeholder="branch_…"
              className="h-11"
              disabled={!posEnabled}
            />
          </Field>
          <Field label="Business date" description="Optional except for exact tender totals.">
            <Input
              aria-label="Business date"
              type="date"
              value={businessDate}
              onChange={(event) => updateBusinessDate(event.target.value)}
              className="h-11"
              disabled={!posEnabled}
            />
          </Field>
        </div>
      </SectionCard>

      {!posEnabled ? (
        <SectionCard title="Restaurant POS module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm text-text-muted">
              Money ledgers require the Restaurant POS entitlement. Filters and reads remain
              disabled.
            </p>
          </div>
        </SectionCard>
      ) : (
        <Tabs value={tab} onValueChange={updateTab}>
          <TabsList aria-label="Money ledgers">
            <TabsTrigger value="bills">Bills</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="drawers">Drawers</TabsTrigger>
            <TabsTrigger value="daily-close">Daily close</TabsTrigger>
          </TabsList>

          {!branchEnabled ? (
            <SectionCard title="Branch required">
              <div className="space-y-3" role="status">
                <StatusPill status="Reads disabled" tone="neutral" />
                <p className="text-sm text-text-muted">
                  Enter a branch ID to load the selected read-only ledger.
                </p>
              </div>
            </SectionCard>
          ) : null}

          <TabsContent value="bills">
            {branchEnabled ? (
              <BillsLedger
                query={billsQuery}
                detailQuery={billQuery}
                selectedId={selectedBillId}
                onSelect={setSelectedBillId}
                pagination={{
                  hasPrevious: billHistory.length > 0,
                  hasNext: Boolean(billsQuery.data?.nextCursor),
                  onPrevious: () =>
                    retreatCursor(billHistory, setBillCursor, setBillHistory, () =>
                      setSelectedBillId('')
                    ),
                  onNext: () =>
                    advanceCursor(
                      billsQuery.data?.nextCursor,
                      billCursor,
                      setBillCursor,
                      setBillHistory,
                      () => setSelectedBillId('')
                    ),
                }}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="payments">
            {branchEnabled ? (
              <PaymentsLedger
                businessDate={businessDate}
                tendersQuery={tendersQuery}
                refundsQuery={refundsQuery}
                totalsQuery={tenderTotalsQuery}
                detailQuery={paymentQuery}
                selectedId={selectedPaymentId}
                onSelect={setSelectedPaymentId}
                tenderPagination={{
                  hasPrevious: tenderHistory.length > 0,
                  hasNext: Boolean(tendersQuery.data?.nextCursor),
                  onPrevious: () =>
                    retreatCursor(tenderHistory, setTenderCursor, setTenderHistory, () =>
                      setSelectedPaymentId('')
                    ),
                  onNext: () =>
                    advanceCursor(
                      tendersQuery.data?.nextCursor,
                      tenderCursor,
                      setTenderCursor,
                      setTenderHistory,
                      () => setSelectedPaymentId('')
                    ),
                }}
                refundPagination={{
                  hasPrevious: refundHistory.length > 0,
                  hasNext: Boolean(refundsQuery.data?.nextCursor),
                  onPrevious: () =>
                    retreatCursor(refundHistory, setRefundCursor, setRefundHistory, () =>
                      setSelectedPaymentId('')
                    ),
                  onNext: () =>
                    advanceCursor(
                      refundsQuery.data?.nextCursor,
                      refundCursor,
                      setRefundCursor,
                      setRefundHistory,
                      () => setSelectedPaymentId('')
                    ),
                }}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="drawers">
            {branchEnabled ? (
              <DrawersLedger
                query={drawersQuery}
                detailQuery={drawerQuery}
                selectedId={selectedDrawerId}
                onSelect={setSelectedDrawerId}
                pagination={{
                  hasPrevious: drawerHistory.length > 0,
                  hasNext: Boolean(drawersQuery.data?.nextCursor),
                  onPrevious: () =>
                    retreatCursor(drawerHistory, setDrawerCursor, setDrawerHistory, () =>
                      setSelectedDrawerId('')
                    ),
                  onNext: () =>
                    advanceCursor(
                      drawersQuery.data?.nextCursor,
                      drawerCursor,
                      setDrawerCursor,
                      setDrawerHistory,
                      () => setSelectedDrawerId('')
                    ),
                }}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="daily-close">
            {branchEnabled ? (
              <DailyCloseLedger
                query={closesQuery}
                detailQuery={closeQuery}
                selectedId={selectedCloseId}
                onSelect={setSelectedCloseId}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function BillsLedger({
  query,
  detailQuery,
  selectedId,
  onSelect,
  pagination,
}: {
  query: ReadQuery<BillPage>;
  detailQuery: ReadQuery<BillDetail | null>;
  selectedId: string;
  onSelect: (id: string) => void;
  pagination: CursorPagination;
}) {
  const bills = query.data?.bills ?? [];
  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Bill register" title="Bills">
        {query.isLoading ? (
          <LoadingState label="Loading bills" />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} subject="bills" />
        ) : (
          <>
            {bills.length === 0 ? (
              <EmptyState title="No bills found" detail="Choose another branch or business date." />
            ) : (
              <>
                <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Loaded bills" value={bills.length} />
                  <Stat label="Date filter" value={bills[0]?.businessDate ?? 'All dates'} />
                  <Stat label="First receipt" value={bills[0]?.receiptNumber ?? 'Unissued'} />
                  <Stat
                    label="Next page"
                    value={query.data?.nextCursor ? 'Available' : 'Complete'}
                  />
                </div>
                <TableFrame label="Bills table">
                  <Table className="min-w-[1180px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Bill</TableHead>
                        <TableHead>Receipt</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Split</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead numeric>Subtotal</TableHead>
                        <TableHead numeric>Tax</TableHead>
                        <TableHead numeric>Service</TableHead>
                        <TableHead numeric>Comp</TableHead>
                        <TableHead numeric>Total</TableHead>
                        <TableHead className="text-right">Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bills.map((bill) => (
                        <TableRow
                          key={bill.id}
                          data-state={selectedId === bill.id ? 'selected' : undefined}
                        >
                          <TableCell>
                            <span className="block font-medium text-text-strong">{bill.id}</span>
                            <span className="block font-mono text-[0.625rem] text-text-faint">
                              Order {bill.orderId}
                            </span>
                          </TableCell>
                          <TableCell>{bill.receiptNumber ?? 'Unissued'}</TableCell>
                          <TableCell>{bill.businessDate}</TableCell>
                          <TableCell>{label(bill.splitKind)}</TableCell>
                          <TableCell>
                            <StatusPill status={label(bill.status)} tone={tone(bill.status)} />
                          </TableCell>
                          <TableCell numeric>{bill.subtotal}</TableCell>
                          <TableCell numeric>{bill.taxTotal}</TableCell>
                          <TableCell numeric>{bill.serviceChargeTotal}</TableCell>
                          <TableCell numeric>{bill.compTotal}</TableCell>
                          <TableCell numeric>{bill.grandTotal}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={selectedId === bill.id ? 'secondary' : 'outline'}
                              aria-pressed={selectedId === bill.id}
                              onClick={() => onSelect(bill.id)}
                            >
                              View bill {bill.id}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableFrame>
              </>
            )}
            <CursorControls label="bills" {...pagination} />
          </>
        )}
      </SectionCard>

      {selectedId ? (
        <SectionCard eyebrow="Selected bill" title="Bill detail">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading bill detail" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="bill detail"
            />
          ) : detailQuery.data ? (
            <BillDetailPanel bill={detailQuery.data} />
          ) : (
            <EmptyState title="Bill not found" detail="Select another bill from the register." />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

function BillDetailPanel({ bill }: { bill: BillDetail }) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="Receipt" value={bill.receiptNumber ?? 'Unissued'} />
        <DetailField label="Status" value={label(bill.status)} />
        <DetailField label="Grand total" value={bill.grandTotal} />
        <DetailField label="Net collected" value={bill.netCollected} />
        <DetailField label="Tender total" value={bill.tenderSummary.amount} />
        <DetailField label="Tender tips" value={bill.tenderSummary.tipAmount} />
        <DetailField label="Refund total" value={bill.refundSummary.amount} />
        <DetailField label="Refunded tips" value={bill.refundSummary.tipRefundAmount} />
        <DetailField label="Opened by" value={bill.openerStaffProfileId} />
        <DetailField label="Device" value={bill.deviceId} />
        <DetailField label="Settled" value={instant(bill.settledAt)} />
        <DetailField label="Void reason" value={bill.voidReason} />
      </dl>

      <section aria-labelledby="bill-lines-heading">
        <h3 id="bill-lines-heading" className="mb-3 font-semibold text-text-strong">
          Lines and comps
        </h3>
        {bill.lines.length ? (
          <TableFrame label="Bill lines table">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead numeric>Qty</TableHead>
                  <TableHead numeric>Unit</TableHead>
                  <TableHead numeric>Subtotal</TableHead>
                  <TableHead numeric>Tax</TableHead>
                  <TableHead numeric>Service</TableHead>
                  <TableHead numeric>Comp</TableHead>
                  <TableHead numeric>Total</TableHead>
                  <TableHead>Comp reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bill.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <span className="block font-medium text-text-strong">{line.name}</span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {line.orderItemId}
                      </span>
                    </TableCell>
                    <TableCell numeric>{line.quantity}</TableCell>
                    <TableCell numeric>{line.unitPrice}</TableCell>
                    <TableCell numeric>{line.lineSubtotal}</TableCell>
                    <TableCell numeric>{line.taxAmount}</TableCell>
                    <TableCell numeric>{line.serviceChargeAmount}</TableCell>
                    <TableCell numeric>{line.compAmount}</TableCell>
                    <TableCell numeric>{line.lineTotal}</TableCell>
                    <TableCell>{line.compReason ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ) : (
          <EmptyState title="No bill lines" detail="This bill has no line snapshots." />
        )}
      </section>

      <BillTenderTable bill={bill} />
      <BillRefundTable bill={bill} />
    </div>
  );
}

function BillTenderTable({ bill }: { bill: BillDetail }) {
  return (
    <section aria-labelledby="bill-tenders-heading">
      <h3 id="bill-tenders-heading" className="mb-3 font-semibold text-text-strong">
        Tender summary
      </h3>
      {bill.tenders.length ? (
        <TableFrame label="Bill tender summary table">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Tender</TableHead>
                <TableHead>Type</TableHead>
                <TableHead numeric>Amount</TableHead>
                <TableHead numeric>Tip</TableHead>
                <TableHead numeric>Cash received</TableHead>
                <TableHead numeric>Change</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bill.tenders.map((tender) => (
                <TableRow key={tender.id}>
                  <TableCell className="font-mono text-xs">{tender.id}</TableCell>
                  <TableCell>{label(tender.type)}</TableCell>
                  <TableCell numeric>{tender.amount}</TableCell>
                  <TableCell numeric>{tender.tipAmount}</TableCell>
                  <TableCell numeric>{tender.cashReceived ?? '—'}</TableCell>
                  <TableCell numeric>{tender.changeGiven ?? '—'}</TableCell>
                  <TableCell>{instant(tender.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState title="No tenders" detail="No tender has been applied to this bill." />
      )}
    </section>
  );
}

function BillRefundTable({ bill }: { bill: BillDetail }) {
  return (
    <section aria-labelledby="bill-refunds-heading">
      <h3 id="bill-refunds-heading" className="mb-3 font-semibold text-text-strong">
        Refund summary
      </h3>
      {bill.refunds.length ? (
        <TableFrame label="Bill refund summary table">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Refund</TableHead>
                <TableHead>Original tender</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead numeric>Amount</TableHead>
                <TableHead numeric>Tip refund</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bill.refunds.map((refund) => (
                <TableRow key={refund.id}>
                  <TableCell className="font-mono text-xs">{refund.id}</TableCell>
                  <TableCell className="font-mono text-xs">{refund.originalTenderId}</TableCell>
                  <TableCell>{label(refund.kind)}</TableCell>
                  <TableCell numeric>{refund.amount}</TableCell>
                  <TableCell numeric>{refund.tipRefundAmount}</TableCell>
                  <TableCell>{refund.reason}</TableCell>
                  <TableCell>{refund.businessDate}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState title="No refunds" detail="No refund references this bill." />
      )}
    </section>
  );
}

function PaymentsLedger({
  businessDate,
  tendersQuery,
  refundsQuery,
  totalsQuery,
  detailQuery,
  selectedId,
  onSelect,
  tenderPagination,
  refundPagination,
}: {
  businessDate: string;
  tendersQuery: ReadQuery<TenderPage>;
  refundsQuery: ReadQuery<RefundPage>;
  totalsQuery: ReadQuery<TenderTotals>;
  detailQuery: ReadQuery<PaymentDetail>;
  selectedId: string;
  onSelect: (id: string) => void;
  tenderPagination: CursorPagination;
  refundPagination: CursorPagination;
}) {
  const error = tendersQuery.error || refundsQuery.error || totalsQuery.error;
  const loading =
    tendersQuery.isLoading ||
    refundsQuery.isLoading ||
    (businessDate ? totalsQuery.isLoading : false);
  const tenders = tendersQuery.data?.tenders ?? [];
  const refunds = refundsQuery.data?.refunds ?? [];

  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Payment register" title="Payments">
        {loading ? (
          <LoadingState label="Loading payments" />
        ) : error ? (
          <ErrorState
            error={error}
            retry={() => {
              void tendersQuery.refetch();
              void refundsQuery.refetch();
              if (businessDate) void totalsQuery.refetch();
            }}
            subject="payments"
          />
        ) : (
          <div className="space-y-6">
            {businessDate && totalsQuery.data ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {totalsQuery.data.tenderTypes.map((total) => (
                  <Stat
                    key={total.tenderType}
                    label={
                      label(total.tenderType) +
                      ' · ' +
                      total.tipAmount +
                      ' tips · ' +
                      total.count +
                      ' tenders'
                    }
                    value={total.amount}
                  />
                ))}
                <Stat
                  label={
                    'All tenders · ' +
                    totalsQuery.data.totals.tipAmount +
                    ' tips · ' +
                    totalsQuery.data.totals.count +
                    ' tenders'
                  }
                  value={totalsQuery.data.totals.amount}
                />
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border-default p-4">
                <p className="text-sm text-text-muted">
                  Select a business date to load exact server-calculated tender-type totals.
                </p>
              </div>
            )}

            <section aria-labelledby="payment-tenders-heading">
              <h3 id="payment-tenders-heading" className="mb-3 font-semibold text-text-strong">
                Tenders
              </h3>
              {tenders.length ? (
                <TableFrame label="Payment tenders table">
                  <Table className="min-w-[1120px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tender</TableHead>
                        <TableHead>Bill</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead numeric>Amount</TableHead>
                        <TableHead numeric>Tip</TableHead>
                        <TableHead>Drawer / payment</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">Event trail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tenders.map((tender) => (
                        <TableRow
                          key={tender.id}
                          data-state={selectedId === tender.paymentId ? 'selected' : undefined}
                        >
                          <TableCell className="font-mono text-xs">{tender.id}</TableCell>
                          <TableCell className="font-mono text-xs">{tender.billId}</TableCell>
                          <TableCell>
                            <StatusPill status={label(tender.type)} tone="neutral" />
                          </TableCell>
                          <TableCell numeric>{tender.amount}</TableCell>
                          <TableCell numeric>{tender.tipAmount}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {tender.paymentId ?? tender.drawerSessionId ?? '—'}
                          </TableCell>
                          <TableCell>{tender.businessDate}</TableCell>
                          <TableCell>{instant(tender.createdAt)}</TableCell>
                          <TableCell className="text-right">
                            {tender.type === 'CARD' && tender.paymentId ? (
                              <Button
                                type="button"
                                size="sm"
                                variant={selectedId === tender.paymentId ? 'secondary' : 'outline'}
                                aria-pressed={selectedId === tender.paymentId}
                                onClick={() => onSelect(tender.paymentId!)}
                              >
                                View payment {tender.paymentId}
                              </Button>
                            ) : (
                              <span className="text-xs text-text-muted">No card trail</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableFrame>
              ) : (
                <EmptyState title="No tenders found" detail="No tenders match these filters." />
              )}
              <CursorControls label="tenders" {...tenderPagination} />
            </section>

            <section aria-labelledby="payment-refunds-heading">
              <h3 id="payment-refunds-heading" className="mb-3 font-semibold text-text-strong">
                Refunds
              </h3>
              {refunds.length ? (
                <TableFrame label="Payment refunds table">
                  <Table className="min-w-[1100px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Refund</TableHead>
                        <TableHead>Bill</TableHead>
                        <TableHead>Original tender</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead numeric>Amount</TableHead>
                        <TableHead numeric>Tip refund</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {refunds.map((refund) => (
                        <TableRow key={refund.id}>
                          <TableCell className="font-mono text-xs">{refund.id}</TableCell>
                          <TableCell className="font-mono text-xs">{refund.billId}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {refund.originalTenderId}
                          </TableCell>
                          <TableCell>{label(refund.kind)}</TableCell>
                          <TableCell numeric>{refund.amount}</TableCell>
                          <TableCell numeric>{refund.tipRefundAmount}</TableCell>
                          <TableCell>{refund.reason}</TableCell>
                          <TableCell>{refund.businessDate}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableFrame>
              ) : (
                <EmptyState title="No refunds found" detail="No refunds match these filters." />
              )}
              <CursorControls label="refunds" {...refundPagination} />
            </section>
          </div>
        )}
      </SectionCard>

      {selectedId ? (
        <SectionCard eyebrow="Selected card payment" title="Payment event trail">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading payment event trail" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="payment event trail"
            />
          ) : detailQuery.data ? (
            <PaymentDetailPanel payment={detailQuery.data} />
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

function PaymentDetailPanel({ payment }: { payment: PaymentDetail }) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="Payment" value={payment.id} />
        <DetailField label="Bill" value={payment.billId} />
        <DetailField label="Provider" value={payment.provider} />
        <DetailField label="Provider reference" value={payment.providerRef} />
        <DetailField label="Capability" value={label(payment.capability)} />
        <DetailField label="Status" value={label(payment.status)} />
        <DetailField label="Amount" value={payment.amount} />
        <DetailField label="Tip" value={payment.tipAmount} />
      </dl>
      {payment.events.length ? (
        <TableFrame label="Payment event trail table">
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Type</TableHead>
                <TableHead numeric>Amount</TableHead>
                <TableHead>Provider reference</TableHead>
                <TableHead>Payload</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payment.events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-mono text-xs">{event.id}</TableCell>
                  <TableCell>{label(event.capability)}</TableCell>
                  <TableCell>
                    <StatusPill status={label(event.eventType)} tone={tone(event.eventType)} />
                  </TableCell>
                  <TableCell numeric>{event.amount ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{event.providerRef ?? '—'}</TableCell>
                  <TableCell>
                    <code className="block max-w-sm whitespace-pre-wrap break-all text-xs text-text-muted">
                      {JSON.stringify(event.payload)}
                    </code>
                  </TableCell>
                  <TableCell>{instant(event.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState title="No payment events" detail="This payment has no event trail." />
      )}
    </div>
  );
}

function DrawersLedger({
  query,
  detailQuery,
  selectedId,
  onSelect,
  pagination,
}: {
  query: ReadQuery<DrawerPage>;
  detailQuery: ReadQuery<DrawerDetail>;
  selectedId: string;
  onSelect: (id: string) => void;
  pagination: CursorPagination;
}) {
  const sessions = query.data?.sessions ?? [];
  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Cash register" title="Drawer sessions">
        {query.isLoading ? (
          <LoadingState label="Loading drawer sessions" />
        ) : query.error ? (
          <ErrorState
            error={query.error}
            retry={() => void query.refetch()}
            subject="drawer sessions"
          />
        ) : (
          <>
            {sessions.length === 0 ? (
              <EmptyState
                title="No drawer sessions found"
                detail="No sessions match these filters."
              />
            ) : (
              <TableFrame label="Drawer sessions table">
                <Table className="min-w-[1120px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Device</TableHead>
                      <TableHead>Operator</TableHead>
                      <TableHead numeric>Opening</TableHead>
                      <TableHead numeric>Expected</TableHead>
                      <TableHead numeric>Counted</TableHead>
                      <TableHead numeric>Variance</TableHead>
                      <TableHead numeric>Movements</TableHead>
                      <TableHead className="text-right">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((session) => (
                      <TableRow
                        key={session.id}
                        data-state={selectedId === session.id ? 'selected' : undefined}
                      >
                        <TableCell className="font-mono text-xs">{session.id}</TableCell>
                        <TableCell>
                          <StatusPill status={label(session.status)} tone={tone(session.status)} />
                        </TableCell>
                        <TableCell>{session.businessDate}</TableCell>
                        <TableCell className="font-mono text-xs">{session.deviceId}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {session.staffProfileId}
                        </TableCell>
                        <TableCell numeric>{session.openingFloat}</TableCell>
                        <TableCell numeric>{session.expectedCash ?? '—'}</TableCell>
                        <TableCell numeric>{session.countedCash ?? '—'}</TableCell>
                        <TableCell numeric>{session.variance ?? '—'}</TableCell>
                        <TableCell numeric>{session.movementCount}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant={selectedId === session.id ? 'secondary' : 'outline'}
                            aria-pressed={selectedId === session.id}
                            onClick={() => onSelect(session.id)}
                          >
                            View drawer {session.id}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
            <CursorControls label="drawers" {...pagination} />
          </>
        )}
      </SectionCard>

      {selectedId ? (
        <SectionCard eyebrow="Selected drawer" title="Movement ledger">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading drawer movement ledger" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="drawer detail"
            />
          ) : detailQuery.data ? (
            <DrawerDetailPanel drawer={detailQuery.data} />
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

function DrawerDetailPanel({ drawer }: { drawer: DrawerDetail }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Opening float" value={drawer.openingFloat} />
        <Stat label="Expected cash" value={drawer.expectedCash} />
        <Stat label="Counted cash" value={drawer.countedCash ?? '—'} />
        <Stat label="Variance" value={drawer.variance ?? '—'} />
      </div>
      {drawer.movements.length ? (
        <TableFrame label="Drawer movement ledger table">
          <Table className="min-w-[1020px]">
            <TableHeader>
              <TableRow>
                <TableHead>Movement</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead numeric>Amount</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Tender</TableHead>
                <TableHead>Refund</TableHead>
                <TableHead>Staff / device</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drawer.movements.map((movement) => (
                <TableRow key={movement.id}>
                  <TableCell className="font-mono text-xs">{movement.id}</TableCell>
                  <TableCell>
                    <StatusPill status={label(movement.kind)} tone={tone(movement.kind)} />
                  </TableCell>
                  <TableCell numeric>{movement.amount}</TableCell>
                  <TableCell>{movement.reason ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{movement.tenderId ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{movement.refundId ?? '—'}</TableCell>
                  <TableCell>
                    <span className="block font-mono text-xs">{movement.staffProfileId}</span>
                    <span className="block font-mono text-[0.625rem] text-text-faint">
                      {movement.deviceId}
                    </span>
                  </TableCell>
                  <TableCell>{instant(movement.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState title="No movements" detail="This drawer has no movement entries." />
      )}
    </div>
  );
}

function DailyCloseLedger({
  query,
  detailQuery,
  selectedId,
  onSelect,
}: {
  query: ReadQuery<ClosePage>;
  detailQuery: ReadQuery<CloseDetail>;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const chains = query.data?.chains ?? [];
  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Close register" title="Daily close correction chains">
        {query.isLoading ? (
          <LoadingState label="Loading daily closes" />
        ) : query.error ? (
          <ErrorState
            error={query.error}
            retry={() => void query.refetch()}
            subject="daily closes"
          />
        ) : chains.length === 0 ? (
          <EmptyState
            title="No daily closes found"
            detail="No close chain matches these filters."
          />
        ) : (
          <div className="space-y-6">
            {chains.map((chain) => (
              <section key={chain.businessDate} aria-labelledby={'close-' + chain.businessDate}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 id={'close-' + chain.businessDate} className="font-semibold text-text-strong">
                    {chain.businessDate}
                  </h3>
                  <p className="font-mono text-xs text-text-muted">
                    Authoritative tip: {chain.tipCloseId ?? 'Unresolved'}
                  </p>
                </div>
                <TableFrame label={'Daily close chain table for ' + chain.businessDate}>
                  <Table className="min-w-[1040px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Close</TableHead>
                        <TableHead>Authority</TableHead>
                        <TableHead>Supersedes</TableHead>
                        <TableHead>Correction</TableHead>
                        <TableHead numeric>Gross</TableHead>
                        <TableHead numeric>Net</TableHead>
                        <TableHead numeric>Refunds</TableHead>
                        <TableHead numeric>Cash variance</TableHead>
                        <TableHead className="text-right">Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {chain.closes.map((close) => (
                        <TableRow
                          key={close.id}
                          data-state={selectedId === close.id ? 'selected' : undefined}
                        >
                          <TableCell className="font-mono text-xs">{close.id}</TableCell>
                          <TableCell>
                            <StatusPill
                              status={close.isTip ? 'Authoritative tip' : 'Superseded'}
                              tone={close.isTip ? 'success' : 'neutral'}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {close.supersedesCloseId ?? '—'}
                          </TableCell>
                          <TableCell>{close.correctionReason ?? 'Original close'}</TableCell>
                          <TableCell numeric>{close.grossSales}</TableCell>
                          <TableCell numeric>{close.netSales}</TableCell>
                          <TableCell numeric>{close.refundTotal}</TableCell>
                          <TableCell numeric>{close.cashVariance}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={selectedId === close.id ? 'secondary' : 'outline'}
                              aria-pressed={selectedId === close.id}
                              onClick={() => onSelect(close.id)}
                            >
                              View close {close.id}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableFrame>
              </section>
            ))}
          </div>
        )}
      </SectionCard>

      {selectedId ? (
        <SectionCard eyebrow="Selected close" title="Daily close detail">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading daily close detail" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="daily close detail"
            />
          ) : detailQuery.data ? (
            <DailyCloseDetailPanel detail={detailQuery.data} />
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

function DailyCloseDetailPanel({ detail }: { detail: CloseDetail }) {
  const totals = detail.close.totals;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill
          status={detail.close.isTip ? 'Authoritative tip' : 'Superseded close'}
          tone={detail.close.isTip ? 'success' : 'warning'}
        />
        <p className="font-mono text-xs text-text-muted">{detail.close.id}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Gross sales" value={totals.grossSales} />
        <Stat label="Net sales" value={totals.netSales} />
        <Stat label="Tax" value={totals.taxTotal} />
        <Stat label="Service charge" value={totals.serviceChargeTotal} />
        <Stat label="Tips" value={totals.tipTotal} />
        <Stat label="Comps" value={totals.compTotal} />
        <Stat label="Discounts" value={totals.discountTotal} />
        <Stat label="Refunds" value={totals.refundTotal} />
        <Stat label="Voids" value={totals.voidTotal} />
        <Stat label="Cash expected" value={totals.cashExpected} />
        <Stat label="Cash counted" value={totals.cashCounted} />
        <Stat label="Cash variance" value={totals.cashVariance} />
      </div>

      <section aria-labelledby="close-tenders-heading">
        <h3 id="close-tenders-heading" className="mb-3 font-semibold text-text-strong">
          Tender totals
        </h3>
        {detail.tenderTotals.length ? (
          <TableFrame label="Daily close tender totals table">
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead numeric>Amount</TableHead>
                  <TableHead numeric>Tips</TableHead>
                  <TableHead numeric>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.tenderTotals.map((total) => (
                  <TableRow key={total.tenderType}>
                    <TableCell>{label(total.tenderType)}</TableCell>
                    <TableCell numeric>{total.amount}</TableCell>
                    <TableCell numeric>{total.tipAmount}</TableCell>
                    <TableCell numeric>{total.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ) : (
          <EmptyState
            title="No tender totals"
            detail="This daily close contains no tender-type totals."
          />
        )}
      </section>

      <section aria-labelledby="close-drawers-heading">
        <h3 id="close-drawers-heading" className="mb-3 font-semibold text-text-strong">
          Drawer variances
        </h3>
        {detail.drawerVariances.length ? (
          <TableFrame label="Daily close drawer variances table">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Drawer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Device / operator</TableHead>
                  <TableHead numeric>Opening</TableHead>
                  <TableHead numeric>Expected</TableHead>
                  <TableHead numeric>Counted</TableHead>
                  <TableHead numeric>Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.drawerVariances.map((drawer) => (
                  <TableRow key={drawer.drawerSessionId}>
                    <TableCell className="font-mono text-xs">{drawer.drawerSessionId}</TableCell>
                    <TableCell>
                      <StatusPill status={label(drawer.status)} tone={tone(drawer.status)} />
                    </TableCell>
                    <TableCell>
                      <span className="block font-mono text-xs">{drawer.deviceId}</span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {drawer.staffProfileId}
                      </span>
                    </TableCell>
                    <TableCell numeric>{drawer.openingFloat}</TableCell>
                    <TableCell numeric>{drawer.expectedCash ?? '—'}</TableCell>
                    <TableCell numeric>{drawer.countedCash ?? '—'}</TableCell>
                    <TableCell numeric>{drawer.variance ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ) : (
          <EmptyState
            title="No drawer variances"
            detail="This daily close contains no drawer reconciliation rows."
          />
        )}
      </section>

      <section aria-labelledby="close-chain-heading">
        <h3 id="close-chain-heading" className="mb-3 font-semibold text-text-strong">
          Correction chain
        </h3>
        <ol className="space-y-2">
          {detail.chain.map((node) => (
            <li
              key={node.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-subtle p-3"
            >
              <div>
                <p className="font-mono text-xs text-text-strong">{node.id}</p>
                <p className="mt-1 text-sm text-text-muted">
                  {node.correctionReason ?? 'Original close'}
                </p>
              </div>
              <StatusPill
                status={node.isTip ? 'Authoritative tip' : 'Superseded'}
                tone={node.isTip ? 'success' : 'neutral'}
              />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
