import { type FormEvent, useMemo, useState } from 'react';

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
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';

export type OrderItem = {
  id: string;
  course: number;
  seatNumber: number | null;
  name: string;
  unitPrice: string;
  quantity: number;
  status: string;
  modifiers: { id: string; name: string; priceDelta: string }[];
};

export type OrderDetail = {
  id: string;
  orderNumber: number;
  status: string;
  channel: string;
  coverCount: number | null;
  items: OrderItem[];
  tables: { id: string; tableId: string; active: boolean }[];
  totals: { subtotal: string; tax: string; serviceCharge: string };
};

export type VoidItemInput = {
  itemId: string;
  reason: string;
  wastageDisposition?: 'WASTE' | 'RESTOCK' | 'NONE';
  approving?: { staffProfileId: string; type: 'PIN'; secret: string };
};

type OrderTicketPanelProps = {
  order: OrderDetail | null;
  pending: boolean;
  onHold: (course: number) => void;
  onFire: (course: number) => void;
  onSend: () => void;
  onServed: (itemId: string) => void;
  onRemake: (itemId: string, reason: string) => void;
  onVoid: (input: VoidItemInput) => void;
  onMove: (fromTableId: string, toTableId: string) => void;
  onMerge: (tableIds: string[]) => void;
  onClose: () => void;
};

const POST_PREP = new Set(['FIRING', 'PREPARED', 'SERVED', 'REMAKE_REQUESTED']);

function tone(status: string): StatusTone {
  if (['PREPARED', 'SERVED', 'CLOSED'].includes(status)) return 'success';
  if (['FIRING', 'QUEUED', 'PAYMENT_PENDING'].includes(status)) return 'warning';
  if (['VOIDED', 'CANCELLED'].includes(status)) return 'danger';
  return 'neutral';
}

function ids(value: string) {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function OrderTicketPanel({
  order,
  pending,
  onHold,
  onFire,
  onSend,
  onServed,
  onRemake,
  onVoid,
  onMove,
  onMerge,
  onClose,
}: OrderTicketPanelProps) {
  const [voidItem, setVoidItem] = useState<OrderItem | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [disposition, setDisposition] = useState<'WASTE' | 'RESTOCK' | 'NONE'>('WASTE');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [remakeReasons, setRemakeReasons] = useState<Record<string, string>>({});
  const [fromTableId, setFromTableId] = useState('');
  const [toTableId, setToTableId] = useState('');
  const [mergeIds, setMergeIds] = useState('');

  const courses = useMemo(() => {
    const grouped = new Map<number, OrderItem[]>();
    for (const item of order?.items ?? []) {
      grouped.set(item.course, [...(grouped.get(item.course) ?? []), item]);
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right);
  }, [order]);

  function openVoid(item: OrderItem) {
    setVoidItem(item);
    setVoidReason('');
    setManagerId('');
    setManagerPin('');
    setDisposition('WASTE');
    setVoidError(null);
  }

  function submitVoid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!voidItem || !voidReason.trim() || pending) return;
    const postPrep = POST_PREP.has(voidItem.status);
    if (postPrep && (!managerId.trim() || !/^\d{4,8}$/.test(managerPin))) {
      setVoidError('Enter manager profile ID and a 4–8 digit PIN.');
      return;
    }
    onVoid({
      itemId: voidItem.id,
      reason: voidReason.trim(),
      ...(postPrep
        ? {
            wastageDisposition: disposition,
            approving: { staffProfileId: managerId.trim(), type: 'PIN' as const, secret: managerPin },
          }
        : {}),
    });
    setVoidItem(null);
  }

  if (!order) {
    return (
      <SectionCard eyebrow="Order ticket" title="No active order">
        <p className="text-sm text-text-muted">Open or resume an order to build its ticket.</p>
      </SectionCard>
    );
  }

  const activeTables = order.tables.filter((table) => table.active).map((table) => table.tableId);

  return (
    <>
      <SectionCard
        eyebrow="Order ticket"
        title={`Order ${order.orderNumber}`}
        actions={<StatusPill status={order.status} tone={tone(order.status)} />}
        className="min-w-0"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-4 text-sm text-text-muted">
          <span>{order.channel.replaceAll('_', ' ')}</span>
          <span>{activeTables.length ? `Tables ${activeTables.join(', ')}` : 'No table'}</span>
          <Button type="button" onClick={onSend} disabled={pending} className="h-11">
            Send whole order
          </Button>
        </div>

        {courses.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">Ticket empty. Select menu items.</p>
        ) : (
          <div className="space-y-4">
            {courses.map(([course, items]) => (
              <section key={course} className="rounded-lg border border-border-subtle bg-surface-sunken p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-mono text-xs font-semibold tracking-wide text-text-muted uppercase">
                    Course {course}
                  </h3>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onHold(course)}
                      disabled={pending}
                      className="h-11"
                    >
                      Hold
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onFire(course)}
                      disabled={pending}
                      className="h-11"
                    >
                      Fire
                    </Button>
                  </div>
                </div>
                <ul className="divide-y divide-border-subtle">
                  {items.map((item) => {
                    const canRemake = ['PREPARED', 'SERVED'].includes(item.status);
                    return (
                      <li key={item.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-text-strong">
                              {item.quantity} × {item.name}
                              {item.seatNumber ? ` · Seat ${item.seatNumber}` : ''}
                            </p>
                            {item.modifiers.length ? (
                              <p className="mt-1 text-xs text-text-muted">
                                {item.modifiers.map((modifier) => modifier.name).join(', ')}
                              </p>
                            ) : null}
                          </div>
                          <StatusPill status={item.status} tone={tone(item.status)} />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {item.status === 'PREPARED' ? (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => onServed(item.id)}
                              disabled={pending}
                              className="h-11"
                            >
                              Mark served
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => openVoid(item)}
                            disabled={pending || item.status === 'VOIDED'}
                            className="h-11"
                          >
                            Void {item.name}
                          </Button>
                        </div>
                        {canRemake ? (
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <div className="min-w-0 flex-1">
                              <Label htmlFor={`remake-${item.id}`} className="sr-only">
                                Remake reason for {item.name}
                              </Label>
                              <Input
                                id={`remake-${item.id}`}
                                value={remakeReasons[item.id] ?? ''}
                                onChange={(event) =>
                                  setRemakeReasons((current) => ({
                                    ...current,
                                    [item.id]: event.target.value,
                                  }))
                                }
                                placeholder="Remake reason"
                                className="h-11"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={pending || !remakeReasons[item.id]?.trim()}
                              onClick={() => onRemake(item.id, remakeReasons[item.id].trim())}
                              className="h-11"
                            >
                              Request remake
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <div className="mt-5 grid gap-3 border-t border-border-subtle pt-5 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border-subtle p-3">
            <p className="text-sm font-semibold text-text-strong">Move table</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="move-from">From table ID</Label>
                <Input
                  id="move-from"
                  value={fromTableId}
                  onChange={(event) => setFromTableId(event.target.value)}
                  placeholder={activeTables[0] ?? 'table-id'}
                  className="mt-1.5 h-11"
                />
              </div>
              <div>
                <Label htmlFor="move-to">To table ID</Label>
                <Input
                  id="move-to"
                  value={toTableId}
                  onChange={(event) => setToTableId(event.target.value)}
                  placeholder="table-id"
                  className="mt-1.5 h-11"
                />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending || !fromTableId.trim() || !toTableId.trim()}
              onClick={() => onMove(fromTableId.trim(), toTableId.trim())}
              className="h-11 w-full"
            >
              Move order
            </Button>
          </div>
          <div className="space-y-2 rounded-lg border border-border-subtle p-3">
            <p className="text-sm font-semibold text-text-strong">Merge tables</p>
            <Label htmlFor="merge-tables">Additional table IDs</Label>
            <Input
              id="merge-tables"
              value={mergeIds}
              onChange={(event) => setMergeIds(event.target.value)}
              placeholder="table-id-2, table-id-3"
              className="h-11"
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending || ids(mergeIds).length === 0}
              onClick={() => onMerge(ids(mergeIds))}
              className="h-11 w-full"
            >
              Merge tables
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <div className="font-mono text-sm tabular-nums text-text-muted">
            Subtotal {order.totals.subtotal} · Tax {order.totals.tax} · Service{' '}
            {order.totals.serviceCharge}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
            className="h-11"
          >
            Close order
          </Button>
        </div>
      </SectionCard>

      <Dialog
        open={Boolean(voidItem)}
        onOpenChange={(open) => {
          if (!open && !pending) setVoidItem(null);
        }}
      >
        <DialogContent showCloseButton={!pending} className="sm:max-w-lg">
          <form onSubmit={submitVoid}>
            <DialogHeader>
              <DialogTitle>Void {voidItem?.name}</DialogTitle>
              <DialogDescription>
                {voidItem && POST_PREP.has(voidItem.status)
                  ? 'Post-preparation void requires manager approval and wastage disposition.'
                  : 'Record a reason before removing this item.'}
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="void-reason">Void reason</Label>
                <Textarea
                  id="void-reason"
                  required
                  value={voidReason}
                  onChange={(event) => setVoidReason(event.target.value)}
                  className="min-h-24"
                />
              </div>
              {voidItem && POST_PREP.has(voidItem.status) ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="manager-id">Approving manager profile ID</Label>
                    <Input
                      id="manager-id"
                      required
                      value={managerId}
                      onChange={(event) => setManagerId(event.target.value)}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="manager-pin">Manager PIN</Label>
                    <Input
                      id="manager-pin"
                      type="password"
                      required
                      inputMode="numeric"
                      pattern="[0-9]{4,8}"
                      minLength={4}
                      maxLength={8}
                      value={managerPin}
                      onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, ''))}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wastage-disposition">Wastage disposition</Label>
                    <select
                      id="wastage-disposition"
                      value={disposition}
                      onChange={(event) =>
                        setDisposition(event.target.value as 'WASTE' | 'RESTOCK' | 'NONE')
                      }
                      className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="WASTE">Waste</option>
                      <option value="RESTOCK">Restock</option>
                      <option value="NONE">None</option>
                    </select>
                  </div>
                </>
              ) : null}
              {voidError ? (
                <p role="alert" className="text-sm text-destructive">
                  {voidError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setVoidItem(null)}
                disabled={pending}
                className="h-11"
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pending} className="h-11">
                {pending ? 'Voiding…' : 'Confirm void'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
