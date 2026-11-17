'use client';

import { type FormEvent, useEffect, useState } from 'react';

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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { TerminalRequest } from './checkout-panel';

type Tender = {
  tenderId: string;
  paymentProvider?: string | null;
  orderNumber: number;
  receiptNumber: string | null;
  type: string;
  paidAmount: string;
  refundedAmount: string;
  remainingAmount: string;
  tipPaidAmount: string;
  tipRefundedAmount: string;
  tipRemainingAmount: string;
  paidAt: string;
};
type Result = {
  amount: string;
  tipRefundAmount: string;
  businessDate: string;
  paymentStatus: string | null;
  taxRefundAmount: string;
  serviceChargeRefundAmount: string;
  replayed: boolean;
};
type DemoApproval = { staffProfileId: string; displayName: string; expiresAt: number };

const amountPattern = /^\d+(\.\d{1,2})?$/;
const demoApprovalExpiredMessage = 'Demo access expired. Reopen the restaurant demo.';
const moneyNumber = (value: string) => Number(value);
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Refund request failed. Retry safely.';

export function RefundPanel({
  request,
  operators,
  actingOperatorId,
  demo = false,
  disabled = false,
}: {
  request: TerminalRequest;
  operators: RestaurantStaffOption[];
  actingOperatorId: string;
  demo?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [tenderId, setTenderId] = useState('');
  const [amount, setAmount] = useState('');
  const [tipAmount, setTipAmount] = useState('0.00');
  const [reason, setReason] = useState('');
  const [cardMachineRefundReference, setCardMachineRefundReference] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managerSecret, setManagerSecret] = useState('');
  const [demoApproval, setDemoApproval] = useState<DemoApproval | null>(null);
  const [state, setState] = useState<
    'idle' | 'loading' | 'ready' | 'confirming' | 'submitting' | 'denied' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const selected = tenders.find((tender) => tender.tenderId === tenderId) ?? null;
  const listedDemoApproval =
    demo &&
    demoApproval &&
    Number.isFinite(demoApproval.expiresAt) &&
    demoApproval.staffProfileId !== actingOperatorId
      ? demoApproval
      : null;
  const managers = demo
    ? listedDemoApproval
      ? [
          {
            id: listedDemoApproval.staffProfileId,
            displayName: listedDemoApproval.displayName,
            role: 'Designated approver',
          },
        ]
      : []
    : operators.filter((operator) => operator.id !== actingOperatorId || operator.canSelfApprove);

  useEffect(() => {
    if (!demo || !demoApproval) return;
    const remaining = demoApproval.expiresAt - Date.now();
    const timer = window.setTimeout(
      () => {
        setDemoApproval(null);
        setManagerId('');
        setError(demoApprovalExpiredMessage);
        setState((current) => (current === 'confirming' ? 'ready' : current));
      },
      Math.max(0, Math.min(remaining, 2_147_483_647))
    );
    return () => window.clearTimeout(timer);
  }, [demo, demoApproval]);

  async function load() {
    setState('loading');
    setError(null);
    setResult(null);
    try {
      const data = await request<{ tenders: Tender[]; demoApproval?: DemoApproval }>(
        '/api/restaurant/checkout/refund'
      );
      if (demo) {
        const approval = data.demoApproval;
        const usable =
          approval &&
          typeof approval.staffProfileId === 'string' &&
          typeof approval.displayName === 'string' &&
          Number.isFinite(approval.expiresAt) &&
          approval.expiresAt > Date.now() &&
          approval.staffProfileId !== actingOperatorId
            ? approval
            : null;
        setDemoApproval(usable);
        setManagerId(usable?.staffProfileId ?? '');
      }
      setTenders(
        data.tenders.filter(
          (tender) =>
            moneyNumber(tender.remainingAmount) > 0 || moneyNumber(tender.tipRemainingAmount) > 0
        )
      );
      setState('ready');
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setState(/permission|capability|revoked/i.test(message) ? 'denied' : 'error');
    }
  }

  function setPanelOpen(next: boolean) {
    setOpen(next);
    if (next) {
      if (demo) {
        setDemoApproval(null);
        setManagerId('');
      }
      void load();
    } else {
      setManagerSecret('');
      setState('idle');
      setError(null);
    }
  }

  function selectTender(id: string) {
    setTenderId(id);
    setCardMachineRefundReference('');
    setResult(null);
    setError(null);
    const next = tenders.find((tender) => tender.tenderId === id);
    setAmount(next?.remainingAmount ?? '');
    setTipAmount(next?.tipRemainingAmount ?? '0.00');
  }

  function validate() {
    const approval =
      listedDemoApproval && listedDemoApproval.expiresAt > Date.now() ? listedDemoApproval : null;
    if (demo && (!approval || managerId !== approval.staffProfileId)) {
      return demoApprovalExpiredMessage;
    }
    if (!selected) return 'Choose a refundable receipt.';
    if (
      !amountPattern.test(amount) ||
      moneyNumber(amount) < 0 ||
      moneyNumber(amount) > moneyNumber(selected.remainingAmount)
    )
      return 'Enter an amount within the remaining refundable balance.';
    if (
      !amountPattern.test(tipAmount) ||
      moneyNumber(tipAmount) < 0 ||
      moneyNumber(tipAmount) > moneyNumber(selected.tipRemainingAmount)
    )
      return 'Enter a tip amount within the remaining tip balance.';
    if (moneyNumber(amount) === 0 && moneyNumber(tipAmount) === 0)
      return 'Enter a principal or tip amount to refund.';
    if (!reason.trim() || reason.trim().length > 240)
      return 'Enter a reason between 1 and 240 characters.';
    if (
      !managerId ||
      (managerId === actingOperatorId &&
        !operators.some((operator) => operator.id === managerId && operator.canSelfApprove))
    )
      return 'Select a distinct approving manager.';
    if (!demo && !/^\d{4,8}$/.test(managerSecret))
      return 'Enter the approving manager’s 4–8 digit PIN.';
    return null;
  }

  function preview(event: FormEvent) {
    event.preventDefault();
    const issue = validate();
    setError(issue);
    if (!issue) setState('confirming');
  }

  async function confirm() {
    if (!selected || state !== 'confirming') return;
    const approval =
      listedDemoApproval && listedDemoApproval.expiresAt > Date.now() ? listedDemoApproval : null;
    if (demo && (!approval || managerId !== approval.staffProfileId)) {
      setError(demoApprovalExpiredMessage);
      setState('ready');
      return;
    }
    const approvingStaffProfileId = approval?.staffProfileId ?? managerId;
    const body = {
      ...(selected.paymentProvider === 'MANUAL' && cardMachineRefundReference.trim()
        ? { cardMachineRefundReference: cardMachineRefundReference.trim() }
        : {}),
      originalTenderId: selected.tenderId,
      amount,
      ...(moneyNumber(tipAmount) ? { tipRefundAmount: tipAmount } : {}),
      reason: reason.trim(),
      approving: demo
        ? { staffProfileId: approvingStaffProfileId, type: 'DEMO' as const }
        : { staffProfileId: managerId, type: 'PIN' as const, secret: managerSecret },
    };
    setState('submitting');
    setError(null);
    try {
      const receipt = await request<Result>('/api/restaurant/checkout/refund', {
        method: 'POST',
        body,
        intent: `refund:${JSON.stringify({
          ...(selected.paymentProvider === 'MANUAL' && cardMachineRefundReference.trim()
            ? { cardMachineRefundReference: cardMachineRefundReference.trim() }
            : {}),
          originalTenderId: selected.tenderId,
          amount,
          tipRefundAmount: tipAmount,
          kind: 'REFUND',
          reason: reason.trim(),
          approvingStaffProfileId,
        })}`,
      });
      setManagerSecret('');
      setResult(receipt);
      setState('ready');
      await load();
      setResult(receipt);
    } catch (caught) {
      setManagerSecret('');
      setError(errorMessage(caught));
      setState('ready');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setPanelOpen}>
      <DialogTrigger
        render={<Button type="button" variant="destructive" className="h-11" />}
        disabled={disabled}
      >
        Refund
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Refund settled payment</DialogTitle>
          <DialogDescription>
            Review the remaining balance, verify the approving manager PIN, then explicitly confirm.
          </DialogDescription>
        </DialogHeader>
        {state === 'loading' ? (
          <p role="status" className="text-sm text-text-muted">
            Loading refundable receipts…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {state === 'denied' ? <StatusPill status="permission denied" tone="danger" /> : null}
        {state === 'error' ? (
          <Button type="button" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        ) : null}
        {state === 'ready' && tenders.length === 0 && !result ? (
          <p className="text-sm text-text-muted">
            No settled payments have a refundable balance at this branch.
          </p>
        ) : null}
        {result ? (
          <div role="status" className="space-y-2 rounded-md border border-border-default p-4">
            <StatusPill
              status={result.replayed ? 'receipt replayed' : 'refund recorded'}
              tone="success"
            />
            <p className="text-sm">
              Refund {result.amount} · Tip {result.tipRefundAmount} · Tax {result.taxRefundAmount}
              {' · Service charge '}
              {result.serviceChargeRefundAmount}
            </p>
            <p className="text-xs text-text-muted">
              Processing date {result.businessDate}
              {result.paymentStatus ? ` · ${result.paymentStatus.replaceAll('_', ' ')}` : ''}
            </p>
          </div>
        ) : null}
        {state === 'confirming' && selected ? (
          <div className="space-y-3 rounded-md border border-destructive/40 p-4">
            <h3 className="font-semibold">Confirm destructive refund</h3>
            <p className="text-sm">
              Refund {amount} plus {tipAmount} tip from receipt{' '}
              {selected.receiptNumber ?? `order ${selected.orderNumber}`}. Frozen tax allocation is
              finalized by the server and shown on the receipt.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setState('ready')}>
                Back
              </Button>
              <Button type="button" variant="destructive" onClick={() => void confirm()}>
                Confirm refund
              </Button>
            </DialogFooter>
          </div>
        ) : null}
        {state === 'ready' && tenders.length > 0 ? (
          <form onSubmit={preview} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="refund-tender">Settled receipt</Label>
              <select
                id="refund-tender"
                value={tenderId}
                onChange={(event) => selectTender(event.target.value)}
                className="h-11 w-full rounded-md border border-input bg-surface-card px-3"
              >
                <option value="">Choose a receipt</option>
                {tenders.map((tender) => (
                  <option key={tender.tenderId} value={tender.tenderId}>
                    Receipt {tender.receiptNumber ?? `order ${tender.orderNumber}`} · {tender.type}{' '}
                    · {tender.remainingAmount} remaining
                  </option>
                ))}
              </select>
            </div>
            {selected ? (
              <dl className="grid grid-cols-3 gap-3 rounded-md bg-surface-sunken p-3 text-sm">
                <div>
                  <dt className="text-text-muted">Paid</dt>
                  <dd>{selected.paidAmount}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Refunded</dt>
                  <dd>{selected.refundedAmount}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Remaining</dt>
                  <dd>{selected.remainingAmount}</dd>
                </div>
              </dl>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="refund-amount">Refund amount</Label>
                <Input
                  id="refund-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="refund-tip">Tip refund</Label>
                <Input
                  id="refund-tip"
                  inputMode="decimal"
                  value={tipAmount}
                  onChange={(e) => setTipAmount(e.target.value)}
                />
              </div>
            </div>
            {selected?.paymentProvider === 'MANUAL' ? (
              <div className="space-y-1.5">
                <Label htmlFor="refund-machine-reference">
                  Card machine refund reference (optional)
                </Label>
                <Input
                  id="refund-machine-reference"
                  maxLength={40}
                  value={cardMachineRefundReference}
                  onChange={(event) => setCardMachineRefundReference(event.target.value)}
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="refund-reason">Reason</Label>
              <Input
                id="refund-reason"
                maxLength={240}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="refund-manager">
                {demo ? 'Demo approving manager' : 'Approving manager'}
              </Label>
              <RestaurantStaffSelect
                id="refund-manager"
                label={demo ? 'Demo approving manager' : 'Approving manager'}
                staff={managers}
                value={managerId}
                onChange={setManagerId}
              />
            </div>
            {demo && listedDemoApproval ? (
              <p className="text-sm text-text-muted">
                Demo approval is ready with the designated manager. No PIN entry is needed.
              </p>
            ) : demo ? (
              <p role="alert" className="text-sm text-destructive">
                {demoApprovalExpiredMessage}{' '}
                <a className="underline" href="/demo/restaurants">
                  Reopen demo
                </a>
              </p>
            ) : (
              <div>
                <Label htmlFor="refund-pin">Manager PIN</Label>
                <Input
                  id="refund-pin"
                  type="password"
                  inputMode="numeric"
                  minLength={4}
                  maxLength={8}
                  value={managerSecret}
                  onChange={(e) => setManagerSecret(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            )}
            <Button
              type="submit"
              variant="destructive"
              className="h-11 w-full"
              disabled={demo && !listedDemoApproval}
            >
              Review refund
            </Button>
          </form>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={state === 'submitting'}
            onClick={() => setPanelOpen(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
