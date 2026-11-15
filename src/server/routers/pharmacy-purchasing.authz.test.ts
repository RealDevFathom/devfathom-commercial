import { hashSync } from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

// #979, PR J — purchasing authorization, end to end through the REAL ABAC
// engine (`@/lib/abac` is deliberately not mocked): deny by default, the
// cashier refused on every procedure, the solo owner allowed on every
// procedure, a separate approver capability, the branch boundary and licence
// verification by a second person.

const mocks = vi.hoisted(() => ({ annotateAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacyPurchasingRouter, SOLO_OWNER_APPROVAL_POLICY } from './pharmacy-purchasing';
import { denyByDefaultProcedure, router, type ProcedureMeta, type TRPCContext } from '../trpc';

const FUTURE = new Date('2030-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');
const PERMISSION = 'You do not have permission for this action.';
const OUTSIDE_BRANCH = 'Branch is outside your scope.';
const APPROVER_HASH = hashSync('1234', 4);

// ── people ────────────────────────────────────────────────────────────────

type Grant = { capability: string; effect: 'ALLOW' | 'DENY' };
type Person = { role: 'ADMIN' | 'EMPLOYEE'; grants: readonly string[] | null };

const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities;

const PEOPLE: Record<string, Person> = {
  // Two counter staff on the stock Cashier template.
  cashier_a: { role: 'EMPLOYEE', grants: template('cashier') },
  cashier_b: { role: 'EMPLOYEE', grants: template('cashier') },
  // Raises orders, cannot approve them.
  buyer: { role: 'EMPLOYEE', grants: template('procurement') },
  manager_a: { role: 'EMPLOYEE', grants: template('manager') },
  manager_b: { role: 'EMPLOYEE', grants: template('manager') },
  // The provisioned owner: tenant ADMIN on the bootstrap `*` role, who is also
  // the pharmacist (exact `pharmacy:dispense` grant), and the only member.
  owner: { role: 'ADMIN', grants: ['*', 'pharmacy:dispense'] },
  // Legacy owner (#375): tenant ADMIN with no organization role at all.
  legacy_owner: { role: 'ADMIN', grants: null },
  // A proprietor on the optional Owner / Operator template (#975), which an
  // assigned role makes the boundary even for a tenant ADMIN.
  owner_operator: { role: 'ADMIN', grants: template('owner-operator') },
  // Roles that do no procurement work (#979, PR J follow-up).
  pharmacist: { role: 'EMPLOYEE', grants: template('pharmacist') },
  // A member invited with the default EMPLOYEE role and no organization role.
  employee: { role: 'EMPLOYEE', grants: null },
  // The agency-style empty Member role.
  member: { role: 'EMPLOYEE', grants: [] },
  inventory_clerk: { role: 'EMPLOYEE', grants: template('inventory') },
  auditor: { role: 'EMPLOYEE', grants: template('auditor') },
  finance: { role: 'EMPLOYEE', grants: template('finance') },
};

function userRow(id: string) {
  const person = PEOPLE[id];
  if (!person) return null;
  const permissions: Grant[] | undefined = person.grants?.map((capability) => ({
    capability,
    effect: 'ALLOW',
  }));
  return {
    id,
    role: person.role,
    status: 'ACTIVE',
    organizationId: 'org_a',
    organizationRole: permissions ? { key: 'role', permissions } : null,
    permissionOverrides: [],
  };
}

// ── a tenant-scoped client where every delegate exists ────────────────────

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({ _sum: {} }),
    groupBy: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'created', ...data })),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'updated', ...data })),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockImplementation(async ({ create }: { create: object }) => create),
    delete: vi.fn().mockResolvedValue(null),
  };
}
type Model = ReturnType<typeof model>;

let models: Map<string, Model>;
let db: Record<string, unknown> & {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

function makeDb() {
  models = new Map();
  const base: Record<string, unknown> = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const proxy = new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      // Never look thenable, and never invent client methods.
      if (key === 'then' || key.startsWith('$')) return undefined;
      if (!models.has(key)) models.set(key, model());
      return models.get(key);
    },
  });
  base.$transaction = vi.fn(async (work: unknown) =>
    typeof work === 'function' ? (work as (tx: unknown) => unknown)(proxy) : Promise.all(work as [])
  );
  return proxy as typeof db;
}

const m = (name: string) => (db as unknown as Record<string, Model>)[name]!;

/** Business tables a refused call must never have touched (the ABAC lookup reads `user`). */
function touchedBusinessTables() {
  return [...models.entries()]
    .filter(([name]) => name !== 'user')
    .filter(([, delegate]) => Object.values(delegate).some((fn) => fn.mock.calls.length > 0))
    .map(([name]) => name);
}

function caller(userId: string) {
  const person = PEOPLE[userId]!;
  return pharmacyPurchasingRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, role: person.role, status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
type Caller = ReturnType<typeof caller>;

/** Active members seen by both the organization and branch solo-owner checks. */
function activeMembers(...ids: string[]) {
  m('user').findMany.mockResolvedValue(ids.map((id) => userRow(id)));
  m('user').count.mockImplementation(
    async ({ where }: { where: { id: { not: string } } }) =>
      ids.filter((id) => id !== where.id.not).length
  );
}

/** Which branches each person is assigned to. */
function assignments(byUser: Record<string, string[]>) {
  m('pharmacyBranchAssignment').findFirst.mockImplementation(
    async ({ where }: { where: { userId: string; branchId: string } }) =>
      byUser[where.userId]?.includes(where.branchId) ? { id: `asg_${where.userId}` } : null
  );
  m('pharmacyBranchAssignment').findMany.mockImplementation(
    async ({ where }: { where: { userId: string; branchId?: { in: string[] } } }) =>
      (byUser[where.userId] ?? [])
        .filter((branchId) => !where.branchId || where.branchId.in.includes(branchId))
        .map((branchId) => ({ branchId }))
  );
}

const SUPPLIER = {
  id: 'supplier_a',
  name: 'Karachi Distributors',
  authorized: true,
  licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po_a',
    status: 'SUBMITTED',
    supplierId: 'supplier_a',
    branchId: 'branch_a',
    createdByUserId: 'buyer',
    requisition: null,
    lines: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = makeDb();
  mocks.annotateAudit.mockReset();
  m('user').findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    userRow(where.id)
  );
  activeMembers('owner', 'cashier_a', 'cashier_b', 'buyer', 'manager_a', 'manager_b');
  m('pharmacyBranch').findFirst.mockResolvedValue({ id: 'branch_a' });
  m('pharmacyBranch').findMany.mockResolvedValue([{ id: 'branch_a' }]);
  assignments({
    cashier_a: ['branch_a'],
    cashier_b: ['branch_a'],
    buyer: ['branch_a'],
    manager_a: ['branch_a'],
    manager_b: ['branch_a'],
    owner_operator: ['branch_a'],
  });
  m('pharmacySupplier').findFirst.mockResolvedValue(SUPPLIER);
  m('medicine').findFirst.mockResolvedValue({ id: 'medicine_a' });
  m('packLevel').findFirst.mockResolvedValue({ id: 'pack_a' });
  m('restaurantOperatorCredential').findFirst.mockResolvedValue({
    id: 'credential_a',
    credentialHash: APPROVER_HASH,
    failedAttempts: 0,
    lockedUntil: null,
  });
});

// ── one valid call per procedure ──────────────────────────────────────────

const RECEIPT_LINE = {
  medicineId: 'medicine_a',
  packLevelId: 'pack_a',
  batchNumber: 'B1',
  printedExpiry: FUTURE,
  expiryPrecision: 'DAY' as const,
  printedMrpMinor: 1_000,
  canonicalUnitsPerPack: 10,
  receivedPacks: 1,
  invoicedPricePerPackMinor: 500,
  stockLocationId: 'loc_a',
};

const CALLS = {
  provisionMyPurchasePin: (c: Caller) => c.provisionMyPurchasePin({ pin: '4821' }),
  createSupplier: (c: Caller) => c.createSupplier({ name: 'Karachi Distributors' }),
  recordSupplierLicence: (c: Caller) =>
    c.recordSupplierLicence({
      supplierId: 'supplier_a',
      licenceType: 'DSL',
      licenceNumber: 'DSL-1',
      issuingAuthority: 'DRAP',
      issuedAt: PAST,
      expiresAt: FUTURE,
    }),
  verifySupplierLicence: (c: Caller) => c.verifySupplierLicence({ licenceId: 'lic_a' }),
  setSupplierAuthorization: (c: Caller) =>
    c.setSupplierAuthorization({ supplierId: 'supplier_a', authorized: true }),
  createRequisition: (c: Caller) =>
    c.createRequisition({
      reference: 'REQ-1',
      branchId: 'branch_a',
      lines: [
        {
          medicineId: 'medicine_a',
          packLevelId: 'pack_a',
          quantityPacks: 1,
          canonicalUnitsPerPack: 10,
        },
      ],
    }),
  submitRequisition: (c: Caller) => c.submitRequisition({ requisitionId: 'req_a' }),
  recordQuote: (c: Caller) =>
    c.recordQuote({
      requisitionId: 'req_a',
      supplierId: 'supplier_a',
      quotedAt: PAST,
      validUntil: FUTURE,
      lines: [
        {
          requisitionLineId: 'reqline_a',
          pricePerPackMinor: 100,
          forecastSellThroughPacks: 1,
          canonicalUnitsPerPack: 10,
        },
      ],
    }),
  compareQuotes: (c: Caller) => c.compareQuotes({ requisitionLineId: 'reqline_a' }),
  createPurchaseOrder: (c: Caller) =>
    c.createPurchaseOrder({
      reference: 'PO-1',
      supplierId: 'supplier_a',
      branchId: 'branch_a',
      lines: [
        {
          medicineId: 'medicine_a',
          packLevelId: 'pack_a',
          orderedPacks: 1,
          canonicalUnitsPerPack: 10,
          listPricePerPackMinor: 100,
        },
      ],
    }),
  submitPurchaseOrder: (c: Caller) => c.submitPurchaseOrder({ purchaseOrderId: 'po_a' }),
  approvePurchaseOrder: (c: Caller) =>
    c.approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED', pin: '1234' }),
  sendPurchaseOrder: (c: Caller) => c.sendPurchaseOrder({ purchaseOrderId: 'po_a' }),
  landedCost: (c: Caller) => c.landedCost({ purchaseOrderId: 'po_a' }),
  createGoodsReceipt: (c: Caller) =>
    c.createGoodsReceipt({
      reference: 'GR-1',
      branchId: 'branch_a',
      supplierId: 'supplier_a',
      directPurchase: { reason: 'Urgent stock-out', approvedByUserId: 'manager_a', pin: '1234' },
      supplierInvoiceRef: 'INV-1',
      supplierInvoiceDate: PAST,
      warrantyEvidenceRef: 'WAR-1',
      receivedAt: new Date(),
      lines: [RECEIPT_LINE],
    }),
  postGoodsReceipt: (c: Caller) =>
    c.postGoodsReceipt({ branchId: 'branch_a', goodsReceiptId: 'gr_a' }),
  controlledWitnesses: (c: Caller) =>
    c.controlledWitnesses({ branchId: 'branch_a', goodsReceiptId: 'gr_a' }),
  controlledReversalWitnesses: (c: Caller) =>
    c.controlledReversalWitnesses({ branchId: 'branch_a', goodsReceiptId: 'gr_a' }),
  reverseGoodsReceipt: (c: Caller) =>
    c.reverseGoodsReceipt({ branchId: 'branch_a', goodsReceiptId: 'gr_a', reason: 'Wrong' }),
  receivingExceptions: (c: Caller) => c.receivingExceptions({ branchId: 'branch_a' }),
  resolveReceivingException: (c: Caller) =>
    c.resolveReceivingException({
      branchId: 'branch_a',
      receivingExceptionId: 'exc_a',
      resolutionNote: 'Checked',
    }),
  createPurchaseReturn: (c: Caller) =>
    c.createPurchaseReturn({
      branchId: 'branch_a',
      supplierId: 'supplier_a',
      kind: 'PURCHASE_RETURN',
      reference: 'RET-1',
      lines: [
        {
          inventoryLotId: 'lot_a',
          stockLocationId: 'loc_a',
          quantityUnits: 1,
          reason: 'Damaged',
          returnWindowEndsAt: FUTURE,
          expectedCreditMinor: 100,
        },
      ],
    }),
  submitPurchaseReturn: (c: Caller) =>
    c.submitPurchaseReturn({ branchId: 'branch_a', purchaseReturnId: 'ret_a' }),
  dispatchPurchaseReturn: (c: Caller) =>
    c.dispatchPurchaseReturn({
      branchId: 'branch_a',
      purchaseReturnId: 'ret_a',
      idempotencyKey: 'dispatch-1',
    }),
  issueDebitNote: (c: Caller) =>
    c.issueDebitNote({ branchId: 'branch_a', purchaseReturnId: 'ret_a', reference: 'DN-1' }),
  recordSupplierCredit: (c: Caller) =>
    c.recordSupplierCredit({
      branchId: 'branch_a',
      supplierId: 'supplier_a',
      reference: 'CR-1',
      amountMinor: 100,
      receivedAt: PAST,
    }),
  allocateSupplierCredit: (c: Caller) =>
    c.allocateSupplierCredit({
      branchId: 'branch_a',
      supplierCreditId: 'credit_a',
      debitNoteId: 'dn_a',
      amountMinor: 100,
    }),
  debitNotePositions: (c: Caller) => c.debitNotePositions({ branchId: 'branch_a' }),
  workspace: (c: Caller) => c.workspace(),
  suppliers: (c: Caller) => c.suppliers(),
  requisitions: (c: Caller) => c.requisitions(),
  purchaseOrders: (c: Caller) => c.purchaseOrders(),
  receivedAgainstOrder: (c: Caller) => c.receivedAgainstOrder({ purchaseOrderId: 'po_a' }),
  officialPriceAlerts: (c: Caller) => c.officialPriceAlerts({ medicineIds: ['med_a'] }),
  goodsReceipts: (c: Caller) => c.goodsReceipts({ branchId: 'branch_a' }),
  receivingExceptionQueue: (c: Caller) => c.receivingExceptionQueue({ branchId: 'branch_a' }),
  lotsFromReceipt: (c: Caller) =>
    c.lotsFromReceipt({ branchId: 'branch_a', goodsReceiptId: 'gr_a' }),
  purchaseReturns: (c: Caller) => c.purchaseReturns({ branchId: 'branch_a' }),
  returnableLots: (c: Caller) => c.returnableLots({ branchId: 'branch_a' }),
  resolveScan: (c: Caller) => c.resolveScan({ term: 'paracetamol' }),
  authenticatePack: (c: Caller) => c.authenticatePack({ branchId: 'branch_a', payload: '0100' }),
  supplierCredits: (c: Caller) => c.supplierCredits({ branchId: 'branch_a' }),
  centralDemand: (c: Caller) => c.centralDemand({}),
  reorderDrafts: (c: Caller) => c.reorderDrafts({ branchId: 'branch_a' }),
  createCentralPurchaseOrder: (c: Caller) =>
    c.createCentralPurchaseOrder({
      reference: 'CPO-1',
      supplierId: 'supplier_a',
      receivingBranchId: 'branch_a',
      lines: [
        {
          medicineId: 'medicine_a',
          packLevelId: 'pack_a',
          orderedPacks: 1,
          canonicalUnitsPerPack: 10,
          listPricePerPackMinor: 100,
        },
      ],
    }),
  allocateCentralReceipt: (c: Caller) =>
    c.allocateCentralReceipt({
      goodsReceiptId: 'gr_a',
      allocations: [
        {
          goodsReceiptLineId: 'grline_a',
          destinationBranchId: 'branch_a',
          destinationStockLocationId: 'loc_a',
          quantityUnits: 1,
        },
      ],
    }),
} satisfies Record<string, (c: Caller) => Promise<unknown>>;

type ProcedureName = keyof typeof CALLS;

const PROCUREMENT = ['pharmacy:procurement'];
const APPROVAL = ['pharmacy:procurement-approve'];
const PROCUREMENT_AND_APPROVAL = ['pharmacy:procurement', 'pharmacy:procurement-approve'];
const PROCUREMENT_AND_FINANCE = ['pharmacy:procurement', 'reports:financial'];
const FINANCIAL = ['reports:financial'];

/** The permission every procedure must declare. A new procedure needs a row here. */
const EXPECTED_CAPABILITIES: Record<ProcedureName, string[]> = {
  provisionMyPurchasePin: PROCUREMENT_AND_APPROVAL,
  createSupplier: PROCUREMENT,
  recordSupplierLicence: PROCUREMENT,
  verifySupplierLicence: PROCUREMENT,
  setSupplierAuthorization: PROCUREMENT_AND_APPROVAL,
  createRequisition: PROCUREMENT,
  submitRequisition: PROCUREMENT,
  recordQuote: PROCUREMENT,
  compareQuotes: PROCUREMENT,
  createPurchaseOrder: PROCUREMENT,
  submitPurchaseOrder: PROCUREMENT,
  approvePurchaseOrder: APPROVAL,
  sendPurchaseOrder: APPROVAL,
  landedCost: PROCUREMENT,
  createGoodsReceipt: PROCUREMENT,
  postGoodsReceipt: PROCUREMENT,
  controlledWitnesses: PROCUREMENT,
  controlledReversalWitnesses: PROCUREMENT,
  reverseGoodsReceipt: PROCUREMENT,
  receivingExceptions: PROCUREMENT,
  resolveReceivingException: PROCUREMENT,
  createPurchaseReturn: PROCUREMENT_AND_FINANCE,
  submitPurchaseReturn: PROCUREMENT_AND_FINANCE,
  dispatchPurchaseReturn: PROCUREMENT_AND_FINANCE,
  issueDebitNote: PROCUREMENT_AND_FINANCE,
  recordSupplierCredit: PROCUREMENT_AND_FINANCE,
  allocateSupplierCredit: PROCUREMENT_AND_FINANCE,
  debitNotePositions: PROCUREMENT,
  workspace: PROCUREMENT,
  suppliers: PROCUREMENT,
  requisitions: PROCUREMENT,
  purchaseOrders: PROCUREMENT,
  receivedAgainstOrder: PROCUREMENT,
  officialPriceAlerts: PROCUREMENT,
  goodsReceipts: PROCUREMENT,
  receivingExceptionQueue: PROCUREMENT,
  lotsFromReceipt: PROCUREMENT,
  purchaseReturns: FINANCIAL,
  returnableLots: PROCUREMENT,
  resolveScan: PROCUREMENT,
  authenticatePack: PROCUREMENT,
  supplierCredits: FINANCIAL,
  centralDemand: PROCUREMENT,
  reorderDrafts: PROCUREMENT,
  createCentralPurchaseOrder: PROCUREMENT,
  allocateCentralReceipt: PROCUREMENT,
};

const PROCEDURES = Object.keys(CALLS) as ProcedureName[];
const BRANCH_SCOPED: ProcedureName[] = [
  'createRequisition',
  'createPurchaseOrder',
  'createGoodsReceipt',
  'postGoodsReceipt',
  'controlledWitnesses',
  'controlledReversalWitnesses',
  'reverseGoodsReceipt',
  'receivingExceptions',
  'resolveReceivingException',
  'createPurchaseReturn',
  'submitPurchaseReturn',
  'dispatchPurchaseReturn',
  'issueDebitNote',
  'recordSupplierCredit',
  'allocateSupplierCredit',
  'debitNotePositions',
  'goodsReceipts',
  'receivingExceptionQueue',
  'lotsFromReceipt',
  'purchaseReturns',
  'returnableLots',
  'authenticatePack',
  'supplierCredits',
  'reorderDrafts',
];
const ORDER_SCOPED: ProcedureName[] = [
  'submitPurchaseOrder',
  'approvePurchaseOrder',
  'sendPurchaseOrder',
  'landedCost',
  'receivedAgainstOrder',
];

/** A refusal by permission, branch scope or segregation of duties. */
function isAuthorizationRefusal(outcome: unknown): boolean {
  if (!(outcome instanceof TRPCError)) return false;
  if (outcome.code === 'UNAUTHORIZED') return true;
  return (
    outcome.code === 'FORBIDDEN' &&
    [
      PERMISSION,
      OUTSIDE_BRANCH,
      'SELF_APPROVAL',
      'SELF_VERIFICATION',
      'Financial report access required.',
      'Pharmacy procurement access required.',
    ].includes(outcome.message)
  );
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok' as const,
    (error: unknown) => error
  );

// ── deny by default ───────────────────────────────────────────────────────

describe('deny by default (#979, PR J)', () => {
  it('declares an explicit permission on every procedure, exactly as intended', () => {
    const procedures = (
      pharmacyPurchasingRouter as unknown as {
        _def: { procedures: Record<string, { _def: { meta?: ProcedureMeta } }> };
      }
    )._def.procedures;
    expect(Object.keys(procedures).sort()).toEqual([...PROCEDURES].sort());
    for (const [name, procedure] of Object.entries(procedures)) {
      expect(procedure._def.meta?.capabilities, name).toEqual(
        EXPECTED_CAPABILITIES[name as ProcedureName]
      );
    }
  });

  it('refuses a procedure that carries no permission annotation, even to the owner', async () => {
    const reached = vi.fn();
    const unannotated = router({
      read: denyByDefaultProcedure.query(() => reached()),
      write: denyByDefaultProcedure.mutation(() => reached()),
      empty: denyByDefaultProcedure.meta({ capabilities: [] }).query(() => reached()),
    }).createCaller(ownerContext());
    await expect(unannotated.read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(unannotated.write()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(unannotated.empty()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reached).not.toHaveBeenCalled();
  });
});

function ownerContext() {
  return {
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'owner', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

// ── every role without procurement ────────────────────────────────────────

/**
 * Every member who does no procurement work: the stock Cashier and Pharmacist
 * templates, a member on the default EMPLOYEE role with no organization role,
 * an empty Member role, and the Inventory, Auditor and Finance templates. None
 * of them holds `pharmacy:procurement`.
 */
const NON_PROCUREMENT = [
  'cashier_a',
  'pharmacist',
  'employee',
  'member',
  'inventory_clerk',
  'auditor',
  'finance',
] as const;

/**
 * The supplier-credit follow-up reads are the Finance role's report source and
 * need only `reports:financial`, so a role holding that permission reaches
 * them by design; the branch boundary still applies.
 */
const FINANCIAL_FOLLOW_UP_READS: ProcedureName[] = ['purchaseReturns', 'supplierCredits'];
const holdsFinancial = (who: string) => PEOPLE[who]!.grants?.includes('reports:financial') === true;

const NON_PROCUREMENT_MATRIX = NON_PROCUREMENT.flatMap((who) =>
  PROCEDURES.filter(
    (name) => !(holdsFinancial(who) && FINANCIAL_FOLLOW_UP_READS.includes(name))
  ).map((name) => [who, name] as const)
);

describe('every role without procurement is refused on every purchasing procedure', () => {
  it('covers the cashier, the pharmacist and the default employee', () => {
    for (const who of ['cashier_a', 'pharmacist', 'employee'])
      expect(NON_PROCUREMENT_MATRIX.filter(([person]) => person === who)).toHaveLength(
        PROCEDURES.length
      );
  });

  it.each(NON_PROCUREMENT_MATRIX)(
    '%s: %s → FORBIDDEN before any business read or write',
    async (who, name) => {
      await expect(CALLS[name](caller(who))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: PERMISSION,
      });
      expect(touchedBusinessTables()).toEqual([]);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(NON_PROCUREMENT.filter(holdsFinancial))(
    '%s reads the supplier-credit follow-up only at an assigned branch',
    async (who) => {
      for (const name of FINANCIAL_FOLLOW_UP_READS) {
        await expect(CALLS[name](caller(who))).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: OUTSIDE_BRANCH,
        });
      }
      expect(m('pharmacyPurchaseReturn').findMany).not.toHaveBeenCalled();
      expect(m('pharmacySupplierCredit').findMany).not.toHaveBeenCalled();
    }
  );
});

// ── the solo owner ────────────────────────────────────────────────────────

describe('the solo owner can do all of their purchasing', () => {
  beforeEach(() => {
    activeMembers('owner');
    // The owner holds no branch assignment: tenant administration reaches every branch.
    assignments({});
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) =>
        where.id
          ? {
              id: 'lic_a',
              supplierId: 'supplier_a',
              licenceType: 'DSL',
              licenceNumber: 'DSL-1',
              issuingAuthority: 'DRAP',
              issuedAt: PAST,
              expiresAt: FUTURE,
              evidenceUri: null,
              verifiedAt: null,
              recordedByUserId: 'owner',
            }
          : null
    );
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'owner' }));
    m('pharmacyCentralPurchasingAccess').findMany.mockResolvedValue([{ branchId: null }]);
  });

  it.each(PROCEDURES)('%s passes permission and branch checks', async (name) => {
    const outcome = await settle(CALLS[name](caller('owner')));
    expect(isAuthorizationRefusal(outcome), String(outcome)).toBe(false);
  });

  it('creates a supplier and authorizes it', async () => {
    await expect(CALLS.createSupplier(caller('owner'))).resolves.toMatchObject({
      name: 'Karachi Distributors',
    });
    await expect(CALLS.setSupplierAuthorization(caller('owner'))).resolves.toMatchObject({
      authorized: true,
    });
  });

  it('files a licence already verified, since nobody else can verify it', async () => {
    const filed = await caller('owner').recordSupplierLicence({
      supplierId: 'supplier_a',
      licenceType: 'DSL',
      licenceNumber: 'DSL-1',
      issuingAuthority: 'DRAP',
      issuedAt: PAST,
      expiresAt: FUTURE,
      verified: true,
    });
    expect(filed).toMatchObject({ recordedByUserId: 'owner', verifiedByUserId: 'owner' });
  });

  it('verifies a licence they filed earlier', async () => {
    await expect(CALLS.verifySupplierLicence(caller('owner'))).resolves.toMatchObject({
      supersedesId: 'lic_a',
      verifiedByUserId: 'owner',
    });
  });

  it('raises a requisition and an order at a branch they hold no assignment for', async () => {
    await expect(CALLS.createRequisition(caller('owner'))).resolves.toMatchObject({
      requestedByUserId: 'owner',
    });
    await expect(CALLS.createPurchaseOrder(caller('owner'))).resolves.toMatchObject({
      createdByUserId: 'owner',
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'PharmacyBranch',
        metadata: expect.objectContaining({
          reason: 'owner-procurement-access-without-branch-assignment',
        }),
      })
    );
  });

  it('approves their own order with a PIN and writes the solo-owner audit proof', async () => {
    await expect(CALLS.approvePurchaseOrder(caller('owner'))).resolves.toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'owner',
    });
    expect(m('pharmacyPurchaseOrderApproval').create.mock.calls[0]![0].data).toMatchObject({
      actorUserId: 'owner',
      policy: SOLO_OWNER_APPROVAL_POLICY,
    });
    expect(m('auditLog').create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'owner',
        action: 'pharmacy.purchaseOrderApproval',
        targetType: 'PharmacyPurchaseOrder',
        targetId: 'po_a',
        metadata: {
          policy: SOLO_OWNER_APPROVAL_POLICY,
          pinVerified: true,
          decision: 'APPROVED',
        },
      }),
    });
    const verifiedPin = db.$queryRaw.mock.calls.find(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('app.pharmacy_purchase_pin_verified_user_id')
    );
    expect(verifiedPin?.slice(1)).toEqual(['owner']);
  });

  it.each([undefined, '9999'])(
    'refuses self-approval without the correct PIN (%s)',
    async (pin) => {
      await expect(
        caller('owner').approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED', pin })
      ).resolves.toHaveProperty('blocked');
      expect(m('pharmacyPurchaseOrder').update).not.toHaveBeenCalled();
      expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
      expect(m('auditLog').create).not.toHaveBeenCalled();
      expect(
        db.$queryRaw.mock.calls.some(([sql]) =>
          (sql as TemplateStringsArray)
            .join('?')
            .includes('app.pharmacy_purchase_pin_verified_user_id')
        )
      ).toBe(false);
    }
  );

  it('sends their approved order', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({ status: 'APPROVED', createdByUserId: 'owner' })
    );
    await expect(CALLS.sendPurchaseOrder(caller('owner'))).resolves.toMatchObject({
      status: 'SENT',
    });
  });

  it('reads the purchasing lists and the credit-outstanding source', async () => {
    await expect(CALLS.suppliers(caller('owner'))).resolves.toEqual([]);
    await expect(CALLS.requisitions(caller('owner'))).resolves.toEqual([]);
    await expect(CALLS.purchaseOrders(caller('owner'))).resolves.toEqual([]);
    await expect(CALLS.purchaseReturns(caller('owner'))).resolves.toEqual([]);
  });

  it('loses the solo exception once a second member is active', async () => {
    activeMembers('owner', 'cashier_a');
    await expect(CALLS.approvePurchaseOrder(caller('owner'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SELF_APPROVAL',
    });
    await expect(
      caller('owner').recordSupplierLicence({
        supplierId: 'supplier_a',
        licenceType: 'DSL',
        licenceNumber: 'DSL-1',
        issuingAuthority: 'DRAP',
        issuedAt: PAST,
        expiresAt: FUTURE,
        verified: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_VERIFICATION' });
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
    expect(m('pharmacySupplierLicence').create).not.toHaveBeenCalled();
  });

  it('does not turn a legacy ADMIN with no live owner grant into a solo owner', async () => {
    activeMembers('legacy_owner');
    assignments({ legacy_owner: ['branch_a'] });
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({ createdByUserId: 'legacy_owner' })
    );
    await expect(CALLS.createSupplier(caller('legacy_owner'))).resolves.toBeDefined();
    await expect(CALLS.approvePurchaseOrder(caller('legacy_owner'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SELF_APPROVAL',
    });
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
    expect(m('auditLog').create).not.toHaveBeenCalled();
  });
});

// ── quotes and receiving exceptions (no menu link, reached through the API) ─

const API_ONLY: ProcedureName[] = [
  'recordQuote',
  'compareQuotes',
  'resolveReceivingException',
  'receivingExceptions',
  'receivingExceptionQueue',
];

describe('quotes and receiving exceptions are checked on the server, not by the menu (#979)', () => {
  beforeEach(() => {
    m('pharmacyRequisition').findFirst.mockResolvedValue({
      id: 'req_a',
      branchId: 'branch_a',
      lines: [{ id: 'reqline_a' }],
    });
    m('pharmacyRequisitionLine').findFirst.mockResolvedValue({
      id: 'reqline_a',
      quantityPacks: 1,
      requisition: { branchId: 'branch_a' },
    });
    m('pharmacyReceivingException').findFirst.mockResolvedValue({
      id: 'exc_a',
      organizationId: 'org_a',
      branchId: 'branch_a',
      status: 'OPEN',
    });
  });

  it.each(API_ONLY)(
    '%s → FORBIDDEN for the cashier, with nothing read or written',
    async (name) => {
      for (const cashier of ['cashier_a', 'cashier_b']) {
        await expect(CALLS[name](caller(cashier))).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: PERMISSION,
        });
      }
      expect(touchedBusinessTables()).toEqual([]);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  describe('the solo owner', () => {
    beforeEach(() => {
      activeMembers('owner');
      assignments({});
    });

    it('records a quote against their requisition', async () => {
      await expect(CALLS.recordQuote(caller('owner'))).resolves.toMatchObject({
        requisitionId: 'req_a',
        supplierId: 'supplier_a',
      });
      expect(m('pharmacyQuote').create).toHaveBeenCalledTimes(1);
    });

    it('compares the quotes for a requisition line', async () => {
      await expect(CALLS.compareQuotes(caller('owner'))).resolves.toMatchObject({
        requisitionLineId: 'reqline_a',
        requiredPacks: 1,
        ranking: expect.any(Array),
      });
    });

    it('lists receiving exceptions and the exception queue', async () => {
      await expect(CALLS.receivingExceptions(caller('owner'))).resolves.toEqual([]);
      await expect(CALLS.receivingExceptionQueue(caller('owner'))).resolves.toEqual([]);
    });

    it('resolves a receiving exception in their own name', async () => {
      await expect(CALLS.resolveReceivingException(caller('owner'))).resolves.toMatchObject({
        status: 'RESOLVED',
        resolvedByUserId: 'owner',
        resolutionNote: 'Checked',
      });
    });
  });

  it.each(API_ONLY)('%s is allowed for a procurement member at their branch', async (name) => {
    const outcome = await settle(CALLS[name](caller('buyer')));
    expect(isAuthorizationRefusal(outcome), String(outcome)).toBe(false);
  });
});

// ── approval ──────────────────────────────────────────────────────────────

describe('approving and sending a purchase order needs the approver capability', () => {
  it.each([
    ['cashier_b', 'cashier_a'],
    ['cashier_a', 'cashier_b'],
  ])('%s cannot approve the order %s raised', async (approver, creator) => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: creator }));
    await expect(CALLS.approvePurchaseOrder(caller(approver))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: PERMISSION,
    });
    await expect(CALLS.sendPurchaseOrder(caller(approver))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: PERMISSION,
    });
    expect(m('pharmacyPurchaseOrder').findFirst).not.toHaveBeenCalled();
    expect(m('pharmacyPurchaseOrder').update).not.toHaveBeenCalled();
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
  });

  it('refuses the procurement role, which raises orders but does not approve them', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'manager_a' }));
    await expect(CALLS.approvePurchaseOrder(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: PERMISSION,
    });
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
  });

  it('lets an Owner / Operator approve and send an order somebody else raised (#975 template)', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'buyer' }));
    await expect(CALLS.approvePurchaseOrder(caller('owner_operator'))).resolves.toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'owner_operator',
    });
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({ createdByUserId: 'buyer', status: 'APPROVED' })
    );
    await expect(CALLS.sendPurchaseOrder(caller('owner_operator'))).resolves.toMatchObject({
      status: 'SENT',
    });
  });

  it('lets a manager approve an order somebody else raised', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'buyer' }));
    await expect(CALLS.approvePurchaseOrder(caller('manager_a'))).resolves.toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'manager_a',
    });
    expect(m('pharmacyPurchaseOrderApproval').create.mock.calls[0]![0].data).toMatchObject({
      policy: 'PUR-02:SEGREGATION_OF_DUTIES',
    });
  });

  it('still refuses a manager approving their own order', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'manager_a' }));
    await expect(CALLS.approvePurchaseOrder(caller('manager_a'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SELF_APPROVAL',
    });
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
  });

  it('refuses an approver who is not assigned to the order branch (#683 rule)', async () => {
    assignments({ manager_a: ['branch_b'] });
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'buyer' }));
    await expect(CALLS.approvePurchaseOrder(caller('manager_a'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(m('pharmacyPurchaseOrder').update).not.toHaveBeenCalled();
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
  });

  it("checks the branch of the order's requisition too", async () => {
    assignments({ manager_a: ['branch_a'] });
    m('pharmacyBranch').findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id })
    );
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({
        createdByUserId: 'buyer',
        requisition: { requestedByUserId: 'buyer', branchId: 'branch_b' },
      })
    );
    await expect(CALLS.approvePurchaseOrder(caller('manager_a'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
  });
});

// ── supplier authorization ────────────────────────────────────────────────

describe('authorizing a supplier needs the approver capability too (PUR-01)', () => {
  it.each([true, false])(
    'refuses the procurement role, which files suppliers but does not authorize them (authorized: %s)',
    async (authorized) => {
      await expect(
        caller('buyer').setSupplierAuthorization({ supplierId: 'supplier_a', authorized })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: PERMISSION });
      expect(m('pharmacySupplier').findFirst).not.toHaveBeenCalled();
      expect(m('pharmacySupplier').update).not.toHaveBeenCalled();
    }
  );

  it('lets a manager authorize and withdraw a supplier', async () => {
    await expect(CALLS.setSupplierAuthorization(caller('manager_a'))).resolves.toMatchObject({
      authorized: true,
    });
    await expect(
      caller('manager_a').setSupplierAuthorization({ supplierId: 'supplier_a', authorized: false })
    ).resolves.toMatchObject({ authorized: false });
  });

  it('lets an Owner / Operator authorize a supplier (#975 template)', async () => {
    await expect(CALLS.setSupplierAuthorization(caller('owner_operator'))).resolves.toMatchObject({
      authorized: true,
    });
  });

  it('keeps it for the provisioned owner and the legacy owner under the solo rule', async () => {
    activeMembers('owner');
    await expect(CALLS.setSupplierAuthorization(caller('owner'))).resolves.toMatchObject({
      authorized: true,
    });
    activeMembers('legacy_owner');
    await expect(CALLS.setSupplierAuthorization(caller('legacy_owner'))).resolves.toMatchObject({
      authorized: true,
    });
  });

  it('still refuses a supplier of another workspace to an approver', async () => {
    m('pharmacySupplier').findFirst.mockResolvedValue(null);
    await expect(CALLS.setSupplierAuthorization(caller('manager_a'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Supplier is outside this workspace.',
    });
    expect(m('pharmacySupplier').update).not.toHaveBeenCalled();
  });
});

// ── the branches a board may offer ────────────────────────────────────────

describe('workspace names the branches the caller may act at (PUR-06 board)', () => {
  beforeEach(() => {
    m('pharmacyBranch').findMany.mockResolvedValue([
      { id: 'branch_a', code: 'A', name: 'A', city: 'Karachi', defaultStockLocationId: null },
      { id: 'branch_b', code: 'B', name: 'B', city: 'Lahore', defaultStockLocationId: null },
    ]);
    m('pharmacyBranchAssignment').findMany.mockImplementation(
      async ({ where }: { where: { userId: string; branchId: { in: string[] } } }) =>
        where.userId === 'buyer'
          ? where.branchId.in.filter((id) => id === 'branch_a').map((branchId) => ({ branchId }))
          : []
    );
  });

  it('lists only the assigned branches for a procurement member', async () => {
    await expect(CALLS.workspace(caller('buyer'))).resolves.toMatchObject({
      reachableBranchIds: ['branch_a'],
    });
    expect(m('pharmacyBranchAssignment').findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_a', userId: 'buyer', active: true }),
      })
    );
  });

  it('lists none for a procurement member with no assignment', async () => {
    m('pharmacyBranchAssignment').findMany.mockResolvedValue([]);
    await expect(CALLS.workspace(caller('buyer'))).resolves.toMatchObject({
      reachableBranchIds: [],
    });
  });

  it('lists every active branch for a tenant administrator', async () => {
    await expect(CALLS.workspace(caller('owner'))).resolves.toMatchObject({
      reachableBranchIds: ['branch_a', 'branch_b'],
    });
    // The administrator's own reach never comes from assignments. The approver
    // picker (#246) still reads other members' assignments.
    expect(m('pharmacyBranchAssignment').findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'owner' }) })
    );
  });
});

// ── branch boundary ───────────────────────────────────────────────────────

describe('a procurement member acts only at branches they are assigned to', () => {
  beforeEach(() => {
    assignments({ buyer: ['branch_b'], manager_a: ['branch_b'] });
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(order({ createdByUserId: 'buyer' }));
  });

  it.each(BRANCH_SCOPED)('%s refuses an unassigned branch', async (name) => {
    // Give the buyer the financial and clinical permissions so each call reaches
    // the branch boundary, including controlled reversal witness enumeration.
    PEOPLE.buyer = {
      role: 'EMPLOYEE',
      grants: [
        ...template('procurement'),
        'reports:financial',
        'pharmacy:dispense',
        'pharmacy:safety',
      ],
    };
    try {
      await expect(CALLS[name](caller('buyer'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: OUTSIDE_BRANCH,
      });
    } finally {
      PEOPLE.buyer = { role: 'EMPLOYEE', grants: template('procurement') };
    }
  });

  it.each(ORDER_SCOPED)('%s refuses an order at an unassigned branch', async (name) => {
    const approving = name === 'approvePurchaseOrder' || name === 'sendPurchaseOrder';
    const who = approving ? 'manager_a' : 'buyer';
    await expect(CALLS[name](caller(who))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(m('pharmacyPurchaseOrder').update).not.toHaveBeenCalled();
  });

  it('refuses a branch of another organization or an inactive branch', async () => {
    assignments({ buyer: ['branch_a'] });
    m('pharmacyBranch').findFirst.mockResolvedValue(null);
    await expect(CALLS.goodsReceipts(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
  });

  it('allows the same call once the member is assigned', async () => {
    assignments({ buyer: ['branch_a'] });
    await expect(CALLS.goodsReceipts(caller('buyer'))).resolves.toEqual([]);
    expect(m('pharmacyBranchAssignment').findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', branchId: 'branch_a', userId: 'buyer', active: true },
      select: { id: true },
    });
  });
});

describe("Goods-in against an organization-wide order checks its requisition's branch (#979)", () => {
  beforeEach(() => {
    m('pharmacyBranch').findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id })
    );
    assignments({ buyer: ['branch_a'] });
  });

  const receiveAgainstOrder = (c: Caller) =>
    c.createGoodsReceipt({
      reference: 'GR-1',
      branchId: 'branch_a',
      supplierId: 'supplier_a',
      purchaseOrderId: 'po_a',
      supplierInvoiceRef: 'INV-1',
      supplierInvoiceDate: PAST,
      warrantyEvidenceRef: 'WAR-1',
      receivedAt: new Date(),
      lines: [RECEIPT_LINE],
    });

  it('refuses to draft a receipt when the requisition belongs to an unassigned branch', async () => {
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({ status: 'SENT', branchId: null, requisitionId: 'req_b' })
    );
    m('pharmacyRequisition').findFirst.mockResolvedValue({ branchId: 'branch_b' });
    await expect(receiveAgainstOrder(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(m('pharmacyGoodsReceipt').create).not.toHaveBeenCalled();
  });

  it('does not refuse by branch once the receiver is assigned to the requisition branch', async () => {
    assignments({ buyer: ['branch_a', 'branch_b'] });
    m('pharmacyPurchaseOrder').findFirst.mockResolvedValue(
      order({ status: 'SENT', branchId: null, requisitionId: 'req_b' })
    );
    m('pharmacyRequisition').findFirst.mockResolvedValue({ branchId: 'branch_b' });
    const outcome = await settle(receiveAgainstOrder(caller('buyer')));
    expect(outcome instanceof TRPCError && outcome.message === OUTSIDE_BRANCH).toBe(false);
  });

  it('refuses to post such a receipt before any receipt transaction', async () => {
    m('pharmacyGoodsReceipt').findFirst.mockResolvedValue({
      id: 'gr_a',
      directPurchase: false,
      status: 'DRAFT',
      purchaseOrder: { branchId: null, requisition: { branchId: 'branch_b' } },
    });
    await expect(CALLS.postGoodsReceipt(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    // One receipt read, scoped to the tenant and the posting branch; the order
    // and requisition branches come with it rather than from a second lookup.
    expect(m('pharmacyGoodsReceipt').findFirst).toHaveBeenCalledTimes(1);
    expect(m('pharmacyGoodsReceipt').findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gr_a', organizationId: 'org_a', branchId: 'branch_a' },
      })
    );
    expect(m('pharmacyPurchaseOrder').findFirst).not.toHaveBeenCalled();
  });

  it('does not refuse posting by branch once the receiver is assigned to the requisition branch', async () => {
    assignments({ buyer: ['branch_a', 'branch_b'] });
    m('pharmacyGoodsReceipt').findFirst.mockResolvedValueOnce({
      id: 'gr_a',
      directPurchase: false,
      status: 'DRAFT',
      purchaseOrder: { branchId: null, requisition: { branchId: 'branch_b' } },
    });
    const outcome = await settle(CALLS.postGoodsReceipt(caller('buyer')));
    expect(outcome instanceof TRPCError && outcome.message === OUTSIDE_BRANCH).toBe(false);
    expect(db.$transaction).toHaveBeenCalled();
  });
});

// ── licence verification ──────────────────────────────────────────────────

describe('a supplier licence is verified by a second person (PUR-01)', () => {
  const filed = (recordedByUserId: string | null) => ({
    id: 'lic_a',
    supplierId: 'supplier_a',
    licenceType: 'DSL',
    licenceNumber: 'DSL-1',
    issuingAuthority: 'DRAP',
    issuedAt: PAST,
    expiresAt: FUTURE,
    evidenceUri: 's3://licences/dsl-1.pdf',
    verifiedAt: null,
    recordedByUserId,
  });

  it('refuses to file a licence already verified', async () => {
    await expect(
      caller('buyer').recordSupplierLicence({
        supplierId: 'supplier_a',
        licenceType: 'DSL',
        licenceNumber: 'DSL-1',
        issuingAuthority: 'DRAP',
        issuedAt: PAST,
        expiresAt: FUTURE,
        verified: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_VERIFICATION' });
    expect(m('pharmacySupplierLicence').create).not.toHaveBeenCalled();
  });

  it('records who filed an unverified licence', async () => {
    await expect(CALLS.recordSupplierLicence(caller('buyer'))).resolves.toMatchObject({
      recordedByUserId: 'buyer',
      verifiedAt: null,
      verifiedByUserId: null,
    });
  });

  it('refuses to let the filer verify their own filing', async () => {
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id ? filed('buyer') : null)
    );
    await expect(CALLS.verifySupplierLicence(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SELF_VERIFICATION',
    });
    expect(m('pharmacySupplierLicence').create).not.toHaveBeenCalled();
  });

  it('refuses a filing whose filer was never recorded', async () => {
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id ? filed(null) : null)
    );
    await expect(CALLS.verifySupplierLicence(caller('manager_a'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SELF_VERIFICATION',
    });
  });

  it('lets a colleague verify it, copying the stored filing rather than the payload', async () => {
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id ? filed('buyer') : null)
    );
    await expect(CALLS.verifySupplierLicence(caller('manager_a'))).resolves.toMatchObject({
      supplierId: 'supplier_a',
      licenceNumber: 'DSL-1',
      evidenceUri: 's3://licences/dsl-1.pdf',
      supersedesId: 'lic_a',
      recordedByUserId: 'manager_a',
      verifiedByUserId: 'manager_a',
    });
  });

  it('locks the filing in one transaction before checking it is not yet superseded', async () => {
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) => (where.id ? filed('buyer') : null)
    );
    await CALLS.verifySupplierLicence(caller('manager_a'));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const lockSql = (db.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(lockSql).toContain('pharmacy_supplier_licences');
    expect(lockSql).toContain('FOR UPDATE');
    expect(db.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['lic_a', 'org_a']);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m('pharmacySupplierLicence').findFirst.mock.invocationCallOrder[0]!
    );
  });

  it('refuses a filing that is already verified or already superseded', async () => {
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) =>
        where.id ? { ...filed('buyer'), verifiedAt: PAST } : null
    );
    await expect(CALLS.verifySupplierLicence(caller('manager_a'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    m('pharmacySupplierLicence').findFirst.mockImplementation(
      async ({ where }: { where: { id?: string } }) =>
        where.id ? filed('buyer') : { id: 'lic_newer' }
    );
    await expect(CALLS.verifySupplierLicence(caller('manager_a'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(m('pharmacySupplierLicence').create).not.toHaveBeenCalled();
  });
});

// ── DEV-678 reorder drafts ───────────────────────────────────────────────

describe('reorder drafts are a read, scoped to the caller’s branch (DEV-678)', () => {
  it('plans one draft per distributor from branch-scoped SQL and writes nothing', async () => {
    assignments({ buyer: ['branch_a'] });
    db.$queryRaw.mockImplementation(async (query: unknown) =>
      (query as { sql?: string }).sql?.includes('pharmacy_sale_lines')
        ? [
            {
              medicineId: 'medicine_a',
              medicineName: 'Alpha',
              soldUnits: BigInt(280),
              onHandUnits: BigInt(50),
              inboundUnits: BigInt(0),
              supplierId: 'supplier_a',
              supplierName: 'Karachi Distributors',
              supplierActive: true,
              packLevelId: 'pack_a',
              canonicalUnitsPerPack: 20,
              listPricePerPackMinor: 15_000,
              discountBps: 0,
              taxBps: 0,
              taxCreditable: false,
              lineLeadTimeDays: 7,
              observedLeadTimeDays: null,
            },
          ]
        : []
    );
    const plan = await caller('buyer').reorderDrafts({ branchId: 'branch_a' });
    expect(plan).toMatchObject({
      branchId: 'branch_a',
      policy: { windowDays: 28, coverDays: 14 },
      drafts: [
        {
          supplierId: 'supplier_a',
          lines: [{ medicineId: 'medicine_a', suggestedPacks: 8 }],
        },
      ],
      unassigned: [],
    });
    const factsQuery = db.$queryRaw.mock.calls
      .map(([query]) => query as { sql?: string; values?: unknown[] })
      .find((query) => query.sql?.includes('pharmacy_sale_lines'));
    expect(factsQuery?.values).toEqual(expect.arrayContaining(['org_a', 'branch_a']));
    for (const [, delegate] of models) {
      expect(delegate.create).not.toHaveBeenCalled();
      expect(delegate.update).not.toHaveBeenCalled();
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a history or cover outside 1..90 / 0..90 days', async () => {
    assignments({ buyer: ['branch_a'] });
    await expect(
      caller('buyer').reorderDrafts({ branchId: 'branch_a', windowDays: 0 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('buyer').reorderDrafts({ branchId: 'branch_a', coverDays: 91 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
