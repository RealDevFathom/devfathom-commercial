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
import type { RestaurantStaffOption } from '@/components/restaurant/restaurant-staff-select';
import { RestaurantStaffSelect } from '@/components/restaurant/restaurant-staff-select';

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
  deliveryStatus?: string | null;
  settled?: boolean;
  publicationId: string | null;
  coverCount: number | null;
  items: OrderItem[];
  kitchenTickets: Array<{ id: string; ticketNumber: number; stationId: string }>;
  tables: { id: string; tableId: string; active: boolean }[];
  totals: { subtotal: string; tax: string; serviceCharge: string; deliveryFee?: string };
};

export function canCloseDeliveredOrder(
  order: Pick<OrderDetail, 'channel' | 'deliveryStatus' | 'settled'>
) {
  return (
    order.channel === 'DELIVERY' && order.deliveryStatus === 'DELIVERED' && order.settled === true
  );
}

export type VoidItemInput = {
  itemId: string;
  reason: string;
  wastageDisposition?: 'WASTE' | 'RESTOCK' | 'NONE';
  approving?: { staffProfileId: string; type: 'PIN'; secret: string };
};

type OrderTicketPanelProps = {
  order: OrderDetail | null;
  actingOperatorId: string;
  operators?: RestaurantStaffOption[];
  pending: boolean;
  tables?: Array<{ id: string; label: string; occupied: boolean; activeOrderIds: string[] }>;
  onHold: (course: number) => void;
  onFire: (course: number) => void;
  onSend: () => void;
  onReprint: (ticketId: string) => void;
  onServed: (itemId: string) => void;
  onRemake: (itemId: string, reason: string) => void;
  onVoid: (input: VoidItemInput) => Promise<boolean>;
  onMove: (fromTableId: string, toTableId: string) => void;
  onMerge: (tableIds: string[]) => void;
  onClose: () => void;
  onCollectPayment: () => void;
};

const POST_PREP = new Set(['FIRING', 'PREPARED', 'SERVED', 'REMAKE_REQUESTED']);

function tone(status: string): StatusTone {
  if (['PREPARED', 'SERVED', 'CLOSED'].includes(status)) return 'success';
  if (['FIRING', 'QUEUED', 'PAYMENT_PENDING'].includes(status)) return 'warning';
  if (['VOIDED', 'CANCELLED'].includes(status)) return 'danger';
  return 'neutral';
}

export function OrderTicketPanel({
  order,
  actingOperatorId,
  operators = [],
  pending,
  tables = [],
  onHold,
  onFire,
  onSend,
  onReprint,
  onServed,
  onRemake,
  onVoid,
  onMove,
  onMerge,
  onClose,
  onCollectPayment,
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
  const [mergeIds, setMergeIds] = useState<string[]>([]);

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

  async function submitVoid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!voidItem || !voidReason.trim() || pending) return;
    const postPrep = POST_PREP.has(voidItem.status);
    if (postPrep && (!managerId.trim() || !/^\d{4,8}$/.test(managerPin))) {
      setVoidError('Select a manager and enter their 4–8 digit PIN.');
      return;
    }
    if (postPrep && managerId.trim() === actingOperatorId) {
      setVoidError('The acting operator cannot approve their own void.');
      return;
    }
    setVoidError(null);
    const succeeded = await onVoid({
      itemId: voidItem.id,
      reason: voidReason.trim(),
      ...(postPrep
        ? {
            wastageDisposition: disposition,
            approving: {
              staffProfileId: managerId.trim(),
              type: 'PIN' as const,
              secret: managerPin,
            },
          }
        : {}),
    });
    if (succeeded) setVoidItem(null);
    else setVoidError('Void was not completed. Review the error and try again.');
  }

  if (!order) {
    return (
      <SectionCard compact eyebrow="Order ticket" title="No active order" className="h-full">
        <p className="text-sm text-text-muted">Open or resume an order to build its ticket.</p>
      </SectionCard>
    );
  }

  const activeTables = order.tables.filter((table) => table.active).map((table) => table.tableId);
  const tableLabel = (id: string) =>
    tables.find((table) => table.id === id)?.label ?? 'Current table';
  const availableDestinations = tables.filter(
    (table) =>
      !activeTables.includes(table.id) &&
      (!table.occupied || table.activeOrderIds.includes(order.id))
  );
  const shouldCollectPayment =
    !canCloseDeliveredOrder(order) &&
    (order.status === 'PAYMENT_PENDING' || order.channel === 'DELIVERY');

  return (
    <>
      <SectionCard
        compact
        eyebrow="Order ticket"
        title={`Order ${order.orderNumber}`}
        actions={<StatusPill status={order.status} tone={tone(order.status)} />}
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-2 text-xs text-text-muted">
            <span>
              {order.channel === 'DINE_IN'
                ? 'Dine in'
                : order.channel === 'TAKEAWAY'
                  ? 'Takeaway'
                  : 'Delivery'}
            </span>
            <span>
              {activeTables.length ? activeTables.map(tableLabel).join(', ') : 'No table'}
            </span>
            <Button
              type="button"
              onClick={onSend}
              disabled={pending}
              className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
            >
              Send whole order
            </Button>
          </div>

          {(order.kitchenTickets?.length ?? 0) > 0 ? (
            <div
              className="mb-2 flex shrink-0 flex-wrap gap-1"
              aria-label="Kitchen ticket reprints"
            >
              {order.kitchenTickets?.map((ticket) => (
                <Button
                  key={ticket.id}
                  type="button"
                  variant="outline"
                  onClick={() => onReprint(ticket.id)}
                  disabled={pending}
                  className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                >
                  Reprint KOT {ticket.ticketNumber}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {courses.length === 0 ? (
              <p className="py-2 text-center text-sm text-text-muted">
                Ticket empty. Select menu items.
              </p>
            ) : (
              <div className="space-y-2">
                {courses.map(([course, items]) => (
                  <section key={course} className="rounded-md border border-border-subtle p-2">
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
                          className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                        >
                          Hold
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => onFire(course)}
                          disabled={pending}
                          className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                        >
                          Fire
                        </Button>
                      </div>
                    </div>
                    <ul className="divide-y divide-border-subtle">
                      {items.map((item) => {
                        const canRemake = ['PREPARED', 'SERVED'].includes(item.status);
                        return (
                          <li key={item.id} className="space-y-1 py-2 first:pt-0 last:pb-0">
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
                              {['PREPARED', 'REMAKE_REQUESTED'].includes(item.status) ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => onServed(item.id)}
                                  disabled={pending}
                                  className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                                >
                                  Mark served
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="destructive"
                                onClick={() => openVoid(item)}
                                disabled={pending || item.status === 'VOIDED'}
                                className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
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
                                    className="h-8"
                                  />
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={pending || !remakeReasons[item.id]?.trim()}
                                  onClick={() => onRemake(item.id, remakeReasons[item.id].trim())}
                                  className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
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

            {order.channel === 'DINE_IN' ? (
              <div className="mt-5 grid gap-3 border-t border-border-subtle pt-5 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border-subtle p-3">
                  <p className="text-sm font-semibold text-text-strong">Move table</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="move-from">Current table</Label>
                      <select
                        id="move-from"
                        value={fromTableId}
                        onChange={(event) => setFromTableId(event.target.value)}
                        className="mt-1.5 h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <option value="">Choose table</option>
                        {activeTables.map((id) => (
                          <option key={id} value={id}>
                            {tableLabel(id)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="move-to">Destination table</Label>
                      <select
                        id="move-to"
                        value={toTableId}
                        onChange={(event) => setToTableId(event.target.value)}
                        className="mt-1.5 h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <option value="">Choose available table</option>
                        {availableDestinations.map((table) => (
                          <option key={table.id} value={table.id}>
                            {table.label}
                          </option>
                        ))}
                      </select>
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
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Additional available tables</legend>
                    {availableDestinations.length === 0 ? (
                      <p className="text-sm text-text-muted">No additional tables are available.</p>
                    ) : (
                      availableDestinations.map((table) => (
                        <label
                          key={table.id}
                          className="flex min-h-11 items-center gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={mergeIds.includes(table.id)}
                            disabled={pending}
                            onChange={() =>
                              setMergeIds((current) =>
                                current.includes(table.id)
                                  ? current.filter((id) => id !== table.id)
                                  : [...current, table.id]
                              )
                            }
                          />
                          {table.label}
                        </label>
                      ))
                    )}
                  </fieldset>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || mergeIds.length === 0}
                    onClick={() => onMerge(mergeIds)}
                    className="h-11 w-full"
                  >
                    Merge tables
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle bg-card pt-2">
            <div className="min-w-0 text-xs text-text-muted">
              <span className="inline-block min-w-16 text-right font-mono text-sm tabular-nums text-text-strong">
                {order.totals.subtotal}
              </span>
              <span className="ml-2 font-mono tabular-nums">
                Tax {order.totals.tax} · Service {order.totals.serviceCharge}
                {order.channel === 'DELIVERY'
                  ? ` · Delivery fee ${order.totals.deliveryFee ?? '0'}`
                  : ''}
              </span>
            </div>
            <Button
              type="button"
              data-pos-pay
              variant={shouldCollectPayment ? 'default' : 'outline'}
              onClick={shouldCollectPayment ? onCollectPayment : onClose}
              disabled={pending}
              className="h-11 shrink-0 shadow-none hover:translate-y-0 active:translate-y-0"
            >
              {shouldCollectPayment ? 'Collect payment' : 'Close order'}
            </Button>
          </div>
        </div>
      </SectionCard>

      <Dialog
        open={Boolean(voidItem)}
        onOpenChange={(open) => {
          if (!open && !pending) setVoidItem(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
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
                    <Label htmlFor="manager-id">Approving manager</Label>
                    <RestaurantStaffSelect
                      id="manager-id"
                      required
                      staff={operators.filter((operator) => operator.id !== actingOperatorId)}
                      value={managerId}
                      onChange={setManagerId}
                      label="Approving manager"
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
