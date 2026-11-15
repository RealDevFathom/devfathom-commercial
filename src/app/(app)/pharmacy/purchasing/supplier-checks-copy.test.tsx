import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * DEV-753 — the purchasing overview and the orders page while the owner has the
 * supplier licence and trade-authorization checks off.
 *
 * "Off" is read from the suppliers the page already loaded (`compliance.checked`),
 * never from a second query, and a summary without `compliance` reads as checked.
 * ON wording is pinned word for word; OFF wording must not call a supplier
 * verified, licensed or authorized.
 */

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  hasModule: vi.fn(),
  createCaller: vi.fn(),
  policy: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.createCaller },
}));
// With no supplier listed yet, the pages ask the stored setting through this router.
vi.mock('@/server/routers/pharmacy-supplier-compliance', () => ({
  pharmacySupplierComplianceRouter: { createCaller: () => ({ policy: mocks.policy }) },
}));
const storedPolicy = (checksEnabled: boolean) => ({
  policy: {
    checksEnabled,
    version: checksEnabled ? 0 : 1,
    source: checksEnabled ? 'DEFAULT' : 'STORED',
    updatedAt: null,
    updatedByName: null,
  },
  canManage: false,
  warningVersion: 'supplier-compliance-off@1',
});

import OrdersPage from './orders/page';
import OverviewPage from './page';
import ReceivingPage from './receiving/page';

const FORBIDDEN_OFF_WORDS = /verified|licensed|authorized/i;

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

function contextStub() {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-procurement'] },
    // The purchasing pages re-check procurement access on the live user row (#994).
    db: {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          organizationRole: {
            permissions: ['pharmacy:procurement', 'pharmacy:procurement-approve'].map(
              (capability) => ({ capability, effect: 'ALLOW' })
            ),
          },
          permissionOverrides: [],
        }),
      },
    },
  };
}

/** An older cached summary with no `compliance` at all: must read as checked. */
const legacySupplier = {
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
  governingLicence: null,
  licences: [],
};

/** Checks on: authorized, with a verified unexpired licence. */
const checkedSupplier = {
  ...legacySupplier,
  compliance: { checked: true, policyVersion: 1, licenceStatus: 'VALID' as const },
};

/** Checks off: orderable with nothing verified, no authorization and no licence. */
const uncheckedSupplier = {
  ...checkedSupplier,
  id: 'sup-off',
  name: 'Hyderabad Traders',
  authorized: false,
  compliance: { checked: false, policyVersion: 2, licenceStatus: 'NONE' as const },
};

/** No stock location and no medicine yet, so the overview lists its readiness rows. */
function workspaceWith(suppliers: readonly object[]) {
  return {
    branches: [
      {
        id: 'branch-1',
        code: 'MAIN',
        name: 'Main branch',
        city: 'Karachi',
        defaultStockLocationId: null,
      },
    ],
    stockLocations: [],
    medicines: [],
    suppliers,
    approvers: [],
  };
}

const approvedOrder = {
  id: 'po-1',
  reference: 'PO-1',
  status: 'APPROVED',
  supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
  branch: null,
  branchId: null,
  supplierId: 'sup-ok',
  requisition: null,
  quoteId: null,
  expectedDeliveryAt: null,
  lines: [],
  approvals: [],
  goodsReceipts: [],
  createdByUserId: 'user-9',
};

function callerFor(suppliers: readonly object[], orders: readonly object[] = []) {
  return {
    workspace: vi.fn().mockResolvedValue(workspaceWith(suppliers)),
    requisitions: vi.fn().mockResolvedValue([]),
    purchaseOrders: vi.fn().mockResolvedValue(orders),
    receivingExceptionQueue: vi.fn().mockResolvedValue([]),
    receiptDebitNotes: vi.fn().mockResolvedValue([]),
    purchaseReturns: vi.fn().mockResolvedValue([]),
    compareQuotes: vi.fn().mockResolvedValue({ ranking: [] }),
    landedCost: vi.fn().mockResolvedValue({
      payableMinor: 0,
      landedCostMinor: 0,
      taxMinor: 0,
      chargesMinor: 0,
      canonicalUnits: 0,
      lines: [],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModule.mockImplementation((entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module)
  );
  mocks.resolveTenantActor.mockResolvedValue(actor);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
});

const params = (query: Record<string, string> = {}) => Promise.resolve(query);

const ORDERS_ON = {
  description:
    'Demand becomes a requisition, quotes are compared and explained, and an approved order is sent to a supplier that is still licensed at the moment it leaves.',
  stat: 'Authorized and licensed',
  send: 'The supplier’s authorization and licence are checked again at this moment; either can have lapsed since the order was drafted.',
};
const ORDERS_OFF = {
  description:
    'Demand becomes a requisition, quotes are compared and explained, and an approved order is sent to a supplier. Supplier checks are off, so suppliers are not checked.',
  stat: 'Supplier checks off: not checked',
  send: 'Supplier checks are off, so this supplier is not checked when the order is sent.',
};

describe('orders page supplier-check copy', () => {
  it('keeps today’s wording while supplier checks are on', async () => {
    mocks.createCaller.mockReturnValue(callerFor([checkedSupplier], [approvedOrder]));

    render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));

    expect(screen.getByText(ORDERS_ON.description)).toBeVisible();
    expect(screen.getByText(ORDERS_ON.stat)).toBeVisible();
    expect(screen.getByText(ORDERS_ON.send)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send to supplier' })).toBeVisible();
    for (const text of Object.values(ORDERS_OFF)) expect(screen.queryByText(text)).toBeNull();
  });

  it('says the suppliers are not checked while supplier checks are off', async () => {
    mocks.createCaller.mockReturnValue(
      callerFor([uncheckedSupplier], [{ ...approvedOrder, supplier: uncheckedSupplier }])
    );

    render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));

    for (const text of Object.values(ORDERS_OFF)) {
      const node = screen.getByText(text);
      expect(node).toBeVisible();
      expect(node.textContent).not.toMatch(FORBIDDEN_OFF_WORDS);
    }
    // The order can still be sent; only the sentence about checking it changes.
    expect(screen.getByRole('button', { name: 'Send to supplier' })).toBeVisible();
    for (const text of Object.values(ORDERS_ON)) expect(screen.queryByText(text)).toBeNull();
  });

  it('reads a supplier summary without compliance as checked (fail closed)', async () => {
    mocks.createCaller.mockReturnValue(callerFor([legacySupplier], [approvedOrder]));

    render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));

    expect(screen.getByText(ORDERS_ON.description)).toBeVisible();
    expect(screen.getByText(ORDERS_ON.stat)).toBeVisible();
    expect(screen.getByText(ORDERS_ON.send)).toBeVisible();
    expect(screen.queryByText(ORDERS_OFF.stat)).toBeNull();
  });
});

const OVERVIEW_ON = {
  why: 'PUR-01 refuses an order or a receipt unless the supplier is authorized and holds an unexpired verified licence.',
  stat: 'Authorized and licensed',
  card: 'Licence evidence, terms, credit and the standing decision to trade. A supplier is orderable only while both the authorization and an unexpired verified licence hold.',
};
const OVERVIEW_OFF = {
  why: 'Supplier checks are off, so suppliers are not checked before an order or a receipt.',
  stat: 'Supplier checks off: not checked',
  card: 'Terms, credit and any licence evidence on file. Supplier checks are off, so suppliers are not checked before ordering.',
};

describe('purchasing overview supplier-check copy', () => {
  it('keeps today’s wording while supplier checks are on', async () => {
    mocks.createCaller.mockReturnValue(callerFor([checkedSupplier]));

    render(await OverviewPage({ searchParams: params() }));

    expect(screen.getByText('A supplier that can be ordered from')).toBeVisible();
    for (const text of Object.values(OVERVIEW_ON)) expect(screen.getByText(text)).toBeVisible();
    for (const text of Object.values(OVERVIEW_OFF)) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('says the suppliers are not checked while supplier checks are off', async () => {
    mocks.createCaller.mockReturnValue(callerFor([uncheckedSupplier]));

    render(await OverviewPage({ searchParams: params() }));

    // The unchecked supplier still satisfies the readiness row: it can be ordered from.
    expect(screen.getByText('A supplier that can be ordered from')).toBeVisible();
    expect(screen.getByText('1 of 1')).toBeVisible();
    for (const text of Object.values(OVERVIEW_OFF)) {
      const node = screen.getByText(text);
      expect(node).toBeVisible();
      expect(node.textContent).not.toMatch(FORBIDDEN_OFF_WORDS);
    }
    for (const text of Object.values(OVERVIEW_ON)) expect(screen.queryByText(text)).toBeNull();
  });

  it('reads a supplier summary without compliance as checked (fail closed)', async () => {
    mocks.createCaller.mockReturnValue(callerFor([legacySupplier]));

    render(await OverviewPage({ searchParams: params() }));

    for (const text of Object.values(OVERVIEW_ON)) expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByText(OVERVIEW_OFF.stat)).toBeNull();
  });
});

describe('with no supplier listed yet, the stored setting decides the wording', () => {
  const ORDERS_EMPTY_ON =
    'There are no suppliers yet. Add one and file a verified licence before raising an order.';
  const ORDERS_EMPTY_OFF =
    'There are no suppliers yet. Add one in the supplier register; supplier checks are off, so it can be ordered from once added.';

  it('does not ask for a licence on the orders page while the stored setting is off', async () => {
    mocks.createCaller.mockReturnValue(callerFor([]));
    mocks.policy.mockResolvedValue(storedPolicy(false));

    render(await OrdersPage({ searchParams: params() }));

    expect(screen.getByText(ORDERS_EMPTY_OFF)).toBeVisible();
    expect(screen.getByText(ORDERS_EMPTY_OFF).textContent).not.toMatch(FORBIDDEN_OFF_WORDS);
    expect(screen.queryByText(ORDERS_EMPTY_ON)).toBeNull();
  });

  it('keeps asking for a verified licence when the stored setting cannot be read (fail closed)', async () => {
    mocks.createCaller.mockReturnValue(callerFor([]));
    mocks.policy.mockRejectedValue(new Error('policy read failed'));

    render(await OrdersPage({ searchParams: params() }));

    expect(screen.getByText(ORDERS_EMPTY_ON)).toBeVisible();
    expect(screen.queryByText(ORDERS_EMPTY_OFF)).toBeNull();
  });

  it('explains the unmet supplier row without licence demands on the overview while off', async () => {
    mocks.createCaller.mockReturnValue(callerFor([]));
    mocks.policy.mockResolvedValue(storedPolicy(false));

    render(await OverviewPage({ searchParams: params() }));

    expect(screen.getByText(OVERVIEW_OFF.why)).toBeVisible();
    expect(screen.queryByText(OVERVIEW_ON.why)).toBeNull();
  });
});

describe('receiving page supplier hint, by the stored setting', () => {
  const RECEIVING_EMPTY_ON =
    'No orderable supplier. Authorize one and file a verified licence first.';
  const RECEIVING_EMPTY_OFF = 'No supplier yet. Add one in the supplier register first.';

  /** Enough of a receiving bench for the direct-purchase form to render, with no supplier yet. */
  function receivingCaller() {
    const bench = {
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
      suppliers: [],
      approvers: [{ id: 'user-2', name: 'Bilal', email: 'bilal@example.test' }],
      // The direct-purchase form, and so its supplier hint, renders only when the
      // branch has a procurement approver (#246, #994).
      procurementApprovers: [
        { id: 'user-2', name: 'Bilal', email: 'bilal@example.test', branchIds: ['branch-1'] },
      ],
    };
    return {
      ...callerFor([]),
      workspace: vi.fn().mockResolvedValue(bench),
      goodsReceipts: vi.fn().mockResolvedValue([]),
      receivedAgainstOrder: vi.fn().mockResolvedValue({}),
      lotsFromReceipt: vi.fn().mockResolvedValue([]),
    };
  }

  // The receiving bench re-checks procurement access on the live user row.
  const withProcurementAccess = () =>
    mocks.createTRPCContext.mockResolvedValue({
      ...contextStub(),
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            organizationRole: {
              permissions: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
            },
            permissionOverrides: [],
          }),
        },
      },
    });

  it('does not ask for a licence or authorization while the stored setting is off', async () => {
    withProcurementAccess();
    mocks.createCaller.mockReturnValue(receivingCaller());
    mocks.policy.mockResolvedValue(storedPolicy(false));

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));

    expect(screen.getByText(RECEIVING_EMPTY_OFF)).toBeVisible();
    expect(screen.getByText(RECEIVING_EMPTY_OFF).textContent).not.toMatch(FORBIDDEN_OFF_WORDS);
    expect(screen.queryByText(RECEIVING_EMPTY_ON)).toBeNull();
  });

  it('keeps today’s hint while the stored setting is on', async () => {
    withProcurementAccess();
    mocks.createCaller.mockReturnValue(receivingCaller());
    mocks.policy.mockResolvedValue(storedPolicy(true));

    render(await ReceivingPage({ searchParams: params({ branch: 'branch-1' }) }));

    expect(screen.getByText(RECEIVING_EMPTY_ON)).toBeVisible();
    expect(screen.queryByText(RECEIVING_EMPTY_OFF)).toBeNull();
  });
});
