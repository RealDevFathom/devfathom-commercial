'use client';

import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

import type { TerminalRequest } from './checkout-panel';

const MONEY = /^\d+(\.\d{1,2})?$/;
type MovementKind = 'PAID_IN' | 'PAID_OUT' | 'DROP';
type OpenResult = {
  drawerSessionId: string;
  businessDate: string;
  openingFloat: string;
  expectedCash?: string;
  movements?: Array<{
    id: string;
    kind: string;
    amount: string;
    reason: string | null;
    staffProfileId: string;
    deviceId: string;
    createdAt: string;
  }>;
  replayed: boolean;
};
type CloseResult = {
  drawerSessionId: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  replayed: boolean;
};
type DrawerReadState =
  | { status: 'loading' | 'empty' | 'open' }
  | { status: 'error' | 'denied'; message: string };

type DrawerPanelProps = {
  request: TerminalRequest;
  disabled?: boolean;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Drawer request failed. Retry this action.';
}

function isAccessDenied(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error.status === 401 || error.status === 403)
  );
}

export function DrawerPanel({ request, disabled = false }: DrawerPanelProps) {
  const [open, setOpen] = useState(false);
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [drawer, setDrawer] = useState<OpenResult | null>(null);
  const [readState, setReadState] = useState<DrawerReadState>({ status: 'loading' });
  const [movementKind, setMovementKind] = useState<MovementKind>('PAID_IN');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [countedCash, setCountedCash] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [closed, setClosed] = useState<CloseResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadDrawerState() {
    if (busy || disabled) return;
    setPending('load');
    setReadState({ status: 'loading' });
    setError(null);
    setNotice(null);
    try {
      const current = await request<OpenResult | null>('/api/restaurant/cash/drawer/current');
      setDrawer(current);
      setReadState({ status: current ? 'open' : 'empty' });
    } catch (requestError) {
      setReadState({
        status: isAccessDenied(requestError) ? 'denied' : 'error',
        message: message(requestError),
      });
    } finally {
      setPending(null);
    }
  }

  async function setPanelOpen(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (next) await loadDrawerState();
  }

  async function openDrawer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writesDisabled || readState.status !== 'empty') return;
    if (!MONEY.test(openingFloat)) {
      setError('Opening float must be a non-negative decimal with at most two places.');
      return;
    }
    const body = { openingFloat };
    setPending('open');
    setError(null);
    setNotice(null);
    try {
      setDrawer(
        await request<OpenResult>('/api/restaurant/cash/drawer/open', {
          method: 'POST',
          body,
          intent: `drawer-open:${JSON.stringify(body)}`,
        })
      );
      setReadState({ status: 'open' });
      setClosed(null);
      setNotice('Drawer opened.');
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setPending(null);
    }
  }

  async function recordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writesDisabled || readState.status !== 'open' || !drawer) return;
    if (!MONEY.test(movementAmount) || !movementReason.trim()) {
      setError('Movement requires an exact decimal amount and a reason.');
      return;
    }
    const body = {
      drawerSessionId: drawer.drawerSessionId,
      kind: movementKind,
      amount: movementAmount,
      reason: movementReason.trim(),
    };
    setPending('movement');
    setError(null);
    setNotice(null);
    try {
      await request<unknown>('/api/restaurant/cash/drawer/movement', {
        method: 'POST',
        body,
        intent: `drawer-movement:${JSON.stringify(body)}`,
      });
      setMovementAmount('');
      setMovementReason('');
      setNotice('Cash movement recorded.');
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setPending(null);
    }
  }

  async function closeDrawer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writesDisabled || readState.status !== 'open' || !drawer) return;
    if (!MONEY.test(countedCash)) {
      setError('Counted cash must be a non-negative decimal with at most two places.');
      return;
    }
    const hasVariance =
      drawer.expectedCash !== undefined &&
      minorUnits(countedCash) !== minorUnits(drawer.expectedCash);
    if (hasVariance && !varianceReason.trim()) {
      setError('Explain the cash variance before closing the drawer.');
      return;
    }
    const body = {
      drawerSessionId: drawer.drawerSessionId,
      countedCash,
      ...(hasVariance ? { varianceReason: varianceReason.trim() } : {}),
    };
    setPending('close');
    setError(null);
    setNotice(null);
    try {
      const result = await request<CloseResult>('/api/restaurant/cash/drawer/close', {
        method: 'POST',
        body,
        intent: `drawer-close:${JSON.stringify(body)}`,
      });
      setClosed(result);
      setDrawer(null);
      setReadState({ status: 'empty' });
      setCountedCash('');
      setVarianceReason('');
      setNotice('Drawer closed.');
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const stateKnown = readState.status === 'empty' || readState.status === 'open';
  const writesDisabled = disabled || busy || !stateKnown;

  function minorUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => void setPanelOpen(next)}>
      <DialogTrigger
        render={<Button type="button" variant="outline" className="h-11" />}
        disabled={disabled}
      >
        Cash drawer
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Cash drawer</DialogTitle>
          <DialogDescription>
            Open, adjust, and close this register drawer with exact cash counts.
          </DialogDescription>
        </DialogHeader>

        {readState.status === 'loading' ? (
          <p role="status" className="text-sm text-text-muted">
            Checking this register’s drawer. Cash actions are unavailable until the check succeeds.
          </p>
        ) : null}
        {readState.status === 'error' || readState.status === 'denied' ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {readState.status === 'denied'
                ? 'Drawer access denied. Unlock an authorized terminal session or ask a manager to check access, then retry.'
                : 'Could not verify drawer state. Retry before opening, adjusting, or closing the drawer.'}{' '}
              {readState.message}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy || disabled}
              onClick={() => void loadDrawerState()}
              className="min-h-11 whitespace-normal"
            >
              Retry drawer state
            </Button>
          </div>
        ) : null}
        {disabled ? (
          <p role="status" className="text-sm text-text-muted">
            Cash actions are unavailable while this register is offline or busy.
          </p>
        ) : null}
        {!stateKnown && (drawer || closed) ? (
          <p role="status" className="text-sm text-text-muted">
            Last known drawer details are stale. Refresh must succeed before cash actions are
            available.
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {!drawer ? (
          <SectionCard
            eyebrow="Drawer state"
            title={
              !stateKnown ? 'Drawer state unknown' : closed ? 'Closed drawer' : 'No open drawer'
            }
            actions={
              <StatusPill
                status={!stateKnown ? 'unknown' : closed ? 'closed' : 'not open'}
                tone={!stateKnown ? 'warning' : closed ? 'success' : 'neutral'}
              />
            }
          >
            {closed ? (
              <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-text-muted">Expected</dt>
                  <dd className="font-mono tabular-nums text-text-strong">{closed.expectedCash}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Counted</dt>
                  <dd className="font-mono tabular-nums text-text-strong">{closed.countedCash}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Variance</dt>
                  <dd className="font-mono tabular-nums text-text-strong">{closed.variance}</dd>
                </div>
              </dl>
            ) : null}
            <form onSubmit={openDrawer} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="drawer-opening-float">Opening float</Label>
                <Input
                  id="drawer-opening-float"
                  value={openingFloat}
                  disabled={writesDisabled}
                  onChange={(event) => setOpeningFloat(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  className="h-11 font-mono tabular-nums"
                />
              </div>
              <Button type="submit" disabled={writesDisabled} className="h-11 w-full">
                {pending === 'open' ? 'Opening drawer…' : 'Open drawer'}
              </Button>
            </form>
          </SectionCard>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-text-strong">
                  {stateKnown ? 'Active drawer' : 'Last known drawer'}
                </p>
                <p className="font-mono text-xs text-text-muted">{drawer.drawerSessionId}</p>
              </div>
              <StatusPill
                status={stateKnown ? 'open' : 'stale'}
                tone={stateKnown ? 'info' : 'warning'}
              />
            </div>

            <SectionCard eyebrow="Cash ledger" title="Record movement">
              <form onSubmit={recordMovement} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-movement-kind">Movement</Label>
                    <select
                      id="drawer-movement-kind"
                      value={movementKind}
                      disabled={writesDisabled}
                      onChange={(event) => setMovementKind(event.target.value as MovementKind)}
                      className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                    >
                      <option value="PAID_IN">Paid in</option>
                      <option value="PAID_OUT">Paid out</option>
                      <option value="DROP">Drop</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-movement-amount">Amount</Label>
                    <Input
                      id="drawer-movement-amount"
                      value={movementAmount}
                      disabled={writesDisabled}
                      onChange={(event) => setMovementAmount(event.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      className="h-11 font-mono tabular-nums"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-movement-reason">Reason</Label>
                  <Input
                    id="drawer-movement-reason"
                    value={movementReason}
                    disabled={writesDisabled}
                    onChange={(event) => setMovementReason(event.target.value)}
                    className="h-11"
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={writesDisabled}
                  className="h-11 w-full"
                >
                  {pending === 'movement' ? 'Recording movement…' : 'Record movement'}
                </Button>
              </form>
            </SectionCard>

            <SectionCard
              eyebrow="Cash ledger"
              title="Current balance and movements"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={writesDisabled}
                  onClick={() => void loadDrawerState()}
                >
                  {pending === 'load' ? 'Refreshing…' : 'Refresh ledger'}
                </Button>
              }
            >
              <div className="mb-4">
                <p className="text-xs text-text-muted">Expected cash</p>
                <p className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                  {drawer.expectedCash ?? 'Refresh to calculate'}
                </p>
              </div>
              {drawer.movements?.length ? (
                <ol className="divide-y divide-border-subtle" aria-label="Current drawer movements">
                  {drawer.movements.map((movement) => (
                    <li
                      key={movement.id}
                      className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]"
                    >
                      <div>
                        <p className="font-medium text-text-strong">
                          {movement.kind.replaceAll('_', ' ').toLowerCase()}
                        </p>
                        <p className="text-xs text-text-muted">
                          {movement.reason ?? 'System-posted movement'} ·{' '}
                          {new Date(movement.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <p className="font-mono tabular-nums text-text-strong">{movement.amount}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-text-muted">No movements are available yet.</p>
              )}
            </SectionCard>

            <SectionCard eyebrow="Closing count" title="Close drawer">
              <form onSubmit={closeDrawer} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-counted-cash">Counted cash</Label>
                  <Input
                    id="drawer-counted-cash"
                    value={countedCash}
                    disabled={writesDisabled}
                    onChange={(event) => setCountedCash(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    className="h-11 font-mono tabular-nums"
                  />
                </div>
                {drawer.expectedCash !== undefined &&
                MONEY.test(countedCash) &&
                minorUnits(countedCash) !== minorUnits(drawer.expectedCash) ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-variance-reason">Variance explanation</Label>
                    <Input
                      id="drawer-variance-reason"
                      value={varianceReason}
                      disabled={writesDisabled}
                      onChange={(event) => setVarianceReason(event.target.value)}
                      maxLength={240}
                      className="h-11"
                    />
                    <p className="text-xs text-text-muted">
                      Required because counted cash differs from expected cash.
                    </p>
                  </div>
                ) : null}
                <Button
                  type="submit"
                  variant="outline"
                  disabled={writesDisabled}
                  className="h-11 w-full"
                >
                  {pending === 'close' ? 'Closing drawer…' : 'Close drawer'}
                </Button>
              </form>
            </SectionCard>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="h-11"
          >
            Close drawer panel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
