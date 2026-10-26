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

function createAssignments(items: SplitBillDialogProps['items']) {
  return Object.fromEntries(items.map((item, index) => [item.id, index + 1]));
}

export function SplitBillDialog({ items, disabled = false, onSplit }: SplitBillDialogProps) {
  const itemIdentity = JSON.stringify(items.map((item) => item.id).sort());
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BillSplit['kind']>('BY_ITEM');
  const [assignments, setAssignments] = useState<Record<string, number>>(() =>
    createAssignments(items)
  );
  const [assignmentItemIdentity, setAssignmentItemIdentity] = useState(itemIdentity);
  const [weights, setWeights] = useState('1, 1');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (assignmentItemIdentity !== itemIdentity) {
    setAssignmentItemIdentity(itemIdentity);
    setAssignments(createAssignments(items));
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    let split: BillSplit;
    if (kind === 'BY_ITEM') {
      if (
        items.some(
          (item) =>
            !Number.isInteger(assignments[item.id]) ||
            assignments[item.id] < 1 ||
            assignments[item.id] > items.length
        )
      ) {
        setError('Choose a valid guest bill for every order line.');
        return;
      }
      const billNumbers = [...new Set(items.map((item) => assignments[item.id]))].sort(
        (a, b) => a - b
      );
      if (billNumbers.length < 2) {
        setError('Assign the order lines to at least two bills.');
        return;
      }
      split = {
        kind,
        groups: billNumbers.map((billNumber) =>
          items.filter((item) => assignments[item.id] === billNumber).map((item) => item.id)
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
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-text-strong">Order lines</p>
                <p id="split-groups-help" className="text-xs text-text-muted">
                  Choose the guest bill for each item. Items assigned to the same bill stay
                  together.
                </p>
                <div
                  className="max-h-72 space-y-2 overflow-y-auto"
                  aria-describedby="split-groups-help"
                >
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface-sunken p-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-text-strong">
                          {item.quantity} × {item.name}
                        </p>
                        <p className="text-xs text-text-muted">
                          {[
                            item.seatNumber === null ? 'No seat' : `Seat ${item.seatNumber}`,
                            ...item.modifiers,
                          ].join(' · ')}
                        </p>
                      </div>
                      <div className="w-24 shrink-0">
                        <Label htmlFor={`split-item-${item.id}`} className="text-xs">
                          Guest bill
                        </Label>
                        <select
                          id={`split-item-${item.id}`}
                          aria-label={`Guest bill for ${item.name}`}
                          value={assignments[item.id]}
                          disabled={pending}
                          onChange={(event) => {
                            setAssignments((current) => ({
                              ...current,
                              [item.id]: Number(event.target.value),
                            }));
                            setError(null);
                          }}
                          className="mt-1 h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                        >
                          {items.map((_, index) => (
                            <option key={index + 1} value={index + 1}>
                              Bill {index + 1}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
