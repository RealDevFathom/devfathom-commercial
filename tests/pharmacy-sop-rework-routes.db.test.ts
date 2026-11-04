// @vitest-environment node
/**
 * DEV-751 — rework after a send-back, end to end on PostgreSQL.
 *
 * After a reviewer sends a procedure back, the engine keeps its steps
 * completed. This suite pins that the owner can still add NEW proof and NEW
 * record links on those already-completed steps through the normal pharmacy
 * routes, then must say what they changed before resubmitting:
 *
 *  - `pharmacySop.evidenceTarget` (the real router procedure) authorizes proof
 *    on a completed step of the IN_PROGRESS rework, and the evidence route's
 *    attach + capture receipt (the real engine `attachEvidence` and
 *    `writePharmacySopUploadReceipt`, in one transaction as the route runs
 *    them) store it;
 *  - `pharmacySop.linkRecord` links another reading to a completed step (and a
 *    refrigerator step still refuses an ambient reading);
 *  - `pharmacySop.submit` refuses until `pharmacySop.addReworkNote` (through
 *    the real insert trigger) records what changed, then goes through;
 *  - `pharmacySop.occurrence` reports the send-back, the note and which proof
 *    and links came after it.
 *
 * Only the session gates (ABAC `can`, the adapter's branch/actor/role lookups)
 * and audit writes are stubbed. Fixture rows are committed (the app uses its
 * own connections) and removed at the end by the cleanup superuser, because the
 * append-only pharmacy SOP tables have no DELETE policy for any app role.
 *
 * Requires PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL (restricted runtime role),
 * PHARMACY_SOP_TEST_OWNER_DATABASE_URL and PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL
 * (cleanup only) against a disposable migrated database; skipped otherwise.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupOrganizations, leftoverRows } from './pharmacy-sop-auto-schedule-fixtures';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(['sop:complete', 'sop:verify']),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual<typeof import('@/server/audit')>('@/server/audit')),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async (_subject: unknown, action: string) => mocks.granted.has(action)),
}));
vi.mock('@/lib/pharmacy/sop-adapter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-adapter')>(
    '@/lib/pharmacy/sop-adapter'
  )),
  ...mocks.adapter,
}));

const runtimeUrl = process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL;
const superuserUrl = process.env.PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL;
const enabled = Boolean(runtimeUrl && ownerUrl && superuserUrl);
// The app's Prisma client reads DATABASE_URL at first use; set it only here.
if (enabled) process.env.DATABASE_URL = runtimeUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = enabled ? describe : describe.skip;

const run = randomBytes(4).toString('hex');
const ORG = `dev751w_${run}_org`;
const USER = `dev751w_${run}_user`;
const k = (name: string) => `${ORG}_${name}`;
const SITE = {
  pharmacyBranchId: k('pb'),
  sopBranchId: k('rb'),
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const OWNER = { staffProfileId: k('sp'), displayName: 'Owner', userId: USER };
const OCC = { pharmacyBranchId: SITE.pharmacyBranchId, occurrenceId: k('occ') };
const HASH = 'c'.repeat(64);

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  trpc: typeof import('@/server/trpc');
  sopRouter: typeof import('@/server/routers/pharmacy-sop');
  execution: typeof import('@/lib/restaurant/sop-execution');
  evidence: typeof import('@/lib/pharmacy/sop-evidence');
  library: typeof import('@/lib/pharmacy/sop-library');
};
let deps: Deps;
let su: Client;

async function seed(runtime: Client) {
  const q = (sql: string, params: unknown[] = []) => runtime.query(sql, params);
  await q(
    `SELECT set_config('app.is_platform_admin','true',false),
            set_config('app.current_organization_id','',false)`
  );
  const pack = deps.library.findPharmacySopPack('temperature-log')!;
  await q(
    `INSERT INTO "organizations" ("id","slug","legalName","displayName","updatedAt")
     VALUES ($1,$1,$1,$1,now())`,
    [ORG]
  );
  await q(
    `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","updatedAt")
     VALUES ($1,$2,'PB1','Main','1 Road','Lahore','PB',now())`,
    [SITE.pharmacyBranchId, ORG]
  );
  await q(
    `INSERT INTO "restaurant_branches" ("id","organizationId","name","timezone","updatedAt")
     VALUES ($1,$2,'Main · SOP','Asia/Karachi',now())`,
    [SITE.sopBranchId, ORG]
  );
  await q(
    `INSERT INTO "pharmacy_sop_sites" ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
     VALUES ($1,$2,$3,$4,$5)`,
    [k('site'), ORG, SITE.pharmacyBranchId, SITE.sopBranchId, USER]
  );
  // The owner's account: the link re-reads the actor's ACTIVE profile by user.
  await q(
    `INSERT INTO "users" ("id","organizationId","name","email","department","title","updatedAt")
     VALUES ($1,$2,'Owner',$3,'OPERATIONS','Assistant',now())`,
    [USER, ORG, `${USER}@example.test`]
  );
  await q(
    `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","userId","updatedAt")
     VALUES ($1,$2,'Owner',$4,now()), ($3,$2,'Reviewer',NULL,now())`,
    [OWNER.staffProfileId, ORG, k('sp_reviewer'), USER]
  );
  await q(
    `INSERT INTO "restaurant_sop_templates" ("id","organizationId","name","updatedAt")
     VALUES ($1,$2,$3,now())`,
    [k('tpl'), ORG, pack.name]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_versions" ("id","organizationId","templateId","versionNumber","status","updatedAt")
     VALUES ($1,$2,$3,1,'PUBLISHED',now())`,
    [k('ver'), ORG, k('tpl')]
  );
  for (const [index, step] of pack.steps.entries()) {
    await q(
      `INSERT INTO "restaurant_sop_template_steps" ("id","organizationId","templateVersionId","stepOrder","title","updatedAt")
       VALUES ($1,$2,$3,$4,$5,now())`,
      [k(`tstep${index + 1}`), ORG, k('ver'), index + 1, step.title]
    );
  }
  await q(
    `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","startDate","assigneeTargetType","assigneeStaffProfileId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'2026-11-01','PERSON',$5,'2026-11-01 00:00',now())`,
    [k('asg'), ORG, SITE.sopBranchId, k('tpl'), OWNER.staffProfileId]
  );
  // Back IN_PROGRESS after a send-back: every step is still completed.
  await q(
    `INSERT INTO "restaurant_sop_occurrences" ("id","organizationId","assignmentId","templateVersionId","branchId","businessDate","status","dueAt","windowEndsAt","startedAt","assignedStaffProfileId","updatedAt")
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,'IN_PROGRESS',now() - interval '2 hours',now() + interval '3 hours',now() - interval '10 minutes',$6,now())`,
    [k('occ'), ORG, k('asg'), k('ver'), SITE.sopBranchId, OWNER.staffProfileId]
  );
  for (const index of [1, 2, 3]) {
    await q(
      `INSERT INTO "restaurant_sop_occurrence_steps" ("id","organizationId","occurrenceId","templateStepId","completed","completedAt","completedByStaffProfileId","note","updatedAt")
       VALUES ($1,$2,$3,$4,true,now() - interval '90 minutes',$5,$6,now())`,
      [k(`ostep${index}`), ORG, k('occ'), k(`tstep${index}`), OWNER.staffProfileId, 'None']
    );
  }
  await q(
    `INSERT INTO "pharmacy_stock_locations" ("id","organizationId","branchId","code","name","kind","coldChain","minimumTemperatureC","maximumTemperatureC","updatedAt")
     VALUES ($1,$3,$4,'FR1','QA Fridge','FRIDGE',true,2,8,now()), ($2,$3,$4,'SH1','Back shelf','STORE',false,NULL,NULL,now())`,
    [k('loc_fridge'), k('loc_shelf'), ORG, SITE.pharmacyBranchId]
  );
  for (const [name, location, minutesAgo] of [
    ['log_fridge_old', 'loc_fridge', 100],
    ['log_shelf', 'loc_shelf', 100],
    ['log_fridge_new', 'loc_fridge', 5],
    ['log_shelf_new', 'loc_shelf', 5],
  ] as const) {
    await q(
      `INSERT INTO "pharmacy_temperature_logs" ("id","organizationId","branchId","stockLocationId","actorId","temperatureC","recordedAt","outOfRange")
       VALUES ($1,$2,$3,$4,$5,5,now() - ($6 || ' minutes')::interval,false)`,
      [k(name), ORG, SITE.pharmacyBranchId, k(location), USER, String(minutesAgo)]
    );
  }
  // The first submission's links (before the send-back).
  await q(
    `INSERT INTO "pharmacy_sop_record_links" ("id","organizationId","pharmacyBranchId","occurrenceId","occurrenceStepId","recordType","recordId","linkedByStaffProfileId","linkedByUserId","createdAt")
     VALUES ($1,$3,$4,$5,$6,'TEMPERATURE_LOG',$7,$9,$10,now() - interval '80 minutes'),
            ($2,$3,$4,$5,$8,'TEMPERATURE_LOG',$11,$9,$10,now() - interval '80 minutes')`,
    [
      k('link_fridge_old'),
      k('link_shelf'),
      ORG,
      SITE.pharmacyBranchId,
      k('occ'),
      k('ostep1'),
      k('log_fridge_old'),
      k('ostep2'),
      OWNER.staffProfileId,
      USER,
      k('log_shelf'),
    ]
  );
  await q(
    `INSERT INTO "restaurant_sop_verifications" ("id","organizationId","occurrenceId","action","actorStaffProfileId","reason","createdAt")
     VALUES ($1,$2,$3,'REJECT',$4,'The fridge reading is too old.',now() - interval '30 minutes')`,
    [k('rej'), ORG, k('occ'), k('sp_reviewer')]
  );
}

function caller() {
  const app = deps.trpc.router({ pharmacySop: deps.sopRouter.pharmacySopRouter });
  return app.createCaller({
    db: deps.scoped.createTenantDb(ORG, USER),
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core', 'pharmacy-safety'],
      modules: [],
      limits: {},
      activeSeats: 1,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: {
        id: USER,
        organizationId: ORG,
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never).pharmacySop;
}

describeIfDatabase('DEV-751 rework after a send-back on the real database', () => {
  beforeAll(async () => {
    const [scoped, trpc, sopRouter, execution, evidence, library] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/server/trpc'),
      import('@/server/routers/pharmacy-sop'),
      import('@/lib/restaurant/sop-execution'),
      import('@/lib/pharmacy/sop-evidence'),
      import('@/lib/pharmacy/sop-library'),
    ]);
    deps = { scoped, trpc, sopRouter, execution, evidence, library };
    su = new Client({ connectionString: superuserUrl });
    await su.connect();
    expect(await leftoverRows(su, [ORG])).toBe(0);
    const runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    try {
      const { rows } = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await seed(runtime);
    } finally {
      await runtime.end();
    }
    mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
    mocks.adapter.resolvePharmacySopActor.mockResolvedValue(OWNER);
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-assistant']);
  }, 120_000);

  afterAll(async () => {
    if (!su) return;
    try {
      await cleanupOrganizations(su, [ORG]);
      expect(await leftoverRows(su, [ORG])).toBe(0);
    } finally {
      await su.end();
    }
  }, 120_000);

  it('accepts new proof on an already-completed step through the pharmacy evidence path', async () => {
    const [step] = (
      await su.query<{ completed: boolean }>(
        `SELECT "completed" FROM "restaurant_sop_occurrence_steps" WHERE "id" = $1`,
        [k('ostep1')]
      )
    ).rows;
    expect(step).toEqual({ completed: true });

    // 1. The route authorizes through the router procedure.
    const target = await caller().evidenceTarget({ ...OCC, occurrenceStepId: k('ostep1') });
    expect(target).toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      occurrenceId: k('occ'),
      occurrenceStepId: k('ostep1'),
      uploaderStaffProfileId: OWNER.staffProfileId,
    });
    // 2. Attach + receipt in one transaction, exactly as the route runs them.
    const db = deps.scoped.createTenantDb(ORG, USER);
    const attached = await (
      db.$transaction as unknown as <T>(work: (tx: typeof db) => Promise<T>) => Promise<T>
    )(async (tx) => {
      const row = await deps.execution.attachEvidence(tx, {
        occurrenceId: target.occurrenceId,
        occurrenceStepId: target.occurrenceStepId,
        contentHashHex: HASH,
        mimeType: 'image/png; evidence=photo',
        sizeBytes: 4,
        storageRef: '/api/files/pharmacy-sop-rework.png',
        uploaderStaffProfileId: target.uploaderStaffProfileId,
      });
      await deps.evidence.writePharmacySopUploadReceipt(tx, {
        organizationId: ORG,
        pharmacyBranchId: target.pharmacyBranchId,
        occurrenceId: target.occurrenceId,
        evidenceId: row.evidenceId,
        contentHash: row.contentHash,
        capturedByStaffProfileId: target.uploaderStaffProfileId,
        capturedByUserId: USER,
      });
      return row;
    });
    expect(attached.created).toBe(true);
    const receipts = await su.query(
      `SELECT "source" FROM "pharmacy_sop_evidence_captures" WHERE "evidenceId" = $1`,
      [attached.evidenceId]
    );
    expect(receipts.rows).toEqual([{ source: 'UPLOAD' }]);
  });

  it('accepts another record link on an already-completed step; zones still apply', async () => {
    await expect(
      caller().linkRecord({
        ...OCC,
        occurrenceStepId: k('ostep1'),
        recordType: 'TEMPERATURE_LOG',
        recordId: k('log_fridge_new'),
      })
    ).resolves.toMatchObject({ created: true });
    // The refrigerator step refuses an ambient reading (location is not cold-chain).
    await expect(
      caller().linkRecord({
        ...OCC,
        occurrenceStepId: k('ostep1'),
        recordType: 'TEMPERATURE_LOG',
        recordId: k('log_shelf_new'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // The picker offers the refrigerator step only cold-chain readings.
    const offered = await caller().linkableRecords({
      ...OCC,
      recordType: 'TEMPERATURE_LOG',
      occurrenceStepId: k('ostep1'),
    });
    expect(offered.map((row) => row.id).sort()).toEqual(
      [k('log_fridge_new'), k('log_fridge_old')].sort()
    );
    expect(offered.every((row) => row.detail.location === 'QA Fridge')).toBe(true);
  });

  it('refuses to resubmit until a rework note says what changed, then goes through', async () => {
    await expect(caller().submit(OCC)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: deps.sopRouter.REWORK_NOTE_REQUIRED_MESSAGE,
    });
    const noted = await caller().addReworkNote({
      ...OCC,
      occurrenceStepId: k('ostep1'),
      note: 'Linked a fresh fridge reading and re-took the photo.',
    });
    expect(noted).toMatchObject({ afterLatestRejection: true, authorName: 'Owner' });

    const read = await caller().occurrence(OCC);
    expect(read.rework.latestRejection).toMatchObject({
      reason: 'The fridge reading is too old.',
      reviewerName: 'Reviewer',
    });
    expect(read.rework.notes).toEqual([
      expect.objectContaining({
        id: noted.id,
        occurrenceStepId: k('ostep1'),
        authorName: 'Owner',
        afterLatestRejection: true,
      }),
    ]);
    expect(read.evidence.map((row) => [row.provenance, row.createdAfterLatestRejection])).toEqual([
      ['RECEIPT', true],
    ]);
    expect(
      Object.fromEntries(read.recordLinks.map((link) => [link.recordId, link.createdAfterLatestRejection]))
    ).toEqual({
      [k('log_fridge_old')]: false,
      [k('log_shelf')]: false,
      [k('log_fridge_new')]: true,
    });
    expect(read.recordLinks.find((link) => link.recordId === k('log_fridge_new'))!.detail).toMatchObject(
      { kind: 'TEMPERATURE_LOG', location: 'QA Fridge', value: '5.0 °C', statusLabel: 'In range' }
    );

    await expect(caller().submit(OCC)).resolves.toMatchObject({ status: 'SUBMITTED' });
    // Submitted: no further note can be filed against this send-back.
    await expect(caller().addReworkNote({ ...OCC, note: 'One more thing' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
