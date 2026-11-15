'use client';

import { useState } from 'react';

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
import {
  SALE_VOID_NOTE_MAX_LENGTH,
  SALE_VOID_REASON_CODES,
  SALE_VOID_REASONS,
  type SaleVoidReason,
  type SaleVoidReasonCode,
} from '@/lib/pharmacy/sale-void-reasons';

export type CounterVoidDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A write is in flight; the confirm stays disabled. */
  busy?: boolean;
  onConfirm: (reason: SaleVoidReason) => void;
};

/**
 * DEV-508: the counter's Void button and its Shift+F4 chord only open this
 * dialog. The bill is voided after a reason is chosen and the void is confirmed,
 * so one stray keypress cannot reach a persistent sale-status change.
 */
export function CounterVoidDialog({
  open,
  onOpenChange,
  busy = false,
  onConfirm,
}: CounterVoidDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted only while open, so every void starts with no reason chosen. */}
        <CounterVoidForm busy={busy} onCancel={() => onOpenChange(false)} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

function CounterVoidForm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: SaleVoidReason) => void;
}) {
  const [choice, setChoice] = useState<SaleVoidReasonCode | null>(null);
  const [other, setOther] = useState('');
  const note = other.trim();
  // The server refuses a void without a code, and "Other" without a description.
  const reason: SaleVoidReason | null =
    choice === null
      ? null
      : choice === 'OTHER'
        ? note
          ? { code: 'OTHER', note }
          : null
        : { code: choice };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !reason) return;
        onConfirm(reason);
      }}
    >
      <DialogHeader>
        <DialogTitle>Void this bill?</DialogTitle>
        <DialogDescription>
          The bill is cancelled and its stock goes back on sale. A voided bill cannot be resumed.
        </DialogDescription>
      </DialogHeader>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium text-text-strong">Reason</legend>
        {SALE_VOID_REASON_CODES.map((option) => (
          <label
            key={option}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-xs)] border border-border-subtle px-3 text-sm text-text-body has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken"
          >
            <input
              type="radio"
              name="counter-void-reason"
              value={option}
              checked={choice === option}
              onChange={() => setChoice(option)}
              className="size-4 accent-[var(--primary)]"
            />
            {SALE_VOID_REASONS[option]}
          </label>
        ))}
        {choice === 'OTHER' ? (
          <div className="space-y-1.5">
            <Label htmlFor="counter-void-other">Describe the reason</Label>
            <Input
              id="counter-void-other"
              autoComplete="off"
              autoFocus
              maxLength={SALE_VOID_NOTE_MAX_LENGTH}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              className="h-11"
            />
          </div>
        ) : null}
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
          Keep bill
        </Button>
        <Button type="submit" variant="destructive" className="h-11" disabled={busy || !reason}>
          Void bill
        </Button>
      </DialogFooter>
    </form>
  );
}
