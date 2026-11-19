// @vitest-environment node
/**
 * DEV-103 — who counts as "someone else who could approve" reversing a supplier expense invoice,
 * against PostgreSQL as the restricted runtime role. The set `otherApReversalApprovers` returns
 * must be exactly the set of people the real reversal procedure lets approve: every candidate
 * below really tries to reverse an invoice the recorder entered, through the AP router with their
 * own session and PIN, and the two sets are compared. Candidates: a second owner with and without
 * the counter grant, with a counter DENY, with an admin:access or finance:read DENY, inactive, on
 * leave, without a PIN, assigned only to another branch, managers who are not owner-level, and an
 * owner of another organization. The card-terminal rule itself is unchanged: with its counter gate
 * it still leaves out the owners without counter access. Skips without a database URL.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const id = (label: string) => `apappr_${label}_${suffix}`;
const organizationId = id('org');
const otherOrganizationId = id('org_other');
/** An organization with two owners, the second without the counter grant. */
const pairOrganizationId = id('org_pair');
const pairBranchId = id('branch_pair');
const branchId = id('branch');
const otherBranchId = id('branch_other');
const recorderId = id('recorder');
const PIN = '2468';

type Candidate = {
  key: string;
  organizationId: string;
  role: 'ADMIN' | 'EMPLOYEE';
  /** owner: every capability; finance: admin:access, finance:read and pharmacy:manage only. */
  orgRole: 'owner' | 'finance';
  status: 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE';
  pin: boolean;
  deny?: string;
  assignedTo?: string;
};

const candidates: Candidate[] = [
  {
    key: 'owner_counter',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
  },
  {
    key: 'owner_no_counter',
    organizationId,
    role: 'ADMIN',
    orgRole: 'finance',
    status: 'ACTIVE',
    pin: true,
  },
  {
    key: 'owner_counter_deny',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    deny: 'pharmacy:counter',
  },
  {
    key: 'owner_admin_deny',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    deny: 'admin:access',
  },
  {
    key: 'owner_finance_deny',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    deny: 'finance:read',
  },
  {
    key: 'owner_inactive',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'INACTIVE',
    pin: true,
  },
  {
    key: 'owner_on_leave',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ON_LEAVE',
    pin: true,
  },
  {
    key: 'owner_no_pin',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: false,
  },
  {
    key: 'owner_other_branch',
    organizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    assignedTo: otherBranchId,
  },
  {
    key: 'manager_here',
    organizationId,
    role: 'EMPLOYEE',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    assignedTo: branchId,
  },
  {
    key: 'manager_other_branch',
    organizationId,
    role: 'EMPLOYEE',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
    assignedTo: otherBranchId,
  },
  {
    key: 'owner_other_org',
    organizationId: otherOrganizationId,
    role: 'ADMIN',
    orgRole: 'owner',
    status: 'ACTIVE',
    pin: true,
  },
];
const userId = (candidate: Candidate) => id(candidate.key);
const pairRecorder: Candidate = {
  key: 'pair_recorder',
  organizationId: pairOrganizationId,
  role: 'ADMIN',
  orgRole: 'owner',
  status: 'ACTIVE',
  pin: true,
};
const pairOwner: Candidate = {
  key: 'pair_owner_no_counter',
  organizationId: pairOrganizationId,
  role: 'ADMIN',
  orgRole: 'finance',
  status: 'ACTIVE',
  pin: true,
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  ap: typeof import('./ap-invoices');
  approvers: typeof import('./ap-reversal-approvers');
  cardTerminal: typeof import('@/lib/pharmacy/card-terminal/review-approvers');
  router: (typeof import('@/server/routers/pharmacy-ap-invoices'))['pharmacyApInvoicesRouter'];
};
let deps: Deps;
const recorder = { organizationId, branchId, actorId: recorderId };
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(organizationId, work, { timeout: 30_000 });
const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, ap, approvers, cardTerminal, routerModule, guard, credentials] = await Promise.all(
    [
      import('@/lib/tenancy/scoped-db'),
      import('./ap-invoices'),
      import('./ap-reversal-approvers'),
      import('@/lib/pharmacy/card-terminal/review-approvers'),
      import('@/server/routers/pharmacy-ap-invoices'),
      import('@/lib/testing/rls-role-guard'),
      import('@/lib/restaurant/operator-credentials'),
    ]
  );
  deps = {
    withTenantDb: scoped.withTenantDb,
    createTenantDb: scoped.createTenantDb,
    ap,
    approvers,
    cardTerminal,
    router: routerModule.pharmacyApInvoicesRouter,
  };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`SET app.is_platform_admin = 'true'`);
    for (const [org, slug] of [
      [organizationId, `apappr-${suffix}`],
      [otherOrganizationId, `apappr-other-${suffix}`],
      [pairOrganizationId, `apappr-pair-${suffix}`],
    ]) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'AP approver fixture','AP approver fixture','PHARMACY','ACTIVE','SHARED',now(),now())`,
        [org, slug]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [`${org}_department`, org]
      );
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now()), ($3,$2,'finance','Finance owner',false,now())`,
        [`${org}_owner`, org, `${org}_finance`]
      );
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW')`,
        [`${org}_owner_all`, org, `${org}_owner`]
      );
      // An owner-level role with exactly what a reversal needs and no counter grant.
      for (const capability of ['admin:access', 'finance:read', 'pharmacy:manage']) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${org}_finance_${capability}`, org, `${org}_finance`, capability]
        );
      }
    }
    for (const [branch, org, code] of [
      [branchId, organizationId, `AA-${suffix}`],
      [otherBranchId, organizationId, `AB-${suffix}`],
      [id('branch_b'), otherOrganizationId, `AC-${suffix}`],
      [pairBranchId, pairOrganizationId, `AD-${suffix}`],
    ]) {
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'Approver pharmacy','1 Test Road','Lahore','PB',now(),now())`,
        [branch, org, code]
      );
    }
    const pinHash = await credentials.hashOperatorCredential('PIN', PIN);
    const people: Candidate[] = [
      {
        key: 'recorder',
        organizationId,
        role: 'ADMIN',
        orgRole: 'owner',
        status: 'ACTIVE',
        pin: true,
      },
      ...candidates,
      pairRecorder,
      pairOwner,
    ];
    for (const person of people) {
      const user = userId(person);
      const org = person.organizationId;
      await client.query(
        `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,$4,$5,'Pharmacy','Staff',$6,$7,now())`,
        [
          user,
          org,
          `${org}_${person.orgRole}`,
          `Person ${person.key}`,
          `${user}@ap-approvers.test`,
          person.role,
          person.status,
        ]
      );
      await client.query(
        `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Staff','ACTIVE',now())`,
        [`${user}_staff`, org, user]
      );
      if (person.pin) {
        await client.query(
          `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
          [`${user}_pin`, org, `${user}_staff`, pinHash]
        );
      }
      if (person.deny) {
        await client.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,$4,'DENY','fixture',now())`,
          [`${user}_deny`, org, user, person.deny]
        );
      }
      if (person.assignedTo) {
        await client.query(
          `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId",active,"updatedAt") VALUES ($1,$2,$3,$4,true,now())`,
          [`${user}_assignment`, org, person.assignedTo, user]
        );
      }
    }
  } finally {
    await client.end();
  }
}, 120_000);

async function recordBill(
  n: number,
  scope: { organizationId: string; branchId: string; actorId: string } = recorder
) {
  const result = await deps.withTenantDb(
    scope.organizationId,
    (db) =>
      deps.ap.recordApInvoice(db, scope, {
        branchId: scope.branchId,
        createKey: `apappr-bill-${suffix}-${n}`,
        reference: `AA-${suffix}-${n}`,
        payeeName: 'K-Electric',
        supplierInvoiceRef: `KE-${suffix}-${n}`,
        invoiceDate: day(-10),
        dueDate: day(-3),
        amountMinor: 12_345,
        currency: 'PKR',
        description: 'Electricity',
        evidenceReference: 'Bill scan',
      }),
    { timeout: 30_000 }
  );
  return result.invoice;
}

/** The candidate's own session, as the app builds it, calling the real reversal procedure. */
function callerFor(candidate: Candidate) {
  const org = candidate.organizationId;
  return deps.router.createCaller({
    db: deps.createTenantDb(org, userId(candidate)),
    entitlements: {
      organizationId: org,
      enabledModules: ['pharmacy-finance'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: userId(candidate),
        role: candidate.role,
        department: 'Pharmacy',
        status: candidate.status,
        organizationId: org,
        name: `Person ${candidate.key}`,
      },
    },
    organization: { id: org, vertical: 'PHARMACY', timezone: 'Asia/Karachi' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describeDb('DEV-103 who else could approve a supplier expense invoice reversal', () => {
  it('counts exactly the people the reversal procedure lets approve, and no one else', async () => {
    const counted = await inTenant((db) => deps.approvers.otherApReversalApprovers(db, recorder));
    const countedKeys = new Set(
      counted.map((person) => candidates.find((c) => userId(c) === person.id)?.key ?? person.id)
    );

    const approved = new Set<string>();
    const refusals: Record<string, string> = {};
    let n = 0;
    for (const candidate of candidates) {
      n += 1;
      const bill = await recordBill(n);
      try {
        const reversed = await callerFor(candidate).reverseInvoice({
          branchId,
          invoiceId: bill.id,
          commandKey: `apappr-rev-${suffix}-${n}`,
          reason: 'Entered twice',
          pin: PIN,
        });
        expect(reversed).toMatchObject({ status: 'REVERSED', reversedByUserId: userId(candidate) });
        approved.add(candidate.key);
      } catch (error) {
        refusals[candidate.key] = (error as { code?: string }).code ?? String(error);
        // A refused attempt changed nothing: the invoice is still posted.
        const after = await inTenant((db) =>
          db.pharmacyApInvoice.findFirst({ where: { organizationId, id: bill.id } })
        );
        expect(after?.status).toBe('POSTED');
      }
    }

    expect([...countedKeys].sort()).toEqual([...approved].sort());
    // Spelled out, so a change to either side shows which person moved.
    expect([...approved].sort()).toEqual(
      ['owner_counter', 'owner_counter_deny', 'owner_no_counter', 'owner_other_branch'].sort()
    );
    for (const key of [
      'owner_admin_deny',
      'owner_finance_deny',
      'owner_inactive',
      'owner_on_leave',
      'owner_no_pin',
      'manager_here',
      'manager_other_branch',
      'owner_other_org',
    ]) {
      expect(refusals[key], key).toMatch(/FORBIDDEN|UNAUTHORIZED/);
    }
  }, 180_000);

  it('leaves the card-terminal rule as it was: its counter gate still drops owners without counter access', async () => {
    const cardTerminal = await inTenant((db) =>
      deps.cardTerminal.otherCardTerminalReviewers(db, recorder)
    );
    const keys = cardTerminal
      .map((person) => candidates.find((c) => userId(c) === person.id)?.key ?? person.id)
      .sort();
    expect(keys).not.toContain('owner_no_counter');
    expect(keys).not.toContain('owner_counter_deny');
    expect(keys).toContain('owner_counter');
  });

  it('a recorder whose only other owner has no counter grant must ask them, not self-approve', async () => {
    const pairScope = {
      organizationId: pairOrganizationId,
      branchId: pairBranchId,
      actorId: userId(pairRecorder),
    };
    // The card-terminal rule would see nobody else, so the recorder could self-approve; the
    // reversal procedures would let the second owner approve, so the recorder may not.
    const cardTerminal = await deps.withTenantDb(pairOrganizationId, (db) =>
      deps.cardTerminal.otherCardTerminalReviewers(db, pairScope)
    );
    expect(cardTerminal).toEqual([]);
    const counted = await deps.withTenantDb(pairOrganizationId, (db) =>
      deps.approvers.otherApReversalApprovers(db, pairScope)
    );
    expect(counted).toEqual([{ id: userId(pairOwner), name: 'Person pair_owner_no_counter' }]);

    const bill = await recordBill(100, pairScope);
    const reverse = (candidate: Candidate, key: string) =>
      callerFor(candidate).reverseInvoice({
        branchId: pairBranchId,
        invoiceId: bill.id,
        commandKey: `apappr-rev-${suffix}-${key}`,
        reason: 'Entered twice',
        pin: PIN,
      });
    await expect(reverse(pairRecorder, 'self')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Another manager or owner must reverse an entry you recorded. Ask Person pair_owner_no_counter or another manager or owner to reverse it.',
    });
    const after = await deps.withTenantDb(pairOrganizationId, (db) =>
      db.pharmacyApInvoice.findFirst({ where: { organizationId: pairOrganizationId, id: bill.id } })
    );
    expect(after?.status).toBe('POSTED');
    await expect(reverse(pairOwner, 'second')).resolves.toMatchObject({
      status: 'REVERSED',
      reversedByUserId: userId(pairOwner),
      createdByUserId: userId(pairRecorder),
    });
  }, 60_000);
});
