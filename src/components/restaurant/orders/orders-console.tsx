'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { browserUuid } from '@/lib/browser-uuid';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
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
import { ORDER_CHANNELS } from '@/lib/restaurant/order-channels';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from '../restaurant-branch-select';
import { RestaurantDeviceSelect } from '../restaurant-device-select';
import { RestaurantStaffSelect } from '../restaurant-staff-select';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type OrderPage = RouterOutputs['restaurantOrders']['listOrders'];
type OrderSummary = OrderPage['orders'][number];
type OrderDetail = RouterOutputs['restaurantOrders']['getOrder'];
type StaffOption = RouterOutputs['restaurantStaff']['listDirectory'][number];
type OrderStatus = OrderSummary['status'];
type Channel = OrderSummary['channel'];
type Disposition = 'WASTE' | 'RESTOCK' | 'NONE';
type UiError = { message: string; data?: { code?: string } | null };

const statuses: OrderStatus[] = [
  'DRAFT',
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
  'PAYMENT_PENDING',
  'CLOSED',
  'CANCELLED',
];
const channels: Channel[] = [...ORDER_CHANNELS];
const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const instantFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function text(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function tone(status: string): StatusTone {
  if (['CLOSED', 'SERVED', 'READY'].includes(status)) return 'success';
  if (['OPEN', 'SENT', 'IN_PREPARATION'].includes(status)) return 'info';
  if (['DRAFT', 'PAYMENT_PENDING'].includes(status)) return 'warning';
  if (status === 'CANCELLED' || status === 'VOIDED') return 'danger';
  return 'neutral';
}

function instant(value: Date | string | null) {
  return value ? instantFormat.format(new Date(value)) : '—';
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={labelClass}>{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-strong">{value ?? '—'}</dd>
    </div>
  );
}

export function OrdersConsole() {
  const entitlements = useEntitlements();
  const posModule = entitlements.modules.find((module) => module.key === 'restaurant-pos');
  const posEnabled = posModule?.enabled ?? entitlements.enabledModules.includes('restaurant-pos');
  const utils = trpc.useUtils();
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: posEnabled,
  });
  const [branchId, setBranchId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [status, setStatus] = useState<'' | OrderStatus>('');
  const [channel, setChannel] = useState<'' | Channel>('');
  const [limit, setLimit] = useState(25);
  const [cursor, setCursor] = useState<string | undefined>();
  const [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([]);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [cancelApproverId, setCancelApproverId] = useState('');

  const normalizedBranchId = branchId.trim();
  const listEnabled = posEnabled && normalizedBranchId.length > 0;
  const staffQuery = trpc.restaurantStaff.listDirectory.useQuery(
    { branchId: normalizedBranchId },
    { enabled: listEnabled }
  );
  const devicesQuery = trpc.restaurantDevices.list.useQuery(undefined, { enabled: listEnabled });
  const listInput = {
    branchId: normalizedBranchId,
    ...(businessDate ? { businessDate } : {}),
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  };
  const ordersQuery = trpc.restaurantOrders.listOrders.useQuery(listInput, {
    enabled: listEnabled,
  });
  const orderQuery = trpc.restaurantOrders.getOrder.useQuery(
    { orderId: selectedOrderId },
    { enabled: listEnabled && selectedOrderId.length > 0 }
  );

  const cancel = trpc.restaurantOrders.cancel.useMutation({
    onSuccess: () => {
      setCancelOpen(false);
      setCancelError('');
      void utils.restaurantOrders.listOrders.invalidate();
      void utils.restaurantOrders.getOrder.invalidate({ orderId: selectedOrderId });
      toast.success('Order cancelled.');
    },
    onError: (error) => {
      setCancelError(error.message);
      toast.error(error.message);
    },
  });

  const resetPage = () => {
    setCursor(undefined);
    setPreviousCursors([]);
  };
  const updateBranch = (value: string) => {
    setBranchId(value);
    setSelectedOrderId('');
    resetPage();
  };
  const selectFilter = <T extends string>(setter: (value: T) => void, value: T) => {
    setter(value);
    resetPage();
  };
  const nextPage = () => {
    if (!ordersQuery.data?.nextCursor) return;
    setPreviousCursors((values) => [...values, cursor]);
    setCursor(ordersQuery.data.nextCursor);
  };
  const previousPage = () => {
    setCursor(previousCursors.at(-1));
    setPreviousCursors((values) => values.slice(0, -1));
  };

  const submitCancellation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrderId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const wastageDisposition = text(data, 'wastageDisposition') as Disposition | '';
    const approvingStaffProfileId = text(data, 'approvingStaffProfileId') || null;
    const approvingType: 'PIN' | 'BADGE' =
      text(data, 'approvingType') === 'BADGE' ? 'BADGE' : 'PIN';
    setCancelError('');
    // The acting staff member is the signed-in user's own staff profile, resolved
    // on the server. A named approver must prove who they are with their own PIN
    // or badge; an approver id alone is refused.
    cancel.mutate({
      orderId: selectedOrderId,
      reason: text(data, 'reason'),
      ...(wastageDisposition ? { wastageDisposition } : {}),
      approvingStaffProfileId,
      ...(approvingStaffProfileId
        ? {
            approvingCredential: {
              type: approvingType,
              // Secrets are sent verbatim; never trim a PIN or badge value.
              secret: String(data.get('approvingSecret') ?? ''),
            },
          }
        : {}),
      actor: {
        deviceId: text(data, 'deviceId'),
        idempotencyKey: browserUuid(),
      },
    });
  };

  const listError = ordersQuery.error;
  const permissionDenied = isPermissionError(listError);
  const orders = ordersQuery.data?.orders ?? [];
  const terminalOrder =
    orderQuery.data?.status === 'CLOSED' || orderQuery.data?.status === 'CANCELLED';

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Orders"
        description="Filter orders, inspect their immutable operational detail, and cancel with attribution."
      />

      {!posEnabled ? (
        <SectionCard title="Restaurant POS module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm text-text-muted">
              Order operations require the Restaurant POS entitlement.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard eyebrow="Order ledger" title="Filters" titleLevel={2}>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_11rem_12rem_11rem_8rem]">
              <Field label="Branch">
                <RestaurantBranchSelect
                  branches={branchesQuery.data ?? []}
                  loading={branchesQuery.isLoading}
                  error={Boolean(branchesQuery.error)}
                  value={branchId}
                  onChange={updateBranch}
                />
              </Field>
              <Field label="Business date">
                <Input
                  aria-label="Business date"
                  type="date"
                  value={businessDate}
                  onChange={(event) => selectFilter(setBusinessDate, event.target.value)}
                  className="h-11"
                />
              </Field>
              <Field label="Status">
                <StudioSelect
                  aria-label="Status"
                  value={status}
                  className={selectClass}
                  onChange={(event) =>
                    selectFilter(setStatus, event.target.value as '' | OrderStatus)
                  }
                >
                  <option value="">All statuses</option>
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {value.replaceAll('_', ' ')}
                    </option>
                  ))}
                </StudioSelect>
              </Field>
              <Field label="Channel">
                <StudioSelect
                  aria-label="Channel"
                  value={channel}
                  className={selectClass}
                  onChange={(event) => selectFilter(setChannel, event.target.value as '' | Channel)}
                >
                  <option value="">All channels</option>
                  {channels.map((value) => (
                    <option key={value} value={value}>
                      {value.replaceAll('_', ' ')}
                    </option>
                  ))}
                </StudioSelect>
              </Field>
              <Field label="Page size">
                <StudioSelect
                  aria-label="Page size"
                  value={limit}
                  className={selectClass}
                  onChange={(event) => {
                    setLimit(Number(event.target.value));
                    resetPage();
                  }}
                >
                  {[10, 25, 50, 100].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </StudioSelect>
              </Field>
            </div>
          </SectionCard>

          {!listEnabled ? (
            <SectionCard title="Choose a branch">
              <EmptyState
                title="Branch required"
                detail="Select a branch to load its order ledger."
              />
            </SectionCard>
          ) : permissionDenied ? (
            <SectionCard title="Order access unavailable">
              <p role="alert" className="text-sm text-destructive">
                You do not have permission to read restaurant orders.
              </p>
            </SectionCard>
          ) : listError ? (
            <SectionCard title="Orders unavailable">
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-destructive">{listError.message}</p>
                <Button variant="outline" onClick={() => void ordersQuery.refetch()}>
                  Try again
                </Button>
              </div>
            </SectionCard>
          ) : ordersQuery.isLoading ? (
            <SectionCard title="Loading orders…">
              <div role="status" aria-label="Loading restaurant orders" className="space-y-3">
                {[0, 1, 2, 3].map((row) => (
                  <Skeleton key={row} className="h-12 w-full" />
                ))}
              </div>
            </SectionCard>
          ) : (
            <>
              <SectionCard
                eyebrow="Current page"
                title={`${orders.length} order${orders.length === 1 ? '' : 's'}`}
              >
                <div className="mb-5 grid gap-5 sm:grid-cols-3">
                  <Stat label="Orders" value={orders.length} />
                  <Stat
                    label="Items"
                    value={orders.reduce((sum, order) => sum + order.itemCount, 0)}
                  />
                  <Stat
                    label="Open tables"
                    value={new Set(orders.flatMap((order) => order.activeTableIds)).size}
                  />
                </div>
                {orders.length === 0 ? (
                  <EmptyState
                    title="No orders found"
                    detail="Adjust filters or choose another business date."
                  />
                ) : (
                  <Table className="min-w-[940px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>Tables</TableHead>
                        <TableHead numeric>Items</TableHead>
                        <TableHead numeric>Subtotal</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((order) => (
                        <TableRow
                          key={order.id}
                          data-state={selectedOrderId === order.id ? 'selected' : undefined}
                        >
                          <TableCell>
                            <span className="block font-medium text-text-strong">
                              #{order.orderNumber}
                            </span>
                          </TableCell>
                          <TableCell>{order.businessDate}</TableCell>
                          <TableCell>
                            <StatusPill status={order.status} tone={tone(order.status)} />
                          </TableCell>
                          <TableCell>{order.channel.replaceAll('_', ' ')}</TableCell>
                          <TableCell>
                            {order.activeTables.map((table) => table.code).join(', ') || '—'}
                          </TableCell>
                          <TableCell numeric>{order.itemCount}</TableCell>
                          <TableCell numeric>{order.subtotal}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedOrderId(order.id)}
                            >
                              View order {order.orderNumber}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
                  <p className="font-mono text-xs text-text-muted">
                    Page {previousCursors.length + 1}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={previousCursors.length === 0 || ordersQuery.isFetching}
                      onClick={previousPage}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!ordersQuery.data?.nextCursor || ordersQuery.isFetching}
                      onClick={nextPage}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </SectionCard>

              {selectedOrderId ? (
                <OrderDetailPanel
                  order={orderQuery.data}
                  staff={staffQuery.data ?? []}
                  isLoading={orderQuery.isLoading}
                  error={orderQuery.error}
                  onRetry={() => void orderQuery.refetch()}
                  onClose={() => setSelectedOrderId('')}
                  onCancel={() => {
                    setCancelError('');
                    setCancelApproverId('');
                    setCancelOpen(true);
                  }}
                />
              ) : null}
            </>
          )}
        </>
      )}

      <Dialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!cancel.isPending) setCancelOpen(open);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          <form className="space-y-4" onSubmit={submitCancellation}>
            <DialogHeader>
              <DialogTitle>
                Cancel order {orderQuery.data ? `#${orderQuery.data.orderNumber}` : ''}?
              </DialogTitle>
              <DialogDescription>
                This is destructive and appends an attributed cancellation event. It cannot reopen
                the order.
              </DialogDescription>
            </DialogHeader>
            {terminalOrder ? (
              <p role="alert" className="rounded-md bg-warning/10 p-3 text-sm text-warning">
                This order is already terminal and cannot be cancelled.
              </p>
            ) : null}
            <p className="text-sm text-text-muted">
              The cancellation is recorded as your own signed-in staff profile.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Device">
                <RestaurantDeviceSelect
                  devices={devicesQuery.data ?? []}
                  branchId={normalizedBranchId}
                  loading={devicesQuery.isLoading}
                  error={Boolean(devicesQuery.error)}
                  required
                />
              </Field>
            </div>
            <Field label="Reason">
              <Input name="reason" required className="h-11" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Wastage disposition">
                <StudioSelect name="wastageDisposition" className={selectClass} defaultValue="">
                  <option value="">Not specified</option>
                  <option value="WASTE">Waste</option>
                  <option value="RESTOCK">Restock</option>
                  <option value="NONE">None</option>
                </StudioSelect>
              </Field>
              <Field label="Approving staff member (optional)">
                <RestaurantStaffSelect
                  name="approvingStaffProfileId"
                  staff={staffQuery.data ?? []}
                  loading={staffQuery.isLoading}
                  error={Boolean(staffQuery.error)}
                  allowEmpty
                  emptyLabel="No additional approval"
                  label="Approving staff member"
                  value={cancelApproverId}
                  onChange={setCancelApproverId}
                />
              </Field>
            </div>
            {cancelApproverId ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Approving credential type">
                  <StudioSelect name="approvingType" defaultValue="PIN" className={selectClass}>
                    <option value="PIN">PIN</option>
                    <option value="BADGE">Badge</option>
                  </StudioSelect>
                </Field>
                <Field label="Approving PIN or badge secret">
                  <Input
                    name="approvingSecret"
                    type="password"
                    required
                    autoComplete="new-password"
                    className="h-11"
                  />
                </Field>
              </div>
            ) : null}
            <p className="text-xs text-text-muted">
              A fresh device-scoped idempotency key is generated in this browser when submitted.
            </p>
            {cancelError ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {cancelError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={cancel.isPending}
                onClick={() => setCancelOpen(false)}
              >
                Keep order
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11"
                disabled={cancel.isPending || terminalOrder}
              >
                {cancel.isPending ? 'Cancelling…' : 'Confirm cancellation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OrderDetailPanel({
  order,
  staff,
  isLoading,
  error,
  onRetry,
  onClose,
  onCancel,
}: {
  order?: OrderDetail;
  staff: StaffOption[];
  isLoading: boolean;
  error?: UiError | null;
  onRetry: () => void;
  onClose: () => void;
  onCancel: () => void;
}) {
  const staffLabel = (staffProfileId: string | null) =>
    staffProfileId
      ? (staff.find((person) => person.id === staffProfileId)?.displayName ??
        'Staff name unavailable')
      : 'System';
  if (isLoading) {
    return (
      <SectionCard title="Loading order detail…">
        <div role="status" aria-label="Loading order detail" className="space-y-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-20 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }
  if (error) {
    return (
      <SectionCard title="Order detail unavailable">
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </SectionCard>
    );
  }
  if (!order) return null;
  const terminal = order.status === 'CLOSED' || order.status === 'CANCELLED';

  return (
    <SectionCard
      eyebrow="Order detail"
      title={`Order #${order.orderNumber}`}
      actions={
        <>
          <Button variant="outline" onClick={onClose}>
            Close detail
          </Button>
          <Button variant="destructive" disabled={terminal} onClick={onCancel}>
            Cancel order
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={order.status} tone={tone(order.status)} />
          <StatusPill
            status={order.channel}
            tone="neutral"
            label={order.channel.replaceAll('_', ' ')}
          />
        </div>

        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <DetailField label="Business date" value={order.businessDate} />
          <DetailField label="Covers" value={order.coverCount} />
          <DetailField label="Opened" value={instant(order.openedAt)} />
          <DetailField label="Closed" value={instant(order.closedAt)} />
          <DetailField label="Cancelled" value={instant(order.cancelledAt)} />
        </dl>

        <div className="grid gap-5 sm:grid-cols-3">
          <Stat label="Derived subtotal" value={order.totals.subtotal} />
          <Stat label="Derived tax" value={order.totals.tax} />
          <Stat label="Derived service charge" value={order.totals.serviceCharge} />
        </div>

        <section aria-labelledby="order-items-heading">
          <h4 id="order-items-heading" className="mb-3 font-semibold text-text-strong">
            Items
          </h4>
          {order.items.length ? (
            <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Course / seat</TableHead>
                  <TableHead>Product / variant</TableHead>
                  <TableHead>Modifiers</TableHead>
                  <TableHead numeric>Qty</TableHead>
                  <TableHead numeric>Unit price</TableHead>
                  <TableHead numeric>Tax</TableHead>
                  <TableHead numeric>Service</TableHead>
                  <TableHead>Void / remake detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className="block font-medium text-text-strong">{item.name}</span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {item.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusPill status={item.status} tone={tone(item.status)} />
                    </TableCell>
                    <TableCell>
                      {item.course} / {item.seatNumber ?? '—'}
                    </TableCell>
                    <TableCell>
                      <span className="block font-mono text-[0.625rem]">{item.productId}</span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {item.variantId ?? 'Base'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {item.modifiers.length
                        ? item.modifiers.map((modifier) => (
                            <span key={modifier.id} className="block">
                              {modifier.name} ({modifier.priceDelta})
                              <span className="block font-mono text-[0.625rem] text-text-faint">
                                {modifier.modifierOptionId}
                              </span>
                            </span>
                          ))
                        : '—'}
                    </TableCell>
                    <TableCell numeric>{item.quantity}</TableCell>
                    <TableCell numeric>{item.unitPrice}</TableCell>
                    <TableCell numeric>{item.taxAmount}</TableCell>
                    <TableCell numeric>{item.serviceChargeAmount}</TableCell>
                    <TableCell>
                      <span className="block">{item.voidReason ?? '—'}</span>
                      <span className="block text-xs text-text-muted">
                        {item.voidedPostPrep ? 'Post-prep' : 'Not post-prep'} ·{' '}
                        {item.wastageDisposition ?? 'No disposition'}
                      </span>
                      {item.remakeOfItemId ? (
                        <span className="block font-mono text-[0.625rem]">
                          Remake of {item.remakeOfItemId}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No order items" detail="This order has no item snapshots." />
          )}
        </section>

        <section aria-labelledby="order-tables-heading">
          <h4 id="order-tables-heading" className="mb-3 font-semibold text-text-strong">
            Table links
          </h4>
          {order.tables.length ? (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Link ID</TableHead>
                  <TableHead>Table ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Linked</TableHead>
                  <TableHead>Unlinked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.tables.map((table) => (
                  <TableRow key={table.id}>
                    <TableCell className="font-mono text-xs">{table.id}</TableCell>
                    <TableCell className="font-mono text-xs">{table.tableId}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={table.active ? 'Active' : 'Unlinked'}
                        tone={table.active ? 'success' : 'neutral'}
                      />
                    </TableCell>
                    <TableCell>{table.linkReason}</TableCell>
                    <TableCell>{instant(table.linkedAt)}</TableCell>
                    <TableCell>{instant(table.unlinkedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No table links" detail="This order is not linked to a table." />
          )}
        </section>

        <section aria-labelledby="order-tickets-heading">
          <h4 id="order-tickets-heading" className="mb-3 font-semibold text-text-strong">
            Kitchen tickets
          </h4>
          {order.kitchenTickets.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {order.kitchenTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  className="rounded-md border border-border-subtle bg-surface-sunken p-4"
                >
                  <p className="font-medium text-text-strong">Ticket #{ticket.ticketNumber}</p>
                  <p className="mt-1 font-mono text-[0.625rem] text-text-faint">{ticket.id}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    <DetailField label="Station ID" value={ticket.stationId} />
                    <DetailField label="Business date" value={ticket.businessDate} />
                    <DetailField label="Created" value={instant(ticket.createdAt)} />
                    <DetailField label="Items" value={ticket.items.length} />
                  </dl>
                  <ul className="mt-3 space-y-1 text-sm text-text-muted">
                    {ticket.items.map((item) => (
                      <li key={item.orderItemId}>
                        {item.quantity} × {item.orderItemId}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No kitchen tickets"
              detail="No tickets were generated for this order."
            />
          )}
        </section>

        <section aria-labelledby="order-events-heading">
          <h4 id="order-events-heading" className="mb-3 font-semibold text-text-strong">
            Event history
          </h4>
          {order.events.length ? (
            <ol className="space-y-3">
              {order.events.map((event) => (
                <li key={event.id} className="rounded-md border border-border-subtle p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-text-strong">
                      {event.sequence}. {event.eventType}
                    </p>
                    <time className="font-mono text-xs text-text-muted">
                      {instant(event.createdAt)}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    Recorded by {staffLabel(event.actorStaffProfileId)}
                  </p>
                  <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-surface-sunken p-3 text-xs whitespace-pre-wrap text-text-muted">
                    {JSON.stringify(event.payload, null, 2) ?? 'null'}
                  </pre>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No events" detail="No order events were returned." />
          )}
        </section>
      </div>
    </SectionCard>
  );
}
