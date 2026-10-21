'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';

type Account = { id: string; displayName: string; balanceMinor: number };

export function KhataCollectionForm({ accounts, disabled, onCollect }: {
  accounts: readonly Account[];
  disabled?: boolean;
  onCollect: (input: { familyAccountId: string; amountMinor: number; idempotencyKey: string }) => Promise<unknown>;
}) {
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const attempt = useRef<{ familyAccountId: string; amountMinor: number; idempotencyKey: string } | null>(null);
  const account = accounts.find(a => a.id === accountId) ?? accounts[0];
  const validText = /^\d+(?:\.\d{1,2})?$/.test(amount);
  const [whole = '', fraction = ''] = amount.split('.');
  const minor = validText ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : 0;
  const valid = Number.isSafeInteger(minor) && minor > 0 && Boolean(account) && minor <= account!.balanceMinor;
  return <form className="space-y-2 border-t border-border-subtle pt-3" onSubmit={async e => {
    e.preventDefault();
    if (!valid || pending || disabled || !account) return;
    const input = { familyAccountId: account.id, amountMinor: minor };
    if (attempt.current && (attempt.current.familyAccountId !== input.familyAccountId || attempt.current.amountMinor !== minor)) {
      setMessage('Retry the pending collection before changing its account or amount.');
      return;
    }
    attempt.current ??= { ...input, idempotencyKey: crypto.randomUUID() };
    setPending(true);
    setMessage('');
    try {
      await onCollect(attempt.current);
      attempt.current = null;
      setAmount('');
      setMessage('Payment recorded.');
    } catch {
      setMessage('Could not confirm payment. Retry with the same account and amount.');
    } finally { setPending(false); }
  }}>
    <p className="font-medium text-text-strong">Record udhar payment</p>
    {accounts.length ? <>
      <Label htmlFor="khata-collection-account">Family account</Label>
      <select id="khata-collection-account" className="h-11 w-full rounded-sm border border-border-subtle bg-surface-card px-3 text-text-body focus-visible:outline-2 focus-visible:outline-ring"
        value={account?.id ?? ''} disabled={disabled || pending || Boolean(attempt.current)} onChange={e => setAccountId(e.target.value)}>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.displayName} · {formatMinor(a.balanceMinor)}</option>)}
      </select>
      <Label htmlFor="khata-collection-amount">Cash received (PKR)</Label>
      <div className="flex flex-wrap gap-2">
        <Input id="khata-collection-amount" inputMode="decimal" value={amount} className="min-w-0 flex-1"
          disabled={disabled || pending || Boolean(attempt.current)} onChange={e => setAmount(e.target.value)} />
        <Button type="submit" variant="outline" className="shadow-none transition-none hover:translate-y-0 active:translate-y-0"
          disabled={disabled || pending || !valid}>{pending ? 'Recording…' : 'Record payment'}</Button>
      </div>
    </> : <p className="text-text-muted">No family Khata account linked.</p>}
    {message ? <p role="status" className="text-sm text-text-body">{message}</p> : null}
  </form>;
}
