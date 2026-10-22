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

export type BillSplit =
  | { kind: 'BY_ITEM'; groups: string[][] }
  | { kind: 'BY_SEAT' }
  | { kind: 'FRACTIONAL'; weights: number[] };

type SplitBillDialogProps = {
  items: {
    id: string;
    name: string;
    quantity: number;
    seatNumber: number | null;
    modifiers: string[];
  }[];
  disabled?: boolean;
  onSplit: (split: BillSplit) => Promise<boolean>;
};

export function SplitBillDialog({ items, disabled = false, onSplit }: SplitBillDialogProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BillSplit['kind']>('BY_ITEM');
  const [itemGroups, setItemGroups] = useState<Record<string, number>>(() =>
    Object.fromEntries(items.map((item, index) => [item.id, index + 1]))
  );
  const [weights, setWeights] = useState('1, 1');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    let split: BillSplit;
    if (kind === 'BY_ITEM') {
      const groupNumbers = [...new Set(items.map((item) => itemGroups[item.id]))].sort(
        (a, b) => a - b
      );
      if (groupNumbers.length < 2) {
        setError('Assign the items across at least two bills.');
        return;
      }
      split = {
        kind,
        groups: groupNumbers.map((group) =>
          items.filter((item) => itemGroups[item.id] === group).map((item) => item.id)
        ),
      };
    } else if (kind === 'FRACTIONAL') {
      const parsed = weights.split(',').map((weight) => Number(weight.trim()));
      if (parsed.length < 2 || parsed.some((weight) => !Number.isInteger(weight) || weight <= 0)) {
        setError('Enter at least two positive whole-number weights separated by commas.');
        return;
      }
      split = { kind, weights: parsed };
    } else {
      split = { kind };
    }

    setPending(true);
    setError(null);
    try {
      if (await onSplit(split)) setOpen(false);
      else setError('Bills were not created. Review the register message and retry.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger
        render={<Button type="button" variant="outline" className="h-11" />}
        disabled={disabled}
      >
        Split bill
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Split bill</DialogTitle>
            <DialogDescription>
              Cut bills by item, seat assignment, or fractional weight.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="split-kind">Split method</Label>
              <select
                id="split-kind"
                value={kind}
                disabled={pending}
                onChange={(event) => {
                  setKind(event.target.value as BillSplit['kind']);
                  setError(null);
                }}
                className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <option value="BY_ITEM">By item</option>
                <option value="BY_SEAT">By seat</option>
                <option value="FRACTIONAL">Fractional</option>
              </select>
            </div>
            {kind === 'BY_ITEM' ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-text-strong">Items and bills</legend>
                <p className="text-xs text-text-muted">
                  Choose the guest bill for each order line.
                </p>
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-sunken p-3"
                  >
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-text-strong">
                        {item.quantity} × {item.name}
                      </p>
                      <p className="text-xs text-text-muted">
                        {[
                          item.seatNumber === null ? null : `Seat ${item.seatNumber}`,
                          ...item.modifiers,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'No seat or modifiers'}
                      </p>
                    </div>
                    <Label className="sr-only" htmlFor={`split-item-${item.id}`}>
                      Bill for {item.name}
                    </Label>
                    <select
                      id={`split-item-${item.id}`}
                      value={itemGroups[item.id]}
                      disabled={pending}
                      onChange={(event) => {
                        setItemGroups((current) => ({
                          ...current,
                          [item.id]: Number(event.target.value),
                        }));
                        setError(null);
                      }}
                      className="h-10 shrink-0 rounded-md border border-input bg-surface-card px-2 text-sm text-text-strong"
                    >
                      {items.map((_, index) => (
                        <option key={index + 1} value={index + 1}>
                          Bill {index + 1}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </fieldset>
            ) : null}
            {kind === 'BY_SEAT' ? (
              <p className="rounded-lg border border-border-subtle bg-surface-sunken p-3 text-sm text-text-muted">
                Existing order-item seat assignments define each bill.
              </p>
            ) : null}
            {kind === 'FRACTIONAL' ? (
              <div className="space-y-1.5">
                <Label htmlFor="split-weights">Fractional weights</Label>
                <Input
                  id="split-weights"
                  value={weights}
                  disabled={pending}
                  onChange={(event) => setWeights(event.target.value)}
                  inputMode="numeric"
                  aria-describedby="split-weights-help"
                  className="h-11"
                />
                <p id="split-weights-help" className="text-xs text-text-muted">
                  Positive ratios separated by commas, for example 1, 1, 2.
                </p>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="h-11"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending} className="h-11">
              {pending ? 'Creating bills…' : 'Create split bills'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
