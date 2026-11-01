'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { trpc } from '@/lib/trpc';

type Consent = 'CUSTOMER_REQUEST' | 'COUNTER_OPT_IN';
type Notice = { tone: 'success' | 'danger'; message: string } | null;

const OUTCOME_MESSAGES: Record<string, string> = {
  QUEUED: 'Receipt link queued for WhatsApp delivery.',
  SENT: 'Receipt link sent on WhatsApp.',
  PREPARED: 'Receipt link prepared. WhatsApp delivery is not enabled for this workspace.',
  UNKNOWN: 'Receipt link sent; WhatsApp has not confirmed delivery yet.',
  FAILED: 'WhatsApp could not deliver the receipt link.',
  DUPLICATE: 'This receipt link was already sent.',
};

/**
 * Staff entry point for the hosted WhatsApp receipt: sends a neutral, expiring
 * link to the customer's number with their recorded consent, and revokes every
 * live link for the sale (wrong number, customer request).
 */
export function CounterHostedReceipt({
  branchId,
  saleId,
  disabled = false,
}: {
  branchId: string;
  saleId: string;
  disabled?: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState<Consent | ''>('');
  const [notice, setNotice] = useState<Notice>(null);
  const send = trpc.pharmacySales.sendHostedReceipt.useMutation({
    onSuccess: (result) =>
      setNotice({
        tone: ['FAILED'].includes(result.outcome) ? 'danger' : 'success',
        message: OUTCOME_MESSAGES[result.outcome] ?? 'Receipt link processed.',
      }),
    onError: (error) => setNotice({ tone: 'danger', message: counterErrorMessage(error) }),
  });
  const revoke = trpc.pharmacySales.revokeHostedReceipts.useMutation({
    onSuccess: (result) =>
      setNotice({
        tone: 'success',
        message:
          result.revoked > 0
            ? `${result.revoked} receipt link${result.revoked === 1 ? '' : 's'} revoked.`
            : 'No live receipt links to revoke.',
      }),
    onError: (error) => setNotice({ tone: 'danger', message: counterErrorMessage(error) }),
  });
  const busy = disabled || send.isPending || revoke.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent) return;
    setNotice(null);
    send.mutate({ branchId, saleId, phone, consent });
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Send receipt link on WhatsApp">
      <div className="space-y-1.5">
        <Label htmlFor="hosted-receipt-phone">Customer WhatsApp number</Label>
        <Input
          id="hosted-receipt-phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={32}
          required
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={busy}
          className="min-h-11"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="hosted-receipt-consent">Customer consent</Label>
        <select
          id="hosted-receipt-consent"
          required
          value={consent}
          disabled={busy}
          onChange={(event) => setConsent(event.target.value as Consent | '')}
          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="">Choose how the customer agreed</option>
          <option value="CUSTOMER_REQUEST">Customer asked for a WhatsApp receipt</option>
          <option value="COUNTER_OPT_IN">Customer opted in at the counter</option>
        </select>
      </div>
      {notice ? (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={notice.tone === 'danger' ? 'text-sm text-destructive' : 'text-sm text-success'}
        >
          {notice.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="min-h-11 flex-1"
          disabled={busy || !consent || phone.trim().length < 8}
        >
          {send.isPending ? 'Sending…' : 'Send receipt link'}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="min-h-11"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Revoke every live receipt link for this sale?')) return;
            setNotice(null);
            revoke.mutate({ branchId, saleId });
          }}
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke links'}
        </Button>
      </div>
    </form>
  );
}
