import { PurchasingValidationError } from './_lib/console';
import { revalidatePath } from 'next/cache';
import ReturnsPage from './returns/page';
import { Children, isValidElement, type ReactNode } from 'react';
import { PurchasingActionForm } from './_components/action-form';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

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

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
// DEV-753: the owner policy router, at its default (checks on, not the owner).
vi.mock('@/server/routers/pharmacy-supplier-compliance', () => ({
  pharmacySupplierComplianceRouter: {
    createCaller: () => ({
      policy: async () => ({
        policy: {
          checksEnabled: true,
          version: 0,
          source: 'DEFAULT',
          updatedAt: null,
          updatedByName: null,
        },
        canManage: false,
        warningVersion: 'supplier-compliance-off@1',
      }),
      history: async () => [],
      skips: async () => [],
    }),
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.createCaller },
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import SuppliersPage from './suppliers/page';
import OrdersPage from './orders/page';
import ReceivingPage from './receiving/page';
import OverviewPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

function contextStub(
  enabledModules = ['pharmacy-procurement'],
  // PR J: the returns board also needs financial report access (Manager + Finance).
  grants: readonly string[] = [
    'pharmacy.procurement',
    'pharmacy:procurement-approve',
    'reports:financial',
  ]
) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { organizationId: 'org-1', enabledModules },
    db: {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          organizationRole: {
            permissions: grants.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
          permissionOverrides: [],
        }),
      },
    },
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
    recordedByUserId: null,
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
  procurementApprovers: [
    { id: 'user-2', name: 'Bilal', email: 'bilal@example.test', branchIds: ['branch-1'] },
  ],
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
  vi.mocked(revalidatePath).mockReset();
  vi.unstubAllGlobals();
  mocks.hasModule.mockImplementation((entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module)
  );
  mocks.resolveTenantActor.mockResolvedValue(actor);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
  mocks.createCaller.mockReturnValue(callerStub());
});

const params = (query: Record<string, string> = {}) => Promise.resolve(query);
const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities;

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

  it('closes goods-in for a cashier who lacks the procurement capability', async () => {
    mocks.createTRPCContext.mockResolvedValue({
      ...contextStub(),
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            organizationRole: {
              permissions: [
                { capability: 'pharmacy.counter', effect: 'ALLOW' },
                { capability: 'pharmacy:orders', effect: 'ALLOW' },
              ],
            },
            permissionOverrides: [],
          }),
        },
      },
    });

    render(await ReceivingPage({ searchParams: params() }));

    expect(
      screen.getByRole('heading', { name: 'You do not have purchasing access' })
    ).toBeDefined();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });

  /**
   * Every member who does no procurement work (#979, PR J): the stock Cashier
   * and Pharmacist templates, the default EMPLOYEE with no organization role, an
   * empty Member role, and the Inventory, Auditor and Finance templates.
   */
  const NON_PROCUREMENT_ROLES = [
    ['cashier', template('cashier')],
    ['pharmacist', template('pharmacist')],
    ['default employee', null],
    ['empty member role', []],
    ['inventory', template('inventory')],
    ['auditor', template('auditor')],
    ['finance', template('finance')],
  ] as const;
  const SURFACES = [
    ['overview', () => OverviewPage({ searchParams: params({ supplier: 'sup-ok' }) })],
    ['suppliers', () => SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) })],
    ['orders', () => OrdersPage({ searchParams: params() })],
    ['goods-in', () => ReceivingPage({ searchParams: params() })],
    ['returns', () => ReturnsPage({ searchParams: params() })],
  ] as const;
  const PROCUREMENT_CONTROLS = [
    'Add supplier',
    'File licence',
    'Verify licence',
    'Withdraw authorization',
    'Authorize this supplier',
    'Draft requisition',
    'Draft order',
    'Submit for approval',
    'Approve',
    'Reject',
    'Send to supplier',
    'Post receipt',
    'Raise return',
  ];

  it.each(
    NON_PROCUREMENT_ROLES.flatMap(([role, grants]) =>
      SURFACES.map(([surface, page]) => [role, surface, grants, page] as const)
    )
  )(
    'closes %s out of %s with no procurement control and no router call (#979)',
    async (_role, _surface, grants, page) => {
      mocks.createTRPCContext.mockResolvedValue({
        ...contextStub(),
        db: {
          user: {
            findUnique: vi.fn().mockResolvedValue({
              role: 'EMPLOYEE',
              organizationRole:
                grants === null
                  ? null
                  : { permissions: grants.map((capability) => ({ capability, effect: 'ALLOW' })) },
              permissionOverrides: [],
            }),
          },
        },
      });

      render(await page());

      expect(
        screen.getByRole('heading', { name: 'You do not have purchasing access' })
      ).toBeDefined();
      for (const action of PROCUREMENT_CONTROLS) {
        expect(screen.queryByRole('button', { name: action }), action).toBeNull();
      }
      expect(mocks.createCaller).not.toHaveBeenCalled();
    }
  );

  it('still offers those actions to a member who holds pharmacy:procurement (#979)', async () => {
    mocks.createTRPCContext.mockResolvedValue(
      contextStub(['pharmacy-procurement'], ['pharmacy:procurement'])
    );

    const suppliers = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
    for (const action of ['Add supplier', 'File licence']) {
      expect(screen.queryAllByRole('button', { name: action }).length, action).toBeGreaterThan(0);
    }
    suppliers.unmount();

    render(await OrdersPage({ searchParams: params() }));
    for (const action of ['Draft requisition', 'Draft order']) {
      expect(screen.queryAllByRole('button', { name: action }).length, action).toBeGreaterThan(0);
    }
  });

  it('says "no purchasing access" — a different sentence — when the session has no user', async () => {
    mocks.createTRPCContext.mockResolvedValue({ ...contextStub(), session: null });

    render(await SuppliersPage({ searchParams: params() }));

    expect(
      screen.getByRole('heading', { name: 'You do not have purchasing access' })
    ).toBeDefined();
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
    expect(
      (screen.getByRole('option', { name: 'Karachi Distributors' }) as HTMLOptionElement).disabled
    ).toBe(false);
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
      callerStub({
        workspace: vi.fn().mockResolvedValue({ ...workspace, procurementApprovers: [] }),
      })
    );

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));

    expect(
      screen.getByRole('heading', { name: 'No authorized approver is available' })
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
          procurementApprovers: [],
        }),
      })
    );

    render(await OverviewPage({ searchParams: params() }));

    expect(screen.getByRole('heading', { name: '4 things still to set up' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open pharmacy onboarding' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Add a stock location' }).getAttribute('href')).toBe(
      '/pharmacy/inventory'
    );
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

  it.each(['SUBMITTED', 'APPROVED'] as const)(
    'offers no approve or send action on a %s order to a buyer without the approval permission (PR J)',
    async (status) => {
      mocks.createTRPCContext.mockResolvedValue(
        contextStub(['pharmacy-procurement'], ['pharmacy:procurement'])
      );
      mocks.createCaller.mockReturnValue(
        callerStub({
          purchaseOrders: vi.fn().mockResolvedValue([
            {
              id: 'po-1',
              reference: 'PO-1',
              status,
              supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
              branch: null,
              branchId: null,
              supplierId: 'sup-ok',
              requisition: null,
              lines: [],
              approvals: [],
              goodsReceipts: [],
              createdByUserId: 'user-9',
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

      expect(screen.getByText(/needs the purchase-order approval permission/)).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send to supplier' })).toBeNull();
    }
  );
});

describe('supplier authorization needs the approval permission (PUR-01, PR J)', () => {
  it('explains instead of offering authorize or withdraw to a buyer without it', async () => {
    mocks.createTRPCContext.mockResolvedValue(
      contextStub(['pharmacy-procurement'], ['pharmacy:procurement'])
    );

    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));

    expect(
      screen.getByText(
        /Authorizing a supplier, or withdrawing it, needs the purchase-order approval/
      )
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Withdraw authorization' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Authorize this supplier' })).toBeNull();
    // Filing and verifying licence evidence stays procurement work.
    expect(screen.queryAllByRole('button', { name: 'File licence' }).length).toBeGreaterThan(0);
  });

  it('offers the control to a member who also holds the approval permission', async () => {
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));

    expect(screen.getByRole('button', { name: 'Withdraw authorization' })).toBeDefined();
    expect(screen.queryByText(/Authorizing a supplier, or withdrawing it/)).toBeNull();
  });

  it('offers it to the legacy owner (tenant admin without a role)', async () => {
    mocks.createTRPCContext.mockResolvedValue({
      ...contextStub(),
      session: { ...actor.session, user: { ...actor.session.user, role: 'ADMIN' } },
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: 'ADMIN',
            organizationRole: null,
            permissionOverrides: [],
          }),
          // Active members, as the solo-owner rule reads them: not alone here.
          findMany: vi.fn().mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]),
        },
      },
    });

    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));

    expect(screen.getByRole('button', { name: 'Withdraw authorization' })).toBeDefined();
  });
});

describe('licence verification controls match the server (PUR-01, PR J)', () => {
  const unverified = (id: string, recordedByUserId: string | null) => ({
    ...licensedSupplier.governingLicence,
    id,
    licenceNumber: id,
    verified: false,
    recordedByUserId,
  });
  function withLicences(...licences: ReturnType<typeof unverified>[]) {
    mocks.createCaller.mockReturnValue(
      callerStub({ suppliers: vi.fn().mockResolvedValue([{ ...licensedSupplier, licences }]) })
    );
  }
  function asOwner(members: string[]) {
    mocks.createTRPCContext.mockResolvedValue({
      ...contextStub(),
      session: { ...actor.session, user: { ...actor.session.user, role: 'ADMIN' } },
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: 'ADMIN',
            status: 'ACTIVE',
            organizationRole: {
              key: 'owner',
              isSystem: true,
              permissions: [{ capability: '*', effect: 'ALLOW' }],
            },
            permissionOverrides: [],
          }),
          findMany: vi.fn().mockResolvedValue(members.map((id) => ({ id }))),
        },
      },
    });
  }

  it("offers Verify only on a colleague's filing, and explains the filer's own and unrecorded ones", async () => {
    withLicences(unverified('lic-mine', 'user-1'), unverified('lic-legacy', null));
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
    expect(screen.queryByRole('button', { name: 'Verify licence' })).toBeNull();
    expect(screen.getByText(/You filed this licence/)).toBeDefined();
    expect(screen.getByText(/filed before DevFathom recorded who filed it/)).toBeDefined();
  });

  it("offers Verify on a colleague's filing", async () => {
    withLicences(unverified('lic-colleague', 'user-2'));
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
    expect(screen.getAllByRole('button', { name: 'Verify licence' })).toHaveLength(1);
  });

  it('offers the solo owner Verify on their own and unrecorded filings', async () => {
    asOwner(['user-1']);
    withLicences(unverified('lic-mine', 'user-1'), unverified('lic-legacy', null));
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
    expect(screen.getAllByRole('button', { name: 'Verify licence' })).toHaveLength(2);
    expect(screen.queryByText(/A colleague with purchasing access verifies it/)).toBeNull();
  });

  it('does not treat an administrator with colleagues as the solo owner', async () => {
    asOwner(['user-1', 'user-2']);
    withLicences(unverified('lic-mine', 'user-1'));
    render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
    expect(screen.queryByRole('button', { name: 'Verify licence' })).toBeNull();
    expect(screen.getByText(/You filed this licence/)).toBeDefined();
  });
});

function findAction(node: ReactNode, name: string): (form: FormData) => Promise<string> {
  let found: ((form: FormData) => Promise<string>) | undefined;
  function visit(children: ReactNode) {
    Children.forEach(children, (child) => {
      if (
        !isValidElement<{ action?: (form: FormData) => Promise<string>; children?: ReactNode }>(
          child
        )
      )
        return;
      if (child.type === PurchasingActionForm && child.props.action?.name === name)
        found = child.props.action;
      visit(child.props.children);
    });
  }
  visit(node);
  if (!found) throw new Error(`Missing action ${name}`);
  return found;
}

describe('explicit purchasing action outcomes', () => {
  it('returns a success destination after one authenticated supplier write', async () => {
    const createSupplier = vi.fn().mockResolvedValue({ id: 'new-supplier', name: 'New supplier' });
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    const form = new FormData();
    form.set('name', 'New supplier');
    const result = new URL(await action(form), 'https://workspace.test');
    expect(result.pathname).toBe('/pharmacy/purchasing/suppliers');
    expect(result.searchParams.get('kind')).toBe('success');
    expect(result.searchParams.get('supplier')).toBe('new-supplier');
    expect(result.searchParams.get('notice')).toContain('New supplier added');
    expect(createSupplier).toHaveBeenCalledTimes(1);
  });

  it('returns field validation feedback without writing', async () => {
    const createSupplier = vi.fn();
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    const form = new FormData();
    form.set('creditLimit', 'invalid');
    const result = new URL(await action(form), 'https://workspace.test');
    expect(result.searchParams.get('kind')).toBe('error');
    expect(result.searchParams.get('notice')).toContain('Credit limit');
    expect(createSupplier).not.toHaveBeenCalled();
  });

  it('re-resolves the session at submission and returns session-loss feedback', async () => {
    const createSupplier = vi.fn();
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    mocks.resolveTenantActor.mockResolvedValue(null);
    const result = new URL(await action(new FormData()), 'https://workspace.test');
    expect(result.searchParams.get('kind')).toBe('error');
    expect(result.searchParams.get('notice')).toContain('session is no longer active');
    expect(createSupplier).not.toHaveBeenCalled();
  });

  it('delivers domain rejection feedback without changing its meaning', async () => {
    const createSupplier = vi.fn().mockRejectedValue(new Error('CROSS_TENANT_REFERENCE'));
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    const result = new URL(await action(new FormData()), 'https://workspace.test');
    expect(result.searchParams.get('kind')).toBe('error');
    expect(result.searchParams.get('notice')).toBe('That record is not part of this workspace.');
    expect(createSupplier).toHaveBeenCalledTimes(1);
  });
});

// Persistent WHA-1349 safety probe from artifact 1bebca46-165f-43a0-9d81-bc3e3b8f8f59.
// Executes actual inline actions and client form; mocked callers are not DB/idempotency proof.
describe('WHA-1349 action-boundary retry safety', () => {
  function mountAction(
    action: (form: FormData) => Promise<string>,
    fields: Record<string, string>
  ) {
    vi.stubGlobal('window', {
      document,
      location: { origin: 'https://workspace.test', replace: vi.fn() },
    });
    const view = render(
      <PurchasingActionForm action={action}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} name={name} defaultValue={value} aria-label={name} />
        ))}
        <button type="submit">Save</button>
      </PurchasingActionForm>
    );
    return view.container.querySelector('form')!;
  }

  it.each(['supplier', 'supplier credit'])(
    'post-write revalidation failure cannot repeat the %s mutation',
    async (path) => {
      const write = vi.fn().mockResolvedValue({ id: 'new-supplier', name: 'New supplier' });
      mocks.createCaller.mockReturnValue(
        callerStub({ createSupplier: write, recordSupplierCredit: write })
      );
      const page =
        path === 'supplier'
          ? await SuppliersPage({ searchParams: params() })
          : await ReturnsPage({ searchParams: params() });
      const action = findAction(page, path === 'supplier' ? 'createSupplier' : 'recordCredit');
      // Supplier reproduces the original generic cache failure; credit also tests that phase dominates a validation error type.
      vi.mocked(revalidatePath).mockImplementation(() => {
        throw path === 'supplier'
          ? new Error('post-write cache failure')
          : new PurchasingValidationError('post-write cache failure');
      });
      const form = mountAction(action, {
        name: 'New supplier',
        branchId: 'branch-1',
        supplierId: 'sup-ok',
        creditReference: 'CR-1',
        amount: '25.00',
        receivedAt: '2026-09-01',
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent('check the record before retrying');
      expect(screen.getByRole('button')).toBeDisabled();
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(write).toHaveBeenCalledTimes(1);
    }
  );

  it('definitive local validation rejection permits correction before the first write', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'new-supplier', name: 'New supplier' });
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier: write }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    mountAction(action, { name: 'New supplier', creditLimit: 'invalid' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByLabelText('creditLimit')).toHaveFocus();
    expect(screen.getByRole('button')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('creditLimit'), { target: { value: '25.00' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('unknown server mutation failure remains locked even with a familiar domain message', async () => {
    const write = vi.fn().mockRejectedValue(new Error('CROSS_TENANT_REFERENCE'));
    mocks.createCaller.mockReturnValue(callerStub({ createSupplier: write }));
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    const form = mountAction(action, { name: 'New supplier' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('button')).toBeDisabled();
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('generic server setup error is not mislabeled as safe local validation', async () => {
    const action = findAction(await SuppliersPage({ searchParams: params() }), 'createSupplier');
    mocks.resolveTenantActor.mockRejectedValue(new Error('backend unavailable'));
    const result = new URL(await action(new FormData()), 'https://workspace.test');
    expect(result.searchParams.get('outcome')).toBe('unknown');
  });
});

describe('goods-in scan and duplicate serial', () => {
  const order = {
    id: 'po-1',
    reference: 'PO-1',
    status: 'SENT',
    supplierId: 'sup-ok',
    supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
    lines: [
      {
        id: 'line-1',
        medicineId: 'med-1',
        packLevelId: 'pack-1',
        orderedPacks: 10,
        bonusPacks: 0,
        canonicalUnitsPerPack: 10,
        orderedCanonicalUnits: 100,
        bonusCanonicalUnits: 0,
        listPricePerPackMinor: 1000,
        medicine: { productName: 'Amoxicillin 500mg' },
        packLevel: { level: 'STRIP' },
      },
    ],
  };

  it('focuses the scan box above the exception queue and counts one serialized pack', async () => {
    const payload = ']d201089612345678941727123110ABCD1234|21A3F09C1E77B2';
    mocks.createCaller.mockReturnValue(
      callerStub({
        purchaseOrders: vi.fn().mockResolvedValue([order]),
        resolveScan: vi.fn().mockResolvedValue({
          kind: 'gs1',
          medicineId: 'med-1',
          packLevelId: 'pack-1',
          label: 'Amoxicillin 500mg',
          gtin: '08961234567894',
          batch: 'ABCD1234',
          expiryDate: '2027-12-31',
          rawExpiry: '271231',
          serial: 'A3F09C1E77B2',
          warnings: [],
        }),
      })
    );

    render(await ReceivingPage({ searchParams: params({ order: 'po-1', scan: payload }) }));

    const scan = screen.getByLabelText(/Scan or search/);
    const queue = screen.getByRole('heading', { name: /Match exceptions/ });
    expect(scan.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scan).toHaveFocus();
    const line = screen.getByRole('group', { name: 'Amoxicillin 500mg' });
    expect(within(line).getByLabelText('Packs received')).toHaveValue(1);
    expect(within(line).getByLabelText(/Invoice corrects the printed batch/)).toBeDefined();
    expect(line.querySelector('input[name="gs1Payload:line-1"]')).toHaveValue(payload);
  });

  it('reports a duplicate serial as a rejection the operator can correct', async () => {
    const write = vi.fn().mockRejectedValue(new Error('DUPLICATE_SERIAL'));
    mocks.createCaller.mockReturnValue(
      callerStub({
        purchaseOrders: vi.fn().mockResolvedValue([order]),
        createGoodsReceipt: write,
      })
    );
    const action = findAction(
      await ReceivingPage({ searchParams: params({ order: 'po-1' }) }),
      'receiveAgainstOrder'
    );
    const form = new FormData();
    form.set('branchId', 'branch-1');
    form.set('purchaseOrderId', 'po-1');
    form.set('reference', 'GRN-1');
    form.set('supplierInvoiceRef', 'INV-1');
    form.set('supplierInvoiceDate', '2026-10-21');
    form.set('warrantyEvidenceRef', 'WAR-1');
    form.set('receivedAt', '2026-10-21');
    form.set('batchNumber:line-1', 'ABCD1234');
    form.set('printedExpiry:line-1', '2027-12-31');
    form.set('printedMrp:line-1', '25.00');
    form.set('receivedPacks:line-1', '1');
    form.set('invoicedPrice:line-1', '10.00');
    form.set('stockLocation:line-1', 'loc-1');
    form.set('serialNumber:line-1', 'A3F09C1E77B2');
    form.set('gtin:line-1', '08961234567894');
    const result = new URL(await action(form), 'https://workspace.test');
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.searchParams.get('outcome')).toBe('rejected');
    expect(result.searchParams.get('notice')).toBe(
      'This GTIN and serial were already received in this pharmacy. Treat it as a duplicate pack and do not stock it in again.'
    );
    expect(result.searchParams.get('field')).toBe('serialNumber');
  });

  // DEV-752: one ordered line may arrive as several lots (extra slots `<line>.lot2/3`).
  function lotForm(lots: Array<{ key: string; batch: string; expiry: string; packs: string }>) {
    const form = new FormData();
    form.set('branchId', 'branch-1');
    form.set('purchaseOrderId', 'po-1');
    form.set('reference', 'GRN-LOTS');
    form.set('supplierInvoiceRef', 'INV-LOTS');
    form.set('supplierInvoiceDate', '2026-10-21');
    form.set('warrantyEvidenceRef', 'WAR-LOTS');
    form.set('receivedAt', '2026-10-21');
    for (const lot of lots) {
      form.set(`batchNumber:${lot.key}`, lot.batch);
      form.set(`printedExpiry:${lot.key}`, lot.expiry);
      form.set(`printedMrp:${lot.key}`, '25.00');
      form.set(`receivedPacks:${lot.key}`, lot.packs);
      form.set(`invoicedPrice:${lot.key}`, '10.00');
      form.set(`stockLocation:${lot.key}`, 'loc-1');
    }
    return form;
  }

  it('files each extra lot slot as its own receipt line against the same order line', async () => {
    const write = vi.fn().mockResolvedValue({ id: 'gr-lots', reference: 'GRN-LOTS' });
    mocks.createCaller.mockReturnValue(
      callerStub({ purchaseOrders: vi.fn().mockResolvedValue([order]), createGoodsReceipt: write })
    );
    const action = findAction(
      await ReceivingPage({ searchParams: params({ order: 'po-1' }) }),
      'receiveAgainstOrder'
    );
    await action(
      lotForm([
        { key: 'line-1', batch: 'SYN-L1', expiry: '2028-06-30', packs: '6' },
        { key: 'line-1.lot2', batch: 'SYN-L2', expiry: '2028-09-30', packs: '4' },
        // A blank extra slot did not arrive and is skipped.
        { key: 'line-1.lot3', batch: '', expiry: '', packs: '' },
      ])
    );
    expect(write).toHaveBeenCalledTimes(1);
    const lines = write.mock.calls[0]![0].lines;
    expect(
      lines.map((line: Record<string, unknown>) => [
        line.purchaseOrderLineId,
        line.medicineId,
        line.packLevelId,
        line.canonicalUnitsPerPack,
        line.batchNumber,
        line.receivedPacks,
      ])
    ).toEqual([
      ['line-1', 'med-1', 'pack-1', 10, 'SYN-L1', 6],
      ['line-1', 'med-1', 'pack-1', 10, 'SYN-L2', 4],
    ]);
  });

  it('refuses the same batch and expiry entered twice on one order line before writing', async () => {
    const write = vi.fn();
    mocks.createCaller.mockReturnValue(
      callerStub({ purchaseOrders: vi.fn().mockResolvedValue([order]), createGoodsReceipt: write })
    );
    const action = findAction(
      await ReceivingPage({ searchParams: params({ order: 'po-1' }) }),
      'receiveAgainstOrder'
    );
    const result = new URL(
      await action(
        lotForm([
          { key: 'line-1', batch: 'SYN-L1', expiry: '2028-06-30', packs: '6' },
          { key: 'line-1.lot2', batch: 'syn-l1', expiry: '2028-06-30', packs: '4' },
        ])
      ),
      'https://workspace.test'
    );
    expect(write).not.toHaveBeenCalled();
    expect(result.searchParams.get('outcome')).toBe('rejected');
    expect(result.searchParams.get('field')).toBe('batchNumber');
    expect(result.searchParams.get('notice')).toMatch(/same batch and expiry is entered twice/);
  });

  it("pre-selects the branch's receiving default on every lot slot without guessing", async () => {
    const twoShelves = {
      ...workspace,
      branches: [{ ...workspace.branches[0]!, defaultStockLocationId: 'loc-2' }],
      stockLocations: [
        ...workspace.stockLocations,
        {
          id: 'loc-2',
          branchId: 'branch-1',
          code: 'BACK',
          name: 'Back store',
          kind: 'STORE',
          coldChain: false,
        },
      ],
    };
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue(twoShelves),
        purchaseOrders: vi.fn().mockResolvedValue([order]),
      })
    );
    const view = render(await ReceivingPage({ searchParams: params({ order: 'po-1' }) }));
    const shelves = [...view.container.querySelectorAll('select[name^="stockLocation:line-1"]')];
    expect(shelves.map((select) => (select as HTMLSelectElement).name)).toEqual([
      'stockLocation:line-1',
      'stockLocation:line-1.lot2',
      'stockLocation:line-1.lot3',
    ]);
    for (const select of shelves) expect(select).toHaveValue('loc-2');

    // No branch default and two receiving shelves: nothing is pre-selected.
    view.unmount();
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          ...twoShelves,
          branches: [{ ...twoShelves.branches[0]!, defaultStockLocationId: null }],
        }),
        purchaseOrders: vi.fn().mockResolvedValue([order]),
      })
    );
    const unset = render(await ReceivingPage({ searchParams: params({ order: 'po-1' }) }));
    expect(unset.container.querySelector('select[name="stockLocation:line-1"]')).toHaveValue('');
  });
});

describe('purchasing PIN controls', () => {
  it('offers only approvers assigned to the receiving branch and preserves the self-solo rule', async () => {
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          ...workspace,
          procurementApprovers: [
            ...workspace.procurementApprovers,
            {
              id: 'other-approver',
              name: 'Other branch',
              email: 'other@example.test',
              branchIds: ['branch-2'],
            },
            {
              id: 'user-1',
              name: 'Owner',
              email: 'owner@example.test',
              branchIds: ['branch-1', 'branch-2'],
              soloBranchIds: ['branch-2'],
            },
          ],
        }),
      })
    );
    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));
    const picker = within(screen.getByLabelText('Approved by'));
    expect(picker.getByRole('option', { name: 'Bilal (bilal@example.test)' })).toBeDefined();
    expect(picker.queryByRole('option', { name: 'Other branch (other@example.test)' })).toBeNull();
    expect(picker.queryByRole('option', { name: 'Owner (owner@example.test)' })).toBeNull();
  });
  it('offers a masked, labelled approval PIN without autocomplete', async () => {
    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));
    const pin = screen.getByLabelText('Approver PIN') as HTMLInputElement;
    expect(pin.type).toBe('password');
    expect(pin.autocomplete).toBe('off');
    expect(pin.required).toBe(true);
    expect(pin.getAttribute('inputmode')).toBe('numeric');
  });
  it('refuses a receiving-view actor without procurement access', async () => {
    const ctx = contextStub();
    ctx.db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'pharmacy:receiving-view', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    mocks.createTRPCContext.mockResolvedValue(ctx);
    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));
    expect(screen.queryByLabelText('Approver PIN')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'You do not have purchasing access' })
    ).toBeDefined();
  });
  it.each(['branch-2', null])(
    'does not offer owner self-approval outside the solo branch (%s)',
    async (branchId) => {
      mocks.createCaller.mockReturnValue(
        callerStub({
          workspace: vi.fn().mockResolvedValue({
            ...workspace,
            procurementApprovers: [
              {
                id: 'user-1',
                name: 'Owner',
                email: 'owner@example.test',
                branchIds: ['branch-1', 'branch-2'],
                soloBranchIds: ['branch-1'],
                soloOrganizationWide: false,
              },
            ],
          }),
          purchaseOrders: vi.fn().mockResolvedValue([
            {
              id: 'po-1',
              reference: 'STAFFED-PO',
              status: 'SUBMITTED',
              supplier: { id: 'sup-ok', name: 'Supplier' },
              branch: null,
              branchId,
              supplierId: 'sup-ok',
              requisition: null,
              lines: [],
              approvals: [],
              goodsReceipts: [],
              createdByUserId: 'user-1',
            },
          ]),
          landedCost: vi.fn().mockResolvedValue(null),
        })
      );
      render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
      expect(screen.queryByLabelText('Owner PIN')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
    }
  );
  it('offers a PIN-protected decision to a solo owner while preserving the multi-staff refusal', async () => {
    const ctx = contextStub();
    mocks.createTRPCContext.mockResolvedValue({
      ...ctx,
      session: { ...actor.session, user: { ...actor.session.user, role: 'ADMIN' } },
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            role: 'ADMIN',
            status: 'ACTIVE',
            organizationRole: {
              key: 'owner',
              isSystem: true,
              permissions: [{ capability: '*', effect: 'ALLOW' }],
            },
            permissionOverrides: [],
          }),
          findMany: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
        },
      },
    });
    mocks.createCaller.mockReturnValue(
      callerStub({
        workspace: vi.fn().mockResolvedValue({
          ...workspace,
          procurementApprovers: [
            {
              id: 'user-1',
              name: 'Owner',
              email: 'owner@example.test',
              branchIds: ['branch-1'],
              soloOrganizationWide: true,
              soloBranchIds: ['branch-1'],
            },
          ],
        }),
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-1',
            reference: 'SOLO-PO',
            status: 'SUBMITTED',
            supplier: { id: 'sup-ok', name: 'Supplier' },
            branch: null,
            branchId: null,
            supplierId: 'sup-ok',
            requisition: null,
            lines: [],
            approvals: [],
            goodsReceipts: [],
            createdByUserId: 'user-1',
          },
        ]),
        landedCost: vi.fn().mockResolvedValue(null),
      })
    );
    render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
    expect((screen.getByLabelText('Owner PIN') as HTMLInputElement).type).toBe('password');
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeDefined();
  });
});
