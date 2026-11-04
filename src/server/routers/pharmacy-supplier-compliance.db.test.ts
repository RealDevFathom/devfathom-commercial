/**
 * DEV-753 — the owner switch for supplier compliance checks, against migrated PostgreSQL with
 * FORCE row level security, as the NOSUPERUSER/NOBYPASSRLS runtime role.
 *
 * Real routers (`pharmacySupplierCompliance`, `pharmacyPurchasing`), persisted organization
 * roles, users and permission overrides. Nothing in `@/lib/abac` is mocked anywhere in this
 * file: who may read or change the policy is decided from those rows, which is the property
 * under test, and none of the purchasing procedures exercised here calls `can`. Only the tRPC
 * audit-log writer is stubbed (an audit side effect, never a decision).
 *
 * Every call runs in its own `withTenantDb` transaction carrying the actor, the way the tRPC
 * route runs a request, so a refused request rolls back everything it wrote. An expected
 * database error aborts its transaction, so every read-back happens in a new one.
 *
 * The schema owner (OWNER_DATABASE_URL) is used once, to plant a LEGACY cross-supplier
 * supersession that today's insert trigger refuses: the trigger is disabled and re-enabled
 * inside that one transaction. Everything else runs as the runtime role.
 *
 * Fixture rows stay in the disposable database: the policy, its audit and the skip evidence
 * leave only with their organization (a sanctioned purge or the organization's own delete,
 * both exercised below), and cleanup never weakens those triggers.
 *
 * Skipped unless TEST_DATABASE_URL and OWNER_DATABASE_URL are set.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** The schema owner, used only to plant a legacy fixture the current triggers no longer allow. */
const ownerUrl = process.env.OWNER_DATABASE_URL ?? process.env.OWNER_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl && ownerUrl ? describe : describe.skip;

// Audit-log side effect only: the request audit row is not under test here.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type PolicyRouter =
  (typeof import('./pharmacy-supplier-compliance'))['pharmacySupplierComplianceRouter'];
type PolicyApi = ReturnType<PolicyRouter['createCaller']>;
type PurchasingRouter = (typeof import('./pharmacy-purchasing'))['pharmacyPurchasingRouter'];
type PurchasingApi = ReturnType<PurchasingRouter['createCaller']>;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let policyRouter: PolicyRouter;
let purchasingRouter: PurchasingRouter;
let seedDepartments: typeof import('@/lib/test-support/departments').seedDepartments;
let disconnect: (() => Promise<void>) | null = null;

const suffix = randomBytes(5).toString('hex');

/** The warning version the server publishes (`policy().warningVersion`), read once in setup. */
let warningVersion = '';
const ack = () => ({ accepted: true, warningVersion });
const OWNER_ONLY = {
  code: 'FORBIDDEN',
  message:
    'Only the pharmacy owner or an administrator with pharmacy settings access can change supplier compliance checks.',
};
const NO_PERMISSION = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
const SUPPLIER_SETTING = 'supplierComplianceChecksEnabled';

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

type Grant = readonly [string, 'ALLOW' | 'DENY'];
type RoleSeed = { key: string; isSystem: boolean; grants: readonly Grant[] };
type UserSeed = {
  id: string;
  name: string;
  role?: string;
  tenantRole?: 'ADMIN' | 'EMPLOYEE';
  status?: 'ACTIVE' | 'INACTIVE';
  /** A live or lapsed DENY override: `expiresAt: null` never expires. */
  deny?: { capability: string; expiresAt: Date | null };
};

/** The pharmacy role templates' grants, as `vertical-catalog.ts` provisions them. */
const ROLES = {
  owner: {
    key: 'owner',
    isSystem: true,
    grants: [
      ['pharmacy:*', 'ALLOW'],
      ['reports:operational', 'ALLOW'],
      ['reports:financial', 'ALLOW'],
    ],
  },
  ownerOperator: {
    key: 'owner-operator',
    isSystem: true,
    grants: [
      'reports:operational',
      'reports:financial',
      'pharmacy:orders',
      'pharmacy:dispense',
      'pharmacy:catalogue-review',
      'pharmacy:safety',
      'pharmacy:procurement',
      'pharmacy:inventory',
      'pharmacy:counter',
      'pharmacy:close',
      'pharmacy:manage',
    ].map((capability) => [capability, 'ALLOW'] as const),
  },
  manager: {
    key: 'manager',
    isSystem: true,
    grants: [
      ['pharmacy:manage', 'ALLOW'],
      ['pharmacy:orders', 'ALLOW'],
      ['pharmacy:procurement', 'ALLOW'],
    ],
  },
  cashier: {
    key: 'cashier',
    isSystem: true,
    grants: [
      ['pharmacy:counter', 'ALLOW'],
      ['pharmacy:orders', 'ALLOW'],
    ],
  },
  procurement: { key: 'procurement', isSystem: true, grants: [['pharmacy:procurement', 'ALLOW']] },
  /** A tenant-made role holding everything. Not the system owner role. */
  superAdmin: { key: 'super-admin', isSystem: false, grants: [['*', 'ALLOW']] },
  /** Everything, except the pharmacy settings capability, which the role itself DENYs. */
  adminNoSettings: {
    key: 'admin-no-settings',
    isSystem: false,
    grants: [
      ['*', 'ALLOW'],
      ['pharmacy:manage', 'DENY'],
    ],
  },
} satisfies Record<string, RoleSeed>;

const DAY = 86_400_000;

/** Org A: the policy router and who may use it. */
const A = {
  org: `org_dev753_a_${suffix}`,
  owner: `u753a_owner_${suffix}`,
  ownerName: `Amna Owner ${suffix}`,
  adminWildcard: `u753a_admin_star_${suffix}`,
  adminNoRole: `u753a_admin_norole_${suffix}`,
  manager: `u753a_manager_${suffix}`,
  cashier: `u753a_cashier_${suffix}`,
  procurement: `u753a_procurement_${suffix}`,
  ownerOperator: `u753a_owner_operator_${suffix}`,
  inactiveOwner: `u753a_inactive_owner_${suffix}`,
  deniedOwner: `u753a_denied_owner_${suffix}`,
  deniedUntilOwner: `u753a_denied_until_owner_${suffix}`,
  procurementDeniedOwner: `u753a_procurement_denied_owner_${suffix}`,
  pharmacyDeniedOwner: `u753a_pharmacy_denied_owner_${suffix}`,
  expiredDenyOwner: `u753a_expired_deny_owner_${suffix}`,
  adminManageDenied: `u753a_admin_manage_denied_${suffix}`,
  adminRoleDenied: `u753a_admin_role_denied_${suffix}`,
  demotedAdmin: `u753a_demoted_admin_${suffix}`,
  inactiveAdmin: `u753a_inactive_admin_${suffix}`,
  supplierAuthorized: `s753a_auth_${suffix}`,
  supplierUnauthorized: `s753a_unauth_${suffix}`,
};
/** Org B: another tenant with its own verified owner. */
const B = {
  org: `org_dev753_b_${suffix}`,
  owner: `u753b_owner_${suffix}`,
  supplier: `s753b_${suffix}`,
};
/** Org C: a tenant whose role keyed `owner` is a custom role, not the system one. */
const C = { org: `org_dev753_c_${suffix}`, fakeOwner: `u753c_fake_owner_${suffix}` };
/** Org D: the database guards, as the runtime role. */
const D = {
  org: `org_dev753_d_${suffix}`,
  owner: `u753d_owner_${suffix}`,
  cashier: `u753d_cashier_${suffix}`,
  inactiveOwner: `u753d_inactive_owner_${suffix}`,
};
/** Org G: deleted outright, to show the evidence goes with its organization. */
const G = { org: `org_dev753_g_${suffix}`, owner: `u753g_owner_${suffix}` };
/** Org F: a verified owner and no policy row yet, for the insert guard. */
const F = { org: `org_dev753_f_${suffix}`, owner: `u753f_owner_${suffix}` };
/** Org H: no owner-role holder at all, as provisioned tenants are; its ADMINs manage the switch. */
const H = {
  org: `org_dev753_h_${suffix}`,
  admin: `u753h_admin_${suffix}`,
  ownerOperatorAdmin: `u753h_owner_operator_admin_${suffix}`,
  adminNoRole: `u753h_admin_norole_${suffix}`,
  manager: `u753h_manager_${suffix}`,
  adminRoleDenied: `u753h_admin_role_denied_${suffix}`,
  adminUserDenied: `u753h_admin_user_denied_${suffix}`,
  inactiveAdmin: `u753h_inactive_admin_${suffix}`,
};
/** Org E: enforcement through the real purchasing router. */
const E = {
  org: `org_dev753_e_${suffix}`,
  branch: `br753e_${suffix}`,
  store: `loc753e_${suffix}`,
  owner: `u753e_owner_${suffix}`,
  buyer: `u753e_buyer_${suffix}`,
  approver: `u753e_approver_${suffix}`,
  cashier: `u753e_cashier_${suffix}`,
  medicine: `med753e_${suffix}`,
  packLevel: `pack753e_${suffix}`,
  controlledMedicine: `medc753e_${suffix}`,
  controlledPackLevel: `packc753e_${suffix}`,
  requisition: `req753e_${suffix}`,
  requisitionLine: `reql753e_${suffix}`,
  superseder: `s753e_superseder_${suffix}`,
};

type StateKey =
  | 'none'
  | 'unverified'
  | 'expired'
  | 'supersededByUnverified'
  | 'crossSuperseded'
  | 'unauthorized'
  | 'valid';
type SupplierState = {
  key: StateKey;
  label: string;
  supplierId: string;
  authorized: boolean;
  licenceStatus: 'VALID' | 'NONE' | 'UNVERIFIED' | 'EXPIRED' | 'SUPERSEDED';
  refusal: 'SUPPLIER_LICENCE_EXPIRED' | 'SUPPLIER_NOT_AUTHORIZED' | null;
  /** Orders raised while the supplier was still valid, before it reached this state. */
  hasOrders: boolean;
};
const supplierOf = (key: StateKey) => `s753e_${key}_${suffix}`;
const licenceOf = (key: string, n = 1) => `l753e_${key}_${n}_${suffix}`;
type OrderPurpose =
  'approve-on' | 'approve-off' | 'send-on' | 'send-off' | 'approve-controlled' | 'send-controlled';
const orderOf = (key: StateKey, purpose: OrderPurpose) => `po753e_${key}_${purpose}_${suffix}`;

const state = (fields: Omit<SupplierState, 'supplierId'>): SupplierState => ({
  ...fields,
  supplierId: supplierOf(fields.key),
});
const STATES: readonly SupplierState[] = [
  state({
    key: 'none',
    label: 'no licence on file',
    authorized: true,
    licenceStatus: 'NONE',
    refusal: 'SUPPLIER_LICENCE_EXPIRED',
    hasOrders: false,
  }),
  state({
    key: 'unverified',
    label: 'only an unverified licence',
    authorized: true,
    licenceStatus: 'UNVERIFIED',
    refusal: 'SUPPLIER_LICENCE_EXPIRED',
    hasOrders: false,
  }),
  state({
    key: 'expired',
    label: 'an expired verified licence',
    authorized: true,
    licenceStatus: 'EXPIRED',
    refusal: 'SUPPLIER_LICENCE_EXPIRED',
    hasOrders: true,
  }),
  state({
    key: 'supersededByUnverified',
    label: 'a verified licence superseded by a later unverified filing',
    authorized: true,
    // The standing filing is the unverified correction.
    licenceStatus: 'UNVERIFIED',
    refusal: 'SUPPLIER_LICENCE_EXPIRED',
    hasOrders: true,
  }),
  state({
    key: 'unauthorized',
    label: 'a valid licence but no trade authorization',
    authorized: false,
    licenceStatus: 'VALID',
    refusal: 'SUPPLIER_NOT_AUTHORIZED',
    hasOrders: true,
  }),
  state({
    key: 'valid',
    label: 'a valid licence and trade authorization',
    authorized: true,
    licenceStatus: 'VALID',
    refusal: null,
    hasOrders: false,
  }),
];
/**
 * DEV-466: a verified licence that another supplier's filing names as superseded. Seeded in
 * its own describe, after everything else, because only the database migration this suite
 * was written against lets such a filing be made at all.
 */
const CROSS = state({
  key: 'crossSuperseded',
  label: "a verified licence superseded from another supplier's record",
  authorized: true,
  licenceStatus: 'SUPERSEDED',
  refusal: 'SUPPLIER_LICENCE_EXPIRED',
  hasOrders: true,
});
const NON_VALID = STATES.filter((state) => state.refusal !== null);
const WITH_ORDERS = STATES.filter((state) => state.hasOrders);
const stateOf = (key: StateKey) => STATES.find((entry) => entry.key === key)!;

/** The expired supplier's only licence lapses this long after the fixture raises its orders. */
const LAPSE_MS = 4_000;

// ---------------------------------------------------------------------------
// Callers and readers
// ---------------------------------------------------------------------------

type Actor = {
  organizationId: string;
  userId: string;
  tenantRole?: 'ADMIN' | 'EMPLOYEE';
  /** The organization the session names, when a test forges it. */
  sessionOrganizationId?: string;
  /** A platform support session acting as this tenant user. */
  support?: boolean;
  /** The session token itself is marked as a support session. */
  isSupportSession?: boolean;
};
type AuditHolder = { audit: { detail: Record<string, unknown> } };

function context(db: ScopedDb, actor: Actor) {
  return {
    db,
    entitlements: {
      organizationId: actor.organizationId,
      enabledModules: ['pharmacy-procurement', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 50,
      activeSeats: 10,
    },
    session: {
      expires: 'later',
      user: {
        id: actor.userId,
        role: actor.tenantRole ?? 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: actor.sessionOrganizationId ?? actor.organizationId,
        ...(actor.isSupportSession ? { isSupportSession: true } : {}),
      },
    },
    organization: { id: actor.organizationId, vertical: 'PHARMACY' },
    support: actor.support
      ? {
          supportSessionId: `support_${suffix}`,
          organizationId: actor.organizationId,
          platformUserId: `platform_support_${suffix}`,
          tenantUserId: actor.userId,
          tenantUserRole: 'ADMIN',
          expiresAt: new Date(Date.now() + 3_600_000),
          reason: 'DEV-753 test support session',
        }
      : null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
}

function asPolicy<T>(actor: Actor, run: (api: PolicyApi, ctx: AuditHolder) => Promise<T>) {
  return withTenantDb(
    actor.organizationId,
    (db) => {
      const ctx = context(db, actor);
      return run(policyRouter.createCaller(ctx as never), ctx);
    },
    { userId: actor.userId, timeout: 60_000 }
  );
}

function asPurchasing<T>(actor: Actor, run: (api: PurchasingApi) => Promise<T>) {
  return withTenantDb(
    actor.organizationId,
    (db) => run(purchasingRouter.createCaller(context(db, actor) as never)),
    { userId: actor.userId, timeout: 60_000 }
  );
}

const a = (userId: string, extra: Partial<Actor> = {}): Actor => ({
  organizationId: A.org,
  userId,
  ...extra,
});
const e = (userId: string): Actor => ({ organizationId: E.org, userId });

function rows<T>(organizationId: string, sql: string, ...params: unknown[]): Promise<T[]> {
  return withTenantDb(organizationId, (db) => db.$queryRawUnsafe<T[]>(sql, ...params));
}

/** Run one statement that is EXPECTED to fail, in its own transaction; returns the error message. */
function sqlRefusal(
  organizationId: string,
  sql: string,
  params: unknown[] = [],
  userId?: string
): Promise<string> {
  return withTenantDb(organizationId, (db) => db.$executeRawUnsafe(sql, ...params), { userId })
    .then((count) => `ACCEPTED (${count} rows) — the statement was expected to fail`)
    .catch((error: Error) => error.message);
}

/**
 * One statement run in a purge context: `platform` is a platform-admin transaction naming
 * `purging` in app.purging_organization_id (the sanctioned purge), `tenant` is the tenant's own
 * transaction naming it there without platform admin. Returns the error, or the row count.
 */
function purgeAttempt(
  context: 'platform' | 'tenant',
  purging: string,
  organizationId: string,
  sql: string
): Promise<string> {
  const run = async (db: ScopedDb) => {
    await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${purging}, true)`;
    return db.$executeRawUnsafe(sql, organizationId);
  };
  const attempt = context === 'platform' ? withPlatformDb(run) : withTenantDb(organizationId, run);
  return attempt.then((count) => `ACCEPTED (${count} rows)`).catch((error: Error) => error.message);
}

type PolicyRow = {
  organizationId: string;
  allowCashierRxSale: boolean;
  supplierComplianceChecksEnabled: boolean;
  supplierCompliancePolicyVersion: number;
  supplierComplianceAcknowledgement: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
};
function policyRow(organizationId: string): Promise<PolicyRow[]> {
  return rows<PolicyRow>(
    organizationId,
    `SELECT "organizationId", "allowCashierRxSale", "supplierComplianceChecksEnabled",
            "supplierCompliancePolicyVersion", "supplierComplianceAcknowledgement",
            "updatedByUserId", "updatedAt"
       FROM pharmacy_owner_policies WHERE "organizationId" = $1`,
    organizationId
  );
}

type AuditRow = {
  id: string;
  organizationId: string;
  setting: string;
  oldValue: boolean | null;
  newValue: boolean;
  actorUserId: string | null;
  policyVersion: number | null;
  acknowledgement: string | null;
  changedAt: Date;
};
function auditRows(organizationId: string, setting?: string): Promise<AuditRow[]> {
  return rows<AuditRow>(
    organizationId,
    `SELECT id, "organizationId", setting, "oldValue", "newValue", "actorUserId",
            "policyVersion", acknowledgement, "changedAt"
       FROM pharmacy_owner_policy_audit
      WHERE "organizationId" = $1 AND ($2::text IS NULL OR setting = $2::text)
      ORDER BY "changedAt", id`,
    organizationId,
    setting ?? null
  );
}

/** Every supplier and licence row of the organization, to prove the switch never touches them. */
async function supplierRegister(organizationId: string) {
  return {
    suppliers: await rows<Record<string, unknown>>(
      organizationId,
      `SELECT * FROM pharmacy_suppliers WHERE "organizationId" = $1 ORDER BY id`,
      organizationId
    ),
    licences: await rows<Record<string, unknown>>(
      organizationId,
      `SELECT * FROM pharmacy_supplier_licences WHERE "organizationId" = $1 ORDER BY id`,
      organizationId
    ),
  };
}

type SkipRow = {
  operation: string;
  supplierId: string;
  purchaseOrderId: string | null;
  goodsReceiptId: string | null;
  reference: string | null;
  policyVersion: number;
  supplierAuthorized: boolean;
  licenceStatus: string;
  actorUserId: string;
};
/** The skip evidence that names any of these subjects, oldest first. */
function skipsAbout(subject: {
  reference?: string | null;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
}): Promise<SkipRow[]> {
  return rows<SkipRow>(
    E.org,
    `SELECT operation, "supplierId", "purchaseOrderId", "goodsReceiptId", reference,
            "policyVersion", "supplierAuthorized", "licenceStatus", "actorUserId"
       FROM pharmacy_supplier_compliance_skips
      WHERE "organizationId" = $1
        AND (reference = $2::text OR "purchaseOrderId" = $3::text OR "goodsReceiptId" = $4::text)
      ORDER BY "recordedAt", id`,
    E.org,
    subject.reference ?? null,
    subject.purchaseOrderId ?? null,
    subject.goodsReceiptId ?? null
  );
}
async function skipCount(organizationId = E.org): Promise<number> {
  const [row] = await rows<{ count: number }>(
    organizationId,
    `SELECT count(*)::int AS count FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1`,
    organizationId
  );
  return row!.count;
}

function expectedSkip(
  operation: string,
  state: SupplierState,
  subject: {
    purchaseOrderId?: string | null;
    goodsReceiptId?: string | null;
    reference?: string | null;
  },
  policyVersion = 1,
  actorUserId = E.buyer
): SkipRow {
  return {
    operation,
    supplierId: state.supplierId,
    purchaseOrderId: subject.purchaseOrderId ?? null,
    goodsReceiptId: subject.goodsReceiptId ?? null,
    reference: subject.reference ?? null,
    policyVersion,
    supplierAuthorized: state.authorized,
    licenceStatus: state.licenceStatus,
    actorUserId,
  };
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const [row] = await rows<{ count: number }>(
    E.org,
    `SELECT count(*)::int AS count FROM ${table} WHERE "organizationId" = $1 AND "${column}" = $2`,
    E.org,
    value
  );
  return row!.count;
}
async function orderStatus(purchaseOrderId: string): Promise<string | undefined> {
  const [row] = await rows<{ status: string }>(
    E.org,
    `SELECT status::text AS status FROM pharmacy_purchase_orders WHERE "organizationId" = $1 AND id = $2`,
    E.org,
    purchaseOrderId
  );
  return row?.status;
}
async function receiptStatus(goodsReceiptId: string): Promise<string | undefined> {
  const [row] = await rows<{ status: string }>(
    E.org,
    `SELECT status::text AS status FROM pharmacy_goods_receipts WHERE "organizationId" = $1 AND id = $2`,
    E.org,
    goodsReceiptId
  );
  return row?.status;
}

/** The owner switches the checks through the router, and no supplier or licence row moves. */
async function switchChecks(organizationId: string, ownerId: string, checksEnabled: boolean) {
  const before = await supplierRegister(organizationId);
  const result = await asPolicy({ organizationId, userId: ownerId }, async (api) => {
    const { policy } = await api.policy();
    return api.setPolicy({
      checksEnabled,
      expectedVersion: policy.version,
      ...(checksEnabled ? {} : { acknowledgement: ack() }),
    });
  });
  expect(result.changed).toBe(true);
  expect(result.policy.checksEnabled).toBe(checksEnabled);
  expect(await supplierRegister(organizationId)).toEqual(before);
  return result;
}

// ---------------------------------------------------------------------------
// Purchasing inputs
// ---------------------------------------------------------------------------

type Item = { medicineId: string; packLevelId: string };
const ORDINARY = (): Item => ({ medicineId: E.medicine, packLevelId: E.packLevel });
const CONTROLLED = (): Item => ({
  medicineId: E.controlledMedicine,
  packLevelId: E.controlledPackLevel,
});

function orderInput(supplierId: string, reference: string, item: Item = ORDINARY()) {
  return {
    reference,
    supplierId,
    branchId: E.branch,
    lines: [
      {
        ...item,
        orderedPacks: 5,
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 10_000,
      },
    ],
  };
}

function centralInput(supplierId: string, reference: string, item: Item = ORDINARY()) {
  return {
    reference,
    supplierId,
    receivingBranchId: E.branch,
    lines: [
      {
        ...item,
        orderedPacks: 3,
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 10_000,
      },
    ],
  };
}

type ReceiptLine = {
  medicineId?: string;
  packLevelId?: string;
  purchaseOrderLineId?: string;
  printedExpiry?: Date;
  receivedPacks?: number;
};
/** A direct-purchase (PUR-05) receipt, or one against `purchaseOrderId` when given. */
function receiptInput(
  supplierId: string,
  label: string,
  options: {
    purchaseOrderId?: string;
    receivedAt?: Date;
    line?: ReceiptLine;
    bypassApprover?: string;
    supplierInvoiceRef?: string;
  } = {}
) {
  const line = options.line ?? {};
  return {
    reference: `GRN-${label}-${suffix}`,
    branchId: E.branch,
    supplierId,
    supplierInvoiceRef: options.supplierInvoiceRef ?? `INV-${label}-${suffix}`,
    supplierInvoiceDate: options.receivedAt ?? new Date(),
    warrantyEvidenceRef: `WARRANTY-${label}-${suffix}`,
    receivedAt: options.receivedAt ?? new Date(),
    ...(options.purchaseOrderId
      ? { purchaseOrderId: options.purchaseOrderId }
      : {
          directPurchase: {
            reason: 'Emergency purchase for a patient waiting at the counter.',
            approvedByUserId: options.bypassApprover ?? E.approver,
          },
        }),
    lines: [
      {
        ...(line.purchaseOrderLineId ? { purchaseOrderLineId: line.purchaseOrderLineId } : {}),
        medicineId: line.medicineId ?? E.medicine,
        packLevelId: line.packLevelId ?? E.packLevel,
        batchNumber: `B-${label}-${suffix}`,
        printedExpiry: line.printedExpiry ?? new Date('2028-06-01T00:00:00.000Z'),
        expiryPrecision: 'DAY' as const,
        printedMrpMinor: 25_000,
        canonicalUnitsPerPack: 10,
        receivedPacks: line.receivedPacks ?? 2,
        invoicedPricePerPackMinor: 10_000,
        stockLocationId: E.store,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roleIdOf = (organizationId: string, key: string) => `${organizationId}_role_${key}`;

async function seedOrganization(
  organizationId: string,
  roles: readonly RoleSeed[],
  users: readonly UserSeed[],
  extra?: (tx: ScopedDb) => Promise<void>
) {
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  await withTenantDb(
    organizationId,
    async (tx) => {
      await seedDepartments(tx, [organizationId], ['LEADERSHIP']);
      for (const role of roles) {
        await tx.organizationRole.create({
          data: {
            id: roleIdOf(organizationId, role.key),
            key: role.key,
            name: role.key,
            isSystem: role.isSystem,
            permissions: {
              create: role.grants.map(([capability, effect]) => ({ capability, effect })),
            },
          },
        });
      }
      for (const user of users) {
        await tx.user.create({
          data: {
            id: user.id,
            name: user.name,
            email: `${user.id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Pharmacy staff',
            role: user.tenantRole ?? 'EMPLOYEE',
            status: user.status ?? 'ACTIVE',
            organizationRoleId: user.role ? roleIdOf(organizationId, user.role) : null,
          },
        });
        if (user.deny) {
          await tx.userPermissionOverride.create({
            data: {
              userId: user.id,
              capability: user.deny.capability,
              effect: 'DENY',
              reason: 'DEV-753 test: suspended pending review',
              expiresAt: user.deny.expiresAt,
            },
          });
        }
      }
      await extra?.(tx);
    },
    { timeout: 60_000 }
  );
}

async function supplierWithLicence(
  tx: ScopedDb,
  supplierId: string,
  licence: { id: string; expiresAt: Date; verified: boolean; supersedesId?: string } | null,
  authorized = true
) {
  await tx.pharmacySupplier.create({
    data: { id: supplierId, name: `Distributor ${supplierId}`, authorized },
  });
  if (licence) await fileLicence(tx, supplierId, licence);
}

function fileLicence(
  tx: ScopedDb,
  supplierId: string,
  licence: { id: string; expiresAt: Date; verified: boolean; supersedesId?: string }
) {
  return tx.pharmacySupplierLicence.create({
    data: {
      id: licence.id,
      supplierId,
      licenceType: 'DRUG_SALE',
      licenceNumber: `DSL-${licence.id}`,
      issuingAuthority: 'DRAP',
      issuedAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: licence.expiresAt,
      verifiedAt: licence.verified ? new Date('2025-01-02T00:00:00.000Z') : null,
      supersedesId: licence.supersedesId ?? null,
    },
  });
}

/** A purchase order walked through the PUR-02 status machine to `status`. */
async function seedOrder(
  tx: ScopedDb,
  id: string,
  supplierId: string,
  status: 'SUBMITTED' | 'APPROVED',
  item: Item = ORDINARY()
) {
  await tx.pharmacyPurchaseOrder.create({
    data: {
      id,
      branchId: E.branch,
      reference: id,
      supplierId,
      createdByUserId: E.buyer,
      lines: {
        create: {
          lineNumber: 1,
          ...item,
          orderedPacks: 5,
          bonusPacks: 0,
          canonicalUnitsPerPack: 10,
          orderedCanonicalUnits: 50,
          bonusCanonicalUnits: 0,
          listPricePerPackMinor: 10_000,
        },
      },
    },
  });
  await tx.pharmacyPurchaseOrder.update({
    where: { id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });
  if (status === 'APPROVED') {
    await tx.pharmacyPurchaseOrder.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: E.approver },
    });
  }
}

const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2026-01-01T00:00:00.000Z');

async function seedEnforcementOrganization() {
  await seedOrganization(
    E.org,
    [ROLES.owner, ROLES.procurement, ROLES.cashier],
    [
      { id: E.owner, name: `Esa Owner ${suffix}`, role: 'owner', tenantRole: 'ADMIN' },
      { id: E.buyer, name: `Bilal Buyer ${suffix}`, role: 'procurement' },
      { id: E.approver, name: `Ayesha Approver ${suffix}`, role: 'procurement' },
      { id: E.cashier, name: `Kamran Cashier ${suffix}`, role: 'cashier' },
    ],
    async (tx) => {
      await tx.pharmacyCentralPurchasingAccess.create({
        data: { userId: E.buyer, branchId: null, grantedById: E.owner },
      });
      await tx.pharmacyBranch.create({
        data: {
          id: E.branch,
          code: `E-${suffix}`,
          name: 'DEV-753 branch',
          addressLine: '1 Mall Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      await tx.pharmacyStockLocation.create({
        data: {
          id: E.store,
          branchId: E.branch,
          code: `MAIN-${suffix}`,
          name: 'Main',
          kind: 'STORE',
        },
      });
      for (const [medicineId, packLevelId, controlled] of [
        [E.medicine, E.packLevel, false],
        [E.controlledMedicine, E.controlledPackLevel, true],
      ] as const) {
        const medicine = await tx.medicine.create({
          data: {
            id: medicineId,
            productName: `${controlled ? 'Tramadol' : 'Amoxicillin'} ${medicineId}`,
            productFamily: 'PHARMACEUTICAL',
            saleable: true,
            controlled,
            presentations: { create: { presentation: 'Tablet, 10 per strip' } },
          },
          include: { presentations: true },
        });
        await tx.packLevel.create({
          data: {
            id: packLevelId,
            presentationId: medicine.presentations[0]!.id,
            versionGroupId: `strip-${packLevelId}`,
            version: 1,
            level: 'STRIP',
            unitsPerParent: 10,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
      }
      // Suppliers whose state is fixed from the start.
      await supplierWithLicence(tx, supplierOf('none'), null);
      await supplierWithLicence(tx, supplierOf('unverified'), {
        id: licenceOf('unverified'),
        expiresAt: FUTURE,
        verified: false,
      });
      await supplierWithLicence(tx, supplierOf('valid'), {
        id: licenceOf('valid'),
        expiresAt: FUTURE,
        verified: true,
      });
      await supplierWithLicence(tx, E.superseder, null);
      // Suppliers that are valid now and reach their state after their orders exist.
      for (const key of ['supersededByUnverified', 'unauthorized'] as const) {
        await supplierWithLicence(tx, supplierOf(key), {
          id: licenceOf(key),
          expiresAt: FUTURE,
          verified: true,
        });
      }
      await tx.pharmacyRequisition.create({
        data: {
          id: E.requisition,
          reference: E.requisition,
          requestedByUserId: E.buyer,
          lines: {
            create: {
              id: E.requisitionLine,
              lineNumber: 1,
              medicineId: E.medicine,
              packLevelId: E.packLevel,
              quantityPacks: 10,
              canonicalUnitsPerPack: 10,
              canonicalUnits: 100,
            },
          },
        },
      });
    }
  );

  // The expired supplier's only licence lapses moments from now; its orders are raised (and
  // walked through approval) in one transaction that starts while the licence still holds,
  // so the PUR-01 table trigger accepts them exactly as it would have in production.
  const lapseAt = new Date(Date.now() + LAPSE_MS);
  await withTenantDb(
    E.org,
    async (tx) => {
      await supplierWithLicence(tx, supplierOf('expired'), {
        id: licenceOf('expired'),
        expiresAt: lapseAt,
        verified: true,
      });
      for (const state of WITH_ORDERS) {
        await seedOrder(tx, orderOf(state.key, 'approve-on'), state.supplierId, 'SUBMITTED');
        await seedOrder(tx, orderOf(state.key, 'approve-off'), state.supplierId, 'SUBMITTED');
        await seedOrder(tx, orderOf(state.key, 'send-on'), state.supplierId, 'APPROVED');
        await seedOrder(tx, orderOf(state.key, 'send-off'), state.supplierId, 'APPROVED');
      }
      // Orders of a controlled medicine: refused while ON, unchecked (with evidence) while OFF.
      const ctl = stateOf('supersededByUnverified');
      await seedOrder(
        tx,
        orderOf(ctl.key, 'approve-controlled'),
        ctl.supplierId,
        'SUBMITTED',
        CONTROLLED()
      );
      await seedOrder(
        tx,
        orderOf(ctl.key, 'send-controlled'),
        ctl.supplierId,
        'APPROVED',
        CONTROLLED()
      );
    },
    { timeout: 60_000 }
  );

  // Now each supplier reaches its state. Licence evidence is append-only, so a correction
  // supersedes the earlier filing rather than rewriting it.
  await withTenantDb(
    E.org,
    async (tx) => {
      await tx.pharmacySupplier.update({
        where: { id: supplierOf('unauthorized') },
        data: { authorized: false },
      });
      await fileLicence(tx, supplierOf('supersededByUnverified'), {
        id: licenceOf('supersededByUnverified', 2),
        expiresAt: FUTURE,
        verified: false,
        supersedesId: licenceOf('supersededByUnverified'),
      });
      for (const [index, state] of STATES.entries()) {
        await tx.pharmacyQuote.create({
          data: {
            requisitionId: E.requisition,
            supplierId: state.supplierId,
            reference: `Q-${state.key}-${suffix}`,
            quotedAt: new Date(Date.now() - DAY),
            validUntil: new Date(Date.now() + 30 * DAY),
            lines: {
              create: {
                requisitionLineId: E.requisitionLine,
                pricePerPackMinor: 9_000 + index * 100,
                canonicalUnitsPerPack: 10,
              },
            },
          },
        });
      }
    },
    { timeout: 60_000 }
  );

  const wait = lapseAt.getTime() + 1_500 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

beforeAll(async () => {
  if (!databaseUrl || !ownerUrl) return;
  // The owner must be a different role, or FORCE RLS would prove nothing below.
  expect(ownerUrl).not.toBe(databaseUrl);
  const scoped = await import('@/lib/tenancy/scoped-db');
  const policy = await import('./pharmacy-supplier-compliance');
  const purchasing = await import('./pharmacy-purchasing');
  const departments = await import('@/lib/test-support/departments');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  policyRouter = policy.pharmacySupplierComplianceRouter;
  purchasingRouter = purchasing.pharmacyPurchasingRouter;
  seedDepartments = departments.seedDepartments;
  disconnect = () => db.$disconnect();
  // With SUPERUSER or BYPASSRLS every tenant case below would pass for the wrong reason.
  await assertRlsEnforcingRole(withPlatformDb);

  await seedOrganization(
    A.org,
    [
      ROLES.owner,
      ROLES.ownerOperator,
      ROLES.manager,
      ROLES.cashier,
      ROLES.procurement,
      ROLES.superAdmin,
      ROLES.adminNoSettings,
    ],
    [
      { id: A.owner, name: A.ownerName, role: 'owner', tenantRole: 'ADMIN' },
      { id: A.adminWildcard, name: 'Wildcard Admin', role: 'super-admin', tenantRole: 'ADMIN' },
      { id: A.adminNoRole, name: 'Legacy Admin', tenantRole: 'ADMIN' },
      { id: A.manager, name: 'Store Manager', role: 'manager' },
      { id: A.cashier, name: 'Counter Cashier', role: 'cashier' },
      { id: A.procurement, name: 'Procurement Officer', role: 'procurement' },
      { id: A.ownerOperator, name: 'Owner Operator', role: 'owner-operator', tenantRole: 'ADMIN' },
      { id: A.inactiveOwner, name: 'Former Owner', role: 'owner', status: 'INACTIVE' },
      {
        id: A.deniedOwner,
        name: 'Suspended Owner',
        role: 'owner',
        deny: { capability: '*', expiresAt: null },
      },
      {
        id: A.deniedUntilOwner,
        name: 'Suspended Owner Until',
        role: 'owner',
        deny: { capability: '*', expiresAt: new Date(Date.now() + 30 * DAY) },
      },
      {
        id: A.procurementDeniedOwner,
        name: 'Owner Barred From Purchasing',
        role: 'owner',
        deny: { capability: 'pharmacy:procurement', expiresAt: null },
      },
      {
        id: A.pharmacyDeniedOwner,
        name: 'Owner Barred From Pharmacy',
        role: 'owner',
        deny: { capability: 'pharmacy:*', expiresAt: null },
      },
      {
        id: A.expiredDenyOwner,
        name: 'Reinstated Owner',
        role: 'owner',
        deny: { capability: '*', expiresAt: new Date(Date.now() - DAY) },
      },
      {
        id: A.adminManageDenied,
        name: 'Admin Denied Settings',
        role: 'super-admin',
        tenantRole: 'ADMIN',
        deny: { capability: 'pharmacy:manage', expiresAt: null },
      },
      {
        id: A.adminRoleDenied,
        name: 'Admin Role Without Settings',
        role: 'admin-no-settings',
        tenantRole: 'ADMIN',
      },
      // Demoted in the database; a stale session below still claims ADMIN.
      { id: A.demotedAdmin, name: 'Demoted Admin', role: 'super-admin', tenantRole: 'EMPLOYEE' },
      {
        id: A.inactiveAdmin,
        name: 'Departed Admin',
        role: 'super-admin',
        tenantRole: 'ADMIN',
        status: 'INACTIVE',
      },
    ],
    async (tx) => {
      await tx.pharmacySupplier.create({
        data: {
          id: A.supplierAuthorized,
          name: 'Authorized Distributor',
          authorized: true,
          licences: {
            create: {
              licenceType: 'DRUG_SALE',
              licenceNumber: `DSL-A-${suffix}`,
              issuingAuthority: 'DRAP',
              issuedAt: new Date('2025-01-01T00:00:00.000Z'),
              expiresAt: FUTURE,
              verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
            },
          },
        },
      });
      await tx.pharmacySupplier.create({
        data: {
          id: A.supplierUnauthorized,
          name: 'Unauthorized Distributor',
          authorized: false,
          licences: {
            create: {
              licenceType: 'DRUG_SALE',
              licenceNumber: `DSL-A2-${suffix}`,
              issuingAuthority: 'DRAP',
              issuedAt: new Date('2025-01-01T00:00:00.000Z'),
              expiresAt: PAST,
              verifiedAt: null,
            },
          },
        },
      });
    }
  );
  await seedOrganization(
    B.org,
    [ROLES.owner],
    [{ id: B.owner, name: `Bushra Owner ${suffix}`, role: 'owner', tenantRole: 'ADMIN' }],
    async (tx) => {
      await supplierWithLicence(tx, B.supplier, {
        id: `l753b_${suffix}`,
        expiresAt: FUTURE,
        verified: true,
      });
    }
  );
  await seedOrganization(
    C.org,
    [{ key: 'owner', isSystem: false, grants: [['*', 'ALLOW']] }],
    // Not an ADMIN either: a custom role keyed 'owner' alone confers nothing.
    [{ id: C.fakeOwner, name: 'Self-styled Owner', role: 'owner' }]
  );
  await seedOrganization(
    D.org,
    [ROLES.owner, ROLES.cashier],
    [
      { id: D.owner, name: `Dua Owner ${suffix}`, role: 'owner', tenantRole: 'ADMIN' },
      { id: D.cashier, name: `Danish Cashier ${suffix}`, role: 'cashier' },
      { id: D.inactiveOwner, name: 'Departed Owner', role: 'owner', status: 'INACTIVE' },
    ]
  );
  await seedOrganization(
    G.org,
    [ROLES.owner],
    [{ id: G.owner, name: `Ghazala Owner ${suffix}`, role: 'owner', tenantRole: 'ADMIN' }]
  );
  await seedOrganization(
    F.org,
    [ROLES.owner],
    [{ id: F.owner, name: `Faiza Owner ${suffix}`, role: 'owner', tenantRole: 'ADMIN' }]
  );
  await seedOrganization(
    H.org,
    [ROLES.superAdmin, ROLES.ownerOperator, ROLES.manager, ROLES.adminNoSettings],
    [
      { id: H.admin, name: `Hira Admin ${suffix}`, role: 'super-admin', tenantRole: 'ADMIN' },
      {
        id: H.ownerOperatorAdmin,
        name: `Hamza Operator ${suffix}`,
        role: 'owner-operator',
        tenantRole: 'ADMIN',
      },
      { id: H.adminNoRole, name: 'Legacy Admin H', tenantRole: 'ADMIN' },
      { id: H.manager, name: 'Store Manager H', role: 'manager' },
      {
        id: H.adminRoleDenied,
        name: 'Admin Role Denied H',
        role: 'admin-no-settings',
        tenantRole: 'ADMIN',
      },
      {
        id: H.adminUserDenied,
        name: 'Admin User Denied H',
        role: 'super-admin',
        tenantRole: 'ADMIN',
        deny: { capability: 'pharmacy:manage', expiresAt: null },
      },
      {
        id: H.inactiveAdmin,
        name: 'Departed Admin H',
        role: 'super-admin',
        tenantRole: 'ADMIN',
        status: 'INACTIVE',
      },
    ]
  );
  await seedEnforcementOrganization();
  // The version the UI reads and sends back with the owner's acknowledgement.
  warningVersion = (await asPolicy(a(A.owner), (api) => api.policy())).warningVersion;
  expect(warningVersion).toMatch(/^supplier-compliance-off@\d+$/);
}, 180_000);

afterAll(async () => {
  await disconnect?.();
});

// ===========================================================================
// 1. The policy router
// ===========================================================================

describeIfDatabase(
  'DEV-753 pharmacySupplierCompliance router (persisted roles, RLS on)',
  { timeout: 60_000 },
  () => {
    /**
     * Everyone without the bounded authority (verified owner, or verified ACTIVE ADMIN of this
     * tenant with the pharmacy settings grant, DENY winning), and either through a support session.
     */
    const NOT_THE_OWNER: ReadonlyArray<[string, Actor]> = [
      [
        'a tenant ADMIN with no organization role (no settings grant)',
        a(A.adminNoRole, { tenantRole: 'ADMIN' }),
      ],
      [
        "a tenant ADMIN with a live 'pharmacy:manage' DENY override",
        a(A.adminManageDenied, { tenantRole: 'ADMIN' }),
      ],
      [
        "a tenant ADMIN whose own role DENYs 'pharmacy:manage'",
        a(A.adminRoleDenied, { tenantRole: 'ADMIN' }),
      ],
      [
        'a demoted ADMIN whose stale session still claims ADMIN',
        a(A.demotedAdmin, { tenantRole: 'ADMIN' }),
      ],
      ['an INACTIVE ADMIN with a still-live session', a(A.inactiveAdmin, { tenantRole: 'ADMIN' })],
      [
        "another tenant's ADMIN owner acting in this tenant",
        { organizationId: A.org, userId: B.owner, tenantRole: 'ADMIN' },
      ],
      ['the system manager role', a(A.manager)],
      [
        "a manager (holds 'pharmacy:manage') whose session claims ADMIN",
        a(A.manager, { tenantRole: 'ADMIN' }),
      ],
      ['a cashier', a(A.cashier)],
      ['a procurement-only user', a(A.procurement)],
      [
        'the ADMIN wildcard user through a support session',
        a(A.adminWildcard, { tenantRole: 'ADMIN', support: true }),
      ],
      ['an INACTIVE owner with a still-live session', a(A.inactiveOwner)],
      ["an owner with a live, non-expiring '*' DENY override", a(A.deniedOwner)],
      ["an owner with a live '*' DENY override that expires later", a(A.deniedUntilOwner)],
      ["an owner with a live 'pharmacy:procurement' DENY override", a(A.procurementDeniedOwner)],
      ["an owner with a live 'pharmacy:*' DENY override", a(A.pharmacyDeniedOwner)],
      ['the owner through a support session (ctx.support)', a(A.owner, { support: true })],
      [
        'the owner through a support-session token (isSupportSession)',
        a(A.owner, { isSupportSession: true }),
      ],
    ];

    it('reads the built-in default to any workspace user; only the verified owner may manage', async () => {
      const owner = await asPolicy(a(A.owner), (api) => api.policy());
      expect(owner).toEqual({
        policy: {
          checksEnabled: true,
          version: 0,
          source: 'DEFAULT',
          updatedAt: null,
          updatedByName: null,
        },
        canManage: true,
        warningVersion,
      });
      // The policy is visible wherever the supplier register is (it shows its effect there),
      // so the read is open to the module; managing it is not.
      for (const reader of [
        a(A.procurement),
        a(A.manager),
        a(A.cashier),
        a(A.adminNoRole, { tenantRole: 'ADMIN' }),
        a(A.adminManageDenied, { tenantRole: 'ADMIN' }),
        a(A.adminRoleDenied, { tenantRole: 'ADMIN' }),
        a(A.demotedAdmin, { tenantRole: 'ADMIN' }),
        a(A.manager, { tenantRole: 'ADMIN' }),
        a(A.inactiveOwner),
        a(A.deniedOwner),
        a(A.procurementDeniedOwner),
        a(A.pharmacyDeniedOwner),
        a(A.owner, { support: true }),
        a(A.owner, { isSupportSession: true }),
      ]) {
        await expect(asPolicy(reader, (api) => api.policy())).resolves.toMatchObject({
          policy: { checksEnabled: true, version: 0, source: 'DEFAULT' },
          canManage: false,
        });
      }
      // A verified ACTIVE tenant ADMIN with the settings grant may manage this one setting:
      // through a '*' role, or through the owner-operator role held as ADMIN.
      for (const admin of [
        a(A.adminWildcard, { tenantRole: 'ADMIN' }),
        a(A.ownerOperator, { tenantRole: 'ADMIN' }),
      ]) {
        await expect(asPolicy(admin, (api) => api.policy())).resolves.toMatchObject({
          canManage: true,
        });
      }
    });

    it.each(NOT_THE_OWNER)(
      'refuses %s the change while no policy row exists, and writes nothing',
      async (_label, actor) => {
        await expect(
          asPolicy(actor, (api) =>
            api.setPolicy({ checksEnabled: false, expectedVersion: 0, acknowledgement: ack() })
          )
        ).rejects.toMatchObject(OWNER_ONLY);
        expect(await policyRow(A.org)).toEqual([]);
        expect(await auditRows(A.org)).toEqual([]);
      }
    );

    it('shows the change history to the verified owner only', async () => {
      await expect(asPolicy(a(A.owner), (api) => api.history())).resolves.toEqual([]);
      // An expired DENY override is not live: that owner is still the verified owner.
      await expect(asPolicy(a(A.expiredDenyOwner), (api) => api.history())).resolves.toEqual([]);
      // So does a verified ADMIN with the settings grant.
      await expect(
        asPolicy(a(A.adminWildcard, { tenantRole: 'ADMIN' }), (api) => api.history())
      ).resolves.toEqual([]);
      for (const actor of [
        a(A.procurement),
        a(A.manager),
        a(A.manager, { tenantRole: 'ADMIN' }),
        a(A.cashier),
        a(A.adminNoRole, { tenantRole: 'ADMIN' }),
        a(A.adminManageDenied, { tenantRole: 'ADMIN' }),
        a(A.adminRoleDenied, { tenantRole: 'ADMIN' }),
        a(A.demotedAdmin, { tenantRole: 'ADMIN' }),
        a(A.inactiveAdmin, { tenantRole: 'ADMIN' }),
        a(A.inactiveOwner),
        a(A.deniedOwner),
        a(A.procurementDeniedOwner),
        a(A.pharmacyDeniedOwner),
      ]) {
        await expect(asPolicy(actor, (api) => api.history())).rejects.toMatchObject(OWNER_ONLY);
      }
    });

    // The commit's contract: "The history read and the write are for the verified tenant owner
    // only: ... no support sessions."
    it('refuses the change history to a support session acting as the owner', async () => {
      await expect(
        asPolicy(a(A.owner, { support: true }), (api) => api.history())
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        asPolicy(a(A.owner, { isSupportSession: true }), (api) => api.history())
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('treats saving the state already in force as a no-op that writes nothing', async () => {
      const result = await asPolicy(a(A.owner), (api) =>
        api.setPolicy({ checksEnabled: true, expectedVersion: 0 })
      );
      expect(result).toMatchObject({
        changed: false,
        policy: { checksEnabled: true, version: 0, source: 'DEFAULT' },
      });
      expect(await policyRow(A.org)).toEqual([]);
      expect(await auditRows(A.org)).toEqual([]);
    });

    it('refuses to turn the checks off without the current warning acknowledged', async () => {
      for (const acknowledgement of [
        undefined,
        { accepted: false, warningVersion },
        { accepted: true, warningVersion: 'supplier-compliance-off@0' },
        { accepted: true, warningVersion: 'supplier-compliance-off@999' },
      ]) {
        await expect(
          asPolicy(a(A.owner), (api) =>
            api.setPolicy({
              checksEnabled: false,
              expectedVersion: 0,
              ...(acknowledgement ? { acknowledgement } : {}),
            })
          )
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(await policyRow(A.org)).toEqual([]);
      expect(await auditRows(A.org)).toEqual([]);
    });

    let auditAfterOff: AuditRow[] = [];

    it('lets the owner turn the checks off: version 1, the acknowledgement kept, one audit row', async () => {
      const register = await supplierRegister(A.org);
      const { result, detail } = await asPolicy(a(A.owner), async (api, ctx) => ({
        result: await api.setPolicy({
          checksEnabled: false,
          expectedVersion: 0,
          acknowledgement: ack(),
        }),
        detail: ctx.audit.detail,
      }));
      expect(result).toMatchObject({
        changed: true,
        policy: {
          checksEnabled: false,
          version: 1,
          source: 'STORED',
          updatedByName: A.ownerName,
        },
      });
      expect(result.policy.updatedAt).toBeInstanceOf(Date);
      expect(detail).toMatchObject({
        targetType: 'PharmacySupplierCompliancePolicy',
        targetId: A.org,
        changes: {
          checksEnabled: { before: true, after: false },
          version: { before: 0, after: 1 },
        },
        metadata: { warningVersion },
      });

      const [row] = await policyRow(A.org);
      expect(row).toMatchObject({
        supplierComplianceChecksEnabled: false,
        supplierCompliancePolicyVersion: 1,
        updatedByUserId: A.owner,
      });
      expect(row!.supplierComplianceAcknowledgement).toMatch(/^supplier-compliance-off@\d+: /);
      expect(row!.supplierComplianceAcknowledgement?.startsWith(`${warningVersion}: `)).toBe(true);
      expect(row!.supplierComplianceAcknowledgement).toContain(
        'the pharmacy remains responsible for sourcing and compliance'
      );

      const audit = await auditRows(A.org, SUPPLIER_SETTING);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        setting: SUPPLIER_SETTING,
        oldValue: true,
        newValue: false,
        actorUserId: A.owner,
        policyVersion: 1,
      });
      expect(audit[0]!.acknowledgement?.startsWith(`${warningVersion}: `)).toBe(true);
      expect(audit[0]!.acknowledgement).toBe(row!.supplierComplianceAcknowledgement);

      // The switch changes enforcement only: no supplier or licence row moved.
      expect(await supplierRegister(A.org)).toEqual(register);

      // A procurement user now sees the checks are off.
      await expect(asPolicy(a(A.procurement), (api) => api.policy())).resolves.toMatchObject({
        policy: { checksEnabled: false, version: 1, source: 'STORED', updatedByName: A.ownerName },
        canManage: false,
      });
      auditAfterOff = await auditRows(A.org);
    });

    it.each(NOT_THE_OWNER)(
      'refuses %s the change once a stored policy exists, and the row is unchanged',
      async (_label, actor) => {
        const before = await policyRow(A.org);
        expect(before).toHaveLength(1);
        await expect(
          asPolicy(actor, (api) => api.setPolicy({ checksEnabled: true, expectedVersion: 1 }))
        ).rejects.toMatchObject(OWNER_ONLY);
        expect(await policyRow(A.org)).toEqual(before);
        expect(await auditRows(A.org)).toEqual(auditAfterOff);
      }
    );

    it('makes repeating the same save a no-op, also with a stale expectedVersion', async () => {
      const before = await policyRow(A.org);
      for (const expectedVersion of [1, 0, 7]) {
        const result = await asPolicy(a(A.owner), (api) =>
          api.setPolicy({ checksEnabled: false, expectedVersion, acknowledgement: ack() })
        );
        expect(result).toMatchObject({
          changed: false,
          policy: { checksEnabled: false, version: 1 },
        });
      }
      expect(await policyRow(A.org)).toEqual(before);
      expect(await auditRows(A.org)).toEqual(auditAfterOff);
    });

    it('refuses a real change made from a stale version with CONFLICT', async () => {
      const before = await policyRow(A.org);
      await expect(
        asPolicy(a(A.owner), (api) => api.setPolicy({ checksEnabled: true, expectedVersion: 0 }))
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await policyRow(A.org)).toEqual(before);
      expect(await auditRows(A.org)).toEqual(auditAfterOff);
    });

    it('turns the checks back on: version 2, one more audit row, the acknowledgement cleared', async () => {
      const register = await supplierRegister(A.org);
      const result = await asPolicy(a(A.owner), (api) =>
        api.setPolicy({ checksEnabled: true, expectedVersion: 1 })
      );
      expect(result).toMatchObject({
        changed: true,
        policy: { checksEnabled: true, version: 2, source: 'STORED', updatedByName: A.ownerName },
      });
      const [row] = await policyRow(A.org);
      expect(row).toMatchObject({
        supplierComplianceChecksEnabled: true,
        supplierCompliancePolicyVersion: 2,
        supplierComplianceAcknowledgement: null,
        updatedByUserId: A.owner,
      });

      const audit = await auditRows(A.org);
      // Earlier evidence is untouched; exactly one row was added.
      expect(audit.filter((entry) => auditAfterOff.some((old) => old.id === entry.id))).toEqual(
        auditAfterOff
      );
      const added = audit.filter((entry) => !auditAfterOff.some((old) => old.id === entry.id));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        setting: SUPPLIER_SETTING,
        oldValue: false,
        newValue: true,
        actorUserId: A.owner,
        policyVersion: 2,
        acknowledgement: null,
      });
      expect(await supplierRegister(A.org)).toEqual(register);

      const history = await asPolicy(a(A.owner), (api) => api.history());
      expect(
        history.map((change) => [change.oldValue, change.newValue, change.policyVersion])
      ).toEqual([
        [false, true, 2],
        [true, false, 1],
      ]);
      expect(history.every((change) => change.actorName === A.ownerName)).toBe(true);
    });

    it("lets org B's owner read and change only org B's policy", async () => {
      const aBefore = await policyRow(A.org);
      const aAuditBefore = await auditRows(A.org);
      await expect(
        asPolicy({ organizationId: B.org, userId: B.owner }, (api) => api.policy())
      ).resolves.toMatchObject({
        policy: { checksEnabled: true, version: 0, source: 'DEFAULT' },
        canManage: true,
      });
      const result = await asPolicy({ organizationId: B.org, userId: B.owner }, (api) =>
        api.setPolicy({ checksEnabled: false, expectedVersion: 0, acknowledgement: ack() })
      );
      expect(result).toMatchObject({ changed: true, policy: { checksEnabled: false, version: 1 } });
      // Org A's row and audit did not move.
      expect(await policyRow(A.org)).toEqual(aBefore);
      expect(await auditRows(A.org)).toEqual(aAuditBefore);
      // Org B's history is its own one change.
      const history = await asPolicy({ organizationId: B.org, userId: B.owner }, (api) =>
        api.history()
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ oldValue: true, newValue: false, actorUserId: B.owner });
      // And A still reads its own state, not B's.
      await expect(asPolicy(a(A.owner), (api) => api.policy())).resolves.toMatchObject({
        policy: { checksEnabled: true, version: 2 },
      });
    });

    it("hides org A's policy row and audit from org B under RLS", async () => {
      expect(await policyRow(A.org)).toHaveLength(1);
      const fromB = (sql: string) => rows<Record<string, unknown>>(B.org, sql, A.org);
      expect(
        await fromB(`SELECT * FROM pharmacy_owner_policies WHERE "organizationId" = $1`)
      ).toEqual([]);
      expect(
        await fromB(`SELECT * FROM pharmacy_owner_policy_audit WHERE "organizationId" = $1`)
      ).toEqual([]);
      // A blind write from B's scope reaches no row of A's.
      const updated = await withTenantDb(
        B.org,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE pharmacy_owner_policies
              SET "supplierComplianceChecksEnabled" = false,
                  "supplierComplianceAcknowledgement" = 'cross-tenant'
            WHERE "organizationId" = $1`,
            A.org
          ),
        { userId: B.owner }
      );
      expect(updated).toBe(0);
      expect(await policyRow(A.org)).toMatchObject([
        { supplierComplianceChecksEnabled: true, supplierCompliancePolicyVersion: 2 },
      ]);
    });

    it("refuses org B's owner in org A's workspace, however the session is shaped", async () => {
      const before = await policyRow(A.org);
      // The session names org B but the request is for org A: no tenant actor at all.
      await expect(
        asPolicy(a(B.owner, { sessionOrganizationId: B.org }), (api) => api.policy())
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      // A session forged to name org A: org B's user is not in org A's live database, so
      // it is nobody's owner here and cannot manage, change or see the history.
      await expect(asPolicy(a(B.owner), (api) => api.policy())).resolves.toMatchObject({
        canManage: false,
      });
      await expect(
        asPolicy(a(B.owner), (api) =>
          api.setPolicy({ checksEnabled: false, expectedVersion: 2, acknowledgement: ack() })
        )
      ).rejects.toMatchObject(OWNER_ONLY);
      await expect(asPolicy(a(B.owner), (api) => api.history())).rejects.toMatchObject(OWNER_ONLY);
      expect(await policyRow(A.org)).toEqual(before);
    });

    it("refuses a custom role keyed 'owner' that is not the system owner role", async () => {
      const actor: Actor = { organizationId: C.org, userId: C.fakeOwner, tenantRole: 'ADMIN' };
      await expect(asPolicy(actor, (api) => api.policy())).resolves.toMatchObject({
        canManage: false,
      });
      await expect(
        asPolicy(actor, (api) =>
          api.setPolicy({ checksEnabled: false, expectedVersion: 0, acknowledgement: ack() })
        )
      ).rejects.toMatchObject(OWNER_ONLY);
      await expect(asPolicy(actor, (api) => api.history())).rejects.toMatchObject(OWNER_ONLY);
      expect(await policyRow(C.org)).toEqual([]);
    });
  }
);

// ===========================================================================
// 2. The database guards, as the runtime role
// ===========================================================================

describeIfDatabase(
  'DEV-753 owner-policy database guards (runtime role, RLS on)',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      if (!databaseUrl) return;
      await switchChecks(D.org, D.owner, false);
      await switchChecks(D.org, D.owner, true);
      expect(await policyRow(D.org)).toMatchObject([
        { supplierComplianceChecksEnabled: true, supplierCompliancePolicyVersion: 2 },
      ]);
    });

    it('refuses a direct UPDATE that turns the checks off with no acknowledgement', async () => {
      const before = await policyRow(D.org);
      const auditBefore = await auditRows(D.org);
      for (const acknowledgement of [null, '   ']) {
        expect(
          await sqlRefusal(
            D.org,
            `UPDATE pharmacy_owner_policies
              SET "supplierComplianceChecksEnabled" = false,
                  "supplierComplianceAcknowledgement" = $2
            WHERE "organizationId" = $1`,
            [D.org, acknowledgement],
            D.owner
          )
        ).toContain('SUPPLIER_COMPLIANCE_ACKNOWLEDGEMENT_REQUIRED');
      }
      expect(await policyRow(D.org)).toEqual(before);
      expect(await auditRows(D.org)).toEqual(auditBefore);
    });

    it('refuses a direct INSERT that turns the checks off with no acknowledgement', async () => {
      expect(
        await sqlRefusal(
          F.org,
          `INSERT INTO pharmacy_owner_policies ("organizationId", "supplierComplianceChecksEnabled", "updatedByUserId")
         VALUES ($1, false, $2)`,
          [F.org, F.owner],
          F.owner
        )
      ).toContain('SUPPLIER_COMPLIANCE_ACKNOWLEDGEMENT_REQUIRED');
      expect(await policyRow(F.org)).toEqual([]);
      expect(await auditRows(F.org)).toEqual([]);
    });

    it('refuses a direct change with no actor', async () => {
      const before = await policyRow(D.org);
      expect(
        await sqlRefusal(
          D.org,
          `UPDATE pharmacy_owner_policies
            SET "supplierComplianceChecksEnabled" = false,
                "supplierComplianceAcknowledgement" = 'acknowledged',
                "updatedByUserId" = NULL
          WHERE "organizationId" = $1`,
          [D.org]
        )
      ).toContain('SUPPLIER_COMPLIANCE_POLICY_ACTOR_REQUIRED');
      expect(await policyRow(D.org)).toEqual(before);
    });

    it('ignores an UPDATE that only rewrites the version or the acknowledgement (checks on)', async () => {
      const before = await policyRow(D.org);
      const auditBefore = await auditRows(D.org);
      const updated = await withTenantDb(
        D.org,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE pharmacy_owner_policies
              SET "supplierCompliancePolicyVersion" = 99,
                  "supplierComplianceAcknowledgement" = 'forged acknowledgement'
            WHERE "organizationId" = $1`,
            D.org
          ),
        { userId: D.owner }
      );
      expect(updated).toBe(1);
      expect(before).toMatchObject([
        {
          supplierComplianceChecksEnabled: true,
          supplierCompliancePolicyVersion: 2,
          supplierComplianceAcknowledgement: null,
        },
      ]);
      expect(await policyRow(D.org)).toEqual(before);
      expect(await auditRows(D.org)).toEqual(auditBefore);
    });

    it('stamps the version itself on a direct change, then ignores a rewrite of it (checks off)', async () => {
      await withTenantDb(
        D.org,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE pharmacy_owner_policies
              SET "supplierComplianceChecksEnabled" = false,
                  "supplierComplianceAcknowledgement" = 'direct acknowledgement',
                  "supplierCompliancePolicyVersion" = 42
            WHERE "organizationId" = $1`,
            D.org
          ),
        { userId: D.owner }
      );
      const [off] = await policyRow(D.org);
      expect(off).toMatchObject({
        supplierComplianceChecksEnabled: false,
        supplierCompliancePolicyVersion: 3,
        supplierComplianceAcknowledgement: 'direct acknowledgement',
        updatedByUserId: D.owner,
      });
      const latest = (await auditRows(D.org, SUPPLIER_SETTING)).at(-1);
      expect(latest).toMatchObject({
        oldValue: true,
        newValue: false,
        policyVersion: 3,
        acknowledgement: 'direct acknowledgement',
        actorUserId: D.owner,
      });

      const auditBefore = await auditRows(D.org);
      await withTenantDb(
        D.org,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE pharmacy_owner_policies
              SET "supplierCompliancePolicyVersion" = 0,
                  "supplierComplianceAcknowledgement" = 'rewritten after the fact'
            WHERE "organizationId" = $1`,
            D.org
          ),
        { userId: D.owner }
      );
      expect(await policyRow(D.org)).toEqual([off]);
      expect(await auditRows(D.org)).toEqual(auditBefore);
    });

    it('keeps the policy audit append-only', async () => {
      const before = await auditRows(D.org);
      expect(before.length).toBeGreaterThan(0);
      expect(
        await sqlRefusal(
          D.org,
          `UPDATE pharmacy_owner_policy_audit SET "newValue" = NOT "newValue", "actorUserId" = 'someone else'
          WHERE "organizationId" = $1`,
          [D.org],
          D.owner
        )
      ).toContain('pharmacy_owner_policy_audit is append-only');
      expect(
        await sqlRefusal(
          D.org,
          `DELETE FROM pharmacy_owner_policy_audit WHERE "organizationId" = $1`,
          [D.org],
          D.owner
        )
      ).toContain('pharmacy_owner_policy_audit is append-only');
      expect(await auditRows(D.org)).toEqual(before);
    });

    it('keeps the skip evidence append-only and tenant-scoped', async () => {
      const reference = `SKIP-D-${suffix}`;
      await withTenantDb(
        D.org,
        (db) =>
          db.$executeRawUnsafe(
            `INSERT INTO pharmacy_supplier_compliance_skips
             ("organizationId", operation, "supplierId", reference, "policyVersion",
              "supplierAuthorized", "licenceStatus", "actorUserId")
           VALUES ($1, 'PURCHASE_ORDER_CREATE', 'some-supplier', $2, 3, false, 'NONE', $3)`,
            D.org,
            reference,
            D.owner
          ),
        { userId: D.owner }
      );
      const read = () =>
        rows<{ licenceStatus: string; supplierAuthorized: boolean }>(
          D.org,
          `SELECT "licenceStatus", "supplierAuthorized" FROM pharmacy_supplier_compliance_skips
          WHERE "organizationId" = $1 AND reference = $2`,
          D.org,
          reference
        );
      expect(await read()).toEqual([{ licenceStatus: 'NONE', supplierAuthorized: false }]);
      expect(
        await sqlRefusal(
          D.org,
          `UPDATE pharmacy_supplier_compliance_skips SET "licenceStatus" = 'VALID', "supplierAuthorized" = true
          WHERE "organizationId" = $1 AND reference = $2`,
          [D.org, reference],
          D.owner
        )
      ).toContain('pharmacy_supplier_compliance_skips is append-only');
      expect(
        await sqlRefusal(
          D.org,
          `DELETE FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1 AND reference = $2`,
          [D.org, reference],
          D.owner
        )
      ).toContain('pharmacy_supplier_compliance_skips is append-only');
      expect(await read()).toEqual([{ licenceStatus: 'NONE', supplierAuthorized: false }]);
      // Evidence cannot be planted in another tenant's register.
      expect(
        await sqlRefusal(
          D.org,
          `INSERT INTO pharmacy_supplier_compliance_skips
           ("organizationId", operation, "supplierId", reference, "policyVersion",
            "supplierAuthorized", "licenceStatus", "actorUserId")
         VALUES ($1, 'PURCHASE_ORDER_CREATE', 'some-supplier', 'planted', 1, true, 'VALID', $2)`,
          [B.org, D.owner],
          D.owner
        )
      ).toMatch(/row-level security/);
      // And another tenant cannot see this one's.
      expect(
        await rows(
          B.org,
          `SELECT 1 FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1`,
          D.org
        )
      ).toEqual([]);
    });

    it("makes the owner's change wait for a write that holds the policy under its share lock", async () => {
      const { readSupplierCompliancePolicy } =
        await import('@/lib/pharmacy/supplier-compliance-policy');
      const [before] = await policyRow(D.org);
      expect(before).toMatchObject({ supplierComplianceChecksEnabled: false });
      let locked!: () => void;
      let release!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      // A purchasing write in flight: it has read the policy FOR SHARE and not yet committed.
      const write = withTenantDb(
        D.org,
        async (db) => {
          const policy = await readSupplierCompliancePolicy(db, D.org, { lock: 'share' });
          locked();
          await released;
          return policy;
        },
        { userId: D.owner }
      );
      await lockHeld;
      let changeSettled = false;
      const change = asPolicy({ organizationId: D.org, userId: D.owner }, (api) =>
        api.setPolicy({
          checksEnabled: true,
          expectedVersion: before!.supplierCompliancePolicyVersion,
        })
      ).finally(() => {
        changeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(changeSettled).toBe(false);
      expect(await policyRow(D.org)).toEqual([before]);
      release();
      await expect(write).resolves.toMatchObject({
        checksEnabled: false,
        version: before!.supplierCompliancePolicyVersion,
        source: 'STORED',
      });
      await expect(change).resolves.toMatchObject({
        changed: true,
        policy: { checksEnabled: true, version: before!.supplierCompliancePolicyVersion + 1 },
      });
    });

    it('refuses a direct change by anyone but an ACTIVE system owner acting as themselves', async () => {
      const before = await policyRow(D.org);
      const auditBefore = await auditRows(D.org);
      expect(before).toMatchObject([{ supplierComplianceChecksEnabled: true }]);
      const turnOffNaming = `UPDATE pharmacy_owner_policies
            SET "supplierComplianceChecksEnabled" = false,
                "supplierComplianceAcknowledgement" = 'acknowledged',
                "updatedByUserId" = $2
          WHERE "organizationId" = $1`;
      // Acting as themselves, but not the owner: a cashier, an INACTIVE owner, and another
      // tenant's owner (not a user of this organization at all).
      for (const userId of [D.cashier, D.inactiveOwner, B.owner]) {
        const refusal = await sqlRefusal(D.org, turnOffNaming, [D.org, userId], userId);
        expect(refusal, userId).toContain('SUPPLIER_COMPLIANCE_POLICY_AUTHORITY_REQUIRED');
        expect(refusal, userId).toContain('42501');
      }
      // Naming someone other than the session's own user: the cashier claiming to be the
      // owner (explicitly, or by leaving the owner's id on the row), or the owner naming
      // somebody else.
      for (const [sessionUser, named] of [
        [D.cashier, D.owner],
        [D.owner, D.cashier],
      ] as const) {
        expect(await sqlRefusal(D.org, turnOffNaming, [D.org, named], sessionUser)).toContain(
          'SUPPLIER_COMPLIANCE_POLICY_ACTOR_REQUIRED'
        );
      }
      expect(before[0]!.updatedByUserId).toBe(D.owner);
      expect(
        await sqlRefusal(
          D.org,
          `UPDATE pharmacy_owner_policies
              SET "supplierComplianceChecksEnabled" = false,
                  "supplierComplianceAcknowledgement" = 'acknowledged'
            WHERE "organizationId" = $1`,
          [D.org],
          D.cashier
        )
      ).toContain('SUPPLIER_COMPLIANCE_POLICY_ACTOR_REQUIRED');
      expect(await policyRow(D.org)).toEqual(before);
      expect(await auditRows(D.org)).toEqual(auditBefore);
      // A custom role keyed 'owner' is not the system owner role, on insert either.
      expect(
        await sqlRefusal(
          C.org,
          `INSERT INTO pharmacy_owner_policies
             ("organizationId", "supplierComplianceChecksEnabled", "supplierComplianceAcknowledgement", "updatedByUserId")
           VALUES ($1, false, 'acknowledged', $2)`,
          [C.org, C.fakeOwner],
          C.fakeOwner
        )
      ).toContain('SUPPLIER_COMPLIANCE_POLICY_AUTHORITY_REQUIRED');
      expect(await policyRow(C.org)).toEqual([]);
    });

    it('refuses deleting the policy row outside a sanctioned purge, and versions continue after one', async () => {
      const deletePolicy = `DELETE FROM pharmacy_owner_policies WHERE "organizationId" = $1`;
      const [before] = await policyRow(D.org);
      expect(before).toMatchObject({
        supplierComplianceChecksEnabled: true,
        supplierCompliancePolicyVersion: 4,
      });
      const REMOVED_ONLY_WITH_TENANT =
        'pharmacy owner policies are removed only with their organization';
      // A plain tenant delete would silently restore the default with no audit row.
      expect(await sqlRefusal(D.org, deletePolicy, [D.org], D.owner)).toContain(
        REMOVED_ONLY_WITH_TENANT
      );
      // The tenant naming itself as the organization being purged is not a sanctioned purge.
      expect(await purgeAttempt('tenant', D.org, D.org, deletePolicy)).toContain(
        REMOVED_ONLY_WITH_TENANT
      );
      // A platform purge of another organization unlocks nothing here.
      expect(await purgeAttempt('platform', B.org, D.org, deletePolicy)).toContain(
        REMOVED_ONLY_WITH_TENANT
      );
      expect(await policyRow(D.org)).toEqual([before]);

      // The sanctioned purge of this organization removes it.
      expect(await purgeAttempt('platform', D.org, D.org, deletePolicy)).toBe('ACCEPTED (1 rows)');
      expect(await policyRow(D.org)).toEqual([]);
      await expect(
        asPolicy({ organizationId: D.org, userId: D.owner }, (api) => api.policy())
      ).resolves.toMatchObject({ policy: { checksEnabled: true, version: 0, source: 'DEFAULT' } });

      // Versions continue from the audit trail: evidence citing versions 1-4 stays unambiguous.
      const cited = (await auditRows(D.org, SUPPLIER_SETTING)).map((row) => row.policyVersion);
      expect(Math.max(...cited.map((version) => version ?? 0))).toBe(4);
      const result = await asPolicy({ organizationId: D.org, userId: D.owner }, (api) =>
        api.setPolicy({ checksEnabled: false, expectedVersion: 0, acknowledgement: ack() })
      );
      expect(result).toMatchObject({ changed: true, policy: { checksEnabled: false, version: 5 } });
      expect((await auditRows(D.org, SUPPLIER_SETTING)).at(-1)).toMatchObject({
        oldValue: true,
        newValue: false,
        policyVersion: 5,
        actorUserId: D.owner,
      });
    });

    it('removes the audit and skip evidence only in a sanctioned purge of its own organization', async () => {
      const auditBefore = await auditRows(D.org);
      const skipsBefore = await skipCount(D.org);
      expect(auditBefore.length).toBeGreaterThan(0);
      expect(skipsBefore).toBeGreaterThan(0);
      for (const table of ['pharmacy_owner_policy_audit', 'pharmacy_supplier_compliance_skips']) {
        const remove = `DELETE FROM ${table} WHERE "organizationId" = $1`;
        const rewrite =
          table === 'pharmacy_owner_policy_audit'
            ? `UPDATE ${table} SET "actorUserId" = 'someone else' WHERE "organizationId" = $1`
            : `UPDATE ${table} SET "licenceStatus" = 'VALID' WHERE "organizationId" = $1`;
        const appendOnly = `${table} is append-only`;
        expect(await sqlRefusal(D.org, remove, [D.org], D.owner)).toContain(appendOnly);
        expect(await purgeAttempt('tenant', D.org, D.org, remove)).toContain(appendOnly);
        expect(await purgeAttempt('platform', B.org, D.org, remove)).toContain(appendOnly);
        // UPDATE is refused even inside the sanctioned purge.
        expect(await purgeAttempt('platform', D.org, D.org, rewrite)).toContain(appendOnly);
      }
      expect(await auditRows(D.org)).toEqual(auditBefore);
      expect(await skipCount(D.org)).toBe(skipsBefore);

      for (const table of ['pharmacy_owner_policy_audit', 'pharmacy_supplier_compliance_skips']) {
        expect(
          await purgeAttempt(
            'platform',
            D.org,
            D.org,
            `DELETE FROM ${table} WHERE "organizationId" = $1`
          )
        ).toMatch(/^ACCEPTED \(\d+ rows\)$/);
      }
      expect(await auditRows(D.org)).toEqual([]);
      expect(await skipCount(D.org)).toBe(0);
    });

    it('removes the policy, its audit and its skip evidence with the organization itself', async () => {
      await switchChecks(G.org, G.owner, false);
      await withTenantDb(
        G.org,
        (db) =>
          db.$executeRawUnsafe(
            `INSERT INTO pharmacy_supplier_compliance_skips
               ("organizationId", operation, "supplierId", reference, "policyVersion",
                "supplierAuthorized", "licenceStatus", "actorUserId")
             VALUES ($1, 'PURCHASE_ORDER_CREATE', 'some-supplier', 'SKIP-G', 1, true, 'NONE', $2)`,
            G.org,
            G.owner
          ),
        { userId: G.owner }
      );
      const evidence = () =>
        withPlatformDb((db) =>
          db.$queryRawUnsafe<Array<{ policies: number; audit: number; skips: number }>>(
            `SELECT (SELECT count(*)::int FROM pharmacy_owner_policies WHERE "organizationId" = $1) AS policies,
                    (SELECT count(*)::int FROM pharmacy_owner_policy_audit WHERE "organizationId" = $1) AS audit,
                    (SELECT count(*)::int FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1) AS skips`,
            G.org
          )
        );
      const [held] = await evidence();
      expect(held).toMatchObject({ policies: 1, skips: 1 });
      expect(held!.audit).toBeGreaterThan(0);
      await withPlatformDb((db) =>
        db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1`, G.org)
      );
      expect(await evidence()).toEqual([{ policies: 0, audit: 0, skips: 0 }]);
    });
  }
);

// ===========================================================================
// 3. Enforcement through the real purchasing router and the central path
// ===========================================================================

describeIfDatabase(
  'DEV-753 supplier checks at every purchasing write (real router, RLS on)',
  { timeout: 90_000 },
  () => {
    const buyer = e(E.buyer);
    const approver = e(E.approver);

    // ----- Checks ON: the built-in default, no policy row -----------------------------------

    describe('with the checks ON (the default: no policy row)', () => {
      beforeAll(async () => {
        if (!databaseUrl) return;
        expect(await policyRow(E.org)).toEqual([]);
        expect(await skipCount()).toBe(0);
      });

      it.each(NON_VALID)(
        'refuses createPurchaseOrder for a supplier with $label',
        async (state) => {
          const reference = `PO-on-${state.key}-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createPurchaseOrder(orderInput(state.supplierId, reference))
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
          expect(await skipCount()).toBe(0);
        }
      );

      it.each(WITH_ORDERS)('refuses approval for a supplier now holding $label', async (state) => {
        const purchaseOrderId = orderOf(state.key, 'approve-on');
        await expect(
          asPurchasing(approver, (api) =>
            api.approvePurchaseOrder({ purchaseOrderId, decision: 'APPROVED' })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
        expect(await orderStatus(purchaseOrderId)).toBe('SUBMITTED');
        expect(
          await countWhere('pharmacy_purchase_order_approvals', 'purchaseOrderId', purchaseOrderId)
        ).toBe(0);
        expect(await skipCount()).toBe(0);
      });

      it.each(WITH_ORDERS)(
        'refuses the SENT transition for a supplier now holding $label',
        async (state) => {
          const purchaseOrderId = orderOf(state.key, 'send-on');
          await expect(
            asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId }))
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          expect(await orderStatus(purchaseOrderId)).toBe('APPROVED');
          expect(await skipCount()).toBe(0);
        }
      );

      it.each(NON_VALID)('refuses createGoodsReceipt for a supplier with $label', async (state) => {
        const input = receiptInput(state.supplierId, `on-${state.key}`);
        await expect(
          asPurchasing(buyer, (api) => api.createGoodsReceipt(input))
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
        expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
        expect(await skipCount()).toBe(0);
      });

      it.each(NON_VALID)(
        'refuses createCentralPurchaseOrder for a supplier with $label as NOT_FOUND',
        async (state) => {
          const reference = `CPO-on-${state.key}-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createCentralPurchaseOrder(centralInput(state.supplierId, reference))
            )
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });
          expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
          expect(await skipCount()).toBe(0);
        }
      );

      it.each(NON_VALID)(
        'refuses a controlled-medicine order, receipt and central order for a supplier with $label',
        async (state) => {
          const reference = `PO-on-controlled-${state.key}-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createPurchaseOrder(orderInput(state.supplierId, reference, CONTROLLED()))
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          const input = receiptInput(state.supplierId, `on-controlled-${state.key}`, {
            line: CONTROLLED(),
          });
          await expect(
            asPurchasing(buyer, (api) => api.createGoodsReceipt(input))
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          const central = `CPO-on-controlled-${state.key}-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createCentralPurchaseOrder(centralInput(state.supplierId, central, CONTROLLED()))
            )
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });
          expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
          expect(await countWhere('pharmacy_purchase_orders', 'reference', central)).toBe(0);
          expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
          expect(await skipCount()).toBe(0);
        }
      );

      it('refuses approval and send of controlled-medicine orders for a supplier licensed only on paper', async () => {
        const ctl = stateOf('supersededByUnverified');
        await expect(
          asPurchasing(approver, (api) =>
            api.approvePurchaseOrder({
              purchaseOrderId: orderOf(ctl.key, 'approve-controlled'),
              decision: 'APPROVED',
            })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: ctl.refusal });
        await expect(
          asPurchasing(buyer, (api) =>
            api.sendPurchaseOrder({ purchaseOrderId: orderOf(ctl.key, 'send-controlled') })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: ctl.refusal });
        expect(await orderStatus(orderOf(ctl.key, 'approve-controlled'))).toBe('SUBMITTED');
        expect(await orderStatus(orderOf(ctl.key, 'send-controlled'))).toBe('APPROVED');
        expect(await skipCount()).toBe(0);
      });

      it('ranks only the valid supplier as comparable, and says every supplier was checked', async () => {
        const result = await asPurchasing(buyer, (api) =>
          api.compareQuotes({ requisitionLineId: E.requisitionLine })
        );
        expect(result.supplierChecksEnabled).toBe(true);
        expect(result.ranking).toHaveLength(STATES.length);
        for (const state of STATES) {
          const row = result.ranking.find((entry) => entry.supplierId === state.supplierId);
          expect(row, state.key).toMatchObject({
            comparable: state.refusal === null,
            supplierChecked: true,
          });
          if (state.refusal === 'SUPPLIER_NOT_AUTHORIZED') {
            expect(row!.reasons).toContain('Supplier is not authorized to supply this pharmacy.');
          } else if (state.refusal) {
            expect(row!.reasons).toContain('Supplier has no unexpired verified licence on file.');
          }
        }
        expect(await skipCount()).toBe(0);
      });

      it('shows the supplier read model as checked, with each state not orderable', async () => {
        const suppliers = await asPurchasing(buyer, (api) => api.suppliers());
        for (const state of STATES) {
          const summary = suppliers.find((supplier) => supplier.id === state.supplierId);
          expect(summary, state.key).toMatchObject({
            eligibility: { orderable: state.refusal === null },
            compliance: { checked: true, policyVersion: 0, licenceStatus: state.licenceStatus },
          });
        }
      });

      it('runs a valid supplier through order, approval, send, receipt and posting with no skip row', async () => {
        const state = stateOf('valid');
        const reference = `PO-on-valid-${suffix}`;
        const order = await asPurchasing(buyer, (api) =>
          api.createPurchaseOrder(orderInput(state.supplierId, reference))
        );
        await asPurchasing(buyer, (api) => api.submitPurchaseOrder({ purchaseOrderId: order!.id }));
        await asPurchasing(approver, (api) =>
          api.approvePurchaseOrder({ purchaseOrderId: order!.id, decision: 'APPROVED' })
        );
        await asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId: order!.id }));
        const receipt = await asPurchasing(buyer, (api) =>
          api.createGoodsReceipt(
            receiptInput(state.supplierId, 'on-valid-po', {
              purchaseOrderId: order!.id,
              line: { purchaseOrderLineId: order!.lines[0]!.id, receivedPacks: 5 },
            })
          )
        );
        const posted = await asPurchasing(buyer, (api) =>
          api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
        );
        expect(posted).toMatchObject({ goodsReceiptId: receipt!.id });
        expect(await receiptStatus(receipt!.id)).toBe('POSTED');
        expect(await orderStatus(order!.id)).toBe('RECEIVING');
        expect(await skipCount()).toBe(0);
      });
    });

    // ----- Checks OFF -------------------------------------------------------------------------

    /** Two drafts per state: one posted while OFF, one posted once the checks are back ON. */
    const draftsToPostOff = new Map<StateKey, { id: string; reference: string }>();
    const draftsToPostOn = new Map<StateKey, { id: string; reference: string }>();

    describe('with the checks OFF (owner switched them off: version 1)', () => {
      beforeAll(async () => {
        if (!databaseUrl) return;
        const result = await switchChecks(E.org, E.owner, false);
        expect(result.policy.version).toBe(1);
      });

      it.each(STATES)(
        'creates a purchase order for a supplier with $label and records one skip',
        async (state) => {
          const reference = `PO-off-${state.key}-${suffix}`;
          const order = await asPurchasing(buyer, (api) =>
            api.createPurchaseOrder(orderInput(state.supplierId, reference))
          );
          expect(order).toMatchObject({ reference, supplierId: state.supplierId, status: 'DRAFT' });
          expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
            expectedSkip('PURCHASE_ORDER_CREATE', state, { purchaseOrderId: order!.id, reference }),
          ]);
        }
      );

      it.each(WITH_ORDERS)(
        'approves an order for a supplier now holding $label and records one skip',
        async (state) => {
          const purchaseOrderId = orderOf(state.key, 'approve-off');
          await expect(
            asPurchasing(approver, (api) =>
              api.approvePurchaseOrder({ purchaseOrderId, decision: 'APPROVED' })
            )
          ).resolves.toMatchObject({ id: purchaseOrderId, status: 'APPROVED' });
          expect(await skipsAbout({ purchaseOrderId })).toEqual([
            expectedSkip('PURCHASE_ORDER_APPROVE', state, { purchaseOrderId }, 1, E.approver),
          ]);
        }
      );

      it.each(WITH_ORDERS)(
        'sends an order for a supplier now holding $label and records one skip',
        async (state) => {
          const purchaseOrderId = orderOf(state.key, 'send-off');
          await expect(
            asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId }))
          ).resolves.toMatchObject({ id: purchaseOrderId, status: 'SENT' });
          expect(await skipsAbout({ purchaseOrderId })).toEqual([
            expectedSkip('PURCHASE_ORDER_SEND', state, { purchaseOrderId }),
          ]);
        }
      );

      it.each(STATES)(
        'drafts goods receipts from a supplier with $label and records one skip each',
        async (state) => {
          for (const [drafts, label] of [
            [draftsToPostOff, `off-${state.key}`],
            [draftsToPostOn, `off-then-on-${state.key}`],
          ] as const) {
            const input = receiptInput(state.supplierId, label);
            const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
            expect(receipt).toMatchObject({ status: 'DRAFT', supplierId: state.supplierId });
            drafts.set(state.key, { id: receipt!.id, reference: input.reference });
            expect(
              await skipsAbout({ reference: input.reference, goodsReceiptId: receipt!.id })
            ).toEqual([
              expectedSkip('GOODS_RECEIPT_CREATE', state, { reference: input.reference }),
            ]);
          }
        }
      );

      it.each(STATES)(
        'posts a goods receipt from a supplier with $label and records one skip',
        async (state) => {
          const draft = draftsToPostOff.get(state.key);
          expect(draft, 'the draft from the previous step').toBeDefined();
          await expect(
            asPurchasing(buyer, (api) =>
              api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: draft!.id })
            )
          ).resolves.toMatchObject({ goodsReceiptId: draft!.id });
          expect(await receiptStatus(draft!.id)).toBe('POSTED');
          expect(
            await skipsAbout({ reference: draft!.reference, goodsReceiptId: draft!.id })
          ).toEqual([
            expectedSkip('GOODS_RECEIPT_CREATE', state, { reference: draft!.reference }),
            expectedSkip('GOODS_RECEIPT_POST', state, {
              goodsReceiptId: draft!.id,
              reference: draft!.reference,
            }),
          ]);
        }
      );

      it.each(STATES)(
        'creates a central purchase order for a supplier with $label and records one skip',
        async (state) => {
          const reference = `CPO-off-${state.key}-${suffix}`;
          const order = await asPurchasing(buyer, (api) =>
            api.createCentralPurchaseOrder(centralInput(state.supplierId, reference))
          );
          expect(order).toMatchObject({ reference, supplierId: state.supplierId, status: 'DRAFT' });
          expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
            expectedSkip('CENTRAL_PURCHASE_ORDER_CREATE', state, {
              purchaseOrderId: order!.id,
              reference,
            }),
          ]);
        }
      );

      it('ranks every quote as comparable and says no supplier was checked', async () => {
        const before = await skipCount();
        const result = await asPurchasing(buyer, (api) =>
          api.compareQuotes({ requisitionLineId: E.requisitionLine })
        );
        expect(result.supplierChecksEnabled).toBe(false);
        expect(result.ranking).toHaveLength(STATES.length);
        for (const row of result.ranking) {
          expect(row).toMatchObject({ comparable: true, supplierChecked: false });
          expect(row.reasons).toContain(
            'Supplier licence and trade authorization not checked: supplier checks are turned off.'
          );
        }
        // A read leaves no evidence row.
        expect(await skipCount()).toBe(before);
      });

      it('shows the supplier read model as not checked, keeping the licence evidence apart', async () => {
        const suppliers = await asPurchasing(buyer, (api) => api.suppliers());
        for (const state of STATES) {
          expect(
            suppliers.find((supplier) => supplier.id === state.supplierId),
            state.key
          ).toMatchObject({
            eligibility: { orderable: true },
            compliance: { checked: false, policyVersion: 1, licenceStatus: state.licenceStatus },
          });
        }
      });

      it('runs an order from a supplier whose licence was superseded end to end, one skip per write', async () => {
        const state = stateOf('supersededByUnverified');
        const reference = `PO-off-lifecycle-${suffix}`;
        const order = await asPurchasing(buyer, (api) =>
          api.createPurchaseOrder(orderInput(state.supplierId, reference))
        );
        await asPurchasing(buyer, (api) => api.submitPurchaseOrder({ purchaseOrderId: order!.id }));
        await asPurchasing(approver, (api) =>
          api.approvePurchaseOrder({ purchaseOrderId: order!.id, decision: 'APPROVED' })
        );
        await asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId: order!.id }));
        const input = receiptInput(state.supplierId, 'off-lifecycle', {
          purchaseOrderId: order!.id,
          line: { purchaseOrderLineId: order!.lines[0]!.id, receivedPacks: 5 },
        });
        const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
        await asPurchasing(buyer, (api) =>
          api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
        );
        expect(await receiptStatus(receipt!.id)).toBe('POSTED');
        expect(await orderStatus(order!.id)).toBe('RECEIVING');
        expect(
          await skipsAbout({ reference, purchaseOrderId: order!.id, goodsReceiptId: receipt!.id })
        ).toEqual([
          expectedSkip('PURCHASE_ORDER_CREATE', state, { purchaseOrderId: order!.id, reference }),
          expectedSkip(
            'PURCHASE_ORDER_APPROVE',
            state,
            { purchaseOrderId: order!.id },
            1,
            E.approver
          ),
          expectedSkip('PURCHASE_ORDER_SEND', state, { purchaseOrderId: order!.id }),
          expectedSkip('GOODS_RECEIPT_CREATE', state, {
            purchaseOrderId: order!.id,
            reference: input.reference,
          }),
          expectedSkip('GOODS_RECEIPT_POST', state, {
            purchaseOrderId: order!.id,
            goodsReceiptId: receipt!.id,
            reference: input.reference,
          }),
        ]);
        // The procurement read of the evidence returns the same rows; a cashier may not read it.
        const evidence = await asPolicy(buyer, (api) => api.skips({ purchaseOrderId: order!.id }));
        expect(evidence.map((skip) => skip.operation).sort()).toEqual([
          'GOODS_RECEIPT_CREATE',
          'GOODS_RECEIPT_POST',
          'PURCHASE_ORDER_APPROVE',
          'PURCHASE_ORDER_CREATE',
          'PURCHASE_ORDER_SEND',
        ]);
        expect(evidence.every((skip) => skip.policyVersion === 1)).toBe(true);
        await expect(
          asPolicy(e(E.cashier), (api) => api.skips({ purchaseOrderId: order!.id }))
        ).rejects.toMatchObject(NO_PERMISSION);
      });

      describe('still enforces everything that is not supplier licensing or authorization', () => {
        const state = stateOf('supersededByUnverified');

        it('refuses self-approval', async () => {
          const reference = `PO-off-self-${suffix}`;
          const order = await asPurchasing(buyer, (api) =>
            api.createPurchaseOrder(orderInput(state.supplierId, reference))
          );
          await asPurchasing(buyer, (api) =>
            api.submitPurchaseOrder({ purchaseOrderId: order!.id })
          );
          await expect(
            asPurchasing(buyer, (api) =>
              api.approvePurchaseOrder({ purchaseOrderId: order!.id, decision: 'APPROVED' })
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
          expect(await orderStatus(order!.id)).toBe('SUBMITTED');
          // The order's own creation evidence only: the refused approval left none.
          expect(
            (await skipsAbout({ reference, purchaseOrderId: order!.id })).map((s) => s.operation)
          ).toEqual(['PURCHASE_ORDER_CREATE']);
        });

        it('refuses a direct purchase whose bypass the receiver approved, leaving no skip behind', async () => {
          const input = receiptInput(state.supplierId, 'off-self-bypass', {
            bypassApprover: E.buyer,
          });
          await expect(
            asPurchasing(buyer, (api) => api.createGoodsReceipt(input))
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
          expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
          // The skip was written inside the refused request's transaction and went with it.
          expect(await skipsAbout({ reference: input.reference })).toEqual([]);
        });

        it('refuses a receipt with a blank supplier invoice reference', async () => {
          const input = receiptInput(state.supplierId, 'off-no-invoice', {
            supplierInvoiceRef: '   ',
          });
          await expect(
            asPurchasing(buyer, (api) => api.createGoodsReceipt(input))
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
          expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
          expect(await skipsAbout({ reference: input.reference })).toEqual([]);
        });

        it('refuses goods-in to a user without the procurement capability', async () => {
          const input = receiptInput(state.supplierId, 'off-cashier');
          await expect(
            asPurchasing(e(E.cashier), (api) => api.createGoodsReceipt(input))
          ).rejects.toMatchObject(NO_PERMISSION);
          expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
        });

        it('refuses a central order to a user without organization-wide purchasing access', async () => {
          const reference = `CPO-off-noaccess-${suffix}`;
          await expect(
            asPurchasing(approver, (api) =>
              api.createCentralPurchaseOrder(centralInput(state.supplierId, reference))
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
          expect(await skipsAbout({ reference })).toEqual([]);
        });

        it('leaves no skip row when an order passes the supplier gate and then fails validation', async () => {
          const reference = `PO-off-unknown-medicine-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createPurchaseOrder(
                orderInput(state.supplierId, reference, {
                  medicineId: `missing_medicine_${suffix}`,
                  packLevelId: E.packLevel,
                })
              )
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_TENANT_REFERENCE' });
          expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
          expect(await skipsAbout({ reference })).toEqual([]);
        });

        it("refuses another tenant's supplier on tenancy, not on licensing", async () => {
          const reference = `PO-off-cross-tenant-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) => api.createPurchaseOrder(orderInput(B.supplier, reference)))
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_TENANT_REFERENCE' });
          expect(await skipsAbout({ reference })).toEqual([]);
        });

        it('refuses to post a line whose pack has expired since it was drafted', async () => {
          const input = receiptInput(state.supplierId, 'off-expired-pack', {
            receivedAt: new Date('2026-03-01T09:00:00.000Z'),
            line: { printedExpiry: new Date('2026-06-01T00:00:00.000Z') },
          });
          const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
          await expect(
            asPurchasing(buyer, (api) =>
              api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
            )
          ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'EXPIRED_PACK' });
          expect(await receiptStatus(receipt!.id)).toBe('DRAFT');
          expect(
            (await skipsAbout({ goodsReceiptId: receipt!.id, reference: input.reference })).map(
              (skip) => skip.operation
            )
          ).toEqual(['GOODS_RECEIPT_CREATE']);
        });
      });

      describe('applies to controlled medicines too, and leaves the controlled-drug safeguards alone', () => {
        const state = stateOf('supersededByUnverified');

        /** Unlicensed, unauthorized, and licensed only on paper: all unchecked while OFF. */
        const CONTROLLED_STATES = [stateOf('none'), stateOf('unauthorized'), state];

        it.each(CONTROLLED_STATES)(
          'raises an order of a controlled medicine (alone or among ordinary lines) from a supplier with $label, recording one skip each',
          async (subject) => {
            const reference = `PO-off-controlled-${subject.key}-${suffix}`;
            const order = await asPurchasing(buyer, (api) =>
              api.createPurchaseOrder(orderInput(subject.supplierId, reference, CONTROLLED()))
            );
            expect(order).toMatchObject({ reference, supplierId: subject.supplierId });
            expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
              expectedSkip('PURCHASE_ORDER_CREATE', subject, {
                purchaseOrderId: order!.id,
                reference,
              }),
            ]);

            const mixed = `PO-off-mixed-${subject.key}-${suffix}`;
            const input = orderInput(subject.supplierId, mixed);
            const mixedOrder = await asPurchasing(buyer, (api) =>
              api.createPurchaseOrder({
                ...input,
                lines: [...input.lines, { ...input.lines[0]!, ...CONTROLLED() }],
              })
            );
            expect(await skipsAbout({ reference: mixed, purchaseOrderId: mixedOrder!.id })).toEqual(
              [
                expectedSkip('PURCHASE_ORDER_CREATE', subject, {
                  purchaseOrderId: mixedOrder!.id,
                  reference: mixed,
                }),
              ]
            );
          }
        );

        it.each(CONTROLLED_STATES)(
          'drafts a controlled goods receipt from a supplier with $label (one skip), and posting still waits for the qualified-person PIN',
          async (subject) => {
            const input = receiptInput(subject.supplierId, `off-controlled-${subject.key}`, {
              line: CONTROLLED(),
            });
            const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
            expect(receipt).toMatchObject({ status: 'DRAFT', supplierId: subject.supplierId });
            // The pharmacist witness PIN is an independent controlled-drug safeguard: the
            // owner switch never reads it, so posting is held exactly as with the checks ON.
            await expect(
              asPurchasing(buyer, (api) =>
                api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
              )
            ).resolves.toEqual({ blocked: 'A different qualified person must enter their PIN.' });
            expect(await receiptStatus(receipt!.id)).toBe('DRAFT');
            expect(
              await skipsAbout({ goodsReceiptId: receipt!.id, reference: input.reference })
            ).toEqual([
              expectedSkip('GOODS_RECEIPT_CREATE', subject, { reference: input.reference }),
            ]);
          }
        );

        it.each(CONTROLLED_STATES)(
          'creates a central order of a controlled medicine for a supplier with $label, recording one skip',
          async (subject) => {
            const reference = `CPO-off-controlled-${subject.key}-${suffix}`;
            const order = await asPurchasing(buyer, (api) =>
              api.createCentralPurchaseOrder(
                centralInput(subject.supplierId, reference, CONTROLLED())
              )
            );
            expect(order).toMatchObject({ reference, supplierId: subject.supplierId });
            expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
              expectedSkip('CENTRAL_PURCHASE_ORDER_CREATE', subject, {
                purchaseOrderId: order!.id,
                reference,
              }),
            ]);
          }
        );

        it('approves and sends an order that holds a controlled medicine, recording one skip each', async () => {
          const toApprove = orderOf(state.key, 'approve-controlled');
          const toSend = orderOf(state.key, 'send-controlled');
          await asPurchasing(approver, (api) =>
            api.approvePurchaseOrder({ purchaseOrderId: toApprove, decision: 'APPROVED' })
          );
          await asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId: toSend }));
          expect(await orderStatus(toApprove)).toBe('APPROVED');
          expect(await orderStatus(toSend)).toBe('SENT');
          expect(await skipsAbout({ purchaseOrderId: toApprove })).toEqual([
            expectedSkip(
              'PURCHASE_ORDER_APPROVE',
              state,
              { purchaseOrderId: toApprove },
              1,
              E.approver
            ),
          ]);
          expect(await skipsAbout({ purchaseOrderId: toSend })).toEqual([
            expectedSkip('PURCHASE_ORDER_SEND', state, { purchaseOrderId: toSend }),
          ]);
        });

        it("records a valid supplier's controlled receipt as unchecked too, and still holds it for the PIN", async () => {
          const valid = stateOf('valid');
          const input = receiptInput(valid.supplierId, 'off-controlled-valid', {
            line: CONTROLLED(),
          });
          const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
          expect(receipt).toMatchObject({ status: 'DRAFT' });
          await expect(
            asPurchasing(buyer, (api) =>
              api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
            )
          ).resolves.toEqual({ blocked: 'A different qualified person must enter their PIN.' });
          expect(await receiptStatus(receipt!.id)).toBe('DRAFT');
          expect(
            await skipsAbout({ goodsReceiptId: receipt!.id, reference: input.reference })
          ).toEqual([expectedSkip('GOODS_RECEIPT_CREATE', valid, { reference: input.reference })]);
        });
      });

      it("keeps org E's skip evidence invisible to org B", async () => {
        expect(await skipCount()).toBeGreaterThan(0);
        expect(
          await rows(
            B.org,
            `SELECT 1 FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1`,
            E.org
          )
        ).toEqual([]);
        await expect(
          asPolicy({ organizationId: B.org, userId: B.owner }, (api) =>
            api.skips({ supplierId: stateOf('supersededByUnverified').supplierId })
          )
        ).resolves.toEqual([]);
      });
    });

    // ----- Back ON ----------------------------------------------------------------------------

    describe('with the checks back ON (version 2)', () => {
      let offEvidence: Record<string, unknown>[] = [];
      const allSkips = () =>
        rows<Record<string, unknown>>(
          E.org,
          `SELECT * FROM pharmacy_supplier_compliance_skips WHERE "organizationId" = $1 ORDER BY id`,
          E.org
        );

      beforeAll(async () => {
        if (!databaseUrl) return;
        offEvidence = await allSkips();
        const result = await switchChecks(E.org, E.owner, true);
        expect(result.policy.version).toBe(2);
      });

      it.each(NON_VALID)(
        'refuses to post a receipt drafted while OFF from a supplier with $label',
        async (state) => {
          const draft = draftsToPostOn.get(state.key);
          expect(draft, 'the draft made while the checks were off').toBeDefined();
          const before = await skipsAbout({
            reference: draft!.reference,
            goodsReceiptId: draft!.id,
          });
          await expect(
            asPurchasing(buyer, (api) =>
              api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: draft!.id })
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          expect(await receiptStatus(draft!.id)).toBe('DRAFT');
          // Only the evidence written while OFF; the current policy won and wrote nothing.
          expect(
            await skipsAbout({ reference: draft!.reference, goodsReceiptId: draft!.id })
          ).toEqual(before);
          expect(before.map((skip) => skip.operation)).toEqual(['GOODS_RECEIPT_CREATE']);
        }
      );

      it("posts the valid supplier's OFF-era draft, checked this time and with no new skip", async () => {
        const draft = draftsToPostOn.get('valid');
        expect(draft).toBeDefined();
        await expect(
          asPurchasing(buyer, (api) =>
            api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: draft!.id })
          )
        ).resolves.toMatchObject({ goodsReceiptId: draft!.id });
        expect(
          (await skipsAbout({ reference: draft!.reference, goodsReceiptId: draft!.id })).map(
            (skip) => skip.operation
          )
        ).toEqual(['GOODS_RECEIPT_CREATE']);
      });

      it.each(NON_VALID)(
        'refuses createPurchaseOrder again for a supplier with $label',
        async (state) => {
          const before = await skipCount();
          const reference = `PO-on-again-${state.key}-${suffix}`;
          await expect(
            asPurchasing(buyer, (api) =>
              api.createPurchaseOrder(orderInput(state.supplierId, reference))
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: state.refusal });
          expect(await skipCount()).toBe(before);
        }
      );

      it('leaves the evidence written while OFF exactly as it was, and adds none', async () => {
        expect(offEvidence.length).toBeGreaterThan(0);
        expect(offEvidence.every((skip) => skip.policyVersion === 1)).toBe(true);
        expect(await allSkips()).toEqual(offEvidence);
      });
    });

    // ----- DEV-466: a licence superseded from another supplier's record ------------------------

    describe("with a licence superseded from another supplier's record (DEV-466 strict reading)", () => {
      const quoteReference = `Q-${CROSS.key}-${suffix}`;

      beforeAll(async () => {
        if (!databaseUrl) return;
        // Orders raised while the supplier still holds its own verified licence.
        await withTenantDb(
          E.org,
          async (tx) => {
            await supplierWithLicence(tx, CROSS.supplierId, {
              id: licenceOf(CROSS.key),
              expiresAt: FUTURE,
              verified: true,
            });
            await seedOrder(tx, orderOf(CROSS.key, 'approve-on'), CROSS.supplierId, 'SUBMITTED');
            await seedOrder(tx, orderOf(CROSS.key, 'approve-off'), CROSS.supplierId, 'SUBMITTED');
            await seedOrder(tx, orderOf(CROSS.key, 'send-on'), CROSS.supplierId, 'APPROVED');
            await seedOrder(tx, orderOf(CROSS.key, 'send-off'), CROSS.supplierId, 'APPROVED');
            await tx.pharmacyQuote.create({
              data: {
                requisitionId: E.requisition,
                supplierId: CROSS.supplierId,
                reference: quoteReference,
                quotedAt: new Date(Date.now() - DAY),
                validUntil: new Date(Date.now() + 30 * DAY),
                lines: {
                  create: {
                    requisitionLineId: E.requisitionLine,
                    pricePerPackMinor: 8_500,
                    canonicalUnitsPerPack: 10,
                  },
                },
              },
            });
          },
          { timeout: 60_000 }
        );
        // A LEGACY cross-supplier link: another supplier's filing names that licence as the
        // one it supersedes. The same-supplier insert trigger refuses such a filing now, so it
        // is planted as the schema owner with that one trigger disabled and re-enabled inside a
        // single transaction: ALTER TABLE holds an exclusive lock until COMMIT, so no other
        // session ever sees the trigger off.
        const owner = new pg.Client({ connectionString: ownerUrl });
        await owner.connect();
        try {
          await owner.query('BEGIN');
          await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
          await owner.query(
            'ALTER TABLE pharmacy_supplier_licences DISABLE TRIGGER pharmacy_supplier_licence_same_supplier_supersession'
          );
          await owner.query(
            `INSERT INTO pharmacy_supplier_licences
               (id, "organizationId", "supplierId", "licenceType", "licenceNumber", "issuingAuthority",
                "issuedAt", "expiresAt", "verifiedAt", "supersedesId")
             VALUES ($1, $2, $3, 'DRUG_SALE', $1, 'DRAP',
                     '2025-01-01T00:00:00Z', $4, '2025-01-02T00:00:00Z', $5)`,
            [licenceOf('superseder'), E.org, E.superseder, FUTURE, licenceOf(CROSS.key)]
          );
          await owner.query(
            'ALTER TABLE pharmacy_supplier_licences ENABLE TRIGGER pharmacy_supplier_licence_same_supplier_supersession'
          );
          await owner.query('COMMIT');
        } catch (error) {
          await owner.query('ROLLBACK');
          throw error;
        } finally {
          await owner.end();
        }
        expect(await policyRow(E.org)).toMatchObject([
          { supplierComplianceChecksEnabled: true, supplierCompliancePolicyVersion: 2 },
        ]);
      });

      it("refuses a new filing that supersedes another supplier's licence; the guard is back on", async () => {
        const [guard] = await rows<{ tgenabled: string }>(
          E.org,
          `SELECT tgenabled::text AS tgenabled FROM pg_trigger
            WHERE tgname = 'pharmacy_supplier_licence_same_supplier_supersession'
              AND tgrelid = 'pharmacy_supplier_licences'::regclass`
        );
        expect(guard).toEqual({ tgenabled: 'O' });
        const attempt = (supplierId: string, id: string) =>
          withTenantDb(E.org, (tx) =>
            fileLicence(tx, supplierId, {
              id,
              expiresAt: FUTURE,
              verified: true,
              supersedesId: licenceOf('valid'),
            })
          )
            .then(() => 'ACCEPTED — the filing was expected to be refused')
            .catch((error: Error) => error.message);
        expect(await attempt(E.superseder, licenceOf('superseder', 2))).toContain(
          'SUPPLIER_LICENCE_SUPERSESSION_CROSS_SUPPLIER'
        );
        expect(
          await countWhere('pharmacy_supplier_licences', 'id', licenceOf('superseder', 2))
        ).toBe(0);
        // The valid supplier's licence is still the only filing naming nothing, and stands.
        const suppliers = await asPurchasing(buyer, (api) => api.suppliers());
        expect(
          suppliers.find((supplier) => supplier.id === stateOf('valid').supplierId)
        ).toMatchObject({ compliance: { licenceStatus: 'VALID' } });
      });

      it('reads the licence as superseded, and the superseding supplier as licensed', async () => {
        const suppliers = await asPurchasing(buyer, (api) => api.suppliers());
        expect(suppliers.find((supplier) => supplier.id === CROSS.supplierId)).toMatchObject({
          eligibility: { orderable: false },
          compliance: { checked: true, policyVersion: 2, licenceStatus: 'SUPERSEDED' },
        });
        expect(suppliers.find((supplier) => supplier.id === E.superseder)).toMatchObject({
          eligibility: { orderable: true },
          compliance: { checked: true, licenceStatus: 'VALID' },
        });
      });

      it('refuses createPurchaseOrder, approval and the SENT transition while ON', async () => {
        const before = await skipCount();
        const reference = `PO-on-${CROSS.key}-${suffix}`;
        await expect(
          asPurchasing(buyer, (api) =>
            api.createPurchaseOrder(orderInput(CROSS.supplierId, reference))
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: CROSS.refusal });
        await expect(
          asPurchasing(approver, (api) =>
            api.approvePurchaseOrder({
              purchaseOrderId: orderOf(CROSS.key, 'approve-on'),
              decision: 'APPROVED',
            })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: CROSS.refusal });
        await expect(
          asPurchasing(buyer, (api) =>
            api.sendPurchaseOrder({ purchaseOrderId: orderOf(CROSS.key, 'send-on') })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: CROSS.refusal });
        expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
        expect(await orderStatus(orderOf(CROSS.key, 'approve-on'))).toBe('SUBMITTED');
        expect(await orderStatus(orderOf(CROSS.key, 'send-on'))).toBe('APPROVED');
        expect(await skipCount()).toBe(before);
      });

      it('refuses createGoodsReceipt and the central order while ON, and ranks the quote not comparable', async () => {
        const before = await skipCount();
        const input = receiptInput(CROSS.supplierId, `on-${CROSS.key}`);
        await expect(
          asPurchasing(buyer, (api) => api.createGoodsReceipt(input))
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: CROSS.refusal });
        const reference = `CPO-on-${CROSS.key}-${suffix}`;
        await expect(
          asPurchasing(buyer, (api) =>
            api.createCentralPurchaseOrder(centralInput(CROSS.supplierId, reference))
          )
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const comparison = await asPurchasing(buyer, (api) =>
          api.compareQuotes({ requisitionLineId: E.requisitionLine })
        );
        expect(comparison.ranking.find((row) => row.supplierId === CROSS.supplierId)).toMatchObject(
          {
            comparable: false,
            supplierChecked: true,
          }
        );
        expect(await countWhere('pharmacy_goods_receipts', 'reference', input.reference)).toBe(0);
        expect(await countWhere('pharmacy_purchase_orders', 'reference', reference)).toBe(0);
        expect(await skipCount()).toBe(before);
      });

      describe('and the checks OFF (version 3)', () => {
        beforeAll(async () => {
          if (!databaseUrl) return;
          const result = await switchChecks(E.org, E.owner, false);
          expect(result.policy.version).toBe(3);
        });

        it('creates, approves and sends orders, one skip each naming the licence SUPERSEDED', async () => {
          const reference = `PO-off-${CROSS.key}-${suffix}`;
          const order = await asPurchasing(buyer, (api) =>
            api.createPurchaseOrder(orderInput(CROSS.supplierId, reference))
          );
          expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
            expectedSkip(
              'PURCHASE_ORDER_CREATE',
              CROSS,
              { purchaseOrderId: order!.id, reference },
              3
            ),
          ]);
          const toApprove = orderOf(CROSS.key, 'approve-off');
          await expect(
            asPurchasing(approver, (api) =>
              api.approvePurchaseOrder({ purchaseOrderId: toApprove, decision: 'APPROVED' })
            )
          ).resolves.toMatchObject({ status: 'APPROVED' });
          expect(await skipsAbout({ purchaseOrderId: toApprove })).toEqual([
            expectedSkip(
              'PURCHASE_ORDER_APPROVE',
              CROSS,
              { purchaseOrderId: toApprove },
              3,
              E.approver
            ),
          ]);
          const toSend = orderOf(CROSS.key, 'send-off');
          await expect(
            asPurchasing(buyer, (api) => api.sendPurchaseOrder({ purchaseOrderId: toSend }))
          ).resolves.toMatchObject({ status: 'SENT' });
          expect(await skipsAbout({ purchaseOrderId: toSend })).toEqual([
            expectedSkip('PURCHASE_ORDER_SEND', CROSS, { purchaseOrderId: toSend }, 3),
          ]);
        });

        it('drafts and posts a goods receipt, one skip each', async () => {
          const input = receiptInput(CROSS.supplierId, `off-${CROSS.key}`);
          const receipt = await asPurchasing(buyer, (api) => api.createGoodsReceipt(input));
          await expect(
            asPurchasing(buyer, (api) =>
              api.postGoodsReceipt({ branchId: E.branch, goodsReceiptId: receipt!.id })
            )
          ).resolves.toMatchObject({ goodsReceiptId: receipt!.id });
          expect(await receiptStatus(receipt!.id)).toBe('POSTED');
          expect(
            await skipsAbout({ reference: input.reference, goodsReceiptId: receipt!.id })
          ).toEqual([
            expectedSkip('GOODS_RECEIPT_CREATE', CROSS, { reference: input.reference }, 3),
            expectedSkip(
              'GOODS_RECEIPT_POST',
              CROSS,
              { goodsReceiptId: receipt!.id, reference: input.reference },
              3
            ),
          ]);
        });

        it('creates a central purchase order with one skip, and ranks the quote unchecked', async () => {
          const reference = `CPO-off-${CROSS.key}-${suffix}`;
          const order = await asPurchasing(buyer, (api) =>
            api.createCentralPurchaseOrder(centralInput(CROSS.supplierId, reference))
          );
          expect(await skipsAbout({ reference, purchaseOrderId: order!.id })).toEqual([
            expectedSkip(
              'CENTRAL_PURCHASE_ORDER_CREATE',
              CROSS,
              { purchaseOrderId: order!.id, reference },
              3
            ),
          ]);
          const comparison = await asPurchasing(buyer, (api) =>
            api.compareQuotes({ requisitionLineId: E.requisitionLine })
          );
          expect(
            comparison.ranking.find((row) => row.supplierId === CROSS.supplierId)
          ).toMatchObject({ comparable: true, supplierChecked: false });
        });
      });
    });
  }
);

// ===========================================================================
// 4. A tenant ADMIN may manage this one setting (org H has no owner-role holder)
// ===========================================================================

describeIfDatabase(
  'DEV-753 a verified tenant ADMIN with the settings grant manages the switch (bounded)',
  { timeout: 60_000 },
  () => {
    const h = (userId: string, extra: Partial<Actor> = {}): Actor => ({
      organizationId: H.org,
      userId,
      ...extra,
    });

    it('refuses an ADMIN without the settings grant and a manager, even with an ADMIN session', async () => {
      for (const actor of [
        h(H.adminNoRole, { tenantRole: 'ADMIN' }),
        h(H.manager),
        h(H.manager, { tenantRole: 'ADMIN' }),
      ]) {
        await expect(
          asPolicy(actor, (api) =>
            api.setPolicy({ checksEnabled: false, expectedVersion: 0, acknowledgement: ack() })
          )
        ).rejects.toMatchObject(OWNER_ONLY);
      }
      expect(await policyRow(H.org)).toEqual([]);
    });

    it('lets the ADMIN turn the checks off and an owner-operator ADMIN turn them back on, audited as ADMIN', async () => {
      const off = await asPolicy(h(H.admin, { tenantRole: 'ADMIN' }), async (api, ctx) => ({
        result: await api.setPolicy({
          checksEnabled: false,
          expectedVersion: 0,
          acknowledgement: ack(),
        }),
        audit: ctx.audit.detail,
      }));
      expect(off.result).toMatchObject({
        changed: true,
        policy: { checksEnabled: false, version: 1 },
      });
      expect(off.audit).toMatchObject({ metadata: { authority: 'ADMIN', warningVersion } });
      const offAudit = await auditRows(H.org, 'supplierComplianceChecksEnabled');
      expect(offAudit).toEqual([
        expect.objectContaining({
          oldValue: true,
          newValue: false,
          actorUserId: H.admin,
          policyVersion: 1,
          acknowledgement: expect.stringMatching(/^supplier-compliance-off@\d+: /),
        }),
      ]);

      const on = await asPolicy(h(H.ownerOperatorAdmin, { tenantRole: 'ADMIN' }), (api) =>
        api.setPolicy({ checksEnabled: true, expectedVersion: 1 })
      );
      expect(on).toMatchObject({ changed: true, policy: { checksEnabled: true, version: 2 } });
      const all = await auditRows(H.org, 'supplierComplianceChecksEnabled');
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(
        expect.objectContaining({
          newValue: true,
          actorUserId: H.ownerOperatorAdmin,
          policyVersion: 2,
        })
      );
      // The first audit row is untouched by the later change.
      expect(all).toContainEqual(offAudit[0]);
    });

    it('applies the same bounded authority in the database: the ADMIN writes, an ADMIN without the grant cannot', async () => {
      const turnOff = `UPDATE pharmacy_owner_policies
            SET "supplierComplianceChecksEnabled" = false,
                "supplierComplianceAcknowledgement" = 'acknowledged',
                "updatedByUserId" = $2
          WHERE "organizationId" = $1`;
      const refusal = await sqlRefusal(H.org, turnOff, [H.org, H.adminNoRole], H.adminNoRole);
      expect(refusal).toContain('SUPPLIER_COMPLIANCE_POLICY_AUTHORITY_REQUIRED');
      // The same bounded rule as the application: a role DENY or a user DENY wins over the
      // ADMIN's '*', an inactive ADMIN is out, and another tenant's ADMIN is no one here.
      for (const userId of [
        H.manager,
        H.adminRoleDenied,
        H.adminUserDenied,
        H.inactiveAdmin,
        B.owner,
      ]) {
        expect(await sqlRefusal(H.org, turnOff, [H.org, userId], userId), userId).toContain(
          'SUPPLIER_COMPLIANCE_POLICY_AUTHORITY_REQUIRED'
        );
      }
      expect(await policyRow(H.org)).toEqual([
        expect.objectContaining({
          supplierComplianceChecksEnabled: true,
          supplierCompliancePolicyVersion: 2,
        }),
      ]);
      // The verified ADMIN, writing as themselves, is accepted by the same trigger.
      await withTenantDb(H.org, (db) => db.$executeRawUnsafe(turnOff, H.org, H.admin), {
        userId: H.admin,
      });
      expect(await policyRow(H.org)).toEqual([
        expect.objectContaining({
          supplierComplianceChecksEnabled: false,
          supplierCompliancePolicyVersion: 3,
          updatedByUserId: H.admin,
        }),
      ]);
    });
  }
);
