/**
 * M7-L4 — SOP execution unit tests.
 * Covers: SCHEDULED→IN_PROGRESS, step completion (idempotent), evidence with sha256,
 * IN_PROGRESS→SUBMITTED/LATE transition based on window, and state-guard errors.
 */
import { createHash, randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { startOccurrence, completeStep, attachEvidence, submitOccurrence } from './sop-execution';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
      createdAt: new Date(),
      ...data,
    })),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopEvidence: model(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;
const NOW = new Date('2026-08-20T10:00:00.000Z');
const WINDOW_FUTURE = new Date('2026-08-20T18:00:00.000Z');
const WINDOW_PAST = new Date('2026-08-20T09:00:00.000Z');
const OCC_ID = 'occ_1';
const STEP_ID = 'step_1';
const TMPL_STEP_ID = 'tmpl_step_1';

beforeEach(() => {
  db = makeDb();
});

// ── startOccurrence ────────────────────────────────────────────────────────────

describe('startOccurrence', () => {
  it('transitions SCHEDULED → IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: NOW });

    const result = await startOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });

    expect(result.status).toBe('IN_PROGRESS');
    expect(result.startedAt).toEqual(NOW);
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'IN_PROGRESS', startedAt: NOW }),
      })
    );
  });

  it('transitions REJECTED → IN_PROGRESS (rework path)', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'REJECTED' });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: NOW });

    const result = await startOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('throws NOT_FOUND when occurrence does not exist', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(null);

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('throws INVALID_STATE when occurrence is already IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });

  it('throws INVALID_STATE when occurrence is SUBMITTED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });
});

// ── completeStep ───────────────────────────────────────────────────────────────

describe('completeStep', () => {
  it('blocks required photo and signature proof until both are captured', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      assignedStaffProfileId: 'staff_1',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
    });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: false,
      completedAt: null,
      templateStep: { requiresPhoto: true, requiresSignature: true },
      evidence: [{ mimeType: 'image/jpeg' }],
    });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
        actorStaffProfileId: 'staff_1',
      })
    ).rejects.toMatchObject({ reason: 'PROOF_REQUIRED' });
    expect(db.restaurantSopOccurrenceStep.update).not.toHaveBeenCalled();

    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: false,
      completedAt: null,
      templateStep: { requiresPhoto: true, requiresSignature: true },
      evidence: [
        { mimeType: 'image/jpeg' },
        { mimeType: 'application/vnd.devfathom.signature+json' },
      ],
    });
    db.restaurantSopOccurrenceStep.update.mockResolvedValue({ id: STEP_ID, completedAt: NOW });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
        actorStaffProfileId: 'staff_1',
      })
    ).resolves.toMatchObject({ completed: true });
  });

  it('allows only the direct assignee or role-pool claimant to complete work', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      assignedStaffProfileId: null,
      poolJobRoleId: 'role_1',
      claimedByStaffProfileId: 'staff_claimant',
    });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
        actorStaffProfileId: 'staff_other',
      })
    ).rejects.toMatchObject({ reason: 'NOT_OWNER' });
    expect(db.restaurantSopOccurrenceStep.findUnique).not.toHaveBeenCalled();
  });

  it('requires a non-blank note when the published step requires one', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
    });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: false,
      completedAt: null,
      templateStep: { requiresPhoto: false, requiresSignature: false, requiresNote: true },
      evidence: [],
    });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
        note: '   ',
      })
    ).rejects.toMatchObject({ reason: 'PROOF_REQUIRED' });
    expect(db.restaurantSopOccurrenceStep.update).not.toHaveBeenCalled();
  });

  it('marks a step completed on an IN_PROGRESS occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: false,
      completedAt: null,
    });
    db.restaurantSopOccurrenceStep.update.mockResolvedValue({ id: STEP_ID, completedAt: NOW });

    const result = await completeStep(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      templateStepId: TMPL_STEP_ID,
      now: NOW,
    });

    expect(result.completed).toBe(true);
    expect(result.completedAt).toEqual(NOW);
  });

  it('is idempotent — returns existing completedAt when already done', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: true,
      completedAt: NOW,
    });

    const result = await completeStep(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      templateStepId: TMPL_STEP_ID,
    });

    expect(result.completed).toBe(true);
    expect(db.restaurantSopOccurrenceStep.update).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATE when occurrence is not IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('throws STEP_NOT_FOUND when step is not on the occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue(null);

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
      })
    ).rejects.toMatchObject({ reason: 'STEP_NOT_FOUND' });
  });
});

// ── attachEvidence ─────────────────────────────────────────────────────────────

describe('attachEvidence', () => {
  const contentBytes = Buffer.from('hello evidence');
  // Precomputed sha256 of "hello evidence":
  const expectedHash = createHash('sha256').update(contentBytes).digest('hex');

  it('computes sha256 from contentBytes and creates evidence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_1',
      contentHash: expectedHash,
      createdAt: NOW,
    });

    const result = await attachEvidence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      contentBytes,
      mimeType: 'image/jpeg',
      sizeBytes: contentBytes.length,
      now: NOW,
    });

    expect(result.contentHash).toBe(expectedHash);
    expect(result.created).toBe(true);
    expect(db.restaurantSopEvidence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contentHash: expectedHash }),
      })
    );
  });

  it('accepts a pre-computed contentHashHex', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_1',
      contentHash: expectedHash,
      createdAt: NOW,
    });

    const result = await attachEvidence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      contentHashHex: expectedHash,
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });

    expect(result.contentHash).toBe(expectedHash);
  });

  it('returns the frozen winner when an identical nullable-attribution retry loses', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopEvidence.createMany.mockResolvedValue({ count: 0 });
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_original',
      contentHash: expectedHash,
      createdAt: NOW,
    });

    const result = await attachEvidence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      occurrenceStepId: null,
      uploaderStaffProfileId: null,
      contentHashHex: expectedHash,
      mimeType: 'image/jpeg; evidence=photo',
      sizeBytes: 100,
      storageRef: '/api/files/retry.jpg',
    });

    expect(result).toEqual({
      evidenceId: 'ev_original',
      contentHash: expectedHash,
      createdAt: NOW,
      created: false,
    });
  });

  it('throws INVALID when neither contentBytes nor contentHashHex is provided', async () => {
    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        mimeType: 'image/jpeg',
        sizeBytes: 0,
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('throws INVALID when sizeBytes is negative', async () => {
    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        contentHashHex: expectedHash,
        mimeType: 'image/jpeg',
        sizeBytes: -1,
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('throws INVALID_STATE when occurrence is VERIFIED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'VERIFIED' });

    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        contentHashHex: expectedHash,
        mimeType: 'image/jpeg',
        sizeBytes: 0,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});

const TEST_DATABASE_URL = process.env.WHA434_TEST_RUNTIME_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.WHA434_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const dbSuffix = randomBytes(6).toString('hex');
const dbIds = {
  organization: `org_wha434_${dbSuffix}`,
  branch: `branch_wha434_${dbSuffix}`,
  staff: `staff_wha434_${dbSuffix}`,
  template: `template_wha434_${dbSuffix}`,
  version: `version_wha434_${dbSuffix}`,
  templateStep: `template_step_wha434_${dbSuffix}`,
  assignment: `assignment_wha434_${dbSuffix}`,
  occurrence: `occurrence_wha434_${dbSuffix}`,
  occurrenceStep: `occurrence_step_wha434_${dbSuffix}`,
};
let tenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];

describeIfDatabase('attachEvidence PostgreSQL retry identity', () => {
  beforeAll(async () => {
    expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);
    const owner = new Client({ connectionString: OWNER_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query(`SET app.is_platform_admin = 'true'`);
      await owner.query(
        `INSERT INTO "organizations"
          ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $2, 'WHA-434 Test Co', 'WHA-434 Test', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [dbIds.organization, `wha434-${dbSuffix}`]
      );
    } finally {
      await owner.end();
    }

    ({ createTenantDb: tenantDb } = await import('@/lib/tenancy/scoped-db'));
    const scoped = tenantDb(dbIds.organization);
    await scoped.$transaction(async (tx) => {
      await tx.restaurantBranch.create({
        data: { id: dbIds.branch, name: 'Retry Lab', timezone: 'UTC', businessDayCutoff: '00:00' },
      });
      await tx.restaurantStaffProfile.create({
        data: { id: dbIds.staff, displayName: 'Retry Operator', primaryBranchId: dbIds.branch },
      });
      await tx.restaurantSopTemplate.create({
        data: { id: dbIds.template, name: 'Retry SOP' },
      });
      await tx.restaurantSopTemplateVersion.create({
        data: {
          id: dbIds.version,
          templateId: dbIds.template,
          versionNumber: 1,
          status: 'PUBLISHED',
        },
      });
      await tx.restaurantSopTemplateStep.create({
        data: {
          id: dbIds.templateStep,
          templateVersionId: dbIds.version,
          stepOrder: 1,
          title: 'Capture proof',
        },
      });
      await tx.restaurantSopAssignment.create({
        data: {
          id: dbIds.assignment,
          branchId: dbIds.branch,
          templateId: dbIds.template,
          daysOfWeek: [],
          startDate: new Date('2026-08-29T00:00:00.000Z'),
          assigneeTargetType: 'PERSON',
          assigneeStaffProfileId: dbIds.staff,
        },
      });
      await tx.restaurantSopOccurrence.create({
        data: {
          id: dbIds.occurrence,
          assignmentId: dbIds.assignment,
          templateVersionId: dbIds.version,
          branchId: dbIds.branch,
          businessDate: new Date('2026-08-29T00:00:00.000Z'),
          status: 'IN_PROGRESS',
          dueAt: new Date('2026-08-29T12:00:00.000Z'),
          windowEndsAt: new Date('2026-08-30T12:00:00.000Z'),
          assignedStaffProfileId: dbIds.staff,
        },
      });
      await tx.restaurantSopOccurrenceStep.create({
        data: {
          id: dbIds.occurrenceStep,
          occurrenceId: dbIds.occurrence,
          templateStepId: dbIds.templateStep,
        },
      });
    });
  });

  afterAll(async () => {
    if (!OWNER_DATABASE_URL) return;
    const owner = new Client({ connectionString: OWNER_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query(`SET app.is_platform_admin = 'true'`);
      await owner.query(`DELETE FROM "organizations" WHERE "id" = $1`, [dbIds.organization]);
    } finally {
      await owner.end();
    }
  });

  it('runs as LOGIN=true SUPERUSER=false BYPASSRLS=false', async () => {
    const rows = await tenantDb(dbIds.organization).$queryRawUnsafe<
      { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
    >(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('collapses sequential and concurrent retries while preserving distinct facts', async () => {
    const input = {
      occurrenceId: dbIds.occurrence,
      occurrenceStepId: dbIds.occurrenceStep,
      contentHashHex: createHash('sha256').update('same proof').digest('hex'),
      mimeType: 'image/jpeg; evidence=photo',
      sizeBytes: 10,
      uploaderStaffProfileId: dbIds.staff,
    };
    const first = await attachEvidence(tenantDb(dbIds.organization), {
      ...input,
      storageRef: '/api/files/original.jpg',
    });
    const sequential = await attachEvidence(tenantDb(dbIds.organization), {
      ...input,
      storageRef: '/api/files/sequential-retry.jpg',
    });
    const concurrent = await Promise.all([
      attachEvidence(tenantDb(dbIds.organization), {
        ...input,
        contentHashHex: createHash('sha256').update('concurrent proof').digest('hex'),
        storageRef: '/api/files/concurrent-a.jpg',
      }),
      attachEvidence(tenantDb(dbIds.organization), {
        ...input,
        contentHashHex: createHash('sha256').update('concurrent proof').digest('hex'),
        storageRef: '/api/files/concurrent-b.jpg',
      }),
    ]);
    const distinctPurpose = await attachEvidence(tenantDb(dbIds.organization), {
      ...input,
      mimeType: 'image/jpeg; evidence=signature',
      storageRef: '/api/files/signature.jpg',
    });

    expect(first.created).toBe(true);
    expect(sequential).toMatchObject({ evidenceId: first.evidenceId, created: false });
    expect(concurrent.filter((row) => row.created)).toHaveLength(1);
    expect(new Set(concurrent.map((row) => row.evidenceId)).size).toBe(1);
    expect(distinctPurpose.created).toBe(true);
    const rows = await tenantDb(dbIds.organization).restaurantSopEvidence.findMany({
      where: { occurrenceId: dbIds.occurrence },
      select: { storageRef: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.storageRef)).toContain('/api/files/original.jpg');
    expect(rows.map((row) => row.storageRef)).not.toContain('/api/files/sequential-retry.jpg');
  });
});

// ── submitOccurrence ───────────────────────────────────────────────────────────

describe('submitOccurrence', () => {
  it('transitions IN_PROGRESS → SUBMITTED when within window', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_FUTURE,
      steps: [],
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: NOW });

    const result = await submitOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('SUBMITTED');
  });

  it('transitions IN_PROGRESS → LATE when window has closed', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_PAST,
      steps: [],
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: NOW });

    const result = await submitOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('LATE');
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LATE' }) })
    );
  });

  it('throws INVALID_STATE when occurrence is not IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'SUBMITTED',
      windowEndsAt: WINDOW_FUTURE,
    });

    await expect(
      submitOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('refuses submission while any checklist step is incomplete', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_FUTURE,
      steps: [
        {
          completed: false,
          note: null,
          templateStep: { requiresPhoto: false, requiresSignature: false, requiresNote: false },
          evidence: [],
        },
      ],
    });

    await expect(
      submitOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({ reason: 'PROOF_REQUIRED' });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });

  it('revalidates published note and evidence requirements at submission', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_FUTURE,
      steps: [
        {
          completed: true,
          note: 'done',
          templateStep: { requiresPhoto: true, requiresSignature: false, requiresNote: true },
          evidence: [],
        },
      ],
    });

    await expect(
      submitOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({ reason: 'PROOF_REQUIRED' });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });
});
