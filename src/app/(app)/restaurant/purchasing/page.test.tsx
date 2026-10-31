import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactNode, type ComponentProps } from 'react';
import { TRPCError } from '@trpc/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
  hasModule: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/server/routers/restaurant-purchasing', () => ({
  restaurantPurchasingRouter: { createCaller: mocks.createCaller },
}));

import PurchasingPage from './page';
import { ReceivingForm } from './receiving-form';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

const searchParams = Promise.resolve({});

function contextStub(enabledModules = ['restaurant-purchasing']) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules },
    db: {
      restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStockItem: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantUnit: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockImplementation((entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module)
  );
  mocks.createCaller.mockReturnValue({
    listSuppliers: vi.fn().mockResolvedValue({ suppliers: [] }),
    listPurchaseOrders: vi.fn().mockResolvedValue({ orders: [] }),
  });
});

describe('PurchasingPage tenancy resolution', () => {
  it('renders when purchasing is enabled even with POS disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Purchasing' })).toBeDefined();
    expect(screen.queryByText('Purchasing could not load')).toBeNull();
    expect(mocks.hasModule).toHaveBeenCalledWith(
      { enabledModules: ['restaurant-purchasing'] },
      'restaurant-purchasing'
    );
  });

  it('denies access when purchasing is disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub(['restaurant-pos']));

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await PurchasingPage({ searchParams });

    // A bare `createTRPCContext()` always throws `Workspace not found.`: the
    // `{ session: undefined }` it forwards suppresses the `auth()` call.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('renders the access state instead of throwing when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });

  it('renders the access state instead of throwing when the session is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ ...contextStub(), session: null });

    render(await PurchasingPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Permission denied' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });
});

describe('PurchasingPage order selection', () => {
  it('defaults to a received order and renders its receipt evidence', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());
    const getPurchaseOrder = vi.fn().mockResolvedValue({
      id: 'received-order',
      reference: 'PO-RECEIVED',
      supplierName: 'Receipt Supplier',
      expectedDate: null,
      status: 'RECEIVED',
      lines: [],
      receipts: [{ id: 'receipt-1' }],
    });
    const getReceipt = vi.fn().mockResolvedValue({
      id: 'receipt-1',
      reference: 'RECEIPT-001',
      receivedAt: '2026-09-01T12:00:00.000Z',
      discrepancies: [],
      lines: [],
    });
    mocks.createCaller.mockReturnValue({
      listSuppliers: vi.fn().mockResolvedValue({ suppliers: [] }),
      listPurchaseOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            id: 'newer-order',
            reference: 'PO-NEW',
            supplierName: 'New Supplier',
            status: 'DRAFT',
            receiptCount: 0,
          },
          {
            id: 'received-order',
            reference: 'PO-RECEIVED',
            supplierName: 'Receipt Supplier',
            status: 'RECEIVED',
            receiptCount: 1,
          },
        ],
      }),
      getPurchaseOrder,
      getReceipt,
    });

    render(await PurchasingPage({ searchParams }));

    expect(getPurchaseOrder).toHaveBeenCalledWith({ purchaseOrderId: 'received-order' });
    expect(screen.getByRole('heading', { name: 'Receipt history' })).toBeDefined();
    expect(screen.getByText('RECEIPT-001')).toBeDefined();
  });
});

describe('PurchasingPage branch scope', () => {
  beforeEach(() => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
  });

  it('loads primary and assigned branches without requesting an all-branch list', async () => {
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'primary', name: 'Primary' },
      { id: 'assigned', name: 'Assigned' },
    ]);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const summary = (id: string, branchId: string, createdAt: string) => ({
      id,
      branchId,
      createdAt: new Date(createdAt),
      reference: id,
      supplierName: 'Supplier',
      status: 'DRAFT',
      receiptCount: 0,
    });
    const primary = summary('primary-order', 'primary', '2026-10-01');
    const assigned = summary('assigned-order', 'assigned', '2026-10-02');
    const listPurchaseOrders = vi.fn(async (input: { branchId?: string }) => {
      if (!input.branchId) throw new TRPCError({ code: 'FORBIDDEN' });
      return { orders: input.branchId === 'primary' ? [primary] : [assigned] };
    });
    const getPurchaseOrder = vi.fn().mockResolvedValue({ ...assigned, lines: [], receipts: [] });
    mocks.createCaller.mockReturnValue({
      listSuppliers: vi.fn().mockResolvedValue({ suppliers: [] }),
      listPurchaseOrders,
      getPurchaseOrder,
    });

    render(await PurchasingPage({ searchParams }));

    expect(screen.queryByText('Purchasing could not load')).toBeNull();
    expect(screen.getByText('primary-order')).toBeDefined();
    expect(screen.getByRole('cell', { name: 'assigned-order' })).toBeDefined();
    expect(getPurchaseOrder).toHaveBeenCalledWith({ purchaseOrderId: 'assigned-order' });
    expect(listPurchaseOrders.mock.calls).toEqual([
      [{ branchId: 'primary', limit: 100 }],
      [{ branchId: 'assigned', limit: 100 }],
    ]);
    expect(ctx.db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          active: true,
          OR: [
            { staffProfiles: { some: { userId: 'user-1', status: 'ACTIVE' } } },
            { assignments: { some: { userId: 'user-1' } } },
          ],
        },
      })
    );
    expect(ctx.db.restaurantStockLocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, branchId: { in: ['primary', 'assigned'] } },
      })
    );
  });

  it('keeps an empty branch scope empty instead of falling back to all branches', async () => {
    const ctx = contextStub();
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const caller = mocks.createCaller();

    render(await PurchasingPage({ searchParams }));

    expect(screen.queryByText('Purchasing could not load')).toBeNull();
    expect(caller.listPurchaseOrders).not.toHaveBeenCalled();
    expect(ctx.db.restaurantStockLocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, branchId: { in: [] } } })
    );
  });

  it('preserves all-branch lists for staff with restaurant:configure', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = contextStub();
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const caller = mocks.createCaller();

    render(await PurchasingPage({ searchParams }));

    expect(screen.queryByText('Purchasing could not load')).toBeNull();
    expect(caller.listPurchaseOrders).toHaveBeenCalledWith({ limit: 100 });
    expect(ctx.db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', active: true } })
    );
  });
});

type ReceivingProps = ComponentProps<typeof ReceivingForm>;

function receivingProps(node: ReactNode): ReceivingProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = receivingProps(child);
      if (found) return found;
    }
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === ReceivingForm) return node.props as ReceivingProps;
  return receivingProps(node.props.children);
}

describe('PurchasingPage receiving action', () => {
  const order = {
    id: 'order-1',
    reference: 'PO-001',
    supplierName: 'Supplier',
    branchId: 'branch-1',
    locationId: null,
    status: 'APPROVED',
    expectedDate: null,
    receipts: [],
    lines: ['a', 'b'].map((id) => ({
      id,
      stockItemId: `stock-${id}`,
      orderedQuantity: '10',
      unitId: 'unit-1',
      unitCost: '12.50',
      receivedQuantityCanonical: '0',
    })),
  };
  let props: ReceivingProps;
  let post: ReturnType<typeof vi.fn>;
  let location: ReturnType<typeof vi.fn>;
  let submitted: FormData;

  beforeEach(async () => {
    const ctx = contextStub();
    location = vi.fn().mockResolvedValue({ id: 'location-1' });
    Object.assign(ctx.db.restaurantStockLocation, { findFirst: location });
    ctx.db.restaurantStockLocation.findMany.mockResolvedValue([
      { id: 'location-1', branchId: 'branch-1', name: 'Store' },
    ]);
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    post = vi.fn().mockResolvedValue({ receiptId: 'receipt-1', purchaseOrderId: order.id });
    mocks.createCaller.mockReturnValue({
      listSuppliers: vi.fn().mockResolvedValue({ suppliers: [] }),
      listPurchaseOrders: vi.fn().mockResolvedValue({ orders: [{ ...order, receiptCount: 0 }] }),
      getPurchaseOrder: vi.fn().mockResolvedValue(order),
      receivePurchaseOrder: post,
    });
    props = receivingProps(await PurchasingPage({ searchParams }))!;
    submitted = new FormData();
    submitted.set('purchaseOrderId', order.id);
    submitted.set('idempotencyKey', props.initialState.idempotencyKey);
    submitted.set('reference', ' Delivery #17 / keep spaces ');
    for (const id of ['a', 'b']) {
      for (const [name, value] of Object.entries({
        receivedQuantity: id === 'a' ? '2.75' : '3',
        unitCost: '13.25',
        batchCode: ` batch-${id} `,
        expiryDate: '2027-03-04',
        discrepancyKind: 'DAMAGED',
        discrepancyNote: ` note-${id} `,
      }))
        submitted.set(`${name}:${id}`, value);
    }
    submitted.set('$ACTION_secret', 'must-not-be-returned');
  });

  const entries = (form: FormData) =>
    Object.fromEntries(
      [...form.entries()].filter(
        ([name]) => !['purchaseOrderId', 'idempotencyKey', '$ACTION_secret'].includes(name)
      )
    );

  it('identifies one invalid line, retains every other field verbatim, and performs no mutation', async () => {
    submitted.set('receivedQuantity:a', 'bad');
    const result = await props.action(props.initialState, submitted);
    expect(result.status).toBe('invalid');
    expect(Object.keys(result.errors)).toEqual(['receivedQuantity:a']);
    expect(result.values).toEqual(entries(submitted));
    expect(result.idempotencyKey).toBe(props.initialState.idempotencyKey);
    expect(post).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('reports cost, expiry, batch, discrepancy and reference errors before posting', async () => {
    submitted.set('unitCost:a', '-5');
    submitted.set('expiryDate:a', '2027-02-30');
    submitted.set('batchCode:a', '');
    submitted.set('discrepancyKind:b', '');
    submitted.set('reference', 'r'.repeat(201));
    const result = await props.action(props.initialState, submitted);
    expect(Object.keys(result.errors).sort()).toEqual([
      'batchCode:a',
      'discrepancyKind:b',
      'expiryDate:a',
      'reference',
      'unitCost:a',
    ]);
    expect(result.values).toEqual(entries(submitted));
    expect(post).not.toHaveBeenCalled();
  });

  it('retains a definitively rejected draft and gives its correction a fresh random key', async () => {
    post.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt cannot post.' })
    );
    const rejected = await props.action(props.initialState, submitted);
    expect(rejected.status).toBe('rejected');
    expect(rejected.values).toEqual(entries(submitted));
    expect(rejected.idempotencyKey).not.toBe(props.initialState.idempotencyKey);
    expect(rejected.message).toContain('Receipt cannot post.');
    expect(revalidatePath).not.toHaveBeenCalled();
    submitted.set('receivedQuantity:a', '4');
    submitted.set('idempotencyKey', rejected.idempotencyKey);
    expect((await props.action(rejected, submitted)).status).toBe('success');
    expect(post.mock.calls[1][0]).toMatchObject({
      idempotencyKey: rejected.idempotencyKey,
      lines: [{ receivedQuantity: '4' }, { receivedQuantity: '3' }],
    });
  });

  it('preserves an uncertain intent and posts the identical payload on explicit retry', async () => {
    post.mockRejectedValueOnce(new Error('connection lost'));
    const uncertain = await props.action(props.initialState, submitted);
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.values).toEqual(entries(submitted));
    expect(uncertain.idempotencyKey).toBe(props.initialState.idempotencyKey);
    expect(uncertain.message).not.toContain('No data was changed');
    expect((await props.action(uncertain, submitted)).status).toBe('success');
    expect(post.mock.calls[0][0]).toEqual(post.mock.calls[1][0]);
    expect(location).toHaveBeenLastCalledWith({
      where: {
        id: 'location-1',
        branchId: 'branch-1',
        isActive: true,
      },
      select: { id: true },
    });
  });

  it('does not post edited uncertain values or unlock after a later rejection', async () => {
    post.mockRejectedValueOnce(new Error('connection lost'));
    const uncertain = await props.action(props.initialState, submitted);
    submitted.set('receivedQuantity:b', '8');
    const edited = await props.action(uncertain, submitted);
    expect(edited.status).toBe('uncertain');
    expect(edited.values).toEqual(uncertain.values);
    expect(post).toHaveBeenCalledTimes(1);
    submitted.set('receivedQuantity:b', '3');
    post.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Order no longer receivable.' })
    );
    const rejectedRetry = await props.action(uncertain, submitted);
    expect(rejectedRetry.status).toBe('uncertain');
    expect(rejectedRetry.idempotencyKey).toBe(uncertain.idempotencyKey);
  });

  it('clears only confirmed success and returns the posted receipt for navigation', async () => {
    const result = await props.action(props.initialState, submitted);
    expect(result).toEqual({
      status: 'success',
      values: {},
      errors: {},
      idempotencyKey: '',
      message: 'Receipt posted.',
      receiptId: 'receipt-1',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith('/restaurant/purchasing');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('keeps a confirmed success when cache refresh fails', async () => {
    vi.mocked(revalidatePath).mockImplementationOnce(() => {
      throw new Error('cache unavailable');
    });
    expect((await props.action(props.initialState, submitted)).status).toBe('success');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rechecks server authorization when permission was revoked after render', async () => {
    mocks.can.mockResolvedValue(false);
    const denied = await props.action(props.initialState, submitted);
    expect(denied.status).toBe('denied');
    expect(denied.values).toEqual(entries(submitted));
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects mismatched order identity and malformed keys without posting', async () => {
    submitted.set('purchaseOrderId', 'other-order');
    expect((await props.action(props.initialState, submitted)).status).toBe('denied');
    submitted.set('purchaseOrderId', order.id);
    submitted.set('idempotencyKey', 'not-a-key');
    expect((await props.action(props.initialState, submitted)).status).toBe('denied');
    expect(post).not.toHaveBeenCalled();
  });
});
