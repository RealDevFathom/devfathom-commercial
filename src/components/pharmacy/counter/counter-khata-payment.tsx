'use client';

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';

type Props = {
  branchId: string;
  storageScope: string;
  branchName: string;
  drawerSessionId?: string;
  onRecorded: () => void;
};

type Slip = {
  receiptId: string;
  accountName: string;
  amountMinor: number;
  remainingBalanceMinor: number;
  tender: string;
  occurredAt: Date;
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );
}

export function buildKhataPaymentSlip(slip: Slip, branchName: string) {
  const lines = [
    'KHATA PAYMENT RECEIPT',
    branchName,
    `Receipt: ${slip.receiptId}`,
    `Account: ${slip.accountName}`,
    `Amount received: ${formatMinor(slip.amountMinor)}`,
    `Tender: ${slip.tender.replace('_', ' ')}`,
    `Balance remaining: ${formatMinor(slip.remainingBalanceMinor)}`,
    `Recorded: ${slip.occurredAt.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) + ' PKT'}`,
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Khata payment receipt</title><style>@page{margin:0}body{width:80mm;padding:4mm;font:12px monospace;color:#000;background:#fff}pre{white-space:pre-wrap}</style></head><body><pre>${escapeHtml(lines.join('\n'))}</pre><script>print();<\/script></body></html>`;
}

export function CounterKhataPayment(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="h-11" onClick={() => setOpen(true)}>
        Khata payment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogTitle>Receive khata payment</DialogTitle>
          <DialogDescription>
            Choose the account and tender. Cash is added to this counter’s open drawer.
          </DialogDescription>
          {open ? <KhataPaymentForm {...props} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function KhataPaymentForm(props: Props) {
  const accounts = trpc.pharmacySales.khataRepaymentAccounts.useQuery(
    { branchId: props.branchId },
    { retry: false }
  );
  const repayment = trpc.pharmacySales.recordKhataRepayment.useMutation();
  const storageKey = `devfathom.khata-payment:${props.storageScope}`;
  type SavedRequest = {
    branchId: string;
    familyAccountId: string;
    amountMinor: number;
    tender: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET';
    drawerSessionId?: string;
    occurredAt: Date;
    idempotencyKey: string;
    accountName: string;
  };
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [saved, setSaved] = useState<SavedRequest | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        parsed.branchId !== props.branchId ||
        !parsed.familyAccountId ||
        !parsed.idempotencyKey ||
        !Number.isSafeInteger(parsed.amountMinor) ||
        parsed.amountMinor <= 0 ||
        !['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET'].includes(parsed.tender) ||
        typeof parsed.accountName !== 'string' ||
        !Number.isFinite(Date.parse(parsed.occurredAt))
      )
        throw new Error('Invalid saved payment');
      return { ...parsed, occurredAt: new Date(parsed.occurredAt) };
    } catch {
      return null;
    }
  });
  const inFlight = useRef(false);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [tender, setTender] = useState<'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET'>('CASH');
  const [error, setError] = useState('');
  const [slip, setSlip] = useState<Slip | null>(null);
  const account = accounts.data?.find((row) => row.id === accountId);
  const amountMinor = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const valid =
    Number.isSafeInteger(amountMinor) &&
    amountMinor <= 2147483647 &&
    !!account &&
    amountMinor > 0 &&
    amountMinor <= account.balanceMinor &&
    (tender !== 'CASH' || !!props.drawerSessionId);

  function printSlip(value: Slip) {
    const popup = window.open('', '_blank', 'popup,width=480,height=720');
    if (!popup) {
      setError('Payment recorded. Allow pop-ups, then use Print slip.');
      return;
    }
    popup.opener = null;
    popup.document.write(buildKhataPaymentSlip(value, props.branchName));
    popup.document.close();
  }

  async function submit() {
    if (inFlight.current || (!saved && (!valid || !account)) || storageBlocked) return;
    inFlight.current = true;
    setError('');
    try {
      let request = saved;
      if (!request) {
        if (localStorage.getItem(storageKey)) {
          setStorageBlocked(true);
          throw new Error(
            'A saved payment needs to be resolved before recording another. Ask a supervisor.'
          );
        }
        request = {
          branchId: props.branchId,
          familyAccountId: account!.id,
          accountName: account!.displayName,
          amountMinor,
          tender,
          drawerSessionId: tender === 'CASH' ? props.drawerSessionId : undefined,
          occurredAt: new Date(),
          idempotencyKey: `khata:${browserUuid()}`,
        };
        const serialized = JSON.stringify(request);
        localStorage.setItem(storageKey, serialized);
        if (localStorage.getItem(storageKey) !== serialized)
          throw new Error('Payment could not be saved safely. No payment was sent.');
        setSaved(request);
      }
      const { accountName, ...payload } = request;
      const result = await repayment.mutateAsync(payload);
      const next = {
        receiptId: result.receiptId,
        accountName,
        amountMinor: result.paidMinor,
        remainingBalanceMinor: result.remainingBalanceMinor,
        tender: result.tender,
        occurredAt: new Date(result.occurredAt),
      };
      setSlip(next);
      // Preserve the accepted receipt even when clearing storage fails.
      try {
        localStorage.removeItem(storageKey);
        setSaved(null);
      } catch {
        setStorageBlocked(true);
      }
      props.onRecorded();
      printSlip(next);
    } catch (caught) {
      setError(
        `Payment has not been confirmed. Use Check saved payment before taking more money. ${counterErrorMessage(caught)}`
      );
    } finally {
      inFlight.current = false;
    }
  }

  if (saved && !slip)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          A saved khata payment must be checked before taking more money. This check uses the
          original request and cannot record it twice.
        </p>
        <Button disabled={repayment.isPending || storageBlocked} onClick={() => void submit()}>
          Check saved payment
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );

  if (accounts.isLoading)
    return (
      <p role="status" className="text-sm text-text-muted">
        Loading khata accounts…
      </p>
    );
  if (accounts.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Khata accounts could not be loaded.
      </p>
    );
  if (!accounts.data?.length)
    return (
      <p role="status" className="text-sm text-text-muted">
        No active khata accounts are available at this branch.
      </p>
    );
  if (slip)
    return (
      <div className="space-y-4" role="status">
        <p className="text-sm font-semibold text-success">Payment recorded.</p>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-text-muted">Receipt</dt>
          <dd className="break-all text-right font-mono">{slip.receiptId}</dd>
          <dt className="text-text-muted">Received</dt>
          <dd className="text-right font-mono">{formatMinor(slip.amountMinor)}</dd>
          <dt className="text-text-muted">Balance</dt>
          <dd className="text-right font-mono">{formatMinor(slip.remainingBalanceMinor)}</dd>
        </dl>
        <Button type="button" className="h-11" onClick={() => printSlip(slip)}>
          Print slip
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-warning">
            {error}
          </p>
        ) : null}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="khata-payment-account">Khata account</Label>
        <select
          id="khata-payment-account"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          className="h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-3"
        >
          <option value="">Choose an account</option>
          {accounts.data
            .filter((row) => row.balanceMinor > 0)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName} · {formatMinor(row.balanceMinor)} due
              </option>
            ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="khata-payment-amount">Amount received</Label>
        <Input
          id="khata-payment-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          aria-describedby="khata-payment-help"
        />
        <p id="khata-payment-help" className="text-xs text-text-muted">
          {account
            ? `${formatMinor(account.balanceMinor)} outstanding. Payment cannot exceed this balance.`
            : 'Choose an account to see its balance.'}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="khata-payment-tender">Tender</Label>
        <select
          id="khata-payment-tender"
          value={tender}
          onChange={(event) => setTender(event.target.value as typeof tender)}
          className="h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-3"
        >
          <option value="CASH">Cash</option>
          <option value="CARD">Card</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="WALLET">Wallet</option>
        </select>
        {tender === 'CASH' && !props.drawerSessionId ? (
          <p role="alert" className="text-sm text-warning">
            Open this counter’s cash drawer before receiving cash.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="h-11 w-full"
        disabled={!valid || repayment.isPending}
        onClick={() => void submit()}
      >
        {repayment.isPending ? 'Recording…' : 'Record payment & print slip'}
      </Button>
    </div>
  );
}
