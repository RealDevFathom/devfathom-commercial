import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/**
 * WHA-1196 — the PH-PUR consoles, held to the UX rules that are acceptance
 * criteria rather than to "the component rendered".
 *
 * Each test below pins one rule that was a real defect somewhere else in this
 * product: no auto-selected first record (5), a validation error rendered
 * inline at its field (11), a picker that never offers a record the server
 * would refuse (12/16), and licensing and permission being different sentences
 * (7). The tenancy plumbing is pinned too, because a bare
 * `createTRPCContext()` is a crash on every host.
 */

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  hasModule: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.createCaller },
}));

import SuppliersPage from './suppliers/page';
import OrdersPage from './orders/page';
import ReceivingPage from './receiving/page';
import OverviewPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

function contextStub(enabledModules = ['pharmacy-procurement']) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { organizationId: 'org-1', enabledModules },
  };
}

const licensedSupplier = {
  id: 'sup-ok',
  name: 'Karachi Distributors',
  legalName: 'Karachi Distributors (Pvt) Ltd',
  authorized: true,
  active: true,
  serviceArea: 'Karachi South',
  contactName: 'Ayesha',
  contactPhone: '0300-0000000',
  paymentTermsDays: 30,
  creditLimitMinor: 500_000,
  eligibility: { orderable: true as const, reason: null },
  governingLicence: {
    id: 'lic-1',
    licenceType: 'Drug sale licence',
    licenceNumber: 'DSL-1',
    issuingAuthority: 'DRAP',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    evidenceUri: null,
    verified: true,
    superseded: false,
    daysToExpiry: 300,
  },
  licences: [],
};

const lapsedSupplier = {
  ...licensedSupplier,
  id: 'sup-lapsed',
  name: 'Lahore Wholesale',
  authorized: true,
  eligibility: { orderable: false as const, reason: 'NO_VALID_LICENCE' as const },
  governingLicence: null,
  licences: [],
};

const workspace = {
  branches: [
    {
      id: 'branch-1',
      code: 'MAIN',
      name: 'Main branch',
      city: 'Karachi',
      defaultStockLocationId: 'loc-1',
    },
  ],
  stockLocations: [
    {
      id: 'loc-1',
      branchId: 'branch-1',
      code: 'SHELF',
      name: 'Front shelf',
      kind: 'STORE',
      coldChain: false,
    },
    {
      id: 'loc-q',
      branchId: 'branch-1',
      code: 'QUAR',
      name: 'Quarantine',
      kind: 'QUARANTINE',
      coldChain: false,
    },
  ],
  medicines: [
    {
      id: 'med-1',
      productName: 'Amoxicillin 500mg',
      brandName: null,
      coldChain: false,
      controlled: false,
      packs: [
        {
          packLevelId: 'pack-1',
          level: 'STRIP',
          presentation: 'Capsule, 10 per strip',
          canonicalUnitsPerPack: 10,
          conversionLabel: '1 STRIP = 10 units',
        },
      ],
    },
  ],
  suppliers: [licensedSupplier, lapsedSupplier],
  approvers: [{ id: 'user-2', name: 'Bilal', email: 'bilal@example.test' }],
};

function callerStub(overrides: Record<string, unknown> = {}) {
  return {
    workspace: vi.fn().mockResolvedValue(workspace),
    suppliers: vi.fn().mockResolvedValue([licensedSupplier, lapsedSupplier]),
    requisitions: vi.fn().mockResolvedValue([]),
    purchaseOrders: vi.fn().mockResolvedValue([]),
    goodsReceipts: vi.fn().mockResolvedValue([]),
    receivingExceptionQueue: vi.fn().mockResolvedValue([]),
    purchaseReturns: vi.fn().mockResolvedValue([]),
    returnableLots: vi.fn().mockResolvedValue([]),
    supplierCredits: vi.fn().mockResolvedValue([]),
    receivedAgainstOrder: vi.fn().mockResolvedValue({}),
    lotsFromReceipt: vi.fn().mockResolvedValue([]),
    resolveScan: vi.fn(),
    compareQuotes: vi.fn().mockResolvedValue({ ranking: [] }),
    landedCost: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModule.mockImplementation(
    (entitlements: { enabledModules: string[] }, module: string) =>
      entitlements.enabledModules.includes(module)
  );
  mocks.resolveTenantActor.mockResolvedValue(actor);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
  mocks.createCaller.mockReturnValue(callerStub());
});

const params = (query: Record<string, string> = {}) => Promise.resolve(query);

describe('tenancy and licensing (UX rule 7)', () => {
  it('never asks the context factory to re-resolve tenancy', async () => {
    await SuppliersPage({ searchParams: params() });

    // A bare `createTRPCContext()` forwards `{ session: undefined }`, which
    // suppresses the `auth()` call and throws `Workspace not found.` on every
    // host. The resolved actor has to be passed through.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('says "not licensed" and never calls the router when the module is absent', async () => {
    mocks.createTRPCContext.mockResolvedValue(contextStub(['pharmacy-core']));

    render(await SuppliersPage({ searchParams: params() }));

    expect(
      screen.getByRole('heading', { name: 'Pharmacy Procurement is not licensed' })
    ).toBeDefined();
    expect(screen.getByText(/no allowance has been consumed/i)).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  it('says "no purchasing access" — a different sentence — when the session has no user', async () => {
    mocks.createTRPCContext.mockResolvedValue({ ...contextStub(), session: null });

    render(await SuppliersPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: 'You do not have purchasing access' })).toBeDefined();
  });

  it('renders the access state rather than throwing when tenancy does not resolve', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await SuppliersPage({ searchParams: params() }));

    expect(
      screen.getByRole('heading', { name: 'Pharmacy Procurement is not licensed' })
    ).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
});

describe('selection (UX rules 3, 4, 5, 6)', () => {
  it('shows the empty state instead of auto-selecting the first supplier', async () => {
    render(await SuppliersPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: 'No supplier selected' })).toBeDefined();
    expect(screen.getByText('Pick a supplier to see its licences')).toBeDefined();
    // The register is populated, so this is "nothing chosen yet" and not "no data".
    expect(screen.getByRole('link', { name: /Karachi Distributors/ })).toBeDefined();
  });

  it('shows the empty state when the requested supplier is not this organization’s', async () => {
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-from-another-tenant' }) }));

    expect(screen.getByRole('heading', { name: 'No supplier selected' })).toBeDefined();
  });

  it('opens the detail beside the list and keeps the selected row a focusable control', async () => {
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));

    const row = screen.getByRole('link', { name: /Karachi Distributors/ });
    // UX rule 3: still a link, still focusable, and marked current rather than
    // being replaced with inert text.
    expect(row.getAttribute('aria-current')).toBe('true');
    // UX rule 4: the row itself is the target, not a trailing "View" button.
    expect(row.getAttribute('href')).toContain('supplier=sup-ok');
    expect(screen.getByRole('heading', { name: 'Karachi Distributors' })).toBeDefined();
  });

  it('carries the requisition selection through an order link (rule 6)', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        requisitions: vi.fn().mockResolvedValue([
          {
            id: 'req-1',
            reference: 'REQ-1',
            status: 'SUBMITTED',
            branchId: 'branch-1',
            branch: { id: 'branch-1', name: 'Main branch' },
            createdAt: new Date('2026-05-01T00:00:00.000Z'),
            neededBy: null,
            lines: [],
            quotes: [],
            purchaseOrders: [],
          },
        ]),
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-1',
            reference: 'PO-1',
            status: 'DRAFT',
            supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
            branch: null,
            branchId: null,
            requisition: null,
            lines: [],
            approvals: [],
            goodsReceipts: [],
            createdByUserId: 'user-9',
          },
        ]),
      })
    );

    render(await OrdersPage({ searchParams: params({ req: 'req-1' }) }));

    const orderLink = screen.getByRole('link', { name: /PO-1/ });
    expect(orderLink.getAttribute('href')).toContain('req=req-1');
    expect(orderLink.getAttribute('href')).toContain('po=po-1');
  });
});

describe('pickers (UX rules 1, 12, 16)', () => {
  it('offers a lapsed supplier as a disabled, explained option rather than hiding or allowing it', async () => {
    render(await OrdersPage({ searchParams: params() }));

    const option = screen.getByRole('option', { name: /Lahore Wholesale — no valid licence/ });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole('option', { name: 'Karachi Distributors' }) as HTMLOptionElement).disabled).toBe(false);
  });

  it('states the pack conversion in the picker so no multiplier is ever typed', async () => {
    render(await OrdersPage({ searchParams: params() }));

    expect(
      screen.getAllByRole('option', { name: /Amoxicillin 500mg — STRIP \(1 STRIP = 10 units\)/ })
        .length
    ).toBeGreaterThan(0);
    // The canonical multiplier travels inside the option value, so the server
    // resolves it without asking the operator for it.
    const option = screen.getAllByRole('option', {
      name: /Amoxicillin 500mg — STRIP/,
    })[0] as HTMLOptionElement;
    expect(option.value).toBe('med-1|pack-1|10');
  });

  it('replaces an empty required picker with what is missing and where to fix it', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({ workspace: vi.fn().mockResolvedValue({ ...workspace, approvers: [] }) })
    );

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));

    expect(
      screen.getByRole('heading', { name: 'No second person can approve a bypass' })
    ).toBeDefined();
    expect(screen.getByRole('link', { name: /Invite a colleague/ }).getAttribute('href')).toBe(
      '/team'
    );
  });
});

describe('validation errors (UX rule 11)', () => {
  it('renders the message at the named field and focuses it, not only in a banner', async () => {
    render(
      await SuppliersPage({
        searchParams: params({
          notice: 'Trading name: enter a name.',
          kind: 'error',
          field: 'name',
        }),
      })
    );

    const input = screen.getByLabelText('Trading name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('field-name-error');
    const described = document.getElementById('field-name-error');
    expect(described?.textContent).toBe('Trading name: enter a name.');
    // Every other control stays valid — one failure does not paint the form red.
    expect(screen.getByLabelText('Contact name').getAttribute('aria-invalid')).toBe('false');
  });

  it('announces the failure to a screen reader as an alert', async () => {
    render(
      await SuppliersPage({
        searchParams: params({ notice: 'Could not add the supplier.', kind: 'error' }),
      })
    );

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not add the supplier.')).toBeDefined();
  });
});

describe('preconditions (UX rule 13)', () => {
  it('lists every unmet gate with a link to the page that clears it', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          branches: [],
          stockLocations: [],
          medicines: [],
          suppliers: [],
          approvers: [],
        }),
      })
    );

    render(await OverviewPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: '4 things still to set up' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open pharmacy onboarding' })).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Open the supplier register' }).getAttribute('href')
    ).toBe('/pharmacy/purchasing/suppliers');
  });

  it('says nothing about setup once every gate is met', async () => {
    render(await OverviewPage({ searchParams: params() }));

    expect(screen.queryByText(/still to set up/)).toBeNull();
  });
});

describe('branch scope (UX rules 1, 5, 12)', () => {
  it('adopts the only branch and says so rather than asking for an id', async () => {
    render(await ReceivingPage({ searchParams: params() }));

    expect(screen.getByText(/the only active branch in this workspace/)).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Choose a branch' })).toBeNull();
  });

  it('prompts for a branch — a distinct state from "no results" — when there are several', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          ...workspace,
          branches: [
            ...workspace.branches,
            {
              id: 'branch-2',
              code: 'NORTH',
              name: 'North branch',
              city: 'Lahore',
              defaultStockLocationId: null,
            },
          ],
        }),
      })
    );

    render(await ReceivingPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: 'Choose a branch' })).toBeDefined();
    // Nothing branch-scoped is read until a branch is chosen.
    expect(mocks.createCaller().goodsReceipts).not.toHaveBeenCalled();
  });

  it('falls through to the prompt when the requested branch is not this organization’s', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          ...workspace,
          branches: [
            ...workspace.branches,
            {
              id: 'branch-2',
              code: 'NORTH',
              name: 'North branch',
              city: 'Lahore',
              defaultStockLocationId: null,
            },
          ],
        }),
      })
    );

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-of-another-tenant' }) }));

    expect(screen.getByRole('heading', { name: 'Choose a branch' })).toBeDefined();
  });

  it('names the branch that has no active location instead of a bare empty page', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({ workspace: vi.fn().mockResolvedValue({ ...workspace, branches: [] }) })
    );

    render(await ReceivingPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: 'No active pharmacy branch' })).toBeDefined();
  });
});

describe('error states (UX rule 9)', () => {
  it('says what failed and what to do when a read throws, and does not crash', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({ suppliers: vi.fn().mockRejectedValue(new Error('database is away')) })
    );

    render(await SuppliersPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: 'This surface could not load' })).toBeDefined();
    expect(screen.getByText('No data was changed.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Try again' })).toBeDefined();
    // The raw failure never reaches the operator.
    expect(screen.queryByText(/database is away/)).toBeNull();
  });
});

describe('goods-in bench (PUR-02/04/05)', () => {
  it('reports an unresolvable scan rather than silently matching nothing', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-1',
            reference: 'PO-1',
            status: 'SENT',
            supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
            branch: null,
            branchId: 'branch-1',
            supplierId: 'sup-ok',
            requisition: null,
            lines: [],
            approvals: [],
            goodsReceipts: [],
            createdByUserId: 'user-9',
          },
        ]),
        resolveScan: vi.fn().mockResolvedValue({ kind: 'unresolved', label: '999' }),
      })
    );

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1', scan: '999' }) }));

    expect(screen.getByRole('alert').textContent).toContain('Nothing in this workspace matches');
  });

  it('does not offer a draft order for receiving', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-draft',
            reference: 'PO-DRAFT',
            status: 'DRAFT',
            supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
            branch: null,
            branchId: 'branch-1',
            supplierId: 'sup-ok',
            requisition: null,
            lines: [],
            approvals: [],
            goodsReceipts: [],
            createdByUserId: 'user-9',
          },
        ]),
      })
    );

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));

    expect(screen.getByRole('heading', { name: 'No order is out with a supplier' })).toBeDefined();
    expect(screen.queryByRole('option', { name: /PO-DRAFT/ })).toBeNull();
  });
});

describe('segregation of duties (PUR-02)', () => {
  it('explains why the raiser cannot approve instead of offering a button that refuses', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-1',
            reference: 'PO-1',
            status: 'SUBMITTED',
            supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
            branch: null,
            branchId: null,
            supplierId: 'sup-ok',
            requisition: null,
            lines: [],
            approvals: [],
            goodsReceipts: [],
            // The signed-in user in this suite.
            createdByUserId: 'user-1',
          },
        ]),
        landedCost: vi.fn().mockResolvedValue({
          payableMinor: 0,
          landedCostMinor: 0,
          taxMinor: 0,
          chargesMinor: 0,
          canonicalUnits: 0,
          netCostMinor: 0,
          lines: [],
        }),
      })
    );

    render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));

    expect(screen.getByText(/You raised this order, so you cannot approve it/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
