'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { Printer, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { browserUuid } from '@/lib/browser-uuid';
import { useEntitlements } from '@/components/entitlements-provider';
import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
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
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import { CateringEvidence } from './catering-evidence';
import { CateringTerminalBoundary } from './catering-terminal-boundary';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>;
type Order = Outputs['restaurantCatering']['list'][number];
type Status = Order['status'];
type Editor = { order?: Order } | null;
const statuses: Status[] = [
  'DRAFT',
  'QUOTED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
];
const nextStatus: Partial<Record<Status, Status>> = {
  DRAFT: 'QUOTED',
  QUOTED: 'CONFIRMED',
  CONFIRMED: 'IN_PRODUCTION',
  IN_PRODUCTION: 'READY',
  READY: 'DELIVERED',
  DELIVERED: 'CLOSED',
};
const inputClass =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';
const labelClass =
  'font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}
function value(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}
function optional(data: FormData, key: string) {
  return value(data, key) || null;
}
/**
 * `eventDate` is a `@db.Date` column and `serviceTime` a `@db.Time` column: the
 * server stores the UTC calendar day / clock time of the Date it receives and
 * every read formats the UTC fields back (`localDate`, the editor defaults, the
 * reports' `dateKey`). A value typed into a date or time input is therefore a
 * calendar value, never an instant, and must be parsed as UTC. Parsing it as
 * local midnight moved an event entered as 2026-11-07 in Asia/Karachi to
 * 2026-11-06T19:00Z, which the ledger then showed as the day before.
 */
function calendarDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}
function calendarDateEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}
function calendarTime(value: string) {
  return new Date(`1970-01-01T${value}:00.000Z`);
}
function localDate(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}
function localDateTime(value: Date | string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function eventIdentity(order: Pick<Order, 'eventName' | 'eventDate'>) {
  return `${order.eventName} · ${localDate(order.eventDate)}`;
}
function tone(status: Status): StatusTone {
  return status === 'CANCELLED'
    ? 'danger'
    : ['DELIVERED', 'CLOSED'].includes(status)
      ? 'success'
      : ['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(status)
        ? 'info'
        : 'warning';
}
function denied(error: { data?: { code?: string } | null } | null | undefined) {
  return ['FORBIDDEN', 'UNAUTHORIZED'].includes(error?.data?.code ?? '');
}

function DeliveryForm({
  order,
  staff,
  disabled,
  onChange,
  onSubmit,
}: {
  order: Order;
  staff: Outputs['restaurantStaff']['listDirectory'] | undefined;
  disabled: boolean;
  onChange: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  // The parent keys this form by order ID. Refetches must not replace its defaults or edits.
  const [delivery] = useState(order.delivery);
  return (
    <form
      data-order-id={order.id}
      aria-label={`Delivery for ${eventIdentity(order)}`}
      onChange={onChange}
      onSubmit={onSubmit}
    >
      <fieldset disabled={disabled} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Scheduled">
          <Input
            className="min-h-11"
            required
            name="scheduledAt"
            type="datetime-local"
            defaultValue={localDateTime(delivery?.scheduledAt)}
          />
        </Field>
        <Field label="Driver">
          <select
            name="driverStaffId"
            aria-label="Driver"
            className={inputClass}
            defaultValue={delivery?.driverStaffId ?? ''}
          >
            <option value="">Unassigned</option>
            {staff?.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dispatched">
          <Input
            className="min-h-11"
            name="dispatchedAt"
            type="datetime-local"
            defaultValue={localDateTime(delivery?.dispatchedAt)}
          />
        </Field>
        <Field label="Delivered">
          <Input
            className="min-h-11"
            name="deliveredAt"
            type="datetime-local"
            defaultValue={localDateTime(delivery?.deliveredAt)}
          />
        </Field>
        <Field label="Vehicle">
          <Input className="min-h-11" name="vehicle" defaultValue={delivery?.vehicle ?? ''} />
        </Field>
        <Field label="Delivery notes">
          <Input className="min-h-11" name="deliveryNotes" defaultValue={delivery?.notes ?? ''} />
        </Field>
        <p className="text-sm text-text-muted sm:col-span-2">Saving for {eventIdentity(order)}</p>
        <Button className="min-h-11" disabled={disabled} type="submit">
          Save delivery
        </Button>
      </fieldset>
    </form>
  );
}

export function CateringConsole({ currency }: { currency: string | null }) {
  const currencyLabel = currency?.trim() || 'Currency unavailable';
  // Catering returns Decimal major-unit strings, including recipe-cost precision.
  // Display those exact amounts; do not coerce to Number or infer a currency/scale.
  const money = (amount: { toString(): string } | null | undefined, label = currencyLabel) =>
    amount == null ? '—' : `${label} ${amount.toString()}`;
  const entitlements = useEntitlements();
  const enabled = entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<'' | Status>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<Editor>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const [orderCustomerId, setOrderCustomerId] = useState('');
  const [transitionTarget, setTransitionTarget] = useState<{
    order: Order;
    to: Status;
    idempotencyKey: string;
  } | null>(null);
  const lifecyclePending = useRef(false);
  const [moneyUnresolved, setMoneyUnresolved] = useState(false);
  const [dirtyForms, setDirtyForms] = useState<string[]>([]);
  const [switchTarget, setSwitchTarget] = useState<Order | 'new' | null>(null);
  const [mutationError, setMutationError] = useState('');

  const branches = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled,
  });
  const list = trpc.restaurantCatering.list.useQuery(
    {
      ...(branchId ? { branchId } : {}),
      ...(status ? { status } : {}),
      ...(from ? { eventDateFrom: calendarDate(from) } : {}),
      ...(to ? { eventDateTo: calendarDateEnd(to) } : {}),
    },
    { enabled }
  );
  const detail = trpc.restaurantCatering.get.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );
  const recipes = trpc.restaurantCatalog.listRecipes.useQuery(undefined, {
    enabled,
  });
  const recipeCosts = trpc.restaurantCatalog.listRecipeCosts.useQuery({}, { enabled });
  const customers = trpc.restaurantDelivery.listCustomers.useQuery({ limit: 100 }, { enabled });
  const addresses = trpc.restaurantDelivery.listAddresses.useQuery(
    { customerId: orderCustomerId },
    { enabled: enabled && Boolean(orderCustomerId) }
  );
  const staff = trpc.restaurantStaff.listDirectory.useQuery(branchId ? { branchId } : undefined, {
    enabled,
  });
  const requirements = trpc.restaurantCatering.productionRequirements.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );
  const costs = trpc.restaurantCatering.costSummary.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );

  const availability = trpc.restaurantCatering.bookingAvailability.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );
  const quotes = trpc.restaurantCatering.quoteHistory.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );
  const locations = trpc.restaurantCatering.bookingLocations.useQuery(
    { branchId: detail.data?.branchId ?? '' },
    { enabled: enabled && Boolean(detail.data?.branchId) }
  );
  useEffect(() => {
    if (!dirtyForms.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyForms.length]);
  const refresh = () => {
    void utils.restaurantCatering.invalidate();
  };
  const succeed = (message: string) => {
    setMutationError('');
    setEditor(null);
    setTransitionTarget(null);
    refresh();
    toast.success(message);
  };
  const fail = (error: { message: string }) => {
    setMutationError(error.message);
    toast.error(error.message);
  };
  const create = trpc.restaurantCatering.create.useMutation({
    onSuccess: (order) => {
      setSelectedId(order.id);
      succeed('Catering order created.');
    },
    onError: fail,
  });
  const update = trpc.restaurantCatering.update.useMutation({
    onSuccess: () => succeed('Catering order updated.'),
    onError: fail,
  });
  const addLine = trpc.restaurantCatering.addLine.useMutation({
    onSuccess: () => succeed('Order line added.'),
    onError: fail,
  });
  const removeLine = trpc.restaurantCatering.removeLine.useMutation({
    onSuccess: () => succeed('Order line removed.'),
    onError: fail,
  });
  const addExtra = trpc.restaurantCatering.addExtraCost.useMutation({
    onSuccess: () => succeed('Extra cost added.'),
    onError: fail,
  });
  const removeExtra = trpc.restaurantCatering.removeExtraCost.useMutation({
    onSuccess: () => succeed('Extra cost removed.'),
    onError: fail,
  });
  const setDelivery = trpc.restaurantCatering.setDelivery.useMutation({
    onSuccess: () => succeed('Delivery schedule saved.'),
    onError: fail,
  });
  const setBooking = trpc.restaurantCatering.setBooking.useMutation({
    onSuccess: () => {
      clearDraft('booking');
      succeed('Booking saved. Quote approval must be renewed.');
    },
    onError: fail,
  });
  const setCapacity = trpc.restaurantCatering.setBranchCapacity.useMutation({
    onSuccess: () => {
      clearDraft('capacity');
      succeed('Branch capacity saved.');
    },
    onError: fail,
  });
  const publishQuote = trpc.restaurantCatering.publishQuote.useMutation({
    onSuccess: () => succeed('Quote revision published.'),
    onError: fail,
  });
  const approveQuote = trpc.restaurantCatering.approveQuote.useMutation({
    onSuccess: () => succeed('Quote approved.'),
    onError: fail,
  });
  const transition = trpc.restaurantCatering.transition.useMutation({
    onSuccess: () => {
      lifecyclePending.current = false;
      succeed('Order status updated.');
    },
    onError: (error) => {
      lifecyclePending.current = false;
      fail(error);
    },
  });
  const busy = [
    create,
    update,
    addLine,
    removeLine,
    addExtra,
    removeExtra,
    setDelivery,
    transition,
    setBooking,
    setCapacity,
    publishQuote,
    approveQuote,
  ].some((item) => item.isPending);

  const markDirty = (name: string) =>
    setDirtyForms((current) => (current.includes(name) ? current : [...current, name]));
  const clearDraft = (name: string) =>
    setDirtyForms((current) => current.filter((item) => item !== name));
  const switchEvent = (target: Order | 'new') => {
    if (moneyUnresolved) return;
    setDirtyForms([]);
    setMutationError('');
    setSwitchTarget(null);
    if (target === 'new') {
      setSelectedId('');
      setOrderCustomerId('');
      setEditor({});
    } else setSelectedId(target.id);
  };
  const requestSwitch = (target: Order | 'new') => {
    if (
      moneyUnresolved ||
      busy ||
      editor ||
      transitionTarget ||
      (target !== 'new' && target.id === selectedId)
    )
      return;
    if (dirtyForms.length) setSwitchTarget(target);
    else switchEvent(target);
  };
  const formOrderId = (form: HTMLFormElement) => {
    const orderId = form.dataset.orderId;
    return !busy && !detail.error && orderId === selectedId && detail.data?.id === orderId
      ? orderId
      : null;
  };

  const submitOrder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !editor) return;
    const data = new FormData(event.currentTarget);
    const order = editor?.order;
    const payload = {
      eventName: value(data, 'eventName'),
      eventDate: calendarDate(value(data, 'eventDate')),
      serviceTime: value(data, 'serviceTime') ? calendarTime(value(data, 'serviceTime')) : null,
      headcount: Number(value(data, 'headcount')),
      customerId: optional(data, 'customerId'),
      venueAddress: optional(data, 'venueAddress'),
      deliveryAddressId: optional(data, 'deliveryAddressId'),
      quotedTotal: optional(data, 'quotedTotal'),
      depositAmount: optional(data, 'depositAmount'),
      notes: optional(data, 'notes'),
    };
    if (order) update.mutate({ orderId: order.id, ...payload });
    else create.mutate({ branchId: value(data, 'branchId'), ...payload });
  };
  const submitLine = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = formOrderId(form);
    if (!orderId) return;
    const data = new FormData(form);
    const recipeId = value(data, 'source');
    addLine.mutate(
      {
        orderId,
        recipeId,
        description: value(data, 'description'),
        portions: value(data, 'portions'),
        unitPrice: value(data, 'unitPrice'),
      },
      {
        onSuccess: () => {
          form.reset();
          clearDraft('line');
        },
      }
    );
  };
  const submitExtra = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = formOrderId(form);
    if (!orderId) return;
    const data = new FormData(form);
    addExtra.mutate(
      {
        orderId,
        kind: value(data, 'kind') as 'LABOUR' | 'TRANSPORT' | 'RENTAL' | 'OTHER',
        label: value(data, 'label'),
        amount: value(data, 'amount'),
      },
      {
        onSuccess: () => {
          form.reset();
          clearDraft('extra');
        },
      }
    );
  };
  const submitDelivery = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const orderId = formOrderId(event.currentTarget);
    if (!orderId) return;
    const data = new FormData(event.currentTarget);
    setDelivery.mutate(
      {
        orderId,
        scheduledAt: new Date(value(data, 'scheduledAt')),
        dispatchedAt: value(data, 'dispatchedAt') ? new Date(value(data, 'dispatchedAt')) : null,
        deliveredAt: value(data, 'deliveredAt') ? new Date(value(data, 'deliveredAt')) : null,
        driverStaffId: optional(data, 'driverStaffId'),
        vehicle: optional(data, 'vehicle'),
        notes: optional(data, 'deliveryNotes'),
      },
      { onSuccess: () => clearDraft('delivery') }
    );
  };
  const order = detail.data?.id === selectedId ? detail.data : undefined;
  const accessDenied = !enabled || denied(list.error);
  const actionsDisabled = accessDenied || busy || Boolean(detail.error);
  const costCurrency = order?.confirmedQuoteRevisionId
    ? (quotes.data?.find((quote) => quote.id === order.confirmedQuoteRevisionId)?.snapshot
        .currency ?? 'Currency unavailable')
    : currencyLabel;
  const editable = Boolean(order && ['DRAFT', 'QUOTED'].includes(order.status));
  const currentQuote = quotes.data?.find(
    (quote) => quote.id === order?.approvedQuoteRevisionId && quote.revision === order?.revision
  );
  const canConfirm = Boolean(
    currentQuote &&
    !detail.isFetching &&
    !quotes.error &&
    !quotes.isFetching &&
    !availability.error &&
    !availability.isFetching &&
    availability.data?.capacityStatus === 'AVAILABLE' &&
    order?.bookingStartsAt &&
    order.bookingEndsAt &&
    order.fulfillmentMode &&
    order.stockLocationId
  );
  const quoteActionsDisabled =
    actionsDisabled ||
    !editable ||
    Boolean(quotes.error) ||
    quotes.isFetching ||
    dirtyForms.length > 0;
  const canPrint =
    Boolean(order) &&
    !detail.error &&
    !busy &&
    requirements.isSuccess &&
    !requirements.isFetching &&
    !requirements.error &&
    !requirements.isPlaceholderData &&
    Array.isArray(requirements.data);

  const accessNotice = !enabled ? (
    <div key="access">
      <PageHeader
        eyebrow="Restaurant"
        heading="Catering"
        description="Plan catered events, production, and delivery."
      />
      <SectionCard title="Restaurant Core module disabled" titleLevel={2}>
        <p className="text-sm text-text-muted">Ask an administrator to enable Restaurant Core.</p>
      </SectionCard>
    </div>
  ) : denied(list.error) ? (
    <div key="access">
      <PageHeader eyebrow="Restaurant" heading="Catering" />
      <SectionCard title="Catering access unavailable" titleLevel={2}>
        <p className="text-sm text-text-muted">
          You do not have permission to view catering orders.
        </p>
        <Button variant="outline" onClick={() => void list.refetch()}>
          Retry catering access
        </Button>
      </SectionCard>
    </div>
  ) : null;

  // Keep unresolved payment intent mounted while denied content is hidden and disabled.
  return [
    accessNotice,
    <div key="workspace" hidden={accessDenied} className="space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Catering"
        description="Quote events, prepare production sheets, coordinate delivery, and protect margin."
        actions={
          <Button
            className="min-h-11"
            disabled={moneyUnresolved || busy || Boolean(editor) || Boolean(transitionTarget)}
            onClick={(event) => {
              editorTrigger.current = event.currentTarget;
              requestSwitch('new');
            }}
          >
            <Plus />
            New order
          </Button>
        }
      />
      <SectionCard eyebrow="Order ledger" title="Filters" titleLevel={2}>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Branch">
            <RestaurantBranchSelect
              value={branchId}
              branches={branches.data ?? []}
              loading={branches.isLoading}
              error={Boolean(branches.error)}
              allowEmpty
              emptyLabel="All branches"
              onChange={setBranchId}
              ariaLabel="Filter by branch"
            />
          </Field>
          <Field label="Status">
            <select
              aria-label="Filter by status"
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | Status)}
            >
              <option value="">All statuses</option>
              {statuses.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label="Event date from">
            <Input
              className="min-h-11"
              name="from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="Event date to">
            <Input
              className="min-h-11"
              name="to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Catering orders" eyebrow={`${list.data?.length ?? 0} results`}>
        {list.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : list.error ? (
          <div role="alert">
            <p className="font-medium text-text-strong">Orders could not be loaded</p>
            <p className="text-sm text-text-muted">{list.error.message}</p>
            <Button className="mt-4 min-h-11" variant="outline" onClick={() => list.refetch()}>
              Try again
            </Button>
          </div>
        ) : !list.data?.length ? (
          <p className="rounded-md border border-dashed border-border-default p-8 text-center text-sm text-text-muted">
            No catering orders match these filters. Create an order or broaden the date range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Guests</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Quote</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={selectedId === item.id ? 'selected' : undefined}
                  >
                    <TableCell className="font-medium">
                      <Button
                        className="min-h-11"
                        variant="ghost"
                        aria-label={`Select event ${eventIdentity(item)}`}
                        aria-pressed={selectedId === item.id}
                        disabled={
                          moneyUnresolved || busy || Boolean(editor) || Boolean(transitionTarget)
                        }
                        onClick={() => requestSwitch(item)}
                      >
                        {item.eventName}
                        {selectedId === item.id ? ' · Selected' : ''}
                      </Button>
                    </TableCell>
                    <TableCell>{localDate(item.eventDate)}</TableCell>
                    <TableCell>{item.headcount}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={item.status}
                        tone={tone(item.status)}
                        label={item.status.replaceAll('_', ' ')}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.quotedTotal)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      {selectedId ? (
        <>
          {detail.isLoading && !order ? (
            <SectionCard title="Loading order detail">
              <Skeleton className="h-48 w-full" />
            </SectionCard>
          ) : detail.error && !order ? (
            <SectionCard title="Order unavailable">
              <p role="alert" className="text-sm text-text-muted">
                {detail.error.message}
              </p>
              <Button
                className="min-h-11"
                variant="outline"
                disabled={detail.isFetching}
                onClick={() => detail.refetch()}
              >
                Retry order detail
              </Button>
            </SectionCard>
          ) : order ? (
            <>
              {detail.error ? (
                <SectionCard title="Order detail could not be refreshed">
                  <p role="alert" className="text-sm text-text-muted">
                    {detail.error.message} Your edits are kept. Retry before saving.
                  </p>
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={detail.isFetching}
                    onClick={() => detail.refetch()}
                  >
                    Retry order detail
                  </Button>
                </SectionCard>
              ) : null}
              {mutationError && !editor && !transitionTarget ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationError} Your edits are kept.
                </p>
              ) : null}
              <SectionCard
                title={order.eventName}
                eyebrow={`${localDate(order.eventDate)} · ${order.headcount} guests`}
                actions={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={actionsDisabled || !editable}
                      onClick={(event) => {
                        editorTrigger.current = event.currentTarget;
                        setMutationError('');
                        setOrderCustomerId(order.customerId ?? '');
                        setEditor({ order });
                      }}
                    >
                      Edit order
                    </Button>
                    {nextStatus[order.status] ? (
                      <Button
                        className="min-h-11"
                        disabled={
                          actionsDisabled ||
                          dirtyForms.length > 0 ||
                          (nextStatus[order.status] === 'CONFIRMED' && !canConfirm)
                        }
                        onClick={() => {
                          setMutationError('');
                          setTransitionTarget({
                            order,
                            to: nextStatus[order.status]!,
                            idempotencyKey: browserUuid(),
                          });
                        }}
                      >
                        Move to {nextStatus[order.status]!.replaceAll('_', ' ').toLowerCase()}
                      </Button>
                    ) : null}
                    {!['CLOSED', 'CANCELLED'].includes(order.status) ? (
                      <Button
                        className="min-h-11"
                        variant="destructive"
                        disabled={actionsDisabled || dirtyForms.length > 0}
                        onClick={() => {
                          setMutationError('');
                          setTransitionTarget({
                            order,
                            to: 'CANCELLED',
                            idempotencyKey: browserUuid(),
                          });
                        }}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                }
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Status" value={order.status.replaceAll('_', ' ')} />
                  <Stat label="Headcount" value={order.headcount} />
                  <Stat label="Quoted" value={money(order.quotedTotal)} />
                  <Stat label="Planned deposit" value={money(order.depositAmount)} />
                </div>
                <p role="status" className="mt-4 text-sm text-text-muted">
                  {busy
                    ? `Saving changes for ${eventIdentity(order)}…`
                    : dirtyForms.length
                      ? 'Unsaved edits. Switching events will ask you to discard them.'
                      : currencyLabel}
                </p>
              </SectionCard>
              <SectionCard key={`booking:${order.id}`} title="Booking and capacity">
                <p className="mb-4 text-sm text-text-muted">
                  Enter start and end with an explicit UTC offset, for example
                  2026-10-07T18:00:00+05:00. The offset applies to that instant; check it for the
                  event date. Saving booking or menu changes invalidates quote approval. Confirmed
                  bookings cannot be edited.
                </p>
                <form
                  aria-label="Booking"
                  onChange={() => markDirty('booking')}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (actionsDisabled || !editable) return;
                    const data = new FormData(event.currentTarget);
                    const start = value(data, 'bookingStartsAt'),
                      end = value(data, 'bookingEndsAt');
                    const zoned =
                      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
                    if (
                      !zoned.test(start) ||
                      !zoned.test(end) ||
                      !Number.isFinite(Date.parse(start)) ||
                      !Number.isFinite(Date.parse(end)) ||
                      Date.parse(end) <= Date.parse(start)
                    ) {
                      fail({
                        message:
                          'Use valid timestamps with an explicit UTC offset and an end after start.',
                      });
                      return;
                    }
                    const mode = value(data, 'fulfillmentMode');
                    if (mode !== 'PICKUP' && mode !== 'DELIVERY') return;
                    setBooking.mutate({
                      orderId: order.id,
                      bookingStartsAt: new Date(start),
                      bookingEndsAt: new Date(end),
                      fulfillmentMode: mode,
                      stockLocationId: value(data, 'stockLocationId'),
                    });
                  }}
                >
                  <fieldset
                    disabled={
                      actionsDisabled ||
                      !editable ||
                      locations.isLoading ||
                      Boolean(locations.error)
                    }
                    className="grid min-w-0 gap-3 sm:grid-cols-2"
                  >
                    <Field label="Booking start with UTC offset">
                      <Input
                        className="min-h-11"
                        required
                        name="bookingStartsAt"
                        defaultValue={
                          order.bookingStartsAt ? new Date(order.bookingStartsAt).toISOString() : ''
                        }
                      />
                    </Field>
                    <Field label="Booking end with UTC offset">
                      <Input
                        className="min-h-11"
                        required
                        name="bookingEndsAt"
                        defaultValue={
                          order.bookingEndsAt ? new Date(order.bookingEndsAt).toISOString() : ''
                        }
                      />
                    </Field>
                    <Field label="Fulfillment">
                      <select
                        className={inputClass}
                        required
                        name="fulfillmentMode"
                        defaultValue={order.fulfillmentMode ?? ''}
                      >
                        <option value="">Choose fulfillment</option>
                        <option value="PICKUP">Pickup</option>
                        <option value="DELIVERY">Delivery</option>
                      </select>
                    </Field>
                    <Field label="Stock location">
                      <select
                        className={inputClass}
                        required
                        name="stockLocationId"
                        defaultValue={order.stockLocationId ?? ''}
                      >
                        <option value="">Choose stock location</option>
                        {locations.data?.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button className="min-h-11" type="submit">
                      Save booking
                    </Button>
                  </fieldset>
                </form>
                {locations.isLoading ? (
                  <p role="status">Loading stock locations…</p>
                ) : locations.error ? (
                  <div role="alert">
                    <p>{locations.error.message}</p>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={locations.isFetching}
                      onClick={() => locations.refetch()}
                    >
                      Retry stock locations
                    </Button>
                  </div>
                ) : !locations.data?.length ? (
                  <p>
                    No active stock locations are available for this branch. Booking cannot be
                    saved.
                  </p>
                ) : null}
                <div className="mt-4 space-y-3">
                  {availability.isLoading ? (
                    <p role="status">Checking capacity…</p>
                  ) : availability.error ? (
                    <div role="alert">
                      <p>{availability.error.message}</p>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        disabled={availability.isFetching}
                        onClick={() => availability.refetch()}
                      >
                        Retry capacity
                      </Button>
                    </div>
                  ) : (
                    <p role="status">
                      Capacity: {availability.data?.capacityStatus ?? 'UNKNOWN'} · Configured
                      guests: {availability.data?.maxConcurrentHeadcount ?? 'Unknown'} · Peak
                      guests: {availability.data?.peakHeadcount ?? 'Unknown'}. Unknown or exceeded
                      capacity prevents confirmation.
                    </p>
                  )}
                  <form
                    key={availability.isLoading ? 'loading' : 'loaded'}
                    aria-label="Branch capacity"
                    onChange={() => markDirty('capacity')}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (actionsDisabled || availability.error) return;
                      const amount = value(new FormData(event.currentTarget), 'capacity');
                      setCapacity.mutate({
                        branchId: order.branchId,
                        maxConcurrentHeadcount: amount ? Number(amount) : null,
                      });
                    }}
                  >
                    <fieldset
                      disabled={
                        actionsDisabled || availability.isLoading || Boolean(availability.error)
                      }
                      className="flex flex-wrap items-end gap-3"
                    >
                      <Field label="Maximum concurrent guests">
                        <Input
                          className="min-h-11"
                          name="capacity"
                          type="number"
                          min="1"
                          step="1"
                          defaultValue={availability.data?.maxConcurrentHeadcount ?? ''}
                        />
                      </Field>
                      <Button className="min-h-11" variant="outline" type="submit">
                        Save branch capacity
                      </Button>
                    </fieldset>
                    <p className="mt-2 text-sm text-text-muted">
                      Requires catering management permission. Empty means unknown, not unlimited.
                    </p>
                  </form>
                </div>
              </SectionCard>
              <SectionCard title="Quote revisions and approval">
                <p className="mb-3 text-sm text-text-muted">
                  Only approval of the current revision permits confirmation. Planned deposit is a
                  planning amount, not a recorded receipt. Persisted receipts and refunds appear in
                  Payment evidence.
                </p>
                <p role="status">
                  {currentQuote
                    ? `Current revision ${currentQuote.revision} approved.`
                    : 'Current quote approval required.'}{' '}
                  See Approval history for persisted approval records.
                </p>
                {!currency || !/^[A-Z]{3}$/.test(currency) ? (
                  <p role="alert">
                    Configure a valid three-letter currency before publishing a quote.
                  </p>
                ) : null}
                <Button
                  className="my-3 min-h-11"
                  disabled={quoteActionsDisabled || !currency || !/^[A-Z]{3}$/.test(currency)}
                  onClick={() => {
                    if (currency) publishQuote.mutate({ orderId: order.id, currency });
                  }}
                >
                  Publish quote revision
                </Button>
                {quotes.isLoading ? (
                  <p role="status">Loading quote history…</p>
                ) : quotes.error ? (
                  <div role="alert">
                    <p>{quotes.error.message}</p>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={quotes.isFetching}
                      onClick={() => quotes.refetch()}
                    >
                      Retry quote history
                    </Button>
                  </div>
                ) : !quotes.data?.length ? (
                  <p>No published quote revisions.</p>
                ) : (
                  quotes.data.map((quote) => (
                    <div className="space-y-3 border-t border-border-subtle py-4" key={quote.id}>
                      <h4 className="font-semibold">
                        Revision {quote.revision} · {quote.snapshot.currency}{' '}
                        {quote.snapshot.quotedTotal} · {quote.snapshot.headcount} guests
                      </h4>
                      <p className="text-sm">
                        {quote.snapshot.fulfillmentMode ?? 'Fulfillment unknown'} ·{' '}
                        {quote.snapshot.bookingStartsAt ?? 'Start unknown'} →{' '}
                        {quote.snapshot.bookingEndsAt ?? 'End unknown'}
                      </p>
                      <p className="text-sm text-text-muted">
                        Frozen reference estimate; actual cost unknown.{' '}
                        {quote.snapshot.missing.length
                          ? `Missing costs: ${quote.snapshot.missing.join(', ')}`
                          : 'No missing reference costs reported.'}
                      </p>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Frozen menu</TableHead>
                              <TableHead>Portions</TableHead>
                              <TableHead>Unit price</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {quote.snapshot.lines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell>{line.description}</TableCell>
                                <TableCell>{line.portions}</TableCell>
                                <TableCell>
                                  {quote.snapshot.currency} {line.unitPrice}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {quote.snapshot.extraCosts.map((extra, index) => (
                        <p key={index}>
                          {extra.label}: {quote.snapshot.currency} {extra.amount}
                        </p>
                      ))}
                      <details>
                        <summary>Frozen ingredient basis</summary>
                        <ul className="space-y-2 break-words">
                          {quote.snapshot.requirements.map((item) => (
                            <li key={item.ingredientId}>
                              {item.ingredientName}: {item.quantityInBaseUnit} canonical base units
                              (unit reference: {item.baseUnitId});{' '}
                              {item.unitCost === null
                                ? 'MISSING'
                                : `${quote.snapshot.currency} ${item.unitCost} per base unit — REFERENCE`}
                            </li>
                          ))}
                        </ul>
                      </details>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={
                          quoteActionsDisabled ||
                          quote.revision !== order.revision ||
                          quote.id === order.approvedQuoteRevisionId
                        }
                        onClick={() =>
                          approveQuote.mutate({
                            orderId: order.id,
                            quoteRevisionId: quote.id,
                          })
                        }
                      >
                        {quote.id === order.approvedQuoteRevisionId
                          ? 'Approved'
                          : quote.revision !== order.revision
                            ? 'Superseded'
                            : 'Approve quote revision'}
                      </Button>
                    </div>
                  ))
                )}
              </SectionCard>
              <CateringTerminalBoundary
                key={order.id}
                organizationId={entitlements.organizationId}
                branchId={order.branchId}
              >
                <CateringEvidence
                  orderId={order.id}
                  approvedQuoteRevisionId={currentQuote?.id ?? null}
                  cancelled={order.status === 'CANCELLED'}
                  receivable={!['CANCELLED', 'CLOSED'].includes(order.status)}
                  disabled={actionsDisabled}
                  onDirty={() => markDirty('disposition')}
                  onSaved={() => clearDraft('disposition')}
                  onMoneyDirty={() => markDirty('money')}
                  onMoneySaved={() => clearDraft('money')}
                  onMoneyUnresolved={setMoneyUnresolved}
                />
              </CateringTerminalBoundary>
              <div className="grid gap-6 xl:grid-cols-2">
                <SectionCard title="Order lines">
                  <form
                    key={order.id}
                    data-order-id={order.id}
                    aria-label={`Order lines for ${eventIdentity(order)}`}
                    onChange={() => markDirty('line')}
                    onSubmit={submitLine}
                  >
                    <fieldset
                      disabled={actionsDisabled || !editable}
                      className="grid min-w-0 gap-3 sm:grid-cols-2"
                    >
                      <Field label="Recipe">
                        <select
                          required
                          name="source"
                          aria-label="Recipe"
                          className={inputClass}
                        >
                          <option value="">Select a recipe</option>
                          {recipes.data
                            ?.filter((item) => item.activeVersionId)
                            .map((item) => {
                              const cost = recipeCosts.data?.find(
                                (cost) => cost.recipeId === item.id
                              );
                              return (
                                <option
                                  key={item.id}
                                  value={item.id}
                                  disabled={Boolean(cost?.error)}
                                >
                                  {item.name} ·{' '}
                                  {cost?.error
                                    ? `Cost unavailable: ${cost.error}`
                                    : `${money(cost?.costPerPortion)}/portion`}
                                </option>
                              );
                            })}
                        </select>
                      </Field>
                      <Field label="Description">
                        <Input className="min-h-11" required name="description" />
                      </Field>
                      <Field label="Portions">
                        <Input
                          className="min-h-11"
                          required
                          name="portions"
                          type="number"
                          min="0.001"
                          step="0.001"
                        />
                      </Field>
                      <Field label="Unit price">
                        <Input
                          className="min-h-11"
                          required
                          name="unitPrice"
                          type="number"
                          min="0"
                          step="0.01"
                        />
                      </Field>
                      <p className="text-sm text-text-muted sm:col-span-2">
                        Adding to {eventIdentity(order)}
                      </p>
                      <Button className="min-h-11" disabled={actionsDisabled} type="submit">
                        Add line
                      </Button>
                    </fieldset>
                  </form>
                  <div className="mt-5 space-y-2">
                    {order.lines.length ? (
                      order.lines.map((line) => (
                        <div
                          key={line.id}
                          className="flex items-center justify-between gap-4 border-t border-border-subtle py-3 text-sm"
                        >
                          <span>
                            {line.description} · {line.portions.toString()} portions @{' '}
                            {money(line.unitPrice)}
                          </span>
                          <Button
                            className="min-h-11"
                            variant="ghost"
                            size="sm"
                            disabled={actionsDisabled || !editable}
                            aria-label={`Remove ${line.description} from ${eventIdentity(order)}`}
                            onClick={() =>
                              removeLine.mutate({
                                orderId: order.id,
                                lineId: line.id,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-text-muted">
                        No items yet. Add an active recipe.
                      </p>
                    )}
                  </div>
                </SectionCard>
                <SectionCard title="Extra costs">
                  <form
                    key={order.id}
                    data-order-id={order.id}
                    aria-label={`Extra costs for ${eventIdentity(order)}`}
                    onChange={() => markDirty('extra')}
                    onSubmit={submitExtra}
                  >
                    <fieldset
                      disabled={actionsDisabled || !editable}
                      className="grid min-w-0 gap-3 sm:grid-cols-2"
                    >
                      <Field label="Cost type">
                        <select required name="kind" aria-label="Cost type" className={inputClass}>
                          {['LABOUR', 'TRANSPORT', 'RENTAL', 'OTHER'].map((item) => (
                            <option key={item}>{item}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Label">
                        <Input className="min-h-11" required name="label" />
                      </Field>
                      <Field label="Amount">
                        <Input
                          className="min-h-11"
                          required
                          name="amount"
                          type="number"
                          min="0"
                          step="0.01"
                        />
                      </Field>
                      <p className="text-sm text-text-muted sm:col-span-2">
                        Adding to {eventIdentity(order)}
                      </p>
                      <Button className="min-h-11" disabled={actionsDisabled} type="submit">
                        Add cost
                      </Button>
                    </fieldset>
                  </form>
                  <div className="mt-5">
                    {order.extraCosts.map((cost) => (
                      <div
                        key={cost.id}
                        className="flex items-center justify-between border-t border-border-subtle py-3 text-sm"
                      >
                        <span>
                          {cost.label} · {money(cost.amount)}
                        </span>
                        <Button
                          className="min-h-11"
                          variant="ghost"
                          size="sm"
                          disabled={actionsDisabled || !editable}
                          aria-label={`Remove ${cost.label} from ${eventIdentity(order)}`}
                          onClick={() =>
                            removeExtra.mutate({
                              orderId: order.id,
                              extraCostId: cost.id,
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              </div>
              <SectionCard
                title="Production sheet"
                eyebrow={`Grouped ingredient requirements · ${eventIdentity(order)}`}
                actions={
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={!canPrint}
                    aria-label={`Print production sheet for ${eventIdentity(order)}`}
                    onClick={() => {
                      if (canPrint) window.print();
                    }}
                  >
                    <Printer />
                    Print
                  </Button>
                }
              >
                <div className="print:block">
                  {requirements.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : requirements.error ? (
                    <div role="alert">
                      <p className="text-sm text-destructive">{requirements.error.message}</p>
                      <p className="text-sm text-text-muted">
                        Requirements are unconfirmed. Retry before printing.
                      </p>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        disabled={requirements.isFetching}
                        onClick={() => requirements.refetch()}
                      >
                        Retry production requirements
                      </Button>
                    </div>
                  ) : requirements.data?.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ingredient</TableHead>
                          <TableHead>Base unit</TableHead>
                          <TableHead className="text-right">Required quantity</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {requirements.data.map((item) => (
                          <TableRow key={item.ingredientId}>
                            <TableCell>{item.ingredientName}</TableCell>
                            <TableCell>
                              {item.baseUnit
                                ? `${item.baseUnit.name}${item.baseUnit.abbreviation ? ` (${item.baseUnit.abbreviation})` : ''}`
                                : `Unit label unavailable (${item.baseUnitId})`}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {item.quantityInBaseUnit.toString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="text-sm text-text-muted">
                      {requirements.isSuccess && Array.isArray(requirements.data)
                        ? 'No recipe ingredients are required yet.'
                        : 'Production requirements are not confirmed yet.'}
                    </p>
                  )}
                </div>
              </SectionCard>
              <div className="grid gap-6 xl:grid-cols-2">
                <SectionCard title="Delivery">
                  <DeliveryForm
                    key={order.id}
                    order={order}
                    staff={staff.data}
                    disabled={actionsDisabled || ['CANCELLED', 'CLOSED'].includes(order.status)}
                    onChange={() => markDirty('delivery')}
                    onSubmit={submitDelivery}
                  />
                </SectionCard>
                <SectionCard title="Cost summary">
                  <p className="mb-4 text-sm text-text-muted">
                    {eventIdentity(order)} · {costCurrency}. Latest loaded event quote, recipe costs
                    and extras. Margin is the quoted amount less included costs; it is not realized
                    profit or cash.
                  </p>
                  {costs.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : costs.error ? (
                    <div role="alert">
                      <p className="text-sm text-destructive">{costs.error.message}</p>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        disabled={costs.isFetching}
                        onClick={() => costs.refetch()}
                      >
                        Retry cost summary
                      </Button>
                    </div>
                  ) : costs.data ? (
                    <div className="grid grid-cols-2 gap-5">
                      <p className="col-span-2 text-sm">
                        Cost basis: {costs.data.costBasis}. Actual cost: unknown. Missing costs:{' '}
                        {costs.data.missing?.join(', ') || 'None reported'}.
                      </p>
                      <Stat
                        label="Ingredient cost"
                        value={money(costs.data.ingredientCost, costCurrency)}
                      />
                      <Stat label="Extras" value={money(costs.data.extraCost, costCurrency)} />
                      <Stat
                        label="Quoted total"
                        value={money(costs.data.quotedTotal, costCurrency)}
                      />
                      <Stat
                        label="Estimated gross margin"
                        value={money(costs.data.grossMargin, costCurrency)}
                        delta={
                          'marginPercent' in costs.data && costs.data.marginPercent
                            ? `${costs.data.marginPercent}%`
                            : '—'
                        }
                        deltaDirection={costs.data.grossMargin?.startsWith('-') ? 'down' : 'up'}
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">Cost summary is not available yet.</p>
                  )}
                </SectionCard>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <Dialog open={editor !== null} onOpenChange={(open) => !open && !busy && setEditor(null)}>
        <DialogContent
          finalFocus={editorTrigger}
          showCloseButton={!busy}
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>
              {editor?.order ? 'Edit catering order' : 'Create catering order'}
            </DialogTitle>
            <DialogDescription>
              {editor?.order ? `${eventIdentity(editor.order)}. ` : ''}
              Capture the customer, event, venue or saved delivery address, and commercial terms.{' '}
              {currencyLabel}.
            </DialogDescription>
          </DialogHeader>
          <form key={editor?.order?.id ?? 'new'} id="catering-order-form" onSubmit={submitOrder}>
            <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="Branch">
                <RestaurantBranchSelect
                  name="branchId"
                  defaultValue={editor?.order?.branchId ?? branchId}
                  branches={branches.data ?? []}
                  loading={branches.isLoading}
                  error={Boolean(branches.error)}
                  required
                  disabled={Boolean(editor?.order)}
                  ariaLabel="Order branch"
                />
              </Field>
              <Field label="Customer">
                <select
                  name="customerId"
                  aria-label="Customer"
                  className={inputClass}
                  value={orderCustomerId}
                  onChange={(event) => setOrderCustomerId(event.target.value)}
                >
                  <option value="">No linked customer</option>
                  {customers.data?.customers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Event name">
                <Input
                  className="min-h-11"
                  required
                  name="eventName"
                  defaultValue={editor?.order?.eventName ?? ''}
                />
              </Field>
              <Field label="Event date">
                <Input
                  className="min-h-11"
                  required
                  name="eventDate"
                  type="date"
                  defaultValue={localDate(editor?.order?.eventDate)}
                />
              </Field>
              <Field label="Service time">
                <Input
                  className="min-h-11"
                  name="serviceTime"
                  type="time"
                  defaultValue={
                    editor?.order?.serviceTime
                      ? new Date(editor.order.serviceTime).toISOString().slice(11, 16)
                      : ''
                  }
                />
              </Field>
              <Field label="Headcount">
                <Input
                  className="min-h-11"
                  required
                  name="headcount"
                  type="number"
                  min="1"
                  defaultValue={editor?.order?.headcount ?? 1}
                />
              </Field>
              <Field label="Venue address">
                <Input
                  className="min-h-11"
                  name="venueAddress"
                  defaultValue={editor?.order?.venueAddress ?? ''}
                />
              </Field>
              <Field label="Saved delivery address">
                <select
                  name="deliveryAddressId"
                  aria-label="Saved delivery address"
                  className={inputClass}
                  defaultValue={editor?.order?.deliveryAddressId ?? ''}
                  disabled={!orderCustomerId}
                >
                  <option value="">Use venue / none</option>
                  {addresses.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {item.addressLine1}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quoted total">
                <Input
                  className="min-h-11"
                  name="quotedTotal"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={editor?.order?.quotedTotal?.toString() ?? ''}
                />
              </Field>
              <Field label="Planned deposit">
                <Input
                  className="min-h-11"
                  name="depositAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={editor?.order?.depositAmount?.toString() ?? ''}
                />
              </Field>
              <Field label="Notes">
                <Input
                  className="min-h-11"
                  name="notes"
                  defaultValue={editor?.order?.notes ?? ''}
                />
              </Field>
            </fieldset>
          </form>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
            <Button className="min-h-11" form="catering-order-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={transitionTarget !== null}
        onOpenChange={(open) => !open && !busy && setTransitionTarget(null)}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Confirm status change</DialogTitle>
            <DialogDescription>
              {transitionTarget ? `${eventIdentity(transitionTarget.order)}. ` : ''}
              {transitionTarget?.to === 'CANCELLED'
                ? 'Cancel this order? Prepared inventory remains consumed.'
                : `Move this order to ${transitionTarget?.to.replaceAll('_', ' ').toLowerCase()}? This action is recorded in the order timeline.`}
            </DialogDescription>
            {transitionTarget?.to === 'CANCELLED' ? (
              <p>
                Cancellation does not return prepared inventory or refund money. Physical
                disposition and refunds are separate actions.
              </p>
            ) : null}
          </DialogHeader>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setTransitionTarget(null)}
            >
              Keep current status
            </Button>
            <Button
              className="min-h-11"
              variant={transitionTarget?.to === 'CANCELLED' ? 'destructive' : 'default'}
              disabled={actionsDisabled || (transitionTarget?.to === 'CONFIRMED' && !canConfirm)}
              onClick={() => {
                if (
                  actionsDisabled ||
                  !transitionTarget ||
                  transitionTarget.order.id !== selectedId ||
                  lifecyclePending.current ||
                  (transitionTarget.to === 'CONFIRMED' && !canConfirm)
                )
                  return;
                lifecyclePending.current = true;
                transition.mutate({
                  orderId: transitionTarget.order.id,
                  to: transitionTarget.to,
                  idempotencyKey: transitionTarget.idempotencyKey,
                });
              }}
            >
              Confirm change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={switchTarget !== null} onOpenChange={(open) => !open && setSwitchTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved event edits?</DialogTitle>
            <DialogDescription>
              {order ? `Unsaved edits for ${eventIdentity(order)} will be discarded. ` : ''}
              {switchTarget === 'new'
                ? 'Create a new order?'
                : switchTarget
                  ? `Switch to ${eventIdentity(switchTarget)}?`
                  : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button className="min-h-11" variant="outline" onClick={() => setSwitchTarget(null)}>
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!busy && switchTarget) switchEvent(switchTarget);
              }}
            >
              Discard and {switchTarget === 'new' ? 'create' : 'switch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>,
  ];
}
