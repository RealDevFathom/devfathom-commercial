'use client';

import { useState, type FormEvent } from 'react';
import {
  RestaurantStaffSelect,
  type RestaurantStaffOption,
} from '@/components/restaurant/restaurant-staff-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TerminalRequest } from './checkout-panel';

type Line = { id: string; billId: string; name: string; quantity: number; lineTotal: string };
const calm = 'h-8 shadow-none transition-none hover:translate-y-0 active:translate-y-0';

export function CompPanel({
  orderId,
  request,
  operators,
  actingOperatorId,
  disabled,
  onApplied,
}: {
  orderId: string | null;
  request: TerminalRequest;
  operators: RestaurantStaffOption[];
  actingOperatorId: string;
  disabled: boolean;
  onApplied: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [lineId, setLineId] = useState('');
  const [reason, setReason] = useState('');
  const [managerId, setManagerId] = useState('');
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managers = operators.filter((operator) => operator.id !== actingOperatorId);
  const selected = lines.find((line) => line.id === lineId);

  async function load() {
    setOpen(true);
    setPending(true);
    setError(null);
    setLines([]);
    setLineId('');
    setReason('');
    setManagerId('');
    setPin('');
    try {
      const result = await request<{ lines: Line[] }>(
        `/api/restaurant/checkout/comp?orderId=${encodeURIComponent(orderId!)}`
      );
      setLines(result.lines);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Comp access unavailable.');
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      pending ||
      disabled ||
      !selected ||
      !reason.trim() ||
      !pin ||
      !managers.some((manager) => manager.id === managerId)
    )
      return;
    setPending(true);
    setError(null);
    try {
      await request('/api/restaurant/checkout/comp', {
        method: 'POST',
        intent: 'comp-line',
        body: {
          billId: selected.billId,
          billLineId: selected.id,
          reason: reason.trim(),
          approving: { staffProfileId: managerId, type: 'PIN', secret: pin },
        },
      });
      setPin('');
      setOpen(false);
      await onApplied();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Comp was not completed. Retry safely.');
    } finally {
      setPending(false);
      setPin('');
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={calm}
        disabled={disabled || !orderId}
        onClick={() => void load()}
      >
        Comp
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            setOpen(next);
            setPin('');
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto data-open:animate-none data-closed:animate-none"
          overlayClassName="data-open:animate-none data-closed:animate-none"
        >
          <DialogHeader>
            <DialogTitle>Comp a bill line</DialogTitle>
            <DialogDescription>
              Remove the line charge and its service with manager approval.
            </DialogDescription>
          </DialogHeader>
          {pending && !lines.length ? <p role="status">Loading bill lines…</p> : null}
          {!pending && !error && !lines.length ? (
            <p className="text-text-muted">
              No open bill lines. Cut a bill before applying a comp.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {lines.length ? (
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="comp-line">Bill line</Label>
                <select
                  id="comp-line"
                  required
                  disabled={pending || disabled}
                  value={lineId}
                  onChange={(event) => setLineId(event.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="">Choose line</option>
                  {lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.quantity} × {line.name} · {line.lineTotal}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="comp-reason">Comp reason</Label>
                <Input
                  id="comp-reason"
                  required
                  disabled={pending || disabled}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="comp-manager">Approving manager</Label>
                <RestaurantStaffSelect
                  id="comp-manager"
                  label="Approving manager"
                  required
                  disabled={pending || disabled}
                  staff={managers}
                  value={managerId}
                  onChange={setManagerId}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="comp-pin">Manager PIN</Label>
                <Input
                  id="comp-pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{4,8}"
                  minLength={4}
                  maxLength={8}
                  autoComplete="off"
                  required
                  disabled={pending || disabled}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                className={`${calm} w-full`}
                disabled={
                  pending || disabled || !selected || !reason.trim() || !managerId || pin.length < 4
                }
              >
                {pending ? 'Applying comp…' : 'Confirm comp'}
              </Button>
            </form>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className={calm}
            disabled={pending}
            onClick={() => {
              setOpen(false);
              setPin('');
            }}
          >
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
