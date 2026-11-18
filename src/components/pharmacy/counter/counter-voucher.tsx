'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { trpc } from '@/lib/trpc';

/** A voucher the cashier has checked and confirmed with their own PIN for the next item. */
export type CounterHeldVoucher = {
  id: string;
  code: string;
  name: string;
  discountMinor: number;
  pin: string;
};

type Looked = {
  id: string;
  code: string;
  name: string;
  discountMinor: number;
  usesLeft: number;
  maxUses: number;
  validUntil: Date | string;
  status: 'READY' | 'REVOKED' | 'EXPIRED' | 'USED_UP';
};

const VOUCHER_CODE = /^[A-Za-z0-9-]{3,40}$/;
const PIN = /^\d{4,8}$/;

const STATUS_MESSAGE: Record<Exclude<Looked['status'], 'READY'>, string> = {
  REVOKED: 'This voucher was revoked and cannot be used.',
  EXPIRED: 'This voucher has expired.',
  USED_UP: 'This voucher has reached its use limit.',
};

/**
 * DEV-780: the counter's place to enter or scan a voucher. The cashier checks the code, then
 * confirms with their own PIN; the voucher is sent with the next item added. The server
 * re-checks the PIN, expiry, revocation, use limit and non-drug item rule when it redeems,
 * and refuses the voucher once its use limit is reached.
 */
export function CounterVoucherEntry({
  branchId,
  held,
  disabled,
  onHold,
  onClear,
}: {
  branchId: string;
  held: CounterHeldVoucher | null;
  disabled: boolean;
  onHold: (voucher: CounterHeldVoucher) => void;
  onClear: () => void;
}) {
  const utils = trpc.useUtils();
  const id = useId();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [looked, setLooked] = useState<Looked | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const check = async () => {
    const trimmed = code.trim();
    setLooked(null);
    if (!VOUCHER_CODE.test(trimmed)) {
      setMessage({
        error: true,
        text: 'Enter the voucher code: 3 to 40 letters, numbers or dashes.',
      });
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      const found = await utils.pharmacySales.counterVoucher.fetch({ branchId, code: trimmed });
      if (!found) {
        setMessage({ error: true, text: 'No voucher with this code at this branch.' });
        return;
      }
      setLooked(found);
      if (found.status !== 'READY') setMessage({ error: true, text: STATUS_MESSAGE[found.status] });
    } catch (error) {
      setMessage({ error: true, text: counterErrorMessage(error) });
    } finally {
      setChecking(false);
    }
  };

  if (held) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm"
        role="status"
      >
        <p className="min-w-0 text-text-body">
          Voucher <span className="font-mono">{held.code}</span> ({held.name}) takes Rs{' '}
          {formatMinor(held.discountMinor)} off the next non-drug item you add.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={onClear}
        >
          Remove voucher
        </Button>
      </div>
    );
  }

  return (
    <details className="rounded-md border border-border-subtle p-3 text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-2 focus-visible:outline-ring">
        Voucher
      </summary>
      <form
        className="mt-3 space-y-3"
        aria-busy={checking}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || checking) return;
          if (!looked || looked.status !== 'READY' || looked.code !== code.trim().toUpperCase()) {
            void check();
            return;
          }
          if (!PIN.test(pin)) {
            setMessage({ error: true, text: 'Enter your own PIN to redeem this voucher.' });
            return;
          }
          onHold({
            id: looked.id,
            code: looked.code,
            name: looked.name,
            discountMinor: looked.discountMinor,
            pin,
          });
          setPin('');
          setCode('');
          setLooked(null);
          setMessage(null);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-code`}>Voucher code</Label>
            <Input
              id={`${id}-code`}
              className="h-11 font-mono uppercase"
              value={code}
              autoComplete="off"
              maxLength={40}
              disabled={disabled || checking}
              aria-invalid={message?.error && !looked ? true : undefined}
              aria-describedby={message ? `${id}-message` : undefined}
              onChange={(event) => {
                setCode(event.target.value);
                setLooked(null);
                setMessage(null);
              }}
            />
          </div>
          {looked?.status === 'READY' ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-pin`}>Your PIN</Label>
              <Input
                id={`${id}-pin`}
                className="h-11"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={pin}
                disabled={disabled}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              />
            </div>
          ) : null}
        </div>
        {looked?.status === 'READY' ? (
          <p className="text-text-body">
            {looked.name}: Rs {formatMinor(looked.discountMinor)} off one non-drug item.{' '}
            {looked.usesLeft} of {looked.maxUses} {looked.maxUses === 1 ? 'use' : 'uses'} left.
          </p>
        ) : null}
        {message ? (
          <p
            id={`${id}-message`}
            role={message.error ? 'alert' : 'status'}
            className={message.error ? 'text-destructive' : 'text-text-body'}
          >
            {message.text}
          </p>
        ) : null}
        <Button type="submit" className="min-h-11" disabled={disabled || checking}>
          {checking
            ? 'Checking…'
            : looked?.status === 'READY'
              ? 'Use on next item'
              : 'Check voucher'}
        </Button>
      </form>
    </details>
  );
}
