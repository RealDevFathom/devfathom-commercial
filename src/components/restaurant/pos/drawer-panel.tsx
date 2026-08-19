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
  replayed: boolean;
};
type CloseResult = {
  drawerSessionId: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  replayed: boolean;
};

type DrawerPanelProps = {
  request: TerminalRequest;
  disabled?: boolean;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Drawer request failed. Retry this action.';
}

export function DrawerPanel({ request, disabled = false }: DrawerPanelProps) {
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [drawer, setDrawer] = useState<OpenResult | null>(null);
  const [movementKind, setMovementKind] = useState<MovementKind>('PAID_IN');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [countedCash, setCountedCash] = useState('');
  const [closed, setClosed] = useState<CloseResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function openDrawer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !MONEY.test(openingFloat)) {
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
    if (!drawer || pending || !MONEY.test(movementAmount) || !movementReason.trim()) {
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
    if (!drawer || pending || !MONEY.test(countedCash)) {
      setError('Counted cash must be a non-negative decimal with at most two places.');
      return;
    }
    const body = { drawerSessionId: drawer.drawerSessionId, countedCash };
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
      setCountedCash('');
      setNotice('Drawer closed.');
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" className="h-11" />} disabled={disabled}>
        Cash drawer
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cash drawer</DialogTitle>
          <DialogDescription>
            Open, adjust, and close this register drawer with exact cash counts.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-text-body">
          Drawer session is remembered only in this terminal memory. Reloading or locking loses the
          reference because L5 has no current-drawer lookup.
        </p>

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
            title={closed ? 'Closed drawer' : 'No drawer in memory'}
            actions={
              <StatusPill
                status={closed ? 'closed' : 'not open'}
                tone={closed ? 'success' : 'neutral'}
              />
            }
          >
            {closed ? (
              <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-text-muted">Expected</dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {closed.expectedCash}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">Counted</dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {closed.countedCash}
                  </dd>
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
                  disabled={busy}
                  onChange={(event) => setOpeningFloat(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  className="h-11 font-mono tabular-nums"
                />
              </div>
              <Button type="submit" disabled={busy} className="h-11 w-full">
                {pending === 'open' ? 'Opening drawer…' : 'Open drawer'}
              </Button>
            </form>
          </SectionCard>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-text-strong">Active drawer</p>
                <p className="font-mono text-xs text-text-muted">{drawer.drawerSessionId}</p>
              </div>
              <StatusPill status="open" tone="info" />
            </div>

            <SectionCard eyebrow="Cash ledger" title="Record movement">
              <form onSubmit={recordMovement} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="drawer-movement-kind">Movement</Label>
                    <select
                      id="drawer-movement-kind"
                      value={movementKind}
                      disabled={busy}
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
                      disabled={busy}
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
                    disabled={busy}
                    onChange={(event) => setMovementReason(event.target.value)}
                    className="h-11"
                  />
                </div>
                <Button type="submit" variant="outline" disabled={busy} className="h-11 w-full">
                  {pending === 'movement' ? 'Recording movement…' : 'Record movement'}
                </Button>
              </form>
            </SectionCard>

            <SectionCard eyebrow="Closing count" title="Close drawer">
              <form onSubmit={closeDrawer} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-counted-cash">Counted cash</Label>
                  <Input
                    id="drawer-counted-cash"
                    value={countedCash}
                    disabled={busy}
                    onChange={(event) => setCountedCash(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    className="h-11 font-mono tabular-nums"
                  />
                </div>
                <Button type="submit" variant="outline" disabled={busy} className="h-11 w-full">
                  {pending === 'close' ? 'Closing drawer…' : 'Close drawer'}
                </Button>
              </form>
            </SectionCard>
          </div>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
