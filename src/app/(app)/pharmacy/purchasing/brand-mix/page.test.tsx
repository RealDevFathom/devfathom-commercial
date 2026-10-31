import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  module: vi.fn(),
  allowed: vi.fn(),
  branches: vi.fn(),
  medicines: vi.fn(),
  proposals: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/lib/abac', () => ({ can: mocks.allowed, subjectFromSession: (user: unknown) => user }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: vi.fn() },
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({
  pharmacySalesRouter: { createCaller: () => ({ marginOptimizedBrandProposals: mocks.proposals }) },
}));

import BrandMixPage from './page';
import Loading from './loading';

const selection = {
  branch: 'branch-a',
  presentation: 'presentation-a',
  quantity: '10',
  compare: '1',
};
const proposal = {
  medicineId: 'medicine-b',
  presentationId: 'presentation-b',
  inventoryLotId: 'lot-b',
  packLevelId: 'pack-b',
  displayName: 'Brand B',
  strength: '500 mg',
  dosageForm: 'Tablet',
  route: 'Oral',
  availableCanonicalUnits: 12,
  priceMinor: 900,
  priceDifferenceMinor: 0,
  costMinor: 400,
  marginMinor: 500,
  marginBps: 5555,
  equivalenceBasis: 'Exact ingredients, strength, form and route',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({
    session: { user: { id: 'user-a' } },
    organization: { id: 'org-a' },
  });
  mocks.context.mockResolvedValue({
    session: { user: { id: 'user-a' } },
    organization: { id: 'org-a', currency: 'PKR' },
    entitlements: { organizationId: 'org-a' },
    db: { pharmacyBranch: { findMany: mocks.branches }, medicine: { findMany: mocks.medicines } },
  });
  mocks.module.mockReturnValue(true);
  mocks.allowed.mockResolvedValue(true);
  mocks.branches.mockResolvedValue([{ id: 'branch-a', name: 'Main branch' }]);
  mocks.medicines.mockResolvedValue([
    {
      id: 'medicine-a',
      productName: 'Reference',
      strengths: [{ value: '500', unit: 'mg' }],
      presentations: [
        { id: 'presentation-a', presentation: 'Strip', dosageForm: 'Tablet', route: 'Oral' },
      ],
    },
  ]);
  mocks.proposals.mockResolvedValue([proposal]);
});
afterEach(cleanup);

it('exposes the view through purchasing navigation and waits for an explicit comparison', async () => {
  render(await BrandMixPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('link', { name: /Brand mix/ })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('form', { name: 'Compare brand mix' })).toHaveAttribute('method', 'get');
  expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveValue('branch-a');
  expect(screen.getByRole('combobox', { name: 'Reference medicine and presentation' })).toHaveValue(
    ''
  );
  expect(mocks.proposals).not.toHaveBeenCalled();
});

it.each(['module', 'permission'])(
  'blocks %s denial before reading choices or costs',
  async (kind) => {
    if (kind === 'module') mocks.module.mockReturnValue(false);
    else mocks.allowed.mockResolvedValue(false);
    render(await BrandMixPage({ searchParams: Promise.resolve(selection) }));
    expect(
      screen.getByRole('heading', {
        name:
          kind === 'module'
            ? 'Pharmacy Procurement is not licensed'
            : 'You do not have purchasing access',
      })
    ).toBeVisible();
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.medicines).not.toHaveBeenCalled();
    expect(mocks.proposals).not.toHaveBeenCalled();
  }
);

it('passes the selected reference and quantity to the guarded endpoint and displays its ranking', async () => {
  mocks.proposals.mockResolvedValue([
    proposal,
    { ...proposal, inventoryLotId: 'lot-c', displayName: 'Brand C', marginMinor: 100 },
  ]);
  render(await BrandMixPage({ searchParams: Promise.resolve(selection) }));
  expect(mocks.allowed).toHaveBeenCalledWith(
    expect.anything(),
    'pharmacy:procurement',
    undefined,
    expect.objectContaining({ db: expect.anything() })
  );
  expect(mocks.proposals).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch-a',
    medicineId: 'medicine-a',
    presentationId: 'presentation-a',
    quantityCanonicalUnits: 10,
  });
  const rows = within(screen.getByRole('table')).getAllByRole('row');
  expect(rows[1]).toHaveTextContent('Brand B');
  expect(rows[2]).toHaveTextContent('Brand C');
  expect(within(rows[1]!).getByText('PKR 5.00')).toBeVisible();
  expect(within(rows[1]!).getByText('PKR 4.00')).toBeVisible();
  expect(within(rows[1]!).getByText('12')).toBeVisible();
  expect(screen.getByRole('spinbutton', { name: 'Quantity (canonical units)' })).toHaveValue(10);
});

it.each([
  { values: { branch: 'foreign' }, label: 'Branch', role: 'combobox' },
  {
    values: { presentation: 'foreign' },
    label: 'Reference medicine and presentation',
    role: 'combobox',
  },
  { values: { quantity: '0' }, label: 'Quantity (canonical units)', role: 'spinbutton' },
  { values: { quantity: '1.5' }, label: 'Quantity (canonical units)', role: 'spinbutton' },
])('rejects invalid $values before reading proposals', async ({ values, label, role }) => {
  render(await BrandMixPage({ searchParams: Promise.resolve({ ...selection, ...values }) }));
  expect(screen.getByRole(role, { name: label })).toHaveAttribute('aria-invalid', 'true');
  expect(mocks.proposals).not.toHaveBeenCalled();
});

it('shows an actionable empty result', async () => {
  mocks.proposals.mockResolvedValue([]);
  render(await BrandMixPage({ searchParams: Promise.resolve(selection) }));
  expect(screen.getByRole('status')).toHaveTextContent(
    'No exact equivalent has enough saleable stock'
  );
  expect(screen.queryByRole('table')).toBeNull();
});

it.each(['unavailable', 'forbidden'])(
  'keeps selections and offers retry after a %s read',
  async (kind) => {
    mocks.proposals.mockRejectedValue(
      kind === 'forbidden' ? new TRPCError({ code: 'FORBIDDEN' }) : new Error('offline')
    );
    render(await BrandMixPage({ searchParams: Promise.resolve(selection) }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      kind === 'forbidden' ? 'You do not have access' : 'could not be read'
    );
    expect(
      screen.getByRole('combobox', { name: 'Reference medicine and presentation' })
    ).toHaveValue('presentation-a');
    expect(screen.getByRole('button', { name: 'Retry comparison' })).toBeEnabled();
    expect(screen.queryByRole('table')).toBeNull();
  }
);

it('disables comparison when reference choices are missing', async () => {
  mocks.medicines.mockResolvedValue([]);
  render(await BrandMixPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Compare brands' })).toBeDisabled();
  expect(screen.getByText(/Add a saleable medicine/)).toBeVisible();
});

it('offers recovery when choices fail to load', async () => {
  mocks.branches.mockRejectedValue(new Error('offline'));
  render(await BrandMixPage({ searchParams: Promise.resolve(selection) }));
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Branch and medicine choices are unavailable'
  );
  expect(screen.getByRole('button', { name: 'Reload choices' })).toBeEnabled();
  expect(mocks.proposals).not.toHaveBeenCalled();
});

it('provides descriptive loading feedback', () => {
  render(<Loading />);
  expect(screen.getByRole('status', { name: 'Loading Brand mix' })).toBeVisible();
});
