import { browserUuid } from '@/lib/browser-uuid';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { TRPCError } from '@trpc/server';

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
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { restaurantPurchasingRouter } from '@/server/routers/restaurant-purchasing';
import { createTRPCContext } from '@/server/trpc';
import { ReceivingForm, type ReceivingState } from './receiving-form';

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

/**
 * Resolve the tenant actor first, then hand the resolved session and
 * organization to the context factory.
 *
 * `createTRPCContext()` with no argument cannot stand in for this. It forwards
 * `{ request: undefined, session: undefined }` to `resolveTenantActor`, whose
 * `'session' in options` check reads that explicitly-undefined key as "the
 * caller already resolved the session". Auth.js is then never consulted, the
 * organization is always null, and the factory throws `Workspace not found.`
 * as an unhandled Server Component error on every request and every host.
 */
async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

/** Every action below maps a throw to an error notice, so this reads there. */
const NO_ACTOR = 'Your session is no longer active. Sign in again and retry.';

function AccessState({ moduleEnabled }: { moduleEnabled: boolean }) {
  return (
    <div className="space-y-6">
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
            : 'Enable the Restaurant Purchasing module to use purchasing.'}
        </p>
      </SectionCard>
    </div>
  );
}

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; kind?: string; selected?: string }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  // Tenancy did not resolve. Entitlements are unknowable here, so show the
  // permission surface rather than let a missing workspace reach the user as an
  // unhandled Server Component crash.
  if (!ctx) return <AccessState moduleEnabled={false} />;

  const user = ctx.session?.user;
  const moduleEnabled = hasModule(ctx.entitlements, 'restaurant-purchasing');

  if (!user) return <AccessState moduleEnabled={moduleEnabled} />;

  const subject = subjectFromSession(user);
  const [readable, creatable, approvable, configurable] = await Promise.all([
    can(subject, 'inventory:read', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'purchasing:create', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'purchasing:approve', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'restaurant:configure', undefined, { db: ctx.db, source: 'TRPC' }),
  ]);

  if (!moduleEnabled || !readable) return <AccessState moduleEnabled={moduleEnabled} />;

  const caller = restaurantPurchasingRouter.createCaller(ctx);
  let loaded;
  try {
    const branches = await ctx.db.restaurantBranch.findMany({
      where: {
        organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
        active: true,
        ...(!configurable && {
          OR: [
            { staffProfiles: { some: { userId: user.id, status: 'ACTIVE' } } },
            { assignments: { some: { userId: user.id } } },
          ],
        }),
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
    // The router reserves unfiltered lists for restaurant:configure. Keep every
    // branch-specific request authorized there, then merge the newest 100 orders.
    const orderPages = configurable
      ? [caller.listPurchaseOrders({ limit: 100 })]
      : branches.map(({ id }) => caller.listPurchaseOrders({ branchId: id, limit: 100 }));
    const [supplierPage, pages, locations, stockItems, units] = await Promise.all([
      caller.listSuppliers({ activeOnly: true, limit: 100 }),
      Promise.all(orderPages),
      ctx.db.restaurantStockLocation.findMany({
        where: {
          isActive: true,
          ...(!configurable && { branchId: { in: branches.map(({ id }) => id) } }),
        },
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
    const orders = pages.flatMap((page) => page.orders);
    if (!configurable) {
      orders.sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      );
    }
    const visibleOrders = orders.slice(0, 100);
    const selectedSummary =
      visibleOrders.find((order) => order.id === query.selected) ??
      visibleOrders.find((order) => order.receiptCount > 0) ??
      visibleOrders[0] ??
      null;
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
      orders: visibleOrders,
      branches,
      locations,
      stockItems,
      units,
      selectedOrder,
      receipts,
    };
  } catch {
    return (
      <div className="space-y-6">
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
      </div>
    );
  }

  async function createSupplier(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
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
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
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
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
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
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
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

  // Capture only receiving identifiers/defaults. The action reauthorizes and
  // rereads the order; a render's capability result is never authorization.
  // Binding the location also keeps a lost-response retry from selecting a
  // different default receiving location.
  const receivingOrderId = loaded.selectedOrder?.id;
  const receivingLineIds = loaded.selectedOrder?.lines.map((line) => line.id) ?? [];
  const receivingLocationId = loaded.locations.find(
    (location) =>
      location.branchId === loaded.selectedOrder?.branchId &&
      (!loaded.selectedOrder?.locationId || location.id === loaded.selectedOrder.locationId)
  )?.id;

  async function receivePurchaseOrder(
    previous: ReceivingState,
    form: FormData
  ): Promise<ReceivingState> {
    'use server';
    const names = [
      'reference',
      ...receivingLineIds.flatMap((id) =>
        [
          'receivedQuantity',
          'unitCost',
          'batchCode',
          'expiryDate',
          'discrepancyKind',
          'discrepancyNote',
        ].map((name) => `${name}:${id}`)
      ),
    ];
    const values = Object.fromEntries(names.map((name) => [name, String(form.get(name) ?? '')]));
    // Opaque keys are never trimmed, derived from form values, or put in URLs.
    const idempotencyKey = String(form.get('idempotencyKey') ?? '');
    const errors: Record<string, string> = {};
    const failure = (
      status: ReceivingState['status'],
      notice: string,
      retryAllowed = true
    ): ReceivingState => ({
      status: previous.status === 'uncertain' ? 'uncertain' : status,
      values: previous.status === 'uncertain' ? previous.values : values,
      errors,
      idempotencyKey:
        previous.status === 'uncertain'
          ? previous.idempotencyKey
          : status === 'rejected'
            ? browserUuid()
            : idempotencyKey,
      message: notice,
      retryAllowed,
    });
    let mutationStarted = false;
    let receiptId: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) return failure('denied', NO_ACTOR, false);
      const actionSubject = subjectFromSession(actionCtx.session.user);
      if (
        !hasModule(actionCtx.entitlements, 'restaurant-purchasing') ||
        !(await can(actionSubject, 'purchasing:create', undefined, {
          db: actionCtx.db,
          source: 'TRPC',
        }))
      ) {
        return failure(
          'denied',
          'Receiving permission is unavailable. Your entries are preserved.',
          false
        );
      }
      if (!receivingOrderId || field(form, 'purchaseOrderId') !== receivingOrderId) {
        return failure('denied', 'The receiving form does not match this purchase order.', false);
      }
      if (
        previous.status === 'uncertain' &&
        (idempotencyKey !== previous.idempotencyKey ||
          names.some((name) => values[name] !== previous.values[name]))
      ) {
        return failure(
          'uncertain',
          'The earlier receipt is still unconfirmed. Retry its original entries.'
        );
      }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          idempotencyKey
        )
      ) {
        return failure(
          'denied',
          'The receiving form could not be verified. Check receipt history before reopening it.',
          false
        );
      }
      const actionCaller = restaurantPurchasingRouter.createCaller(actionCtx);
      const order = await actionCaller.getPurchaseOrder({ purchaseOrderId: receivingOrderId });
      if (!receivingLocationId) {
        return failure(
          'rejected',
          'No active receiving location is available. Your entries are preserved.'
        );
      }
      const defaultLocation = await actionCtx.db.restaurantStockLocation.findFirst({
        where: {
          id: receivingLocationId,
          branchId: order.branchId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!defaultLocation) {
        return failure(
          'rejected',
          'The receiving location is no longer active. Your entries are preserved.'
        );
      }

      const lines = order.lines.flatMap((line) => {
        const receivedQuantity = field(form, `receivedQuantity:${line.id}`);
        if (!receivedQuantity || /^0+(?:\.0+)?$/.test(receivedQuantity)) return [];
        if (!positiveDecimal.test(receivedQuantity)) {
          errors[`receivedQuantity:${line.id}`] =
            'Enter a positive decimal quantity, or 0 to omit this line.';
        }
        const unitCost = optionalField(form, `unitCost:${line.id}`);
        if (unitCost && !nonNegativeDecimal.test(unitCost)) {
          errors[`unitCost:${line.id}`] = 'Enter a non-negative decimal unit cost.';
        }
        const batchCode = optionalField(form, `batchCode:${line.id}`);
        const expiryDate = optionalField(form, `expiryDate:${line.id}`);
        const discrepancyKind = optionalField(form, `discrepancyKind:${line.id}`);
        const discrepancyNote = optionalField(form, `discrepancyNote:${line.id}`);
        if (expiryDate) {
          const date = new Date(`${expiryDate}T00:00:00.000Z`);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) ||
            !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== expiryDate
          ) {
            errors[`expiryDate:${line.id}`] = 'Enter a valid expiry date.';
          }
          if (!batchCode) errors[`batchCode:${line.id}`] = 'Enter a batch for this expiry date.';
        }
        if (
          discrepancyKind &&
          !['SHORTAGE', 'OVERAGE', 'DAMAGED', 'EXPIRED', 'REJECTED', 'OTHER'].includes(
            discrepancyKind
          )
        ) {
          errors[`discrepancyKind:${line.id}`] = 'Choose a listed discrepancy kind.';
        }
        if (discrepancyNote && !discrepancyKind) {
          errors[`discrepancyKind:${line.id}`] = 'Choose a kind for this discrepancy note.';
        }
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
      if (field(form, 'reference').length > 200)
        errors.reference = 'Use at most 200 characters for the receipt reference.';
      if (!lines.length) {
        for (const id of receivingLineIds)
          errors[`receivedQuantity:${id}`] = 'Enter a positive quantity on at least one line.';
      }
      if (Object.keys(errors).length)
        return failure('invalid', 'Check the marked fields. Your entries are preserved.');
      mutationStarted = true;
      const receipt = await actionCaller.receivePurchaseOrder({
        purchaseOrderId: receivingOrderId,
        locationId: defaultLocation.id,
        reference: optionalField(form, 'reference'),
        idempotencyKey,
        lines,
      });
      if (!receipt.receiptId || receipt.purchaseOrderId !== receivingOrderId) {
        return failure(
          'uncertain',
          'The receipt result could not be confirmed. Your entries are preserved.'
        );
      }
      receiptId = receipt.receiptId;
    } catch (error) {
      if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)) {
        return failure('denied', 'Receiving access was denied. Your entries are preserved.', false);
      }
      // PurchasingError is mapped to BAD_REQUEST/NOT_FOUND by the existing
      // router. Its transaction rolls back the receipt AND its key. A corrected
      // draft therefore gets a fresh key; an earlier uncertain intent never does.
      if (error instanceof TRPCError && ['BAD_REQUEST', 'NOT_FOUND'].includes(error.code)) {
        return failure(
          'rejected',
          `${error.message} Your entries are preserved. Review them before retrying.`
        );
      }
      return failure(
        mutationStarted ? 'uncertain' : 'rejected',
        mutationStarted
          ? 'The receipt result could not be confirmed. Your entries are preserved.'
          : 'Receiving could not be checked. Your entries are preserved; retry when the service is available.'
      );
    }
    // Cache refresh failure cannot undo a confirmed posting or permit another
    // post. The client still clears the draft and navigates to receipt history.
    try {
      revalidatePath(route);
    } catch {
      // The confirmed receipt remains available through the existing reader.
    }
    return {
      status: 'success',
      values: {},
      errors: {},
      idempotencyKey: '',
      message: 'Receipt posted.',
      receiptId,
    };
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
    <div className="space-y-6">
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
                pattern="(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)"
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
                pattern="(?:0|\d+(?:\.\d+)?|\.\d+)"
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

        <SectionCard data-tour={loaded.selectedOrder ? 'purchase-receipt' : undefined}>
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
                <ReceivingForm
                  key={loaded.selectedOrder.id}
                  purchaseOrderId={loaded.selectedOrder.id}
                  canReceive={creatable}
                  action={receivePurchaseOrder}
                  lines={loaded.selectedOrder.lines.map((line) => ({
                    id: line.id,
                    name: stockItemNames.get(line.stockItemId) ?? line.stockItemId,
                    unitCost: line.unitCost,
                  }))}
                  initialState={{
                    status: 'idle',
                    message: '',
                    errors: {},
                    idempotencyKey: browserUuid(),
                    values: Object.fromEntries([
                      ['reference', ''],
                      ...loaded.selectedOrder.lines.flatMap((line) => [
                        [`receivedQuantity:${line.id}`, '0'],
                        [`unitCost:${line.id}`, line.unitCost],
                        [`batchCode:${line.id}`, ''],
                        [`expiryDate:${line.id}`, ''],
                        [`discrepancyKind:${line.id}`, ''],
                        [`discrepancyNote:${line.id}`, ''],
                      ]),
                    ]),
                  }}
                />
              )}

              <div id="receipt-history" className="mt-6">
                <h3 className="font-semibold text-text-strong">Receipt history</h3>
                {loaded.receipts.length ? (
                  <div className="mt-3 space-y-4">
                    {loaded.receipts.map((receipt) => (
                      <article
                        id={`receipt-${receipt.id}`}
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
    </div>
  );
}
