import { render, screen, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  hasModule: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/server/routers/restaurant-inventory', () => ({
  restaurantInventoryRouter: { createCaller: mocks.createCaller },
}));

import InventoryPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};
const locations = [{ id: 'loc-1', name: 'Main Kitchen' }];
const stockItems = [
  { id: 'item-1', ingredient: { name: 'Chicken (boneless)' } },
  { id: 'item-2', ingredient: { name: 'Basmati Rice (Super Kernel)' } },
];
type Status = 'DRAFT' | 'SUBMITTED' | 'POSTED';

function countSummary(status: Status = 'DRAFT') {
  return {
    id: 'count-1',
    locationId: 'loc-1',
    status,
    reference: 'Saturday close',
    countedAt: new Date('2026-08-29T12:00:00Z'),
    submittedAt: status === 'DRAFT' ? null : new Date('2026-08-29T13:00:00Z'),
    postedAt: status === 'POSTED' ? new Date('2026-08-29T14:00:00Z') : null,
    _count: { lines: 1 },
  };
}
function countDetail(status: Status = 'DRAFT') {
  return {
    ...countSummary(status),
    lines: [
      {
        id: 'line-1',
        stockItemId: 'item-1',
        countedQuantity: '12.5',
        snapshotQuantity: '10',
        varianceQuantity: '2.5',
      },
    ],
  };
}
function contextStub(
  detail: ReturnType<typeof countDetail> | null = null,
  enabledModules = ['restaurant-inventory']
) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules },
    db: {
      restaurantStockLocation: {
        findMany: vi.fn().mockResolvedValue(locations),
        findFirst: vi.fn().mockResolvedValue(locations[0]),
      },
      restaurantStockItem: {
        findMany: vi.fn().mockResolvedValue(stockItems),
        findFirst: vi
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(stockItems.find((item) => item.id === where.id) ?? null)
          ),
      },
      restaurantStockCount: { findFirst: vi.fn().mockResolvedValue(detail) },
    },
  };
}
function callerStub(status?: Status) {
  return {
    listStockOnHand: vi.fn().mockResolvedValue([]),
    evaluateLowStockRules: vi.fn().mockResolvedValue([]),
    listStockMovements: vi.fn().mockResolvedValue({ items: [] }),
    listStockCounts: vi.fn().mockResolvedValue({ items: status ? [countSummary(status)] : [] }),
    listStockTransfers: vi.fn().mockResolvedValue({ items: [] }),
    createStockCount: vi.fn().mockResolvedValue({ id: 'count-new', status: 'DRAFT' }),
    addStockCountLine: vi.fn().mockResolvedValue({ id: 'line-new' }),
    submitStockCount: vi.fn().mockResolvedValue({ stockCountId: 'count-1' }),
    postStockCount: vi.fn().mockResolvedValue({ stockCountId: 'count-1', movementsPosted: 1 }),
  };
}
function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}
function formAction(tree: ReactNode, buttonText: string): (form: FormData) => Promise<void> {
  let found: ((form: FormData) => Promise<void>) | undefined;
  function visit(node: ReactNode) {
    if (found || !node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || !('props' in node)) return;
    const element = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
    if (
      element.type === 'form' &&
      textContent(element.props.children).includes(buttonText) &&
      typeof element.props.action === 'function'
    ) {
      found = element.props.action as (form: FormData) => Promise<void>;
      return;
    }
    visit(element.props.children);
  }
  visit(tree);
  if (!found) throw new Error(`Form not found: ${buttonText}`);
  return found;
}
async function pageWithCount(status: Status) {
  const caller = callerStub(status);
  mocks.createCaller.mockReturnValue(caller);
  mocks.createTRPCContext.mockResolvedValue(contextStub(countDetail(status)));
  return { page: await InventoryPage({ searchParams: Promise.resolve({}) }), caller };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantActor.mockResolvedValue(actor);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockImplementation((entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module)
  );
  mocks.createCaller.mockReturnValue(callerStub());
});

describe('InventoryPage tenancy and access', () => {
  it('renders when inventory is enabled even with POS disabled', async () => {
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeDefined();
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    expect(mocks.hasModule).toHaveBeenCalledWith(
      { enabledModules: ['restaurant-inventory'] },
      'restaurant-inventory'
    );
  });
  it('denies access when inventory is disabled', async () => {
    mocks.createTRPCContext.mockResolvedValue(contextStub(null, ['restaurant-pos']));
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });
  it('renders the access state when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Module disabled' })).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
  it('renders the access state when the session is absent', async () => {
    mocks.createTRPCContext.mockResolvedValue({ ...contextStub(), session: null });
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Permission denied' })).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });
  it('keeps reads visible but disables mutations without inventory:count', async () => {
    mocks.can.mockImplementation(async (_subject, capability) => capability === 'inventory:read');
    render(await InventoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Stock on hand')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create count' })).toBeDisabled();
    expect(screen.getByText(/inventory count permission is required/i)).toBeDefined();
  });
});

describe('physical count workflow', () => {
  it('uses named selectors and has no raw-ID text input', async () => {
    const { page } = await pageWithCount('DRAFT');
    render(page);
    const createForm = screen.getByRole('button', { name: 'Create count' }).closest('form')!;
    const lineForm = screen.getByRole('button', { name: 'Add count line' }).closest('form')!;
    expect(within(createForm).getByRole('option', { name: 'Main Kitchen' })).toBeDefined();
    expect(
      within(lineForm).getByRole('option', { name: 'Basmati Rice (Super Kernel)' })
    ).toBeDefined();
    expect(screen.queryByRole('textbox', { name: /location|stock item|count id/i })).toBeNull();
  });
  it('renders exactly one add-line form for the selected count', async () => {
    const { page } = await pageWithCount('DRAFT');
    const { container } = render(page);
    const addLineForms = Array.from(container.querySelectorAll('form')).filter(
      (form) =>
        form.querySelector('select[name="stockItemId"]') &&
        form.querySelector('input[name="stockCountId"]')
    );
    expect(addLineForms).toHaveLength(1);
    expect(addLineForms[0].querySelector('input[name="stockCountId"]')).toHaveValue('count-1');
  });
  it('sends exact create and add-line payloads', async () => {
    const { page, caller } = await pageWithCount('DRAFT');
    const create = new FormData();
    create.set('locationId', 'loc-1');
    create.set('reference', 'Saturday close');
    await formAction(page, 'Create count')(create);
    expect(caller.createStockCount).toHaveBeenCalledWith({
      locationId: 'loc-1',
      reference: 'Saturday close',
    });
    const line = new FormData();
    line.set('stockCountId', 'count-1');
    line.set('stockItemId', 'item-1');
    line.set('countedQuantity', '12.5');
    await formAction(page, 'Add count line')(line);
    expect(caller.addStockCountLine).toHaveBeenCalledWith({
      stockCountId: 'count-1',
      stockItemId: 'item-1',
      countedQuantity: '12.5',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
  it('redirects a created count without invalidating the redirecting route', async () => {
    const { page } = await pageWithCount('DRAFT');
    const create = new FormData();
    create.set('locationId', 'loc-1');
    create.set('reference', 'Saturday close');

    await formAction(page, 'Create count')(create);

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/restaurant/inventory?notice=Physical+count+created.&kind=success&selected=count-new'
    );
  });
  it('renders both distinct lines in a fresh tree after consecutive add-line submissions', async () => {
    const detail = countDetail('DRAFT');
    detail.lines = [];
    const caller = callerStub('DRAFT');
    caller.addStockCountLine.mockImplementation(async ({ stockItemId, countedQuantity }) => {
      detail.lines.push({
        id: `line-${detail.lines.length + 1}`,
        stockItemId,
        countedQuantity,
        snapshotQuantity: '0',
        varianceQuantity: '0',
      });
      return { id: `line-${detail.lines.length}` };
    });
    mocks.createCaller.mockReturnValue(caller);
    mocks.createTRPCContext.mockResolvedValue(contextStub(detail));

    const page = await InventoryPage({ searchParams: Promise.resolve({}) });
    const addLine = formAction(page, 'Add count line');
    const view = render(page);
    let previousDetail = screen
      .getByRole('heading', { name: 'Saturday close' })
      .closest<HTMLElement>('[data-slot="section-card"]');

    for (const [stockItemId, countedQuantity] of [
      ['item-1', '25.125'],
      ['item-2', '30.75'],
    ] as const) {
      const line = new FormData();
      line.set('stockCountId', 'count-1');
      line.set('stockItemId', stockItemId);
      line.set('countedQuantity', countedQuantity);
      await addLine(line);

      const target = String(mocks.redirect.mock.lastCall?.[0]);
      const destination = new URL(target, 'https://devfathom.test');
      expect(destination.pathname).toBe('/restaurant/inventory');
      expect(destination.searchParams.get('selected')).toBe('count-1');
      expect(destination.searchParams.get('fresh')).toBeTruthy();
      for (const rawId of ['line-1', 'line-2', 'item-1', 'item-2', 'loc-1', 'org-1', 'user-1']) {
        expect(target).not.toContain(rawId);
      }

      view.rerender(
        await InventoryPage({
          searchParams: Promise.resolve(Object.fromEntries(destination.searchParams)),
        })
      );
      const freshDetail = screen
        .getByRole('heading', { name: 'Saturday close' })
        .closest<HTMLElement>('[data-slot="section-card"]');
      expect(freshDetail).not.toBe(previousDetail);
      previousDetail = freshDetail;
    }

    if (!previousDetail) throw new Error('Fresh count detail did not render.');
    expect(within(previousDetail).getByRole('cell', { name: 'Chicken (boneless)' })).toBeDefined();
    expect(within(previousDetail).getByRole('cell', { name: '25.125' })).toBeDefined();
    expect(
      within(previousDetail).getByRole('cell', { name: 'Basmati Rice (Super Kernel)' })
    ).toBeDefined();
    expect(within(previousDetail).getByRole('cell', { name: '30.75' })).toBeDefined();
  });
  it('awaits consecutive add-line writes and redirects each success to a fresh safe URL', async () => {
    const { page, caller } = await pageWithCount('DRAFT');
    const pending: Array<() => void> = [];
    caller.addStockCountLine.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => pending.push(() => resolve({ id: 'line-secret' })))
    );
    const addLine = formAction(page, 'Add count line');
    const line = new FormData();
    line.set('stockCountId', 'count-1');
    line.set('stockItemId', 'item-1');
    line.set('countedQuantity', '12.5');

    const first = addLine(line);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(mocks.redirect).not.toHaveBeenCalled();
    pending.shift()?.();
    await first;
    const second = addLine(line);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    pending.shift()?.();
    await second;

    const targets = mocks.redirect.mock.calls.map(([target]) => String(target));
    expect(targets).toHaveLength(2);
    expect(targets[0]).not.toBe(targets[1]);
    for (const target of targets) {
      const destination = new URL(target, 'https://devfathom.test');
      expect(destination.pathname).toBe('/restaurant/inventory');
      expect(destination.searchParams.get('selected')).toBe('count-1');
      expect(destination.searchParams.get('fresh')).toBeTruthy();
      for (const rawId of ['line-secret', 'item-1', 'loc-1', 'org-1', 'user-1']) {
        expect(target).not.toContain(rawId);
      }
    }
  });
  it('redirects an add-line write failure to visible error feedback without claiming freshness', async () => {
    const { page, caller } = await pageWithCount('DRAFT');
    caller.addStockCountLine.mockRejectedValueOnce(new Error('Write failed.'));
    const line = new FormData();
    line.set('stockCountId', 'count-1');
    line.set('stockItemId', 'item-1');
    line.set('countedQuantity', '12.5');

    await formAction(page, 'Add count line')(line);

    expect(caller.addStockCountLine).toHaveBeenCalledTimes(1);
    const target = String(mocks.redirect.mock.lastCall?.[0]);
    expect(target).toContain('kind=error');
    expect(target).toContain('Write+failed.');
    expect(target).not.toContain('fresh=');
    expect(target).not.toContain('Count+line+added');
  });
  it('rejects missing selections and invalid decimals before mutation', async () => {
    const { page, caller } = await pageWithCount('DRAFT');
    for (const quantity of ['', '-1', 'NaN', '1e3']) {
      const form = new FormData();
      form.set('stockCountId', 'count-1');
      form.set('stockItemId', quantity === '' ? '' : 'item-1');
      form.set('countedQuantity', quantity);
      await formAction(page, 'Add count line')(form);
    }
    expect(caller.addStockCountLine).not.toHaveBeenCalled();
    expect(mocks.redirect.mock.calls).toHaveLength(4);
    expect(mocks.redirect.mock.calls.every(([url]) => String(url).includes('kind=error'))).toBe(
      true
    );
  });
  it('exposes only legal actions and sends exact submit/post payloads', async () => {
    const draft = await pageWithCount('DRAFT');
    const draftView = render(draft.page);
    expect(screen.getByRole('button', { name: 'Add count line' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Submit and freeze count' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Post reconciliation' })).toBeNull();
    const submit = new FormData();
    submit.set('stockCountId', 'count-1');
    await formAction(draft.page, 'Submit and freeze count')(submit);
    expect(draft.caller.submitStockCount).toHaveBeenCalledWith({ stockCountId: 'count-1' });
    draftView.unmount();
    const submitted = await pageWithCount('SUBMITTED');
    render(submitted.page);
    expect(screen.queryByRole('button', { name: 'Add count line' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit and freeze count' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Post reconciliation' })).toBeDefined();
    const post = new FormData();
    post.set('stockCountId', 'count-1');
    await formAction(submitted.page, 'Post reconciliation')(post);
    expect(submitted.caller.postStockCount).toHaveBeenCalledWith({ stockCountId: 'count-1' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
  it('renders expected, counted, and signed variance after freeze', async () => {
    const { page } = await pageWithCount('SUBMITTED');
    render(page);
    expect(screen.getByRole('columnheader', { name: 'Expected' })).toBeDefined();
    expect(screen.getByRole('cell', { name: '10' })).toBeDefined();
    expect(screen.getByRole('cell', { name: '12.5' })).toBeDefined();
    expect(screen.getByRole('cell', { name: '2.5' })).toBeDefined();
  });
  it('shows a server error redirect and never claims success', async () => {
    const { page, caller } = await pageWithCount('SUBMITTED');
    caller.postStockCount.mockRejectedValueOnce(new Error('Ledger is unavailable.'));
    const post = new FormData();
    post.set('stockCountId', 'count-1');
    await formAction(page, 'Post reconciliation')(post);
    const target = String(mocks.redirect.mock.lastCall?.[0]);
    expect(target).toContain('kind=error');
    expect(target).toContain('Ledger+is+unavailable');
    expect(target).not.toContain('Reconciliation+posted');
  });
  it('prevents a repeated transition by exposing no action after posting', async () => {
    const { page } = await pageWithCount('POSTED');
    render(page);
    expect(screen.queryByRole('button', { name: 'Post reconciliation' })).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeDefined();
  });
});
