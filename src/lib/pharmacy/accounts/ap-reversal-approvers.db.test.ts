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
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
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
  orgRole: 'owner' | 'finance' | 'manager';
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
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now()), ($3,$2,'finance','Finance owner',false,now())`,
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
  allowed = candidates.find((candidate) => candidate.key === 'owner_no_counter')!
): Promise<T> {
  for (const candidate of [
    administratorWithoutFinance,
    candidates.find((person) => person.key === 'owner_finance_deny')!,
  ]) {
    await expect(run(contextFor(candidate)), candidate.key).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Finance permission is required.',
    });
  }
  return run(contextFor(allowed));
}

describeDb('DEV-969 pharmacy accounts require a live finance grant', () => {
  const otherSigner = candidates.find((candidate) => candidate.key === 'owner_counter')!;

  it('reads, pays, offsets and reverses a supplier invoice through the AP procedures', async () => {
    type Caller = ReturnType<typeof callerFor>;
    const checked = <T>(call: (api: Caller) => Promise<T>, signer?: Candidate) =>
      checkFinance((ctx) => call(deps.router.createCaller(ctx)), signer);
    const amountMinor = 500;
    const reason = 'Duplicate';
    const invoice = await checked((api) =>
      api.record({
        branchId,
        createKey: id('record'),
        reference: id('bill'),
        payeeName: 'Test supplier',
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
    await checked((api) => api.list({ branchId }));
    await checked((api) => api.aging({ branchId, asOf: day(0) }));
    await checked((api) => api.payablesDrafts({ branchId, asOf: day(0) }));
    await checked((api) => api.creditSetOffs({ branchId }));
    await checked((api) => api.reversalAccess({ branchId }));
    const matches = await checked((api) =>
      api.reversalSearch({ branchId, reference: invoice.reference })
    );
    expect(matches.invoices.map((row) => row.id)).toContain(invoiceId);
    const supplierCreditId = await inTenant(async (db) => {
      const supplier = await db.pharmacySupplier.create({
        data: { organizationId, name: 'Test supplier' },
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
      checked((api) =>
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
      (api) =>
        api.rejectCreditSetOff({ branchId, setOffId: first.id, decisionKey: id('reject'), reason }),
      otherSigner
    );
    const second = await request('request2');
    await checked(
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
    const payment = await checked((api) =>
      api.pay({
        branchId,
        invoiceId,
        commandKey: id('pay'),
        reference: id('payment'),
        amountMinor,
        paidAt: new Date().toISOString(),
        fundingAccount: 'BANK',
      })
    );
    await checked(
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
    const checked = <T>(call: (api: ReturnType<typeof router.createCaller>) => Promise<T>) =>
      checkFinance((ctx) => call(router.createCaller(ctx)));
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
    await checked((api) => api.catalog({ branchId }));
    const draft = await checked((api) => api.createDraft({ ...fields, createKey: id('draft') }));
    await checked((api) => api.list({ branchId }));
    await checked((api) => api.get({ branchId, voucherId: draft.id }));
    const edit = await checked((api) =>
      api.updateDraft({
        ...fields,
        voucherId: draft.id,
        expectedVersion: draft.version,
        reason: 'Updated accrual',
      })
    );
    await checked((api) =>
      api.cancelDraft({ branchId, voucherId: draft.id, expectedVersion: edit.version, reason })
    );
    const next = await checked((api) =>
      api.createDraft({ ...fields, reference: id('nextjournal'), createKey: id('nextdraft') })
    );
    await checked((api) =>
      api.post({
        branchId,
        voucherId: next.id,
        expectedVersion: next.version,
        commandKey: id('postjournal'),
      })
    );
    const reversal = await checked((api) =>
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
    const checked = <T>(call: (api: ReturnType<typeof router.createCaller>) => Promise<T>) =>
      checkFinance((ctx) => call(router.createCaller(ctx)));
    const at = new Date();
    const from = new Date(at.getTime() - 86_400_000);
    const amountMinor = 100;
    await checked((api) => api.workspace({ branchId }));
    await checked((api) =>
      api.financialStatements({ branchId, from: from.toISOString(), to: at.toISOString() })
    );
    const txn = await checked((api) =>
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
    const entry = await checkFinance((ctx) =>
      journalEntryLookupRouter.createCaller(ctx).lookup({
        branchId,
        entryId: txn.journalEntryId!,
        from: from.toISOString(),
        to: new Date(at.getTime() + 86_400_000).toISOString(),
      })
    );
    expect(entry.status).toBe('FOUND');
    const bank = await checked((api) =>
      api.importBankLine({
        branchId,
        statementRef: id('line'),
        lineReference: id('bank'),
        bookedAt: at,
        amountMinor: -amountMinor,
        description: 'Supplier payment',
      })
    );
    await checked((api) =>
      api.reconcile({ branchId, statementLineId: bank.id, transactionId: txn.id, amountMinor })
    );
    await checked((api) =>
      api.reverse({
        branchId,
        transactionId: txn.id,
        at,
        idempotencyKey: id('breverse'),
        reason: 'Duplicate',
      })
    );
    const period = await checked((api) =>
      api.closePeriod({ branchId, startsAt: from, endsAt: at })
    );
    await checked((api) => api.reopenPeriod({ branchId, periodId: period.id, reason: 'Review' }));
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
    await checked((api) =>
      api.createSettlementBatch({
        branchId,
        reference: id('batch'),
        provider: 'Test Bank',
        tenderType: 'BANK_TRANSFER',
        businessDate: at,
        tenderIds: [tender.id],
      })
    );
    await checked((api) =>
      api.publishTaxProfile({
        branchId,
        name: 'Test tax',
        effectiveFrom: at,
        approvalReference: id('taxapproval'),
        idempotencyKey: id('tax'),
        rules: [
          { productClass: 'FRONT_SHOP', pctHsCode: '1234', priceMode: 'EXCLUSIVE', rate: '0' },
        ],
      })
    );
  }, 60_000);
});
