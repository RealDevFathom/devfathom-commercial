import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { restaurantPurchasingRouter } from '@/server/routers/restaurant-purchasing';
import { createTRPCContext } from '@/server/trpc';

const route = '/restaurant/purchasing';
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optionalField = (form: FormData, name: string) => field(form, name) || undefined;
const positiveDecimal = /^(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)$/;
const nonNegativeDecimal = /^(?:0|\d+(?:\.\d+)?|\.\d+)$/;

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function destination(notice: string, kind: 'success' | 'error', selected?: string) {
  const params = new URLSearchParams({ notice, kind });
  if (selected) params.set('selected', selected);
  return `${route}?${params}`;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

function AccessState({ moduleEnabled }: { moduleEnabled: boolean }) {
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Purchasing"
        description="Suppliers, purchase orders, receipts, and stock intake."
      />
      <SectionCard>
        <h2 className="text-lg font-semibold text-text-strong">
          {moduleEnabled ? 'Permission denied' : 'Module disabled'}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          {moduleEnabled
            ? 'Inventory read permission is required to open the purchasing console.'
            : 'Enable the Restaurant POS module to use purchasing.'}
        </p>
      </SectionCard>
    </main>
  );
}

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; kind?: string; selected?: string }>;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  const moduleEnabled = hasModule(ctx.entitlements, 'restaurant-pos');

  if (!user) return <AccessState moduleEnabled={moduleEnabled} />;

  const subject = subjectFromSession(user);
  const [readable, creatable, approvable] = await Promise.all([
    can(subject, 'inventory:read', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'purchasing:create', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'purchasing:approve', undefined, { db: ctx.db, source: 'TRPC' }),
  ]);

  if (!moduleEnabled || !readable) return <AccessState moduleEnabled={moduleEnabled} />;

  const caller = restaurantPurchasingRouter.createCaller(ctx);
  let loaded;
  try {
    const [supplierPage, orderPage, branches, locations, stockItems, units] = await Promise.all([
      caller.listSuppliers({ activeOnly: true, limit: 100 }),
      caller.listPurchaseOrders({ limit: 100 }),
      ctx.db.restaurantBranch.findMany({
        where: { active: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
      ctx.db.restaurantStockLocation.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, branchId: true, name: true },
      }),
      ctx.db.restaurantStockItem.findMany({
        where: { isActive: true },
        orderBy: { ingredient: { name: 'asc' } },
        select: {
          id: true,
          canonicalUnitId: true,
          ingredient: { select: { name: true } },
        },
      }),
      ctx.db.restaurantUnit.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, abbreviation: true },
      }),
    ]);
    const selectedSummary =
      orderPage.orders.find((order) => order.id === query.selected) ?? orderPage.orders[0] ?? null;
    const selectedOrder = selectedSummary
      ? await caller.getPurchaseOrder({ purchaseOrderId: selectedSummary.id })
      : null;
    const receipts = selectedOrder
      ? await Promise.all(
          selectedOrder.receipts.map((receipt) => caller.getReceipt({ receiptId: receipt.id }))
        )
      : [];
    loaded = {
      suppliers: supplierPage.suppliers,
      orders: orderPage.orders,
      branches,
      locations,
      stockItems,
      units,
      selectedOrder,
      receipts,
    };
  } catch {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="Purchasing"
          description="Suppliers, purchase orders, receipts, and stock intake."
        />
        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">Purchasing could not load</h2>
          <p className="mt-2 text-sm text-text-muted">
            No data was changed. Refresh the page to try again.
          </p>
          <Link className={buttonVariants({ variant: 'secondary' })} href={route}>
            Retry
          </Link>
        </SectionCard>
      </main>
    );
  }

  async function createSupplier(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await createTRPCContext();
      const actionCaller = restaurantPurchasingRouter.createCaller(actionCtx);
      await actionCaller.createSupplier({
        name: field(form, 'name'),
        code: optionalField(form, 'code'),
        contactName: optionalField(form, 'contactName'),
        contactEmail: optionalField(form, 'contactEmail'),
        contactPhone: optionalField(form, 'contactPhone'),
      });
      revalidatePath(route);
      next = destination('Supplier created.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not create supplier.'), 'error');
    }
    redirect(next);
  }

  async function createPurchaseOrder(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await createTRPCContext();
      const actionCaller = restaurantPurchasingRouter.createCaller(actionCtx);
      const locationId = field(form, 'locationId');
      const stockItemId = field(form, 'stockItemId');
      const orderedQuantity = field(form, 'orderedQuantity');
      const unitCost = field(form, 'unitCost');
      if (!positiveDecimal.test(orderedQuantity) || !nonNegativeDecimal.test(unitCost)) {
        throw new Error('Enter a positive quantity and a non-negative unit cost.');
      }
      const [location, stockItem] = await Promise.all([
        actionCtx.db.restaurantStockLocation.findFirst({
          where: { id: locationId, isActive: true },
          select: { id: true, branchId: true },
        }),
        actionCtx.db.restaurantStockItem.findFirst({
          where: { id: stockItemId, isActive: true },
          select: { id: true, canonicalUnitId: true },
        }),
      ]);
      if (!location || !stockItem) throw new Error('Select a current location and stock item.');
      const order = await actionCaller.createPurchaseOrder({
        supplierId: field(form, 'supplierId'),
        branchId: location.branchId,
        locationId: location.id,
        reference: optionalField(form, 'reference'),
        expectedDate: optionalField(form, 'expectedDate'),
        lines: [
          {
            stockItemId: stockItem.id,
            orderedQuantity,
            unitId: stockItem.canonicalUnitId,
            unitCost,
          },
        ],
      });
      revalidatePath(route);
      next = destination('Purchase order created.', 'success', order.id);
    } catch (error) {
      next = destination(message(error, 'Could not create purchase order.'), 'error');
    }
    redirect(next);
  }

  async function submitPurchaseOrder(form: FormData) {
    'use server';
    const purchaseOrderId = field(form, 'purchaseOrderId');
    let next: string;
    try {
      const actionCtx = await createTRPCContext();
      await restaurantPurchasingRouter
        .createCaller(actionCtx)
        .submitPurchaseOrder({ purchaseOrderId });
      revalidatePath(route);
      next = destination('Purchase order submitted.', 'success', purchaseOrderId);
    } catch (error) {
      next = destination(
        message(error, 'Could not submit purchase order.'),
        'error',
        purchaseOrderId
      );
    }
    redirect(next);
  }

  async function approvePurchaseOrder(form: FormData) {
    'use server';
    const purchaseOrderId = field(form, 'purchaseOrderId');
    let next: string;
    try {
      const actionCtx = await createTRPCContext();
      await restaurantPurchasingRouter
        .createCaller(actionCtx)
        .approvePurchaseOrder({ purchaseOrderId });
      revalidatePath(route);
      next = destination('Purchase order approved.', 'success', purchaseOrderId);
    } catch (error) {
      next = destination(
        message(error, 'Could not approve purchase order.'),
        'error',
        purchaseOrderId
      );
    }
    redirect(next);
  }

  async function receivePurchaseOrder(form: FormData) {
    'use server';
    const purchaseOrderId = field(form, 'purchaseOrderId');
    let next: string;
    try {
      const actionCtx = await createTRPCContext();
      const actionCaller = restaurantPurchasingRouter.createCaller(actionCtx);
      const order = await actionCaller.getPurchaseOrder({ purchaseOrderId });
      const defaultLocation = await actionCtx.db.restaurantStockLocation.findFirst({
        where: {
          branchId: order.branchId,
          isActive: true,
          ...(order.locationId ? { id: order.locationId } : {}),
        },
        orderBy: { name: 'asc' },
        select: { id: true },
      });
      if (!defaultLocation) throw new Error('No active receiving location is available.');

      const lines = order.lines.flatMap((line) => {
        const receivedQuantity = field(form, `receivedQuantity:${line.id}`);
        if (!receivedQuantity || receivedQuantity === '0') return [];
        if (!positiveDecimal.test(receivedQuantity)) {
          throw new Error('Received quantities must be positive decimal values.');
        }
        const unitCost = optionalField(form, `unitCost:${line.id}`);
        if (unitCost && !nonNegativeDecimal.test(unitCost)) {
          throw new Error('Unit costs must be non-negative decimal values.');
        }
        const batchCode = optionalField(form, `batchCode:${line.id}`);
        const expiryDate = optionalField(form, `expiryDate:${line.id}`);
        const discrepancyKind = optionalField(form, `discrepancyKind:${line.id}`);
        const discrepancyNote = optionalField(form, `discrepancyNote:${line.id}`);
        return [
          {
            purchaseOrderLineId: line.id,
            receivedQuantity,
            unitId: line.unitId,
            unitCost,
            batch: batchCode ? { code: batchCode, expiryDate } : undefined,
            discrepancies: discrepancyKind
              ? [
                  {
                    kind: discrepancyKind as
                      'SHORTAGE' | 'OVERAGE' | 'DAMAGED' | 'EXPIRED' | 'REJECTED' | 'OTHER',
                    expectedQuantity: line.orderedQuantity,
                    receivedQuantity,
                    note: discrepancyNote,
                  },
                ]
              : undefined,
          },
        ];
      });
      if (!lines.length) throw new Error('Enter at least one positive received quantity.');
      await actionCaller.receivePurchaseOrder({
        purchaseOrderId,
        locationId: defaultLocation.id,
        reference: optionalField(form, 'reference'),
        idempotencyKey: field(form, 'idempotencyKey'),
        lines,
      });
      revalidatePath(route);
      next = destination('Receipt posted.', 'success', purchaseOrderId);
    } catch (error) {
      next = destination(
        message(error, 'Could not receive purchase order.'),
        'error',
        purchaseOrderId
      );
    }
    redirect(next);
  }

  const openOrders = loaded.orders.filter((order) =>
    ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED'].includes(order.status)
  ).length;
  const awaitingApproval = loaded.orders.filter((order) => order.status === 'SUBMITTED').length;
  const dueReceipts = loaded.orders.filter((order) =>
    ['APPROVED', 'PARTIALLY_RECEIVED'].includes(order.status)
  ).length;
  const unitNames = new Map(
    loaded.units.map((unit) => [unit.id, unit.abbreviation || unit.name] as const)
  );
  const stockItemNames = new Map(
    loaded.stockItems.map((item) => [item.id, item.ingredient.name] as const)
  );

  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Purchasing"
        description="Suppliers, purchase orders, receipts, and stock intake."
      />

      {query.notice && (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${
            query.kind === 'error'
              ? 'border-destructive bg-destructive-background text-destructive-foreground'
              : 'border-success bg-success-background text-success-foreground'
          }`}
          role={query.kind === 'error' ? 'alert' : 'status'}
        >
          {query.notice}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Purchasing ledger">
        <Stat label="Open orders" value={openOrders} />
        <Stat label="Awaiting approval" value={awaitingApproval} />
        <Stat label="Due receipts" value={dueReceipts} />
        <Stat label="Active suppliers" value={loaded.suppliers.length} />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">Supplier registry</h2>
          <div className="mt-4 divide-y divide-border-subtle">
            {loaded.suppliers.length ? (
              loaded.suppliers.map((supplier) => (
                <div className="grid gap-1 py-3 text-sm sm:grid-cols-2" key={supplier.id}>
                  <div>
                    <p className="font-medium text-text-strong">{supplier.name}</p>
                    <p className="font-mono text-xs text-text-muted">
                      {supplier.code || 'No code'}
                    </p>
                  </div>
                  <div className="text-text-muted sm:text-right">
                    <p>{supplier.contactName || 'No contact'}</p>
                    <p>{supplier.contactEmail || supplier.contactPhone || 'No contact details'}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="py-8 text-sm text-text-muted">No suppliers yet. Create one below.</p>
            )}
          </div>
          <form action={createSupplier} className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-text-body">
              Name
              <Input name="name" required disabled={!creatable} className="mt-1 min-h-11" />
            </label>
            <label className="text-sm text-text-body">
              Code
              <Input name="code" disabled={!creatable} className="mt-1 min-h-11" />
            </label>
            <label className="text-sm text-text-body">
              Contact name
              <Input name="contactName" disabled={!creatable} className="mt-1 min-h-11" />
            </label>
            <label className="text-sm text-text-body">
              Contact email
              <Input
                name="contactEmail"
                type="email"
                disabled={!creatable}
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm text-text-body sm:col-span-2">
              Contact phone
              <Input name="contactPhone" disabled={!creatable} className="mt-1 min-h-11" />
            </label>
            <Button type="submit" disabled={!creatable} className="min-h-11 sm:col-span-2">
              Create supplier
            </Button>
          </form>
          {!creatable && (
            <p className="mt-3 text-sm text-text-muted">Purchasing create permission required.</p>
          )}
        </SectionCard>

        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">New purchase order</h2>
          <form action={createPurchaseOrder} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-text-body sm:col-span-2">
              Supplier
              <select name="supplierId" required disabled={!creatable} className={inputClass}>
                <option value="">Select supplier</option>
                {loaded.suppliers.map((supplier) => (
                  <option value={supplier.id} key={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              Branch
              <select name="branch" disabled className={inputClass}>
                <option>
                  {loaded.branches.length ? 'Derived from location' : 'No active branch'}
                </option>
              </select>
            </label>
            <label className="text-sm text-text-body">
              Location
              <select name="locationId" required disabled={!creatable} className={inputClass}>
                <option value="">Select location</option>
                {loaded.locations.map((location) => (
                  <option value={location.id} key={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body sm:col-span-2">
              Stock item
              <select name="stockItemId" required disabled={!creatable} className={inputClass}>
                <option value="">Select stock item</option>
                {loaded.stockItems.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.ingredient.name} · {unitNames.get(item.canonicalUnitId) ?? 'unit'}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              Ordered quantity
              <Input
                name="orderedQuantity"
                inputMode="decimal"
                pattern="(?:0*[1-9]\\d*(?:\\.\\d+)?|0*\\.\\d*[1-9]\\d*)"
                required
                disabled={!creatable}
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm text-text-body">
              Unit cost
              <Input
                name="unitCost"
                inputMode="decimal"
                pattern="(?:0|\\d+(?:\\.\\d+)?|\\.\\d+)"
                required
                disabled={!creatable}
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm text-text-body">
              Expected date
              <Input
                name="expectedDate"
                type="date"
                disabled={!creatable}
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm text-text-body">
              Reference
              <Input name="reference" disabled={!creatable} className="mt-1 min-h-11" />
            </label>
            <Button
              type="submit"
              disabled={!creatable || !loaded.suppliers.length || !loaded.locations.length}
              className="min-h-11 sm:col-span-2"
            >
              Create purchase order
            </Button>
          </form>
          {!creatable && (
            <p className="mt-3 text-sm text-text-muted">Purchasing create permission required.</p>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <SectionCard>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Purchase-order queue</h2>
            <span className="font-mono text-xs text-text-muted">{loaded.orders.length} orders</span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.orders.length ? (
                  loaded.orders.map((order) => (
                    <TableRow
                      data-state={order.id === loaded.selectedOrder?.id ? 'selected' : undefined}
                      key={order.id}
                    >
                      <TableCell className="font-mono text-xs">
                        {order.reference || order.id}
                      </TableCell>
                      <TableCell>{order.supplierName}</TableCell>
                      <TableCell>
                        <StatusPill status={order.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          aria-current={order.id === loaded.selectedOrder?.id ? 'true' : undefined}
                          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                          href={`${route}?selected=${order.id}`}
                        >
                          {order.id === loaded.selectedOrder?.id ? 'Selected' : 'Review'}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-text-muted">
                      No purchase orders yet. Create one to start the queue.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>

        <SectionCard>
          {loaded.selectedOrder ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Selected order
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-text-strong">
                    {loaded.selectedOrder.reference || loaded.selectedOrder.id}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {loaded.selectedOrder.supplierName} · expected{' '}
                    {formatDate(loaded.selectedOrder.expectedDate)}
                  </p>
                </div>
                <StatusPill status={loaded.selectedOrder.status} />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <form action={submitPurchaseOrder}>
                  <input type="hidden" name="purchaseOrderId" value={loaded.selectedOrder.id} />
                  <Button
                    type="submit"
                    disabled={!creatable || loaded.selectedOrder.status !== 'DRAFT'}
                    className="min-h-11"
                  >
                    Submit
                  </Button>
                </form>
                <form action={approvePurchaseOrder}>
                  <input type="hidden" name="purchaseOrderId" value={loaded.selectedOrder.id} />
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={!approvable || loaded.selectedOrder.status !== 'SUBMITTED'}
                    className="min-h-11"
                  >
                    Approve
                  </Button>
                </form>
              </div>
              {!creatable && (
                <p className="mt-2 text-xs text-text-muted">Submit and receive unavailable.</p>
              )}
              {!approvable && (
                <p className="mt-1 text-xs text-text-muted">Approval permission unavailable.</p>
              )}

              <div className="mt-5 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Ordered</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Unit cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaded.selectedOrder.lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>
                          {stockItemNames.get(line.stockItemId) ?? line.stockItemId}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {line.orderedQuantity} {unitNames.get(line.unitId) ?? 'unit'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {line.receivedQuantityCanonical}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{line.unitCost}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {['APPROVED', 'PARTIALLY_RECEIVED'].includes(loaded.selectedOrder.status) && (
                <form action={receivePurchaseOrder} className="mt-6 space-y-4">
                  <input type="hidden" name="purchaseOrderId" value={loaded.selectedOrder.id} />
                  <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                  <div>
                    <h3 className="font-semibold text-text-strong">Receive stock</h3>
                    <p className="mt-1 text-sm text-text-muted">
                      Enter only quantities arriving in this receipt.
                    </p>
                  </div>
                  {loaded.selectedOrder.lines.map((line) => (
                    <fieldset
                      className="grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-4 sm:grid-cols-2"
                      disabled={!creatable}
                      key={line.id}
                    >
                      <legend className="px-1 text-sm font-medium text-text-strong">
                        {stockItemNames.get(line.stockItemId) ?? line.stockItemId}
                      </legend>
                      <label className="text-sm text-text-body">
                        Received quantity
                        <Input
                          name={`receivedQuantity:${line.id}`}
                          inputMode="decimal"
                          defaultValue="0"
                          className="mt-1 min-h-11"
                        />
                      </label>
                      <label className="text-sm text-text-body">
                        Unit cost
                        <Input
                          name={`unitCost:${line.id}`}
                          inputMode="decimal"
                          defaultValue={line.unitCost}
                          className="mt-1 min-h-11"
                        />
                      </label>
                      <label className="text-sm text-text-body">
                        Batch
                        <Input name={`batchCode:${line.id}`} className="mt-1 min-h-11" />
                      </label>
                      <label className="text-sm text-text-body">
                        Expiry
                        <Input
                          name={`expiryDate:${line.id}`}
                          type="date"
                          className="mt-1 min-h-11"
                        />
                      </label>
                      <label className="text-sm text-text-body">
                        Discrepancy kind
                        <select name={`discrepancyKind:${line.id}`} className={inputClass}>
                          <option value="">None</option>
                          <option value="SHORTAGE">Shortage</option>
                          <option value="OVERAGE">Overage</option>
                          <option value="DAMAGED">Damaged</option>
                          <option value="EXPIRED">Expired</option>
                          <option value="REJECTED">Rejected</option>
                          <option value="OTHER">Other</option>
                        </select>
                      </label>
                      <label className="text-sm text-text-body">
                        Discrepancy note
                        <Input name={`discrepancyNote:${line.id}`} className="mt-1 min-h-11" />
                      </label>
                    </fieldset>
                  ))}
                  <label className="block text-sm text-text-body">
                    Receipt reference
                    <Input name="reference" disabled={!creatable} className="mt-1 min-h-11" />
                  </label>
                  <Button type="submit" disabled={!creatable} className="min-h-11">
                    Receive purchase order
                  </Button>
                </form>
              )}

              <div className="mt-6">
                <h3 className="font-semibold text-text-strong">Receipt history</h3>
                {loaded.receipts.length ? (
                  <div className="mt-3 space-y-4">
                    {loaded.receipts.map((receipt) => (
                      <article
                        className="rounded-[var(--radius-sm)] border border-border-subtle p-4"
                        key={receipt.id}
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <div>
                            <p className="font-mono text-xs text-text-muted">
                              {receipt.reference || receipt.id}
                            </p>
                            <p className="mt-1 text-sm text-text-body">
                              Received {formatDate(receipt.receivedAt)}
                            </p>
                          </div>
                          <StatusPill
                            status={receipt.discrepancies.length ? 'DISCREPANCY' : 'RECEIVED'}
                          />
                        </div>
                        <div className="mt-3 overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Item</TableHead>
                                <TableHead className="text-right">Quantity</TableHead>
                                <TableHead className="text-right">Unit cost</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {receipt.lines.map((line) => (
                                <TableRow key={line.id}>
                                  <TableCell>
                                    {stockItemNames.get(line.stockItemId) ?? line.stockItemId}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {line.receivedQuantity} {unitNames.get(line.unitId) ?? 'unit'}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {line.unitCost}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        {receipt.discrepancies.length > 0 && (
                          <ul className="mt-3 space-y-1 text-sm text-text-muted">
                            {receipt.discrepancies.map((discrepancy) => (
                              <li key={discrepancy.id}>
                                {discrepancy.kind}: expected {discrepancy.expectedQuantity},
                                received {discrepancy.receivedQuantity}
                                {discrepancy.note ? ` · ${discrepancy.note}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    No receipts recorded for this order.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="py-12 text-center">
              <h2 className="text-lg font-semibold text-text-strong">No order selected</h2>
              <p className="mt-2 text-sm text-text-muted">
                Create or select a purchase order to review its lines and receipts.
              </p>
            </div>
          )}
        </SectionCard>
      </div>
    </main>
  );
}
