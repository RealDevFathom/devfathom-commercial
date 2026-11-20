'use client';

import { type RefObject, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
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
 *
 * DEV-972: it sits on the bill side as a compact "Voucher" button that opens a small panel,
 * and one short line with its remove action while a voucher is held, so nothing comes between
 * the search box and its results. Escape (or using the voucher) closes the panel and focus
 * returns to `returnFocus`.
 */
export function CounterVoucherEntry({
  branchId,
  held,
  disabled,
  onHold,
  onClear,
  returnFocus,
}: {
  branchId: string;
  held: CounterHeldVoucher | null;
  disabled: boolean;
  onHold: (voucher: CounterHeldVoucher) => void;
  onClear: () => void;
  /** Where focus goes when the panel closes (the counter's search box). */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const utils = trpc.useUtils();
  const id = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
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
        role="status"
        title={`Voucher ${held.code} (${held.name}) takes Rs ${formatMinor(held.discountMinor)} off the next non-drug item you add.`}
        className="flex min-w-0 items-center gap-1 rounded-xs bg-surface-sunken ps-3 text-sm"
      >
        <span className="min-w-0 truncate text-text-body">
          Voucher {held.code} applied: Rs {formatMinor(held.discountMinor)} off
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Remove voucher"
          disabled={disabled}
          onClick={onClear}
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" className="min-h-11" />}>
        Voucher
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-h-(--available-height) w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
        initialFocus={codeRef}
        finalFocus={returnFocus ?? true}
      >
        <PopoverTitle className="text-sm font-semibold text-text-strong">
          Voucher for the next item
        </PopoverTitle>
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
            setOpen(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-code`}>Voucher code</Label>
              <Input
                ref={codeRef}
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
      </PopoverContent>
    </Popover>
  );
}
