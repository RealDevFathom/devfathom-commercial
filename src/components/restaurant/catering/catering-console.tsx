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
function money(value: { toString(): string } | null | undefined) {
  return value == null
    ? '—'
    : new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(Number(value));
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

export function CateringConsole() {
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
  const [transitionTo, setTransitionTo] = useState<Status | null>(null);
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
    setTransitionTo(null);
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

  const submitOrder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    if (!selectedId) return;
    const data = new FormData(event.currentTarget);
    const source = value(data, 'source');
    const [kind, id] = source.split(':');
    addLine.mutate({
      orderId: selectedId,
      productId: kind === 'product' ? id : null,
      recipeId: kind === 'recipe' ? id : null,
      description: value(data, 'description'),
      portions: value(data, 'portions'),
      unitPrice: value(data, 'unitPrice'),
    });
  };
  const submitExtra = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    addExtra.mutate({
      orderId: selectedId,
      kind: value(data, 'kind') as 'LABOUR' | 'TRANSPORT' | 'RENTAL' | 'OTHER',
      label: value(data, 'label'),
      amount: value(data, 'amount'),
    });
  };
  const submitDelivery = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setDelivery.mutate({
      orderId: selectedId,
      scheduledAt: new Date(value(data, 'scheduledAt')),
      dispatchedAt: value(data, 'dispatchedAt') ? new Date(value(data, 'dispatchedAt')) : null,
      deliveredAt: value(data, 'deliveredAt') ? new Date(value(data, 'deliveredAt')) : null,
      driverStaffId: optional(data, 'driverStaffId'),
      vehicle: optional(data, 'vehicle'),
      notes: optional(data, 'deliveryNotes'),
    });
  };
  const order = detail.data;

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
            onClick={() => {
              setOrderCustomerId('');
              setEditor({});
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
              name="from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="Event date to">
            <Input
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
            <Button className="mt-4" variant="outline" onClick={() => list.refetch()}>
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
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(item.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium">{item.eventName}</TableCell>
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
          {detail.isLoading ? (
            <SectionCard title="Loading order detail">
              <Skeleton className="h-48 w-full" />
            </SectionCard>
          ) : detail.error ? (
            <SectionCard title="Order unavailable">
              <p role="alert" className="text-sm text-text-muted">
                {detail.error.message}
              </p>
            </SectionCard>
          ) : order ? (
            <>
              <SectionCard
                title={order.eventName}
                eyebrow={`${localDate(order.eventDate)} · ${order.headcount} guests`}
                actions={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setOrderCustomerId(order.customerId ?? '');
                        setEditor({ order });
                      }}
                    >
                      Edit order
                    </Button>
                    {nextStatus[order.status] ? (
                      <Button onClick={() => setTransitionTo(nextStatus[order.status]!)}>
                        Move to {nextStatus[order.status]!.replaceAll('_', ' ').toLowerCase()}
                      </Button>
                    ) : null}
                    {!['CLOSED', 'CANCELLED'].includes(order.status) ? (
                      <Button variant="destructive" onClick={() => setTransitionTo('CANCELLED')}>
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
              </SectionCard>
              <div className="grid gap-6 xl:grid-cols-2">
                <SectionCard title="Order lines">
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={submitLine}>
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
                      <Input required name="description" />
                    </Field>
                    <Field label="Portions">
                      <Input required name="portions" type="number" min="0.001" step="0.001" />
                    </Field>
                    <Field label="Unit price">
                      <Input required name="unitPrice" type="number" min="0" step="0.01" />
                    </Field>
                    <Button disabled={busy} type="submit">
                      Add line
                    </Button>
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
                            variant="ghost"
                            size="sm"
                            disabled={busy}
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
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={submitExtra}>
                    <Field label="Cost type">
                      <select required name="kind" aria-label="Cost type" className={inputClass}>
                        {['LABOUR', 'TRANSPORT', 'RENTAL', 'OTHER'].map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Label">
                      <Input required name="label" />
                    </Field>
                    <Field label="Amount">
                      <Input required name="amount" type="number" min="0" step="0.01" />
                    </Field>
                    <Button disabled={busy} type="submit">
                      Add cost
                    </Button>
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
                          variant="ghost"
                          size="sm"
                          disabled={busy}
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
                eyebrow="Grouped ingredient requirements"
                actions={
                  <Button variant="outline" onClick={() => window.print()}>
                    <Printer />
                    Print
                  </Button>
                }
              >
                <div className="print:block">
                  {requirements.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : requirements.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {requirements.error.message}
                    </p>
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
                      No recipe ingredients are required yet.
                    </p>
                  )}
                </div>
              </SectionCard>
              <div className="grid gap-6 xl:grid-cols-2">
                <SectionCard title="Delivery">
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={submitDelivery}>
                    <Field label="Scheduled">
                      <Input
                        required
                        name="scheduledAt"
                        type="datetime-local"
                        defaultValue={localDateTime(order.delivery?.scheduledAt)}
                      />
                    </Field>
                    <Field label="Driver">
                      <select
                        name="driverStaffId"
                        aria-label="Driver"
                        className={inputClass}
                        defaultValue={order.delivery?.driverStaffId ?? ''}
                      >
                        <option value="">Unassigned</option>
                        {staff.data?.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.displayName}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Dispatched">
                      <Input
                        name="dispatchedAt"
                        type="datetime-local"
                        defaultValue={localDateTime(order.delivery?.dispatchedAt)}
                      />
                    </Field>
                    <Field label="Delivered">
                      <Input
                        name="deliveredAt"
                        type="datetime-local"
                        defaultValue={localDateTime(order.delivery?.deliveredAt)}
                      />
                    </Field>
                    <Field label="Vehicle">
                      <Input name="vehicle" defaultValue={order.delivery?.vehicle ?? ''} />
                    </Field>
                    <Field label="Delivery notes">
                      <Input name="deliveryNotes" defaultValue={order.delivery?.notes ?? ''} />
                    </Field>
                    <Button disabled={busy} type="submit">
                      Save delivery
                    </Button>
                  </form>
                </SectionCard>
                <SectionCard title="Cost summary">
                  {costs.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : costs.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {costs.error.message}
                    </p>
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
                        deltaDirection={Number(costs.data.margin ?? 0) >= 0 ? 'up' : 'down'}
                      />
                    </div>
                  ) : null}
                </SectionCard>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.order ? 'Edit catering order' : 'Create catering order'}
            </DialogTitle>
            <DialogDescription>
              Capture the customer, event, venue or saved delivery address, and commercial terms.
            </DialogDescription>
          </DialogHeader>
          <form
            id="catering-order-form"
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={submitOrder}
          >
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
              <Input required name="eventName" defaultValue={editor?.order?.eventName ?? ''} />
            </Field>
            <Field label="Event date">
              <Input
                required
                name="eventDate"
                type="date"
                defaultValue={localDate(editor?.order?.eventDate)}
              />
            </Field>
            <Field label="Service time">
              <Input
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
                required
                name="headcount"
                type="number"
                min="1"
                defaultValue={editor?.order?.headcount ?? 1}
              />
            </Field>
            <Field label="Venue address">
              <Input name="venueAddress" defaultValue={editor?.order?.venueAddress ?? ''} />
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
                name="quotedTotal"
                type="number"
                min="0"
                step="0.01"
                defaultValue={editor?.order?.quotedTotal?.toString() ?? ''}
              />
            </Field>
            <Field label="Deposit">
              <Input
                name="depositAmount"
                type="number"
                min="0"
                step="0.01"
                defaultValue={editor?.order?.depositAmount?.toString() ?? ''}
              />
            </Field>
            <Field label="Notes">
              <Input name="notes" defaultValue={editor?.order?.notes ?? ''} />
            </Field>
          </form>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button form="catering-order-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={transitionTo !== null} onOpenChange={(open) => !open && setTransitionTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm status change</DialogTitle>
            <DialogDescription>
              {transitionTo === 'CANCELLED'
                ? 'Cancel this order? Ready-order ingredient consumption will be reversed.'
                : `Move this order to ${transitionTo?.replaceAll('_', ' ').toLowerCase()}? This action is recorded in the order timeline.`}
            </DialogDescription>
          </DialogHeader>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransitionTo(null)}>
              Keep current status
            </Button>
            <Button
              variant={transitionTo === 'CANCELLED' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() =>
                transitionTo && transition.mutate({ orderId: selectedId, to: transitionTo })
              }
            >
              Confirm change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
