'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { Printer, Plus } from 'lucide-react';
import { toast } from 'sonner';

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
  const money = (amount: { toString(): string } | null | undefined) =>
    amount == null ? '—' : `${currencyLabel} ${amount.toString()}`;
  const entitlements = useEntitlements();
  const enabled = entitlements.enabledModules.includes('restaurant-core');
  const utils = trpc.useUtils();
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<'' | Status>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<Editor>(null);
  const [orderCustomerId, setOrderCustomerId] = useState('');
  const [transitionTarget, setTransitionTarget] = useState<{ order: Order; to: Status } | null>(
    null
  );
  const [dirtyForms, setDirtyForms] = useState<string[]>([]);
  const [switchTarget, setSwitchTarget] = useState<Order | 'new' | null>(null);
  const [mutationError, setMutationError] = useState('');

  const branches = trpc.restaurantStaff.listBranches.useQuery(undefined, { enabled });
  const list = trpc.restaurantCatering.list.useQuery(
    {
      ...(branchId ? { branchId } : {}),
      ...(status ? { status } : {}),
      ...(from ? { eventDateFrom: new Date(`${from}T00:00:00`) } : {}),
      ...(to ? { eventDateTo: new Date(`${to}T23:59:59`) } : {}),
    },
    { enabled }
  );
  const detail = trpc.restaurantCatering.get.useQuery(
    { orderId: selectedId },
    { enabled: enabled && Boolean(selectedId) }
  );
  const products = trpc.restaurantCatalog.listProducts.useQuery({ status: 'ACTIVE' }, { enabled });
  const recipes = trpc.restaurantCatalog.listRecipes.useQuery(undefined, { enabled });
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
  const transition = trpc.restaurantCatering.transition.useMutation({
    onSuccess: () => succeed('Order status updated.'),
    onError: fail,
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
  ].some((item) => item.isPending);

  const markDirty = (name: string) =>
    setDirtyForms((current) => (current.includes(name) ? current : [...current, name]));
  const clearDraft = (name: string) =>
    setDirtyForms((current) => current.filter((item) => item !== name));
  const switchEvent = (target: Order | 'new') => {
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
    if (busy || editor || transitionTarget || (target !== 'new' && target.id === selectedId))
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
      eventDate: new Date(`${value(data, 'eventDate')}T00:00:00`),
      serviceTime: value(data, 'serviceTime')
        ? new Date(`1970-01-01T${value(data, 'serviceTime')}:00`)
        : null,
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
    const source = value(data, 'source');
    const [kind, id] = source.split(':');
    addLine.mutate(
      {
        orderId,
        productId: kind === 'product' ? id : null,
        recipeId: kind === 'recipe' ? id : null,
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
  const actionsDisabled = busy || Boolean(detail.error);
  const canPrint =
    Boolean(order) &&
    !detail.error &&
    !busy &&
    requirements.isSuccess &&
    !requirements.isFetching &&
    !requirements.error &&
    !requirements.isPlaceholderData &&
    Array.isArray(requirements.data);

  if (!enabled)
    return (
      <>
        <PageHeader
          eyebrow="Restaurant"
          heading="Catering"
          description="Plan catered events, production, and delivery."
        />
        <SectionCard title="Restaurant Core module disabled" titleLevel={2}>
          <p className="text-sm text-text-muted">Ask an administrator to enable Restaurant Core.</p>
        </SectionCard>
      </>
    );
  if (denied(list.error))
    return (
      <>
        <PageHeader eyebrow="Restaurant" heading="Catering" />
        <SectionCard title="Catering access unavailable" titleLevel={2}>
          <p className="text-sm text-text-muted">
            You do not have permission to view catering orders.
          </p>
        </SectionCard>
      </>
    );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Catering"
        description="Quote events, prepare production sheets, coordinate delivery, and protect margin."
        actions={
          <Button
            className="min-h-11"
            disabled={busy || Boolean(editor) || Boolean(transitionTarget)}
            onClick={() => requestSwitch('new')}
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
                        disabled={busy || Boolean(editor) || Boolean(transitionTarget)}
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
                      disabled={actionsDisabled}
                      onClick={() => {
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
                        disabled={actionsDisabled}
                        onClick={() => {
                          setMutationError('');
                          setTransitionTarget({ order, to: nextStatus[order.status]! });
                        }}
                      >
                        Move to {nextStatus[order.status]!.replaceAll('_', ' ').toLowerCase()}
                      </Button>
                    ) : null}
                    {!['CLOSED', 'CANCELLED'].includes(order.status) ? (
                      <Button
                        className="min-h-11"
                        variant="destructive"
                        disabled={actionsDisabled}
                        onClick={() => {
                          setMutationError('');
                          setTransitionTarget({ order, to: 'CANCELLED' });
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
                  <Stat label="Deposit" value={money(order.depositAmount)} />
                </div>
                <p role="status" className="mt-4 text-sm text-text-muted">
                  {busy
                    ? `Saving changes for ${eventIdentity(order)}…`
                    : dirtyForms.length
                      ? 'Unsaved edits. Switching events will ask you to discard them.'
                      : currencyLabel}
                </p>
              </SectionCard>
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
                      disabled={actionsDisabled}
                      className="grid min-w-0 gap-3 sm:grid-cols-2"
                    >
                      <Field label="Product or recipe">
                        <select
                          required
                          name="source"
                          aria-label="Product or recipe"
                          className={inputClass}
                        >
                          <option value="">Select an item</option>
                          {products.data?.map((item) => (
                            <option key={item.id} value={`product:${item.id}`}>
                              {item.name}
                            </option>
                          ))}
                          {recipes.data
                            ?.filter((item) => item.activeVersionId)
                            .map((item) => (
                              <option key={item.id} value={`recipe:${item.id}`}>
                                {item.name} ·{' '}
                                {money(
                                  recipeCosts.data?.find((cost) => cost.recipeId === item.id)
                                    ?.costPerPortion
                                )}
                                /portion
                              </option>
                            ))}
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
                            disabled={actionsDisabled}
                            aria-label={`Remove ${line.description} from ${eventIdentity(order)}`}
                            onClick={() =>
                              removeLine.mutate({ orderId: order.id, lineId: line.id })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-text-muted">
                        No items yet. Add products or active recipes.
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
                      disabled={actionsDisabled}
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
                          disabled={actionsDisabled}
                          aria-label={`Remove ${cost.label} from ${eventIdentity(order)}`}
                          onClick={() =>
                            removeExtra.mutate({ orderId: order.id, extraCostId: cost.id })
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
                            <TableCell>{item.baseUnitId}</TableCell>
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
                    disabled={actionsDisabled}
                    onChange={() => markDirty('delivery')}
                    onSubmit={submitDelivery}
                  />
                </SectionCard>
                <SectionCard title="Cost summary">
                  <p className="mb-4 text-sm text-text-muted">
                    {eventIdentity(order)} · {currencyLabel}. Latest loaded event quote, recipe
                    costs and extras. Margin is the quoted amount less included costs; it is not
                    realized profit or cash.
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
                      <Stat label="Ingredient cost" value={money(costs.data.recipeCost)} />
                      <Stat label="Extras" value={money(costs.data.extraCost)} />
                      <Stat label="Quoted total" value={money(costs.data.quotedTotal)} />
                      <Stat
                        label="Margin"
                        value={money(costs.data.margin)}
                        delta={
                          costs.data.marginPercent
                            ? `${Number(costs.data.marginPercent).toFixed(1)}%`
                            : '—'
                        }
                        deltaDirection={costs.data.margin?.startsWith('-') ? 'down' : 'up'}
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
              <Field label="Deposit">
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
                ? 'Cancel this order? Ready-order ingredient consumption will be reversed.'
                : `Move this order to ${transitionTarget?.to.replaceAll('_', ' ').toLowerCase()}? This action is recorded in the order timeline.`}
            </DialogDescription>
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
              disabled={actionsDisabled}
              onClick={() =>
                !actionsDisabled &&
                transitionTarget?.order.id === selectedId &&
                transition.mutate({ orderId: transitionTarget.order.id, to: transitionTarget.to })
              }
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
    </div>
  );
}
