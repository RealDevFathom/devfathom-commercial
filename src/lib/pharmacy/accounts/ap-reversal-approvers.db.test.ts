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
import { PHARMACY_MODULES, PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { TRPCContext } from '@/server/trpc';
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
  /** The manager and finance roles differ only in the finance grant. */
  orgRole:
    | 'owner'
    | 'finance'
    | 'manager'
    | 'system_finance'
    | 'owner-operator'
    | 'cashier'
    | 'inventory'
    | 'pharmacist'
    | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE';
  pin: boolean;
  deny?: string;
  assignedTo?: string;
};

const administratorWithoutFinance: Candidate = {
  key: 'admin_without_finance',
  organizationId,
  role: 'ADMIN',
  orgRole: 'manager',
  status: 'ACTIVE',
  pin: true,
};

const rolelessAdministrator: Candidate = {
  ...administratorWithoutFinance,
  key: 'roleless_admin',
  orgRole: null,
};

const readOnlyAdministrator: Candidate = { ...administratorWithoutFinance, key: 'read_only_admin' };

const ownerWithManageDeny: Candidate = {
  ...readOnlyAdministrator,
  key: 'owner_manage_deny',
  orgRole: 'owner',
  deny: 'finance:manage',
};

const candidates: Candidate[] = [
  administratorWithoutFinance,
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
const financeScenarios = (['finance', 'owner-operator'] as const).map((roleKey, index) => {
  const orgRole = roleKey === 'finance' ? 'system_finance' : roleKey;
  const maker: Candidate = { ...administratorWithoutFinance, key: `${roleKey}_maker`, orgRole };
  const signer: Candidate = { ...maker, key: `${roleKey}_signer` };
  return { roleKey, maker, signer, branch: id(`finance_branch_${index}`) };
});
const financeEmployee: Candidate = {
  ...administratorWithoutFinance,
  key: 'finance_employee',
  role: 'EMPLOYEE',
  orgRole: 'system_finance',
  pin: false,
  assignedTo: branchId,
};
const readOnlyEmployee: Candidate = {
  ...financeEmployee,
  key: 'finance_read_only',
  deny: 'finance:manage',
};
const employeeJobBranch = id('employee_jobs_branch');
const financePayer: Candidate = { ...financeEmployee, key: 'finance_payer' };
const employeeJobPayer = {
  ...financePayer,
  key: 'employee_job_payer',
  assignedTo: employeeJobBranch,
};
const employeeJobMaker = {
  ...financeEmployee,
  key: 'employee_jobs_maker',
  assignedTo: employeeJobBranch,
};
const excludedRoles = ['cashier', 'pharmacist', 'inventory', 'manager'] as const;
const excludedEmployees = excludedRoles.map((orgRole): Candidate => ({
  ...financeEmployee,
  key: orgRole,
  orgRole,
  organizationId: pairOrganizationId,
  assignedTo: pairBranchId,
}));
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
      // DEV-961: these reversals are approved with fixed PINs, which apply while the owner has
      // the authenticator for approvals turned off.
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","requireApprovalAuthenticator","createdAt","updatedAt") VALUES ($1,$2,'AP approver fixture','AP approver fixture','PHARMACY','ACTIVE','SHARED',false,now(),now())`,
        [org, slug]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [`${org}_department`, org]
      );
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now()), ($3,$2,'custom-finance','Custom finance',false,now())`,
        [`${org}_owner`, org, `${org}_finance`]
      );
      // Exercise both existing wildcard grants and the actual pharmacy Owner template,
      // which has pharmacy:* and report grants, but no finance:read grant.
      const ownerGrants =
        org === pairOrganizationId
          ? PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!.capabilities
          : ['*'];
      for (const capability of ownerGrants) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${org}_owner_${capability}`, org, `${org}_owner`, capability]
        );
      }
      // A finance manager who can read statements and approve reversals, without counter access.
      for (const capability of [
        'admin:access',
        'finance:read',
        'finance:manage',
        'pharmacy:manage',
        'reports:financial',
        'reports:operational',
      ]) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${org}_finance_${capability}`, org, `${org}_finance`, capability]
        );
      }
    }
    await client.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'manager','Manager',now())`,
      [`${organizationId}_manager`, organizationId]
    );
    for (const capability of [
      'admin:access',
      'pharmacy:manage',
      'reports:financial',
      'reports:operational',
    ]) {
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
        [id(`manager_${capability}`), organizationId, `${organizationId}_manager`, capability]
      );
    }
    for (const { roleKey, maker } of financeScenarios) {
      const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === roleKey)!;
      const roleId = `${organizationId}_${maker.orgRole}`;
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$4,true,now())`,
        [roleId, organizationId, roleKey, template.name]
      );
      for (const grant of template.capabilities)
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${roleId}_${grant}`, organizationId, roleId, grant]
        );
    }
    for (const [branch, org, code] of [
      [branchId, organizationId, `AA-${suffix}`],
      [employeeJobBranch, organizationId, `AJ-${suffix}`],
      [otherBranchId, organizationId, `AB-${suffix}`],
      [id('branch_b'), otherOrganizationId, `AC-${suffix}`],
      [pairBranchId, pairOrganizationId, `AD-${suffix}`],
      ...financeScenarios.map(({ branch, roleKey }) => [
        branch,
        organizationId,
        `${roleKey}-${suffix}`,
      ]),
    ]) {
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'Approver pharmacy','1 Test Road','Lahore','PB',now(),now())`,
        [branch, org, code]
      );
    }
    for (const key of excludedRoles) {
      const roleId = pairOrganizationId + '_' + key;
      const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!;
      await client.query(
        'INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$4,true,now())',
        [roleId, pairOrganizationId, key, template.name]
      );
      for (const capability of template.capabilities) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [roleId + '_' + capability, pairOrganizationId, roleId, capability]
        );
      }
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
      financeEmployee,
      employeeJobMaker,
      readOnlyEmployee,
      financePayer,
      employeeJobPayer,
      ...excludedEmployees,
      rolelessAdministrator,
      readOnlyAdministrator,
      ownerWithManageDeny,
      ...financeScenarios.flatMap(({ maker, signer }) => [maker, signer]),
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
          person.orgRole ? `${org}_${person.orgRole}` : null,
          `Person ${person.key}`,
          `${user}@ap-approvers.test`,
          person.role,
          financeScenarios.some(({ maker, signer }) => person === maker || person === signer)
            ? 'INACTIVE'
            : person.status,
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
      // The Finance template alone cannot approve a set-off. This signer has the
      // separate management approval grant required by the existing maker-checker rule.
      if (
        financeScenarios.some(({ roleKey, signer }) => roleKey === 'finance' && signer === person)
      ) {
        await client.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:manage','ALLOW','independent approver',now())`,
          [`${user}_approval`, org, user]
        );
      }
      if (person === readOnlyAdministrator) {
        await client.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'finance:read','ALLOW','read only',now())`,
          [`${user}_read`, org, user]
        );
      }
      if (person === rolelessAdministrator) {
        for (const capability of ['reports:operational', 'reports:financial', 'pharmacy:manage']) {
          await client.query(
            `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,$4,'ALLOW','isolated prerequisite',now())`,
            [`${user}_${capability}`, org, user, capability]
          );
        }
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
function contextFor(candidate: Candidate): TRPCContext {
  const org = candidate.organizationId;
  return {
    db: deps.createTenantDb(org, userId(candidate)),
    entitlements: {
      organizationId: org,
      enabledModules: ['pharmacy-finance', 'pharmacy-reports'],
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
  } as unknown as TRPCContext;
}

function callerFor(candidate: Candidate) {
  return deps.router.createCaller(contextFor(candidate));
}

describeDb('DEV-103 who else could approve a supplier expense invoice reversal', () => {
  it('requires finance access to open the supplier reversal list', async () => {
    await expect(
      callerFor(administratorWithoutFinance).reversalSearch({ branchId })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      callerFor(pairRecorder).reversalSearch({ branchId: pairBranchId })
    ).resolves.toMatchObject({ invoices: expect.any(Array) });
    await expect(
      callerFor(pairOwner).reversalSearch({ branchId: pairBranchId })
    ).resolves.toMatchObject({
      invoices: expect.any(Array),
    });
  });

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
      'admin_without_finance',
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

/** Use the same valid command for all three callers. Checking the specific finance refusal
 * catches accidental denials from missing input, branch scope, PIN or maker-checker rules. */
async function checkFinance<T>(
  run: (ctx: TRPCContext) => Promise<T>,
  allowed: Candidate,
  access: 'read' | 'manage'
): Promise<T> {
  for (const candidate of [
    rolelessAdministrator,
    administratorWithoutFinance,
    candidates.find((person) => person.key === 'owner_finance_deny')!,
  ]) {
    await expect(run(contextFor(candidate)), candidate.key).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Finance permission is required.',
    });
  }
  for (const readOnly of [readOnlyAdministrator, ownerWithManageDeny]) {
    if (access === 'manage') {
      await expect(run(contextFor(readOnly))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Finance permission is required.',
      });
    } else {
      await run(contextFor(readOnly));
    }
  }
  return run(contextFor(allowed));
}

describeDb('DEV-969 pharmacy accounts require a live finance grant', () => {
  beforeAll(async () => {
    // Isolate the pre-existing approver-enumeration fixtures above from these additional users.
    await inTenant((db) =>
      db.user.updateMany({
        where: {
          id: {
            in: financeScenarios.flatMap(({ maker, signer }) => [userId(maker), userId(signer)]),
          },
        },
        data: { status: 'ACTIVE' },
      })
    );
  });

  it('a view-only finance tick opens the supplier list and refuses a valid payment command before looking up its invoice', async () => {
    const api = deps.router.createCaller(contextFor(readOnlyAdministrator));
    await expect(api.list({ branchId })).resolves.toBeDefined();
    await expect(
      api.pay({
        branchId,
        invoiceId: id('missing'),
        commandKey: id('readonlypay'),
        reference: id('readonlyref'),
        amountMinor: 100,
        paidAt: new Date().toISOString(),
        fundingAccount: 'BANK',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Finance permission is required.' });
  });

  const originalScenario = {
    roleKey: 'custom finance',
    maker: candidates.find((person) => person.key === 'owner_no_counter')!,
    signer: candidates.find((person) => person.key === 'owner_counter')!,
    branch: branchId,
  };
  const testId = id;
  describe.each([
    originalScenario,
    ...financeScenarios,
    {
      roleKey: 'employee Finance',
      maker: employeeJobMaker,
      signer: originalScenario.signer,
      branch: employeeJobBranch,
    },
  ])('$roleKey', ({ roleKey, maker, signer: otherSigner, branch: branchId }) => {
    const id = (label: string) => testId(`${roleKey.replaceAll(' ', '-')}_${label}`);
    it('reads, pays, offsets and reverses a supplier invoice through the AP procedures', async () => {
      type Caller = ReturnType<typeof callerFor>;
      const checked = <T>(
        access: 'read' | 'manage',
        call: (api: Caller) => Promise<T>,
        signer?: Candidate
      ) => checkFinance((ctx) => call(deps.router.createCaller(ctx)), signer ?? maker, access);
      const amountMinor = 500;
      const reason = 'Duplicate';
      const invoice = await checked('manage', (api) =>
        api.record({
          branchId,
          createKey: id('record'),
          reference: id('bill'),
          payeeName: `Test supplier ${roleKey}`,
          supplierInvoiceRef: id('supplier-invoice'),
          invoiceDate: day(-5),
          dueDate: day(-1),
          amountMinor: 5_000,
          currency: 'PKR',
          description: 'Supplies',
          evidenceReference: 'Slip',
        })
      );
      const invoiceId = invoice.id;
      await checked('read', (api) => api.list({ branchId }));
      await checked('read', (api) => api.aging({ branchId, asOf: day(0) }));
      await checked('read', (api) => api.payablesDrafts({ branchId, asOf: day(0) }));
      await checked('read', (api) => api.creditSetOffs({ branchId }));
      await checked('read', (api) => api.reversalAccess({ branchId }));
      const matches = await checked('read', (api) =>
        api.reversalSearch({ branchId, reference: invoice.reference })
      );
      expect(matches.invoices.map((row) => row.id)).toContain(invoiceId);
      const supplierCreditId = await inTenant(async (db) => {
        const supplier = await db.pharmacySupplier.create({
          data: { organizationId, name: `Test supplier ${roleKey}` },
        });
        const credit = await db.pharmacySupplierCredit.create({
          data: {
            organizationId,
            branchId,
            supplierId: supplier.id,
            reference: id('credit'),
            amountMinor,
            receivedAt: new Date(),
            recordedByUserId: recorderId,
          },
        });
        return credit.id;
      });
      const request = (key: string) =>
        checked('manage', (api) =>
          api.requestCreditSetOff({
            branchId,
            invoiceId,
            supplierCreditId,
            amountMinor,
            requestKey: id(key),
          })
        );
      const first = await request('request1');
      await checked(
        'manage',
        (api) =>
          api.rejectCreditSetOff({
            branchId,
            setOffId: first.id,
            decisionKey: id('reject'),
            reason,
          }),
        otherSigner
      );
      const second = await request('request2');
      await checked(
        'manage',
        (api) =>
          api.approveCreditSetOff({
            branchId,
            setOffId: second.id,
            decisionKey: id('approve'),
            pin: PIN,
          }),
        otherSigner
      );
      await checked(
        'manage',
        (api) =>
          api.reverseCreditSetOff({
            branchId,
            setOffId: second.id,
            commandKey: id('undo'),
            reason,
            pin: PIN,
          }),
        otherSigner
      );
      const payment = await checked(
        'manage',
        (api) =>
          api.pay({
            branchId,
            invoiceId,
            commandKey: id('pay'),
            reference: id('payment'),
            amountMinor,
            paidAt: new Date().toISOString(),
            fundingAccount: 'BANK',
            ...(maker.role === 'ADMIN' ? { pin: PIN } : {}),
          }),
        maker.role === 'ADMIN' ? maker : employeeJobPayer
      );
      await checked(
        'manage',
        (api) =>
          api.reverseSettlement({
            branchId,
            settlementId: payment.id,
            commandKey: id('reversepay'),
            reason,
            pin: PIN,
          }),
        otherSigner
      );
      const reversed = await checked(
        'manage',
        (api) =>
          api.reverseInvoice({
            branchId,
            invoiceId,
            commandKey: id('reversebill'),
            reason,
            pin: PIN,
          }),
        otherSigner
      );
      expect(reversed.status).toBe('REVERSED');
    }, 60_000);

    it('reads, drafts, cancels, posts and reverses through the general journal procedures', async () => {
      const { pharmacyGeneralJournalRouter: router } =
        await import('@/server/routers/pharmacy-general-journal');
      const checked = <T>(
        access: 'read' | 'manage',
        call: (api: ReturnType<typeof router.createCaller>) => Promise<T>
      ) => checkFinance((ctx) => call(router.createCaller(ctx)), maker, access);
      const reason = 'Rent accrual';
      const fields = {
        branchId,
        reference: id('journal'),
        purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
        occurredAt: new Date().toISOString(),
        reason,
        evidenceReference: 'Lease',
        lines: [
          { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 200 },
          { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT' as const, amountMinor: 200 },
        ],
      };
      await checked('read', (api) => api.catalog({ branchId }));
      const draft = await checked('manage', (api) =>
        api.createDraft({ ...fields, createKey: id('draft') })
      );
      await checked('read', (api) => api.list({ branchId }));
      await checked('read', (api) => api.get({ branchId, voucherId: draft.id }));
      const edit = await checked('manage', (api) =>
        api.updateDraft({
          ...fields,
          voucherId: draft.id,
          expectedVersion: draft.version,
          reason: 'Updated accrual',
        })
      );
      await checked('manage', (api) =>
        api.cancelDraft({ branchId, voucherId: draft.id, expectedVersion: edit.version, reason })
      );
      const next = await checked('manage', (api) =>
        api.createDraft({ ...fields, reference: id('nextjournal'), createKey: id('nextdraft') })
      );
      await checked('manage', (api) =>
        api.post({
          branchId,
          voucherId: next.id,
          expectedVersion: next.version,
          commandKey: id('postjournal'),
        })
      );
      const reversal = await checked('manage', (api) =>
        api.reverse({
          branchId,
          voucherId: next.id,
          commandKey: id('reversejournal'),
          at: new Date().toISOString(),
          reason,
        })
      );
      expect(reversal.status).toBe('REVERSED');
    }, 60_000);

    it('reads statements and executes the bookkeeping procedures with their other gates intact', async () => {
      const { pharmacyFinanceRouter: router } = await import('@/server/routers/pharmacy-finance');
      const checked = <T>(
        access: 'read' | 'manage',
        call: (api: ReturnType<typeof router.createCaller>) => Promise<T>
      ) => checkFinance((ctx) => call(router.createCaller(ctx)), maker, access);
      const at = new Date();
      const from = new Date(at.getTime() - 86_400_000);
      const amountMinor = 100;
      await checked('read', (api) => api.workspace({ branchId }));
      await checked('read', (api) =>
        api.financialStatements({ branchId, from: from.toISOString(), to: at.toISOString() })
      );
      const txn = await checked('manage', (api) =>
        api.post({
          branchId,
          reference: id('bpay'),
          kind: 'SUPPLIER_PAYMENT',
          amountMinor,
          occurredAt: at,
          idempotencyKey: id('bpost'),
        })
      );
      const { journalEntryLookupRouter } = await import('./journal-entry-lookup');
      const entry = await checkFinance(
        (ctx) =>
          journalEntryLookupRouter.createCaller(ctx).lookup({
            branchId,
            entryId: txn.journalEntryId!,
            from: from.toISOString(),
            to: new Date(at.getTime() + 86_400_000).toISOString(),
          }),
        maker,
        'read'
      );
      expect(entry.status).toBe('FOUND');
      const bank = await checked('manage', (api) =>
        api.importBankLine({
          branchId,
          statementRef: id('line'),
          lineReference: id('bank'),
          bookedAt: at,
          amountMinor: -amountMinor,
          description: 'Supplier payment',
        })
      );
      await checked('manage', (api) =>
        api.reconcile({ branchId, statementLineId: bank.id, transactionId: txn.id, amountMinor })
      );
      await checked('manage', (api) =>
        api.reverse({
          branchId,
          transactionId: txn.id,
          at,
          idempotencyKey: id('breverse'),
          reason: 'Duplicate',
        })
      );
      const period = await checked('manage', (api) =>
        api.closePeriod({ branchId, startsAt: from, endsAt: at })
      );
      // Reopening is a separate administrator job, including when the employee closed the period.
      const reopener = maker.role === 'ADMIN' ? maker : otherSigner;
      await checkFinance(
        (ctx) =>
          router
            .createCaller(ctx)
            .reopenPeriod({ branchId, periodId: period.id, reason: 'Review' }),
        reopener,
        'manage'
      );
      const tender = await inTenant(async (db) => {
        const sale = await db.pharmacySale.create({
          data: { organizationId, branchId, createdByUserId: recorderId },
        });
        return db.pharmacyTender.create({
          data: {
            organizationId,
            branchId,
            saleId: sale.id,
            type: 'BANK_TRANSFER',
            businessDate: at,
            actorId: recorderId,
            deviceId: id('device'),
            amountMinor,
          },
        });
      });
      await checked('manage', (api) =>
        api.createSettlementBatch({
          branchId,
          reference: id('batch'),
          provider: 'Test Bank',
          tenderType: 'BANK_TRANSFER',
          businessDate: at,
          tenderIds: [tender.id],
        })
      );
      await checkFinance(
        (ctx) =>
          router.createCaller(ctx).publishTaxProfile({
            branchId,
            name: 'Test tax',
            effectiveFrom: at,
            approvalReference: id('taxapproval'),
            idempotencyKey: id('tax'),
            rules: [
              { productClass: 'FRONT_SHOP', pctHsCode: '1234', priceMode: 'EXCLUSIVE', rate: '0' },
            ],
          }),
        reopener,
        'manage'
      );
    }, 60_000);
  });
});

describeDb('DEV-1034 employee finance jobs at an admitted branch', () => {
  it('records and pays a supplier bill and reads the branch ledger through the pharmacy routers', async () => {
    const api = callerFor(financeEmployee);
    const invoice = await api.record({
      branchId,
      createKey: id('employee-bill'),
      reference: id('employee-bill'),
      payeeName: 'Synthetic supplier',
      supplierInvoiceRef: id('invoice'),
      invoiceDate: day(-2),
      dueDate: day(1),
      amountMinor: 2000,
      currency: 'PKR',
      description: 'Office supplies',
      evidenceReference: 'Slip',
    });
    const command = {
      branchId,
      invoiceId: invoice.id,
      commandKey: id('employee-payment'),
      reference: id('employee-payment'),
      amountMinor: 1000,
      paidAt: new Date().toISOString(),
      fundingAccount: 'BANK' as const,
    };
    await expect(api.pay(command)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Someone else must pay an invoice you recorded.',
    });
    const payer = callerFor(financePayer);
    const payment = await payer.pay(command);
    expect((await payer.pay(command)).id).toBe(payment.id);
    expect(payment.invoiceId).toBe(invoice.id);
    const { pharmacyFinanceRouter } = await import('@/server/routers/pharmacy-finance');
    const finance = pharmacyFinanceRouter.createCaller(contextFor(financeEmployee));
    const report = await finance.financialStatements({
      branchId,
      from: day(-3) + 'T00:00:00Z',
      to: day(2) + 'T00:00:00Z',
    });
    expect(report.scope).toEqual({ organizationId, branchId });
    expect(
      (await finance.workspace({ branchId })).transactions.some(
        (row) => row.id === payment.transactionId
      )
    ).toBe(true);
    await expect(api.list({ branchId: otherBranchId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your finance scope.',
    });
    await expect(
      finance.reopenPeriod({ branchId, periodId: id('locked'), reason: 'Review' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Administrator access is required to reopen a locked period.',
    });
  });
  it('reserves all five AP approval and reversal commands and refuses payment to a read-only employee', async () => {
    const api = callerFor(financeEmployee);
    expect((await api.reversalAccess({ branchId })).mayReverse).toBe(false);
    const denied = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
    const target = { branchId, setOffId: id('credit'), reason: 'Duplicate', pin: PIN };
    await expect(
      api.approveCreditSetOff({
        branchId,
        setOffId: target.setOffId,
        decisionKey: id('approve'),
        pin: PIN,
      })
    ).rejects.toMatchObject(denied);
    await expect(
      api.rejectCreditSetOff({
        branchId,
        setOffId: target.setOffId,
        decisionKey: id('reject'),
        reason: target.reason,
      })
    ).rejects.toMatchObject(denied);
    await expect(
      api.reverseCreditSetOff({ ...target, commandKey: id('reverse-credit') })
    ).rejects.toMatchObject(denied);
    await expect(
      api.reverseSettlement({
        branchId,
        settlementId: id('settlement'),
        commandKey: id('reverse-pay'),
        reason: target.reason,
        pin: PIN,
      })
    ).rejects.toMatchObject(denied);
    await expect(
      api.reverseInvoice({
        branchId,
        invoiceId: id('invoice'),
        commandKey: id('reverse-invoice'),
        reason: target.reason,
        pin: PIN,
      })
    ).rejects.toMatchObject(denied);
    const reader = callerFor(readOnlyEmployee);
    await expect(reader.list({ branchId })).resolves.toBeDefined();
    await expect(
      reader.pay({
        branchId,
        invoiceId: id('invoice'),
        commandKey: id('readonly-pay'),
        reference: 'Payment',
        amountMinor: 100,
        paidAt: new Date().toISOString(),
        fundingAccount: 'BANK',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Finance permission is required.' });
  });
  it('refuses staff, settings, catalogue, stock and counter actions to the Finance employee', async () => {
    const ctx = contextFor(financeEmployee);
    ctx.entitlements.enabledModules = PHARMACY_MODULES.map((module) => module.key);
    const { organizationAdminRouter } = await import('@/server/routers/organization-admin');
    const { pharmacyInventoryRouter } = await import('@/server/routers/pharmacy-inventory');
    const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
    const { pharmacySalesRouter } = await import('@/server/routers/pharmacy-sales');
    const organization = organizationAdminRouter.createCaller(ctx);
    const forbidden = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
    await expect(
      organization.updateMember({
        id: userId(financeEmployee),
        status: 'ACTIVE',
        role: 'EMPLOYEE',
        department: 'Pharmacy',
        title: 'Accountant',
        organizationRoleId: organizationId + '_system_finance',
      })
    ).rejects.toMatchObject(forbidden);
    await expect(
      organization.updateBrand({
        logoUrl: '',
        markUrl: '',
        faviconUrl: '',
        primaryColor: '#000000',
        accentColor: '#ffffff',
        supportEmail: '',
        fromName: null,
      })
    ).rejects.toMatchObject(forbidden);
    await expect(
      pharmacyInventoryRouter.createCaller(ctx).createCount({
        branchId,
        varianceThreshold: 0,
        readings: [
          {
            inventoryLotId: id('lot'),
            stockLocationId: id('location'),
            countedSealedPacks: 1,
            countedLooseUnits: 0,
          },
        ],
      })
    ).rejects.toMatchObject(forbidden);
    await expect(pharmacyMedicineRouter.createCaller(ctx).catalogueEdits()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Your role cannot open the catalogue queue. Ask a catalogue editor to submit the change or a catalogue reviewer to decide it.',
    });
    await expect(
      pharmacySalesRouter.createCaller(ctx).openDrawer({
        branchId,
        deviceId: id('device'),
        businessDate: new Date(),
        openingFloatMinor: 0,
      })
    ).rejects.toMatchObject(forbidden);
  });
  it.each(excludedEmployees)('refuses $orgRole at their assigned branch', async (candidate) => {
    const { pharmacyFinanceRouter } = await import('@/server/routers/pharmacy-finance');
    const finance = pharmacyFinanceRouter.createCaller(contextFor(candidate));
    const forbidden = { code: 'FORBIDDEN', message: 'Finance permission is required.' };
    await expect(finance.workspace({ branchId: pairBranchId })).rejects.toMatchObject(forbidden);
    await expect(
      finance.post({
        branchId: pairBranchId,
        kind: 'EXPENSE',
        reference: 'Supplies',
        amountMinor: 200,
        occurredAt: new Date(),
        idempotencyKey: id('denied-entry'),
      })
    ).rejects.toMatchObject(forbidden);
    await expect(
      finance.financialStatements({
        branchId: pairBranchId,
        from: day(-2) + 'T00:00:00Z',
        to: day(1) + 'T00:00:00Z',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Financial report permission is required.',
    });
    const api = callerFor(candidate);
    await expect(api.list({ branchId: pairBranchId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Finance permission is required.',
    });
    await expect(
      api.pay({
        branchId: pairBranchId,
        invoiceId: id('bill'),
        commandKey: id('denied'),
        reference: 'Payment',
        amountMinor: 1000,
        paidAt: new Date().toISOString(),
        fundingAccount: 'BANK',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Finance permission is required.' });
  });
});
