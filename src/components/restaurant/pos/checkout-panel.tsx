'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  RestaurantStaffSelect,
  type RestaurantStaffOption,
} from '@/components/restaurant/restaurant-staff-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';

import { ReceiptView } from './receipt-view';
import { SplitBillDialog, type BillSplit } from './split-bill-dialog';
import { TenderPad, type TenderResult } from './tender-pad';

export type TerminalRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  intent?: string;
};

export type TerminalRequest = <T>(path: string, options?: TerminalRequestOptions) => Promise<T>;

// Restore the comp control only when the public endpoint supports it after MVP.
const COMPLIMENTARY_ITEMS_AVAILABLE = false;

type CheckoutSummary = {
  orderId: string;
  settled: boolean;
  blocker: 'NO_BILLS' | 'ITEMS_UNBILLED' | 'BILLS_OPEN' | 'TOTAL_MISMATCH' | null;
  derivedOrderTotal: string;
  accountedTotal: string;
  deliveryFeeTotal: string | null;
  unbilledItemIds: string[];
  unbilledItems: {
    id: string;
    name: string;
    quantity: number;
    seatNumber: number | null;
    modifiers: string[];
  }[];
  bills: {
    id: string;
    status: string;
    splitKind: string;
    grandTotal: string;
    taxTotal: string;
    remainingDue: string;
    deliveryFeeTotal: string;
    compTotal: string;
    receiptNumber: number | null;
    lines: {
      id: string;
      name: string;
      quantity: number;
      lineSubtotal: string;
      compAmount: string;
    }[];
  }[];
};

type CheckoutPanelProps = {
  open: boolean;
  orderId: string | null;
  request: TerminalRequest;
  /** Checkout is server-authoritative: an already-open panel must also fail closed offline. */
  connected?: boolean;
  operators?: RestaurantStaffOption[];
  actingOperatorId?: string;
  /** `settled` reports whether the order was fully settled when the panel closed. */
  onClose: (result: { settled: boolean }) => void;
};

function CompControl({
  billId,
  lines,
  request,
  operators,
  actingOperatorId,
  disabled,
  onComped,
}: {
  billId: string;
  lines: CheckoutSummary['bills'][number]['lines'];
  request: TerminalRequest;
  operators: RestaurantStaffOption[];
  actingOperatorId: string;
  disabled: boolean;
  onComped: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [lineId, setLineId] = useState('');
  const [reason, setReason] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligibleLines = lines.filter((line) => Number(line.compAmount) === 0);
  const managers = operators.filter((operator) => operator.id !== actingOperatorId);

  function reset() {
    setLineId('');
    setReason('');
    setManagerId('');
    setManagerPin('');
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedReason = reason.trim();
    if (!lineId || !trimmedReason || !managerId || submitting) return;
    const body = {
      billId,
      billLineId: lineId,
      reason: trimmedReason,
      approving: { staffProfileId: managerId, type: 'PIN', secret: managerPin },
    };
    setSubmitting(true);
    setError(null);
    try {
      await request('/api/restaurant/checkout/comp', {
        method: 'POST',
        body,
        intent: `checkout-comp:${JSON.stringify(body)}`,
      });
      setOpen(false);
      reset();
      await onComped();
    } catch (caught) {
      setError(errorDetails(caught).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button
        type="button"
        variant="outline"
        className="mb-4 h-11"
        disabled={disabled || eligibleLines.length === 0}
        onClick={() => setOpen(true)}
      >
        Comp item
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Comp bill item</DialogTitle>
            <DialogDescription>
              Select an item and record distinct manager approval. The original price remains in
              the audit record.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`comp-line-${billId}`}>Bill item</Label>
              <select
                id={`comp-line-${billId}`}
                required
                value={lineId}
                onChange={(event) => setLineId(event.target.value)}
                className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="">Select an item</option>
                {eligibleLines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.quantity} × {line.name} — {line.lineSubtotal}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`comp-reason-${billId}`}>Comp reason</Label>
              <Textarea
                id={`comp-reason-${billId}`}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`comp-manager-${billId}`}>Approving manager</Label>
              <RestaurantStaffSelect
                id={`comp-manager-${billId}`}
                required
                staff={managers}
                value={managerId}
                onChange={setManagerId}
                label="Approving manager"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`comp-pin-${billId}`}>Manager PIN</Label>
              <Input
                id={`comp-pin-${billId}`}
                type="password"
                required
                inputMode="numeric"
                pattern="[0-9]{4,8}"
                minLength={4}
                maxLength={8}
                value={managerPin}
                onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, ''))}
              />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !reason.trim()}>
              {submitting ? 'Comping…' : 'Confirm comp'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function errorDetails(error: unknown) {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : null;
  const message = error instanceof Error ? error.message : 'Checkout request failed.';
  return {
    status,
    message: status === 403 ? `Permission denied: ${message}` : message,
  };
}

function billTone(status: string): StatusTone {
  if (status === 'SETTLED') return 'success';
  if (status === 'OPEN') return 'warning';
  if (status === 'VOID') return 'danger';
  return 'neutral';
}

// A Map (not an object literal) so inherited keys such as `constructor` never resolve,
// and unknown kinds fall back to fixed copy instead of exposing the raw server value.
const splitKindLabels = new Map<string, string>([
  ['NONE', 'Whole order'],
  ['BY_ITEM', 'By item'],
  ['BY_SEAT', 'By seat'],
  ['FRACTIONAL', 'Fractional'],
]);

function billTitle(splitKind: string) {
  return splitKindLabels.get(splitKind) ?? 'Bill details';
}

const blockerLabels: Record<Exclude<CheckoutSummary['blocker'], null>, string> = {
  NO_BILLS: 'No bills have been cut.',
  ITEMS_UNBILLED: 'Some order items are not billed.',
  BILLS_OPEN: 'Payment is still due on one or more bills.',
  TOTAL_MISMATCH: 'Bill totals do not match the order total.',
};

/** The redemption panel's read model (`GET /api/restaurant/checkout/loyalty`). Ids and
 * money only — the server sends no guest PII to a pad. */
type LoyaltySnapshot = {
  billId: string;
  orderId: string;
  billStatus: string;
  customerId: string | null;
  accountId: string | null;
  accountActive: boolean;
  balance: number;
  redemptionValue: string;
  outstanding: string;
  maxRedeemablePoints: number;
  redeemedValue: string;
};

/** A search hit. `masked` is all the pad ever receives of an email or phone number. */
type CustomerMatch = {
  customerId: string;
  displayName: string | null;
  identifiers: { id: string; kind: 'EMAIL' | 'PHONE'; masked: string }[];
};

const MIN_SEARCH_LENGTH = 2;

/**
 * Guest + loyalty for ONE open bill — CONNECTED-ONLY.
 *
 * Every read and write here is a live server round-trip: nothing is cached, queued or
 * replayed from local state, because a redemption moves an append-only ledger and discounts a
 * live bill. Search results hold MASKED identifiers only and are dropped when the guest is
 * attached, so no contactable address is ever retained on the pad.
 *
 * Authorization is the SERVER'S: this renders whatever it is given and surfaces a 403 as a
 * message. It never hides a control to "enforce" a capability, because a hidden control is
 * not a permission check — `customers:read` and `loyalty:redeem` are enforced on every route.
 *
 * `maxRedeemablePoints` is a keypad affordance, not a limit: the server re-derives the balance
 * and outstanding-balance bounds under row locks, so an edited value is refused, not honoured.
 */
function GuestLoyaltySection({
  orderId,
  billId,
  request,
  disabled,
  onRedeemed,
}: {
  orderId: string;
  billId: string;
  request: TerminalRequest;
  disabled: boolean;
  onRedeemed: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<LoyaltySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<CustomerMatch[] | null>(null);
  const [points, setPoints] = useState('');
  const [redeemed, setRedeemed] = useState<string | null>(null);

  const fetchSnapshot = useCallback(
    () =>
      request<LoyaltySnapshot>(
        `/api/restaurant/checkout/loyalty?billId=${encodeURIComponent(billId)}`
      ),
    [billId, request]
  );

  /** Re-read after a mutation, or on an explicit retry — both already outside render. */
  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDenied(false);
    try {
      setSnapshot(await fetchSnapshot());
    } catch (requestError) {
      const details = errorDetails(requestError);
      setSnapshot(null);
      setDenied(details.status === 403);
      setError(details.message);
    } finally {
      setLoading(false);
    }
  }, [fetchSnapshot]);

  // The first read settles state in the promise callbacks rather than synchronously in the
  // effect body (the panel's existing summary idiom), so the mount does not cascade a render.
  // `active` drops a reply that lands after the bill changed or the panel unmounted.
  useEffect(() => {
    let active = true;
    void fetchSnapshot()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setDenied(false);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        const details = errorDetails(requestError);
        setSnapshot(null);
        setDenied(details.status === 403);
        setError(details.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchSnapshot]);

  async function runSearch() {
    const term = query.trim();
    if (term.length < MIN_SEARCH_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await request<{ customers: CustomerMatch[] }>(
        `/api/restaurant/orders/customer/search?query=${encodeURIComponent(term)}`
      );
      setMatches(found.customers);
    } catch (requestError) {
      const details = errorDetails(requestError);
      setDenied(details.status === 403);
      setError(details.message);
    } finally {
      setBusy(false);
    }
  }

  async function attach(customerId: string) {
    if (busy) return;
    const body = { orderId, customerId };
    setBusy(true);
    setError(null);
    try {
      await request<unknown>('/api/restaurant/orders/customer/attach', {
        method: 'POST',
        body,
        intent: `customer-attach:${JSON.stringify(body)}`,
      });
      // Masked identifiers are discarded the moment they are no longer needed.
      setMatches(null);
      setQuery('');
      await loadSnapshot();
    } catch (requestError) {
      const details = errorDetails(requestError);
      setDenied(details.status === 403);
      setError(details.message);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    const count = Number(points);
    if (!snapshot?.accountId || busy) return;
    if (!Number.isInteger(count) || count <= 0) {
      setError('Enter a whole number of points to redeem.');
      return;
    }
    const body = { billId, accountId: snapshot.accountId, points: count };
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ value: string; balance: number }>(
        '/api/restaurant/checkout/loyalty',
        { method: 'POST', body, intent: `loyalty-redeem:${JSON.stringify(body)}` }
      );
      setRedeemed(result.value);
      setPoints('');
      await loadSnapshot();
      await onRedeemed();
    } catch (requestError) {
      const details = errorDetails(requestError);
      setDenied(details.status === 403);
      setError(details.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-text-muted">Loading guest and loyalty…</p>;
  }

  if (!snapshot) {
    // Keep the heading so the failure is attributable to THIS section rather than reading as a
    // checkout-wide error. A hard denial offers no retry — looping on a 403 cannot succeed.
    return (
      <div className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-text-strong">Guest &amp; loyalty</h4>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        {denied ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadSnapshot()}
            className="h-11"
          >
            Retry loyalty
          </Button>
        )}
      </div>
    );
  }

  const controlsDisabled = disabled || busy;
  const canRedeem = snapshot.accountId !== null && snapshot.accountActive && snapshot.balance > 0;

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-text-strong">Guest &amp; loyalty</h4>
        {snapshot.customerId ? (
          <StatusPill status={canRedeem ? 'enrolled' : 'not enrolled'} tone="neutral" />
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {redeemed ? (
        <p role="status" className="text-sm text-text-muted">
          Redeemed {redeemed} off this bill.
        </p>
      ) : null}

      {snapshot.customerId === null ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`guest-search-${billId}`}>Find guest</Label>
            <div className="flex gap-2">
              <Input
                id={`guest-search-${billId}`}
                value={query}
                disabled={controlsDisabled}
                autoComplete="off"
                placeholder="Name, email, or phone"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runSearch();
                  }
                }}
                className="h-11"
              />
              <Button
                type="button"
                variant="outline"
                disabled={controlsDisabled || query.trim().length < MIN_SEARCH_LENGTH}
                onClick={() => void runSearch()}
                className="h-11 shrink-0"
              >
                {busy ? 'Searching…' : 'Search'}
              </Button>
            </div>
          </div>

          {matches?.length === 0 ? (
            <p className="text-sm text-text-muted">No guest matches that search.</p>
          ) : null}

          {matches?.length ? (
            <ul className="grid gap-2">
              {matches.map((match) => (
                <li
                  key={match.customerId}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface-sunken p-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-strong">
                      {match.displayName ?? 'Unnamed guest'}
                    </span>
                    <span className="block truncate text-xs text-text-muted">
                      {match.identifiers.map((identifier) => identifier.masked).join(' · ')}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={controlsDisabled}
                    onClick={() => void attach(match.customerId)}
                    className="h-11 shrink-0"
                  >
                    Attach
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-text-muted">Points balance</dt>
              <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                {snapshot.balance}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Value per point</dt>
              <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                {snapshot.redemptionValue}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Already redeemed</dt>
              <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                {snapshot.redeemedValue}
              </dd>
            </div>
          </dl>

          {canRedeem ? (
            <div className="space-y-1.5">
              <Label htmlFor={`loyalty-points-${billId}`}>
                Points to redeem (up to {snapshot.maxRedeemablePoints})
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`loyalty-points-${billId}`}
                  value={points}
                  disabled={controlsDisabled || snapshot.maxRedeemablePoints === 0}
                  inputMode="numeric"
                  autoComplete="off"
                  onChange={(event) => setPoints(event.target.value)}
                  className="h-11 font-mono tabular-nums"
                />
                <Button
                  type="button"
                  disabled={
                    controlsDisabled || snapshot.maxRedeemablePoints === 0 || !points.trim()
                  }
                  onClick={() => void redeem()}
                  className="h-11 shrink-0"
                >
                  {busy ? 'Redeeming…' : 'Redeem'}
                </Button>
              </div>
              {snapshot.maxRedeemablePoints === 0 ? (
                <p className="text-sm text-text-muted">
                  Nothing is redeemable against the remaining {snapshot.outstanding}.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              This guest has no active loyalty balance to redeem.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function CheckoutPanel({
  open,
  orderId,
  request,
  connected = true,
  operators = [],
  actingOperatorId = '',
  onClose,
}: CheckoutPanelProps) {
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tenderPending, setTenderPending] = useState(false);

  const fetchSummary = useCallback(
    () =>
      !connected
        ? Promise.reject(new Error('Checkout is connected-only. Reconnect to continue.'))
        : orderId
          ? request<CheckoutSummary>(
              `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(orderId)}`
            )
          : Promise.reject(new Error('An order is required for checkout.')),
    [connected, orderId, request]
  );

  const loadSummary = useCallback(async () => {
    if (!open || !orderId) return;
    setLoading(true);
    setPermissionDenied(false);
    setError(null);
    try {
      setSummary(await fetchSummary());
    } catch (requestError) {
      const details = errorDetails(requestError);
      setSummary(null);
      setPermissionDenied(details.status === 403);
      setError(details.message);
    } finally {
      setLoading(false);
    }
  }, [fetchSummary, open, orderId]);

  useEffect(() => {
    if (!open || !orderId || !connected) return;
    let active = true;
    void fetchSummary()
      .then((next) => {
        if (!active) return;
        setSummary(next);
        setPermissionDenied(false);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        const details = errorDetails(requestError);
        setSummary(null);
        setPermissionDenied(details.status === 403);
        setError(details.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connected, fetchSummary, open, orderId]);

  async function cut(split: { kind: 'NONE' } | BillSplit) {
    if (!orderId || busy) return false;
    const body = { orderId, split };
    setBusy(true);
    setError(null);
    try {
      await request<unknown>('/api/restaurant/checkout/bill', {
        method: 'POST',
        body,
        intent: `checkout-bill:${JSON.stringify(body)}`,
      });
      await loadSummary();
      return true;
    } catch (requestError) {
      const details = errorDetails(requestError);
      setPermissionDenied(details.status === 403);
      setError(details.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function tenderApplied(result: TenderResult) {
    setSummary((current) =>
      current
        ? {
            ...current,
            bills: current.bills.map((bill) =>
              bill.id === result.billId ? { ...bill, remainingDue: result.remainingDue } : bill
            ),
          }
        : current
    );
    if (result.settled) await loadSummary();
  }

  function closePanel() {
    const settled = summary?.settled ?? false;
    setSummary(null);
    setError(null);
    setLoading(true);
    onClose({ settled });
  }

  const dismissBlocked = busy || tenderPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissBlocked) closePanel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>Collect payment</DialogTitle>
          <DialogDescription>
            Cut bills, apply split tenders, and review settled receipts for this order.
          </DialogDescription>
        </DialogHeader>

        {!connected ? (
          <SectionCard
            eyebrow="Checkout"
            title="Checkout unavailable offline"
            actions={<StatusPill status="offline" tone="warning" />}
          >
            <p role="status" className="text-sm text-text-muted">
              Checkout, tenders, customer and loyalty actions, receipts, refunds, drawers, and close
              are connected-only. Reconnect to continue.
            </p>
          </SectionCard>
        ) : null}

        {connected && loading ? (
          <SectionCard eyebrow="Checkout" title="Loading settlement">
            <p className="text-sm text-text-muted">Loading bill and settlement state…</p>
          </SectionCard>
        ) : null}

        {connected && !loading && error && !summary ? (
          <SectionCard
            eyebrow="Checkout"
            title={permissionDenied ? 'Payment access denied' : 'Checkout unavailable'}
            actions={<StatusPill status={permissionDenied ? 'denied' : 'error'} tone="danger" />}
          >
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadSummary()}
                className="h-11"
              >
                Retry checkout
              </Button>
            </div>
          </SectionCard>
        ) : null}

        {connected && !loading && summary ? (
          <div className="space-y-4" data-tour="bill-settlement">
            <SectionCard
              eyebrow="Settlement"
              title="Order balance"
              actions={
                <StatusPill
                  status={summary.settled ? 'settled' : 'payment pending'}
                  tone={summary.settled ? 'success' : 'warning'}
                />
              }
            >
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-text-muted">Order total</dt>
                  <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                    {summary.derivedOrderTotal}
                  </dd>
                </div>
                {summary.deliveryFeeTotal !== null ? (
                  <div>
                    <dt className="text-xs text-text-muted">Delivery fee</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {summary.deliveryFeeTotal}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-text-muted">Accounted on bills</dt>
                  <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                    {summary.accountedTotal}
                  </dd>
                </div>
              </dl>
              {summary.blocker ? (
                <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-text-body">
                  {blockerLabels[summary.blocker]}
                </p>
              ) : null}
            </SectionCard>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            {summary.bills.length === 0 && summary.unbilledItemIds.length > 0 ? (
              <SectionCard
                eyebrow="Billing"
                title={`${summary.unbilledItemIds.length} unbilled item${summary.unbilledItemIds.length === 1 ? '' : 's'}`}
              >
                <p className="mb-4 text-sm text-text-muted">
                  Cut one bill for the order or choose a supported split method.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => void cut({ kind: 'NONE' })}
                    disabled={busy}
                    className="h-11"
                  >
                    {busy ? 'Creating bill…' : 'Cut single bill'}
                  </Button>
                  <SplitBillDialog
                    items={summary.unbilledItems}
                    disabled={busy}
                    onSplit={cut}
                  />
                </div>
              </SectionCard>
            ) : null}

            {summary.bills.length === 0 && summary.unbilledItemIds.length === 0 ? (
              <SectionCard eyebrow="Billing" title="Nothing to collect">
                <p className="text-sm text-text-muted">
                  This order has no live bills or unbilled items.
                </p>
              </SectionCard>
            ) : null}

            {summary.bills.map((bill, index) => (
              <SectionCard
                key={bill.id}
                eyebrow={`Bill ${index + 1}`}
                title={
                  bill.receiptNumber !== null
                    ? `Receipt ${bill.receiptNumber}`
                    : billTitle(bill.splitKind)
                }
                actions={<StatusPill status={bill.status} tone={billTone(bill.status)} />}
              >
                <dl className="mb-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-text-muted">Bill total</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {bill.grandTotal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Tax</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {bill.taxTotal}
                    </dd>
                  </div>
                  {summary.deliveryFeeTotal !== null ? (
                    <div>
                      <dt className="text-xs text-text-muted">Delivery fee</dt>
                      <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                        {bill.deliveryFeeTotal}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs text-text-muted">Comp total</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {bill.compTotal}
                    </dd>
                  </div>
                </dl>
                {bill.status === 'OPEN' ? (
                  <>
                    <CompControl
                      billId={bill.id}
                      lines={bill.lines ?? []}
                      request={request}
                      operators={operators}
                      actingOperatorId={actingOperatorId}
                      disabled={busy || tenderPending}
                      onComped={loadSummary}
                    />
                    <TenderPad
                      billId={bill.id}
                      amountDue={bill.remainingDue}
                      request={request}
                      disabled={busy}
                      onApplied={tenderApplied}
                      onPendingChange={setTenderPending}
                    />
                    {orderId ? (
                      <GuestLoyaltySection
                        orderId={orderId}
                        billId={bill.id}
                        request={request}
                        disabled={busy || tenderPending}
                        onRedeemed={loadSummary}
                      />
                    ) : null}
                  </>
                ) : null}
                {bill.status === 'SETTLED' ? (
                  <ReceiptView billId={bill.id} request={request} />
                ) : null}
                {!['OPEN', 'SETTLED'].includes(bill.status) ? (
                  <p className="text-sm text-text-muted">This bill is not available for tender.</p>
                ) : null}
              </SectionCard>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={closePanel}
            disabled={dismissBlocked}
            className="h-11"
          >
            Close checkout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
