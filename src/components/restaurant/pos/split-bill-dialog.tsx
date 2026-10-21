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
import { Textarea } from '@/components/ui/textarea';

export type BillSplit =
  | { kind: 'BY_ITEM'; groups: string[][] }
  | { kind: 'BY_SEAT' }
  | { kind: 'FRACTIONAL'; weights: number[] };

type SplitBillDialogProps = {
  itemIds: string[];
  disabled?: boolean;
  onSplit: (split: BillSplit) => Promise<boolean>;
};

export function SplitBillDialog({ itemIds, disabled = false, onSplit }: SplitBillDialogProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BillSplit['kind']>('BY_ITEM');
  const [groups, setGroups] = useState(itemIds.join('\n'));
  const [weights, setWeights] = useState('1, 1');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    let split: BillSplit;
    if (kind === 'BY_ITEM') {
      const parsed = groups
        .split('\n')
        .map((group) =>
          group
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        )
        .filter((group) => group.length > 0);
      const assigned = parsed.flat();
      if (
        parsed.length < 2 ||
        assigned.length !== itemIds.length ||
        new Set(assigned).size !== assigned.length ||
        assigned.some((id) => !itemIds.includes(id))
      ) {
        setError('Use every unbilled item ID once across at least two lines.');
        return;
      }
      split = { kind, groups: parsed };
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
                <Label htmlFor="split-groups">Item groups</Label>
                <Textarea
                  id="split-groups"
                  value={groups}
                  disabled={pending}
                  onChange={(event) => setGroups(event.target.value)}
                  aria-describedby="split-groups-help"
                  className="min-h-28 font-mono text-sm"
                />
                <p id="split-groups-help" className="text-xs text-text-muted">
                  One bill per line; separate item IDs on one bill with commas.
                </p>
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
