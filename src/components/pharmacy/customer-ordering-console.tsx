'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';
import { PackageCheck, Search, ShoppingBasket, Store, Truck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { DeliveryEvidenceForm } from './delivery-evidence-form';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>;
type CatalogItem = Outputs['pharmacyOrdering']['catalog'][number];
type CustomerOrder = NonNullable<Outputs['pharmacyOrdering']['mine'][number]>;
type CartLine = CatalogItem & { quantity: number };
type Notice = { tone: 'success' | 'danger' | 'neutral'; message: string };

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-PK', { style: 'currency', currency }).format(minor / 100);
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
  }).format(value);
}

function message(error: { message: string }) {
  const messages: Record<string, string> = {
    CUSTOMER_ACCOUNT_REQUIRED: 'Ask pharmacy staff to link this sign-in to your customer account.',
    ITEM_NOT_ORDERABLE: 'That item is not available for customer ordering.',
    INSUFFICIENT_STOCK: 'Stock changed before placement. Review the basket and try again.',
    INVALID_STATE: 'That order has already moved to another stage. Refresh and try again.',
    RUNNER_REQUIRED: 'Assign a staff runner before dispatch.',
    SALE_NOT_COMPLETED: 'Complete the linked counter sale before completing this order.',
  };
  return messages[error.message] ?? error.message;
}

function OrderCard({
  order,
  staff,
  runnerUserId,
  onRunnerChange,
  onAction,
  pending,
  runners,
  currency,
}: {
  order: CustomerOrder;
  staff: boolean;
  runnerUserId: string;
  onRunnerChange: (value: string) => void;
  onAction: (action: string, order: CustomerOrder) => void;
  pending: string | null;
  runners: Array<{ id: string; name: string }>;
  currency: string;
}) {
  const total = order.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const next =
    order.status === 'PROPOSED'
      ? 'accept'
      : order.status === 'ACCEPTED'
        ? 'pack'
        : order.status === 'PACKING'
          ? order.fulfillment === 'COLLECT'
            ? 'ready'
            : 'dispatch'
          : order.status === 'READY_FOR_COLLECTION' || order.status === 'OUT_FOR_DELIVERY'
            ? order.counterSaleId
              ? 'complete'
              : 'checkout'
            : null;
  return (
    <article className="rounded-md border border-border-subtle bg-surface-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-wide text-text-muted uppercase">
            {order.id.slice(-8)} · {order.branch.name}
          </p>
          <h3 className="mt-1 font-display text-base font-semibold text-text-strong">
            {order.customer.displayName}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {order.fulfillment === 'COLLECT'
              ? 'Collect at branch'
              : `${order.addressLine}, ${order.city}`}
          </p>
        </div>
        <div className="text-right">
          <StatusPill status={order.status} />
          <p className="mt-2 font-mono text-xs tabular-nums text-text-strong">
            Quoted total: {money(total, currency)}
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-2 border-t border-border-subtle pt-3 text-sm">
        {order.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-4">
            <span className="text-text-body">
              {line.quantity} × {line.medicine.brandName ?? line.medicine.productName}
            </span>
            <span className="font-mono tabular-nums text-text-muted">
              {money(line.lineTotalMinor, currency)}
            </span>
          </li>
        ))}
      </ul>
      <ol aria-label="Order tracking" className="mt-3 space-y-1 text-sm text-text-muted">
        {order.events.map((event) => (
          <li key={event.id}>
            {event.kind.replaceAll('_', ' ')} · {dateTime(event.occurredAt)}
          </li>
        ))}
        {order.deliveryEvidence.map((event) => (
          <li key={event.id}>
            {event.action.replaceAll('_', ' ')} · {dateTime(event.occurredAt)}
          </li>
        ))}
      </ol>
      {staff && ['READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'COMPLETED'].includes(order.status) ? (
        <DeliveryEvidenceForm branchId={order.branchId} orderId={order.id} />
      ) : null}
      {order.runner ? (
        <p className="mt-3 text-xs text-text-muted">Runner: {order.runner.name}</p>
      ) : null}
      {['PROPOSED', 'ACCEPTED', 'PACKING'].includes(order.status) ? (
        <p className="mt-3 text-xs text-text-muted">
          Reservation expires {dateTime(order.reservationExpiresAt)}
        </p>
      ) : null}
      {staff && next ? (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          {next === 'dispatch' ? (
            <div className="min-w-48 flex-1">
              <Label htmlFor={`runner-${order.id}`}>Assigned runner</Label>
              <select
                id={`runner-${order.id}`}
                className="h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm"
                value={runnerUserId}
                onChange={(event) => onRunnerChange(event.target.value)}
              >
                <option value="">Select a staff runner</option>
                {runners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button
            size="lg"
            disabled={pending !== null || (next === 'dispatch' && !runnerUserId)}
            onClick={() => onAction(next, order)}
          >
            {next === 'accept'
              ? 'Accept proposal'
              : next === 'pack'
                ? 'Start packing'
                : next === 'ready'
                  ? 'Mark ready'
                  : next === 'dispatch'
                    ? 'Send with runner'
                    : next === 'checkout'
                      ? 'Start counter sale'
                      : 'Complete order'}
          </Button>
          {['PROPOSED', 'ACCEPTED', 'PACKING'].includes(order.status) ? (
            <>
              <Button
                variant="destructive"
                size="lg"
                disabled={pending !== null}
                onClick={() => onAction('cancel', order)}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={pending !== null}
                onClick={() => onAction('expire', order)}
              >
                Expire if due
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {order.counterSaleId ? (
        <Link
          className="mt-3 inline-flex text-sm font-semibold text-primary underline-offset-4 hover:underline"
          href={`/pharmacy/counter?orderSaleId=${encodeURIComponent(order.counterSaleId)}&branchId=${encodeURIComponent(order.branchId)}`}
        >
          Open linked counter sale
        </Link>
      ) : null}
    </article>
  );
}

export function PharmacyCustomerOrderingConsole() {
  const utils = trpc.useUtils();
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [fulfillment, setFulfillment] = useState<'COLLECT' | 'DELIVER'>('COLLECT');
  const [payment, setPayment] = useState<'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT'>(
    'CASH'
  );
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [actingCustomerId, setActingCustomerId] = useState('');
  const [runnerByOrder, setRunnerByOrder] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const branchesQuery = trpc.pharmacyOrdering.branches.useQuery();
  const branches = branchesQuery.data?.branches ?? [];
  const branchId = selectedBranchId || branches[0]?.id || '';
  const catalogQuery = trpc.pharmacyOrdering.catalog.useQuery(
    { branchId, search },
    { enabled: Boolean(branchId), staleTime: 5_000 }
  );
  const mineQuery = trpc.pharmacyOrdering.mine.useQuery();
  const staffQueueQuery = trpc.pharmacyOrdering.staffQueue.useQuery(
    { branchId },
    { enabled: Boolean(branchId), retry: false }
  );
  const customersQuery = trpc.pharmacyOrdering.customers.useQuery(undefined, { retry: false });
  const runnersQuery = trpc.pharmacyOrdering.runners.useQuery(undefined, { retry: false });
  const staff = staffQueueQuery.isSuccess;
  const currency = branchesQuery.data?.currency ?? 'PKR';

  const place = trpc.pharmacyOrdering.place.useMutation();
  const cancelMine = trpc.pharmacyOrdering.cancelMine.useMutation();
  const transition = trpc.pharmacyOrdering.transition.useMutation();
  const startCheckout = trpc.pharmacyOrdering.startCheckout.useMutation();
  const complete = trpc.pharmacyOrdering.complete.useMutation();

  const totalMinor = useMemo(
    () => cart.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0),
    [cart]
  );

  async function refresh() {
    await Promise.all([
      utils.pharmacyOrdering.mine.invalidate(),
      utils.pharmacyOrdering.staffQueue.invalidate(),
      utils.pharmacyOrdering.catalog.invalidate(),
    ]);
  }

  function add(item: CatalogItem) {
    setCart((current) => {
      const existing = current.find((line) => line.packLevelId === item.packLevelId);
      if (!existing) return [...current, { ...item, quantity: 1 }];
      if (existing.quantity >= item.availablePacks) return current;
      return current.map((line) =>
        line.packLevelId === item.packLevelId ? { ...line, quantity: line.quantity + 1 } : line
      );
    });
  }

  async function submitOrder() {
    setPending('place');
    setNotice(null);
    try {
      await place.mutateAsync({
        branchId,
        ...(staff && actingCustomerId ? { customerId: actingCustomerId } : {}),
        fulfillment,
        intendedPaymentMethod: payment,
        ...(fulfillment === 'DELIVER'
          ? {
              addressLine,
              city,
              ...(deliveryInstructions ? { deliveryInstructions } : {}),
            }
          : {}),
        lines: cart.map((line) => ({
          medicineId: line.medicineId,
          presentationId: line.presentationId,
          packLevelId: line.packLevelId,
          saleUnit: 'PACK' as const,
          quantity: line.quantity,
        })),
      });
      setCart([]);
      setNotice({ tone: 'success', message: 'Order proposed and branch stock reserved.' });
      await refresh();
    } catch (error) {
      setNotice({ tone: 'danger', message: message(error as { message: string }) });
    } finally {
      setPending(null);
    }
  }

  async function staffAction(action: string, order: CustomerOrder) {
    setPending(`${action}:${order.id}`);
    setNotice(null);
    try {
      if (action === 'checkout') {
        const result = await startCheckout.mutateAsync({ branchId, orderId: order.id });
        setNotice({
          tone: 'success',
          message: `Counter sale ${result.saleId.slice(-8)} is ready for the intended ${order.intendedPaymentMethod.toLowerCase()} tender.`,
        });
      } else if (action === 'complete') {
        await complete.mutateAsync({ branchId, orderId: order.id });
      } else {
        await transition.mutateAsync({
          branchId,
          orderId: order.id,
          action: action as 'accept' | 'pack' | 'ready' | 'dispatch' | 'cancel' | 'expire',
          ...(action === 'dispatch' ? { runnerUserId: runnerByOrder[order.id] } : {}),
        });
      }
      await refresh();
    } catch (error) {
      setNotice({ tone: 'danger', message: message(error as { message: string }) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
      <div className="min-w-0 space-y-6">
        <SectionCard
          eyebrow="Storefront"
          title="Orderable pharmacy catalogue"
          titleLevel={2}
          actions={
            <label className="relative block min-w-52">
              <span className="sr-only">Search catalogue</span>
              <Search aria-hidden className="absolute top-2.5 left-3 size-4 text-text-muted" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search OTC products"
              />
            </label>
          }
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="order-branch">Fulfilling branch</Label>
              <select
                id="order-branch"
                className="h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm"
                value={branchId}
                onChange={(event) => setSelectedBranchId(event.target.value)}
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} · {branch.city}
                  </option>
                ))}
              </select>
            </div>
            {staff ? (
              <div>
                <Label htmlFor="acting-customer">Ordering for customer</Label>
                <select
                  id="acting-customer"
                  className="h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm"
                  value={actingCustomerId}
                  onChange={(event) => setActingCustomerId(event.target.value)}
                >
                  <option value="">Select a customer</option>
                  {(customersQuery.data ?? []).map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.displayName}
                      {customer.phoneLast4 ? ` · •••• ${customer.phoneLast4}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          {catalogQuery.isLoading ? (
            <div className="rounded-md border border-border-subtle bg-surface-sunken p-6 text-sm text-text-muted">
              Checking branch stock…
            </div>
          ) : catalogQuery.isError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-6"
            >
              <p className="text-sm text-destructive">Catalogue could not be loaded.</p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => void catalogQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : catalogQuery.data?.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {catalogQuery.data.map((item) => (
                <article
                  key={`${item.medicineId}:${item.packLevelId}`}
                  className="rounded-md border border-border-subtle p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-text-strong">
                        {item.brandName ?? item.productName}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {item.presentation} · {item.packLabel}
                      </p>
                    </div>
                    <StatusPill
                      status="in stock"
                      tone="success"
                      label={`${item.availablePacks} packs`}
                    />
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="font-mono text-sm tabular-nums text-text-strong">
                      {money(item.unitPriceMinor, currency)}
                    </span>
                    <Button size="lg" disabled={item.availablePacks < 1} onClick={() => add(item)}>
                      Add
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-border-subtle bg-surface-sunken p-6 text-sm text-text-muted">
              No non-prescription, saleable item with available stock matches this branch and
              search.
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Orders"
          title={staff ? 'Branch fulfilment queue' : 'Your orders'}
          titleLevel={2}
        >
          {(staff ? staffQueueQuery : mineQuery).isLoading ? (
            <p className="text-sm text-text-muted">Loading orders…</p>
          ) : (staff ? staffQueueQuery.data : mineQuery.data)?.length ? (
            <div className="space-y-3">
              {(staff ? staffQueueQuery.data : mineQuery.data)?.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  staff={staff}
                  runnerUserId={runnerByOrder[order.id] ?? ''}
                  onRunnerChange={(value) =>
                    setRunnerByOrder((current) => ({ ...current, [order.id]: value }))
                  }
                  onAction={(action, selected) => void staffAction(action, selected)}
                  pending={pending}
                  runners={runnersQuery.data ?? []}
                  currency={currency}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              {staff ? 'No customer orders at this branch.' : 'You have not placed an order yet.'}
            </p>
          )}
          {!staff && mineQuery.data?.some((order) => order.status === 'PROPOSED') ? (
            <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
              {mineQuery.data
                .filter((order) => order.status === 'PROPOSED')
                .map((order) => (
                  <Button
                    key={order.id}
                    variant="destructive"
                    disabled={pending !== null}
                    onClick={async () => {
                      setPending(`cancel:${order.id}`);
                      try {
                        await cancelMine.mutateAsync({
                          branchId: order.branchId,
                          orderId: order.id,
                        });
                        await refresh();
                      } catch (error) {
                        setNotice({
                          tone: 'danger',
                          message: message(error as { message: string }),
                        });
                      } finally {
                        setPending(null);
                      }
                    }}
                  >
                    Cancel proposal {order.id.slice(-8)}
                  </Button>
                ))}
            </div>
          ) : null}
        </SectionCard>
      </div>

      <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
        <SectionCard eyebrow="Basket" title="Order proposal" titleLevel={2}>
          {cart.length ? (
            <ul className="space-y-3">
              {cart.map((line) => (
                <li
                  key={line.packLevelId}
                  className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-text-strong">
                      {line.brandName ?? line.productName}
                    </p>
                    <p className="text-xs text-text-muted">
                      {line.quantity} × {line.packLabel}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setCart((current) =>
                        current.filter((item) => item.packLevelId !== line.packLevelId)
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center gap-3 rounded-md bg-surface-sunken p-4 text-sm text-text-muted">
              <ShoppingBasket aria-hidden className="size-5" />
              Add an in-stock OTC pack to begin.
            </div>
          )}

          <fieldset className="mt-5 grid grid-cols-2 gap-2">
            <legend className="mb-2 text-sm font-semibold text-text-strong">Fulfilment</legend>
            <Button
              type="button"
              size="lg"
              variant={fulfillment === 'COLLECT' ? 'default' : 'outline'}
              onClick={() => setFulfillment('COLLECT')}
            >
              <Store aria-hidden /> Collect
            </Button>
            <Button
              type="button"
              size="lg"
              variant={fulfillment === 'DELIVER' ? 'default' : 'outline'}
              onClick={() => setFulfillment('DELIVER')}
            >
              <Truck aria-hidden /> Deliver
            </Button>
          </fieldset>

          {fulfillment === 'DELIVER' ? (
            <div className="mt-4 space-y-3">
              <div>
                <Label htmlFor="delivery-address">Delivery address</Label>
                <Input
                  id="delivery-address"
                  value={addressLine}
                  onChange={(event) => setAddressLine(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="delivery-city">City</Label>
                <Input
                  id="delivery-city"
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="delivery-notes">Delivery instructions</Label>
                <Input
                  id="delivery-notes"
                  value={deliveryInstructions}
                  onChange={(event) => setDeliveryInstructions(event.target.value)}
                />
              </div>
            </div>
          ) : null}

          <div className="mt-4">
            <Label htmlFor="payment-intent">Intended payment method</Label>
            <select
              id="payment-intent"
              className="h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm"
              value={payment}
              onChange={(event) => setPayment(event.target.value as typeof payment)}
            >
              <option value="CASH">Cash at fulfilment</option>
              <option value="CARD">Card at fulfilment</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="WALLET">Wallet at counter</option>
              <option value="CREDIT">Approved credit</option>
            </select>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              This is an intention only. No online payment is taken; staff settle the linked counter
              sale.
            </p>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <div>
              <p className="font-mono text-xs tracking-wide text-text-muted uppercase">
                Total
              </p>
              <p className="font-display text-xl font-semibold text-text-strong">
                {money(totalMinor, currency)}
              </p>
            </div>
            <Button
              size="lg"
              disabled={
                pending !== null ||
                cart.length === 0 ||
                !branchId ||
                (staff && !actingCustomerId) ||
                (!staff && !branchesQuery.data?.customer) ||
                (fulfillment === 'DELIVER' && (!addressLine.trim() || !city.trim()))
              }
              onClick={() => void submitOrder()}
            >
              <PackageCheck aria-hidden /> Place order
            </Button>
          </div>
        </SectionCard>

        {notice ? (
          <div
            role={notice.tone === 'danger' ? 'alert' : 'status'}
            className={
              notice.tone === 'danger'
                ? 'rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive'
                : 'rounded-md border border-success/30 bg-success/5 p-4 text-sm text-success'
            }
          >
            {notice.message}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
