import type * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  actions: [] as ((form: FormData) => Promise<string>)[],
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.caller },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../_components/action-form', () => ({
  PurchasingActionForm: ({
    action,
    children,
  }: {
    action: (form: FormData) => Promise<string>;
    children: React.ReactNode;
  }) => {
    mocks.actions.push(action);
    return <form>{children}</form>;
  },
}));
import ReorderPage from './page';
import Loading from './loading';

const reads = {
  workspace: vi.fn(),
  reorderDrafts: vi.fn(),
  createPurchaseOrder: vi.fn(),
};
const findUser = vi.fn();
const procurementUser = (capability: string) => ({
  role: 'EMPLOYEE',
  organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
  permissionOverrides: [],
});
const LINE = {
  medicineId: 'med_a',
  medicineName: 'Alpha 500mg',
  packLevelId: 'pack_a',
  canonicalUnitsPerPack: 20,
  suggestedPacks: 8,
  listPricePerPackMinor: 15_000,
  discountBps: 500,
  taxBps: 1_700,
  taxCreditable: false,
  soldUnits: 280,
  onHandUnits: 50,
  inboundUnits: 0,
  leadTimeDays: 7,
  leadTimeSource: 'LAST_ORDER_TERMS',
  targetUnits: 210,
  shortfallUnits: 160,
  explanation: 'Sold 280 units in 28 days.',
};
const PLAN = {
  branchId: 'branch',
  policy: { windowDays: 28, coverDays: 14 },
  drafts: [
    {
      supplierId: 'sup_a',
      supplierName: 'Karachi Distributors',
      lines: [LINE, { ...LINE, medicineId: 'med_b', medicineName: 'Beta', suggestedPacks: 2 }],
      listValueMinor: 150_000,
    },
  ],
  unassigned: [
    { medicineId: 'med_c', medicineName: 'Gamma', shortfallUnits: 30, reason: 'NO_DISTRIBUTOR' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actions.length = 0;
  mocks.actor.mockResolvedValue({ session: { user: { id: 'user' } }, organization: { id: 'org' } });
  mocks.context.mockResolvedValue({
    session: { user: { id: 'user' } },
    entitlements: { organizationId: 'org' },
    db: { user: { findUnique: findUser } },
  });
  findUser.mockResolvedValue(procurementUser('pharmacy:procurement'));
  mocks.module.mockReturnValue(true);
  mocks.caller.mockReturnValue(reads);
  reads.workspace.mockResolvedValue({
    branches: [{ id: 'branch', name: 'Main', city: 'Karachi', code: 'M' }],
    reachableBranchIds: ['branch'],
    suppliers: [],
    medicines: [],
    approvers: [],
  });
  reads.reorderDrafts.mockResolvedValue(PLAN);
  reads.createPurchaseOrder.mockResolvedValue({ id: 'po_1', reference: 'RO-1' });
});
afterEach(cleanup);

it('closes the board to a counter-only role before any read', async () => {
  findUser.mockResolvedValue(procurementUser('pharmacy:counter'));
  render(await ReorderPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('heading', { name: 'You do not have purchasing access' })).toBeVisible();
  expect(reads.reorderDrafts).not.toHaveBeenCalled();
});

it('shows one editable draft per distributor and the medicines with no distributor', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({ days: '30', cover: '7' }) }));
  expect(reads.reorderDrafts).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch',
    windowDays: 30,
    coverDays: 7,
  });
  expect(screen.getByRole('heading', { name: 'Karachi Distributors' })).toBeVisible();
  expect(screen.getByLabelText(/Packs of Alpha 500mg/)).toHaveValue(8);
  expect(screen.getAllByText('Sold 280 units in 28 days.')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Confirm draft order' })).toBeVisible();
  expect(screen.getByText('Gamma')).toBeVisible();
  expect(reads.createPurchaseOrder).not.toHaveBeenCalled();
});

it('ignores out-of-range settings in the address', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({ days: '900', cover: '-1' }) }));
  expect(reads.reorderDrafts).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch',
    windowDays: 28,
    coverDays: 14,
  });
});

it('confirming re-reads the plan and drafts the order with server terms and the person’s packs', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({}) }));
  const form = new FormData();
  form.set('branchId', 'branch');
  form.set('supplierId', 'sup_a');
  form.set('days', '28');
  form.set('cover', '14');
  form.set('reference', 'RO-TEST');
  form.set('packs-med_a', '5');
  form.set('packs-med_b', '0');
  // A tampered price field is not read: terms come from the server's draft.
  form.set('listPricePerPackMinor', '1');
  const next = await mocks.actions[0]!(form);
  expect(reads.reorderDrafts).toHaveBeenLastCalledWith({
    branchId: 'branch',
    windowDays: 28,
    coverDays: 14,
  });
  expect(reads.createPurchaseOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      reference: 'RO-TEST',
      supplierId: 'sup_a',
      branchId: 'branch',
      lines: [
        {
          medicineId: 'med_a',
          packLevelId: 'pack_a',
          orderedPacks: 5,
          canonicalUnitsPerPack: 20,
          listPricePerPackMinor: 15_000,
          discountBps: 500,
          taxBps: 1_700,
          taxCreditable: false,
        },
      ],
    })
  );
  expect(next).toContain('/pharmacy/purchasing/orders?');
  expect(next).toContain('po=po_1');
});

it('refuses to draft when the distributor no longer has a suggestion', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({}) }));
  reads.reorderDrafts.mockResolvedValue({ ...PLAN, drafts: [] });
  const form = new FormData();
  form.set('branchId', 'branch');
  form.set('supplierId', 'sup_a');
  form.set('reference', 'RO-TEST');
  form.set('packs-med_a', '5');
  const next = await mocks.actions[0]!(form);
  expect(reads.createPurchaseOrder).not.toHaveBeenCalled();
  expect(next).toContain('/pharmacy/purchasing/reorder?');
  expect(next).toContain('kind=error');
});

it('does not order a line that appeared after the page loaded', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({}) }));
  const form = new FormData();
  form.set('branchId', 'branch');
  form.set('supplierId', 'sup_a');
  form.set('reference', 'RO-TEST');
  form.set('packs-med_a', '5');
  form.set('packs-med_b', '2');
  reads.reorderDrafts.mockResolvedValue({
    ...PLAN,
    drafts: [
      {
        ...PLAN.drafts[0]!,
        lines: [...PLAN.drafts[0]!.lines, { ...LINE, medicineId: 'med_new', medicineName: 'New' }],
      },
    ],
  });
  const next = await mocks.actions[0]!(form);
  expect(reads.createPurchaseOrder).not.toHaveBeenCalled();
  expect(new URL(next, 'http://x').searchParams.get('kind')).toBe('error');
});

it('names the field when every line is set to zero', async () => {
  render(await ReorderPage({ searchParams: Promise.resolve({}) }));
  const form = new FormData();
  form.set('branchId', 'branch');
  form.set('supplierId', 'sup_a');
  form.set('reference', 'RO-TEST');
  form.set('packs-med_a', '0');
  form.set('packs-med_b', '0');
  const next = await mocks.actions[0]!(form);
  expect(reads.createPurchaseOrder).not.toHaveBeenCalled();
  expect(new URL(next, 'http://x').searchParams.get('notice')).toContain('Keep at least one line');
});

it('retains the descriptive route loading state', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading Reorder' })).toBeVisible();
});
