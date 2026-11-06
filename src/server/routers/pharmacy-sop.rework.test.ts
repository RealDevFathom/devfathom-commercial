/**
 * DEV-751 — browser QA follow-ups on the pharmacy SOP router.
 *
 * Runs the real router against an in-memory db (same harness as
 * `pharmacy-sop.test.ts`) and pins:
 *
 * - rework after a send-back: `addReworkNote` (own work, back IN_PROGRESS, the
 *   latest review is a REJECT, server-derived author, audited) and the submit
 *   gate that needs a note answering the latest send-back; proof and record
 *   links after a send-back still go through the normal routes;
 * - the occurrence read's `rework` summary, `createdAfterLatestRejection`
 *   flags and plain-language `detail` for each linked record;
 * - `linkableRecords` details without status codes, and temperature steps that
 *   take only their own storage zone;
 * - fixed, plain wording for every engine refusal (never the engine's text);
 * - the pause/resume notice fields of `setAssignmentActive`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  annotateAudit: vi.fn(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    assertOccurrenceAtSite: vi.fn(),
    assertIndependentPharmacyVerifier: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
    linkPharmacySopRecord: vi.fn(),
  },
  engine: {
    startOccurrence: vi.fn(),
    completeStep: vi.fn(),
    submitOccurrence: vi.fn(),
    verifyOccurrence: vi.fn(),
    rejectOccurrence: vi.fn(),
    setAssignmentActive: vi.fn(),
    getOccurrenceAuditTrail: vi.fn(),
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async (_subject, action: string) => mocks.granted.has(action)) };
});
vi.mock('@/lib/pharmacy/sop-adapter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-adapter')>(
    '@/lib/pharmacy/sop-adapter'
  )),
  ...mocks.adapter,
}));
vi.mock('@/lib/restaurant/sop-execution', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-execution')>(
    '@/lib/restaurant/sop-execution'
  )),
  startOccurrence: mocks.engine.startOccurrence,
  completeStep: mocks.engine.completeStep,
  submitOccurrence: mocks.engine.submitOccurrence,
}));
vi.mock('@/lib/restaurant/sop-verification', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-verification')>(
    '@/lib/restaurant/sop-verification'
  )),
  verifyOccurrence: mocks.engine.verifyOccurrence,
  rejectOccurrence: mocks.engine.rejectOccurrence,
}));
vi.mock('@/lib/restaurant/sop-templates', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-templates')>(
    '@/lib/restaurant/sop-templates'
  )),
  setAssignmentActive: mocks.engine.setAssignmentActive,
}));
vi.mock('@/lib/restaurant/sop-audit', () => ({
  getOccurrenceAuditTrail: mocks.engine.getOccurrenceAuditTrail,
}));

import { TRPCError } from '@trpc/server';

import { router } from '../trpc';
import {
  REWORK_NOTE_REQUIRED_MESSAGE,
  SOP_STATE_MESSAGES,
  mapSopError,
  pharmacySopRouter,
  type SopCommand,
} from './pharmacy-sop';
import { PharmacySopAccessError } from '@/lib/pharmacy/sop-adapter';
import { findPharmacySopPack } from '@/lib/pharmacy/sop-library';
import { SopExecutionError } from '@/lib/restaurant/sop-execution';
import { RecurrenceError } from '@/lib/restaurant/sop-recurrence';
import { AssigneeTargetError } from '@/lib/restaurant/sop-assignment';
import { SopTemplateError } from '@/lib/restaurant/sop-templates';
import { SopVerificationError } from '@/lib/restaurant/sop-verification';

const app = router({ pharmacySop: pharmacySopRouter });
const SITE = {
  pharmacyBranchId: 'pbranch_1',
  sopBranchId: 'sopbranch_1',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const ACTOR = { staffProfileId: 'staff_me', displayName: 'Me', userId: 'user_1' };
const OCC_INPUT = { pharmacyBranchId: SITE.pharmacyBranchId, occurrenceId: 'occ_1' };
const temperatureLog = findPharmacySopPack('temperature-log')!;
const receiving = findPharmacySopPack('receiving')!;
const training = findPharmacySopPack('training-attestation')!;

const T_REJECT = new Date('2026-11-04T10:00:00.000Z');
const BEFORE = new Date('2026-11-04T09:00:00.000Z');
const AFTER = new Date('2026-11-04T10:30:00.000Z');

type Delegate = Record<string, ReturnType<typeof vi.fn>>;
const model = (): Delegate => ({
  findFirst: vi.fn().mockResolvedValue(null),
  findUnique: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
});

function makeDb() {
  const db = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopTemplateVersion: model(),
    restaurantSopAssignment: model(),
    restaurantSopVerification: model(),
    restaurantStaffProfile: model(),
    restaurantJobRole: model(),
    restaurantSopEvidence: model(),
    pharmacySopRecordLink: model(),
    pharmacySopReworkNote: model(),
    pharmacySopEvidenceCapture: model(),
    pharmacyTemperatureLog: model(),
    pharmacyControlledRegisterEntry: model(),
    pharmacyGoodsReceipt: model(),
    pharmacyManufacturingBatch: model(),
    pharmacyRecallNotice: model(),
  };
  const typed = db as Record<keyof typeof db, Delegate> & {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  typed.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(typed));
  typed.$queryRaw = vi.fn().mockResolvedValue([]);
  return typed;
}

let db: ReturnType<typeof makeDb>;
let occurrenceRow: {
  id: string;
  status: string;
  templateVersionId: string;
  assignedStaffProfileId: string | null;
  claimedByStaffProfileId: string | null;
  poolJobRoleId: string | null;
};

function caller() {
  return app.createCaller({
    db: db as never,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['pharmacy-core', 'pharmacy-safety'],
      modules: [],
      limits: {},
      activeSeats: 1,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        organizationId: 'org_1',
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

function audited(action: string) {
  return mocks.annotateAudit.mock.calls
    .map(([, detail]) => detail as { action: string; targetId?: string; metadata?: unknown })
    .filter((detail) => detail.action === action);
}

/** The occurrence as the note mutation re-reads it under its share lock. */
function arrangeNoteTarget(
  overrides: Partial<{
    status: string;
    assignedStaffProfileId: string | null;
    claimedByStaffProfileId: string | null;
    verifications: Array<{ id: string; action: string }>;
  }> = {}
) {
  db.restaurantSopOccurrence.findFirst.mockResolvedValue({
    status: 'IN_PROGRESS',
    assignedStaffProfileId: ACTOR.staffProfileId,
    claimedByStaffProfileId: null,
    verifications: [{ id: 'ver_reject_2', action: 'REJECT' }],
    ...overrides,
  });
  db.pharmacySopReworkNote.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'note_1',
      occurrenceStepId: data.occurrenceStepId,
      note: data.note,
      createdAt: AFTER,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  mocks.granted = new Set(['sop:manage', 'sop:complete', 'sop:verify']);
  occurrenceRow = {
    id: 'occ_1',
    status: 'IN_PROGRESS',
    templateVersionId: 'ver_1',
    assignedStaffProfileId: ACTOR.staffProfileId,
    claimedByStaffProfileId: null,
    poolJobRoleId: null,
  };
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
  mocks.adapter.resolvePharmacySopActor.mockResolvedValue(ACTOR);
  mocks.adapter.assertOccurrenceAtSite.mockImplementation(async () => ({ ...occurrenceRow }));
  mocks.adapter.assertIndependentPharmacyVerifier.mockResolvedValue(undefined);
  mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-manager']);
  mocks.adapter.linkPharmacySopRecord.mockResolvedValue({ linkId: 'link_1', created: true });
  mocks.engine.submitOccurrence.mockResolvedValue({
    occurrenceId: 'occ_1',
    status: 'SUBMITTED',
    submittedAt: new Date(),
  });
  mocks.engine.getOccurrenceAuditTrail.mockResolvedValue([]);
});

// ── addReworkNote ─────────────────────────────────────────────────────────────

describe('addReworkNote', () => {
  it('records what changed against the latest send-back, authored by the session actor', async () => {
    arrangeNoteTarget();
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue({ id: 'ostep_2' });
    await expect(
      caller().addReworkNote({
        ...OCC_INPUT,
        occurrenceStepId: 'ostep_2',
        note: '  Re-took the fridge reading after the door seal was fixed.  ',
      })
    ).resolves.toEqual({
      id: 'note_1',
      occurrenceStepId: 'ostep_2',
      note: 'Re-took the fridge reading after the door seal was fixed.',
      createdAt: AFTER,
      authorName: 'Me',
      afterLatestRejection: true,
    });
    expect(db.pharmacySopReworkNote.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        organizationId: 'org_1',
        pharmacyBranchId: SITE.pharmacyBranchId,
        occurrenceId: 'occ_1',
        occurrenceStepId: 'ostep_2',
        rejectionVerificationId: 'ver_reject_2',
        note: 'Re-took the fridge reading after the door seal was fixed.',
        authorStaffProfileId: ACTOR.staffProfileId,
        authorUserId: ACTOR.userId,
      },
      select: { id: true, occurrenceStepId: true, note: true, createdAt: true },
    });
    // Read under a share lock on this occurrence at this site, newest review first.
    const lock = db.$queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(lock.strings.join('?')).toContain('FOR SHARE');
    expect(lock.values).toEqual(['occ_1', 'org_1', SITE.sopBranchId]);
    expect(db.restaurantSopOccurrence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'occ_1', branchId: SITE.sopBranchId },
        select: expect.objectContaining({
          verifications: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { id: true, action: true },
          },
        }),
      })
    );
    expect(audited('pharmacy.sop.addReworkNote')).toEqual([
      expect.objectContaining({
        targetId: 'note_1',
        metadata: expect.objectContaining({ occurrenceId: 'occ_1', occurrenceStepId: 'ostep_2' }),
      }),
    ]);
  });

  it('takes no author, user or send-back from the input (strict schema)', async () => {
    arrangeNoteTarget();
    for (const extra of [
      { authorStaffProfileId: 'staff_other' },
      { authorUserId: 'user_other' },
      { rejectionVerificationId: 'ver_reject_1' },
    ]) {
      await expect(
        caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it', ...extra } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(db.pharmacySopReworkNote.create).not.toHaveBeenCalled();
  });

  it('needs a note that is not blank and fits in 2000 characters', async () => {
    arrangeNoteTarget();
    for (const note of ['', '   ', 'x'.repeat(2001)]) {
      await expect(caller().addReworkNote({ ...OCC_INPUT, note })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    await expect(
      caller().addReworkNote({ ...OCC_INPUT, note: 'x'.repeat(2000) })
    ).resolves.toMatchObject({ id: 'note_1' });
  });

  it('is only for the owner of the work', async () => {
    occurrenceRow = { ...occurrenceRow, assignedStaffProfileId: 'staff_other' };
    arrangeNoteTarget();
    await expect(caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: SOP_STATE_MESSAGES.ownWork,
    });
    expect(db.pharmacySopReworkNote.create).not.toHaveBeenCalled();
  });

  it('needs the latest review to be a send-back', async () => {
    for (const verifications of [[], [{ id: 'ver_verify', action: 'VERIFY' }]]) {
      arrangeNoteTarget({ verifications });
      await expect(
        caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it' })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'This procedure has not been sent back, so there is nothing to answer.',
      });
    }
    expect(db.pharmacySopReworkNote.create).not.toHaveBeenCalled();
  });

  it('needs the procedure started again (IN_PROGRESS)', async () => {
    arrangeNoteTarget({ status: 'REJECTED' });
    await expect(caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Start this procedure again before saying what you changed.',
    });
    arrangeNoteTarget({ status: 'SUBMITTED' });
    await expect(caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.changed,
    });
    expect(db.pharmacySopReworkNote.create).not.toHaveBeenCalled();
  });

  it('refuses a step that is not on this occurrence', async () => {
    arrangeNoteTarget();
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue(null);
    await expect(
      caller().addReworkNote({ ...OCC_INPUT, occurrenceStepId: 'ostep_elsewhere', note: 'Fixed' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.restaurantSopOccurrenceStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ostep_elsewhere', occurrenceId: 'occ_1' } })
    );
    expect(db.pharmacySopReworkNote.create).not.toHaveBeenCalled();
  });

  it('needs sop:complete', async () => {
    mocks.granted = new Set(['sop:verify']);
    await expect(caller().addReworkNote({ ...OCC_INPUT, note: 'Fixed it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// ── Submit after a send-back ─────────────────────────────────────────────────

/** The training pack, every requirement met: step 2 noted, step 3 signed (not checked here). */
function arrangeSubmittable() {
  db.restaurantSopOccurrence.findUnique.mockResolvedValue({
    assignment: { template: { name: training.name } },
    steps: [],
  });
}

describe('submit after a send-back', () => {
  it('needs a rework note answering the latest send-back', async () => {
    arrangeSubmittable();
    db.restaurantSopVerification.findFirst.mockResolvedValue({ id: 'ver_reject_2' });
    db.pharmacySopReworkNote.findFirst.mockResolvedValue(null);
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: REWORK_NOTE_REQUIRED_MESSAGE,
    });
    expect(REWORK_NOTE_REQUIRED_MESSAGE).toBe(
      'Say what you changed after it was sent back before sending it for review again.'
    );
    expect(db.restaurantSopVerification.findFirst).toHaveBeenCalledWith({
      where: { occurrenceId: 'occ_1', action: 'REJECT' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    // Only a note for THAT send-back (written after it) counts.
    expect(db.pharmacySopReworkNote.findFirst).toHaveBeenCalledWith({
      where: {
        occurrenceId: 'occ_1',
        pharmacyBranchId: SITE.pharmacyBranchId,
        rejectionVerificationId: 'ver_reject_2',
      },
      select: { id: true },
    });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });

  it('goes through to the engine once the note exists', async () => {
    arrangeSubmittable();
    db.restaurantSopVerification.findFirst.mockResolvedValue({ id: 'ver_reject_2' });
    db.pharmacySopReworkNote.findFirst.mockResolvedValue({ id: 'note_1' });
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
    expect(mocks.engine.submitOccurrence).toHaveBeenCalledOnce();
  });

  it('never asks for a note on a first submission', async () => {
    arrangeSubmittable();
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
    expect(db.pharmacySopReworkNote.findFirst).not.toHaveBeenCalled();
  });

  it('still applies the existing proof and record requirements after the note', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      assignment: { template: { name: temperatureLog.name } },
      steps: temperatureLog.steps.map((step, index) => ({
        id: `ostep_${index + 1}`,
        note: 'None',
        templateStep: {
          title: step.title,
          stepOrder: index + 1,
          requiresPhoto: false,
          requiresSignature: false,
        },
        evidence: [],
      })),
    });
    db.restaurantSopVerification.findFirst.mockResolvedValue({ id: 'ver_reject_2' });
    db.pharmacySopReworkNote.findFirst.mockResolvedValue({ id: 'note_1' });
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(temperatureLog.steps[0]!.title),
    });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });

  it('says plainly when the procedure is not open, never naming a status', async () => {
    for (const [status, message] of [
      ['REJECTED', 'Start this procedure before sending it for review.'],
      ['SCHEDULED', 'Start this procedure before sending it for review.'],
      ['SUBMITTED', SOP_STATE_MESSAGES.changed],
      ['VERIFIED', SOP_STATE_MESSAGES.changed],
    ] as const) {
      occurrenceRow = { ...occurrenceRow, status };
      const error = await caller()
        .submit(OCC_INPUT)
        .catch((caught: TRPCError) => caught);
      expect(error).toMatchObject({ code: 'CONFLICT', message });
      expect((error as TRPCError).message).not.toMatch(/[A-Z]{3,}_?[A-Z]*|status/);
    }
  });
});

describe('new proof and links after a send-back use the normal routes', () => {
  it('evidenceTarget accepts the owner once the procedure is back IN_PROGRESS', async () => {
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue({ id: 'ostep_1' });
    await expect(
      caller().evidenceTarget({ ...OCC_INPUT, occurrenceStepId: 'ostep_1' })
    ).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      occurrenceId: 'occ_1',
      occurrenceStepId: 'ostep_1',
      uploaderStaffProfileId: ACTOR.staffProfileId,
    });
    occurrenceRow = { ...occurrenceRow, status: 'REJECTED' };
    await expect(
      caller().evidenceTarget({ ...OCC_INPUT, occurrenceStepId: 'ostep_1' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.changed });
  });

  it.each(['SCHEDULED', 'REJECTED', 'SUBMITTED', 'LATE', 'VERIFIED'] as const)(
    'a stale screen adding proof or a record to a %s procedure is told it changed',
    async (status) => {
      db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
        template: { name: receiving.name },
      });
      occurrenceRow = { ...occurrenceRow, status };
      for (const call of [
        () => caller().evidenceTarget({ ...OCC_INPUT, occurrenceStepId: 'ostep_1' }),
        () => caller().linkRecord({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT', recordId: 'gr_2' }),
      ]) {
        const error = await call().catch((caught: TRPCError) => caught);
        expect(error).toMatchObject({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.changed });
        expect((error as TRPCError).message).not.toMatch(/occurrence|[A-Z]{3,}/);
      }
      expect(mocks.adapter.linkPharmacySopRecord).not.toHaveBeenCalled();
    }
  );

  it('a procedure that moved on inside the link transaction is told it changed', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: receiving.name },
    });
    mocks.adapter.linkPharmacySopRecord.mockRejectedValueOnce(
      new PharmacySopAccessError('This procedure is not in progress.', 'STATE_CHANGED')
    );
    await expect(
      caller().linkRecord({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT', recordId: 'gr_2' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.changed });
  });

  it('says plainly that a cancelled or reversed receipt cannot be linked', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: receiving.name },
    });
    mocks.adapter.linkPharmacySopRecord.mockRejectedValueOnce(
      new PharmacySopAccessError(
        'A cancelled or reversed receipt can’t be linked.',
        'INVALID_INPUT'
      )
    );
    await expect(
      caller().linkRecord({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT', recordId: 'gr_x' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A cancelled or reversed receipt can’t be linked.',
    });
  });

  it('linkRecord accepts a new link once the procedure is back IN_PROGRESS', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: receiving.name },
    });
    await expect(
      caller().linkRecord({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT', recordId: 'gr_2' })
    ).resolves.toEqual({ linkId: 'link_1', created: true });
    occurrenceRow = { ...occurrenceRow, status: 'REJECTED' };
    await expect(
      caller().linkRecord({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT', recordId: 'gr_3' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.adapter.linkPharmacySopRecord).toHaveBeenCalledOnce();
  });
});

// ── Occurrence read ──────────────────────────────────────────────────────────

function arrangeOccurrenceRead(): Record<string, unknown> {
  db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
    template: { name: temperatureLog.name },
  });
  const detail = {
    id: 'occ_1',
    status: 'IN_PROGRESS',
    businessDate: new Date(Date.UTC(2026, 10, 4)),
    dueAt: new Date('2026-11-04T08:00:00.000Z'),
    windowEndsAt: new Date('2026-11-04T12:00:00.000Z'),
    startedAt: AFTER,
    claimedAt: null,
    submittedAt: null,
    resolvedAt: null,
    assignedStaffProfileId: ACTOR.staffProfileId,
    claimedByStaffProfileId: null,
    poolJobRoleId: null,
    assignedStaff: { displayName: 'Me' },
    claimedBy: null,
    assignment: {
      graceMinutes: 0,
      template: { id: 'tpl', name: temperatureLog.name, category: 'Storage' },
    },
    steps: temperatureLog.steps.map((step, index) => ({
      id: `ostep_${index + 1}`,
      templateStepId: `tstep_${index + 1}`,
      completed: true,
      completedAt: BEFORE,
      note: null,
      completedBy: { displayName: 'Me' },
      templateStep: {
        stepOrder: index + 1,
        title: step.title,
        instructions: null,
        requiresPhoto: false,
        requiresNote: false,
        requiresSignature: false,
      },
    })),
    evidence: [
      {
        id: 'ev_old',
        occurrenceStepId: 'ostep_3',
        mimeType: 'image/png; evidence=photo',
        sizeBytes: 3,
        storageRef: null,
        contentHash: 'a'.repeat(64),
        uploaderStaffProfileId: ACTOR.staffProfileId,
        capturedAt: BEFORE,
        createdAt: BEFORE,
        uploader: { displayName: 'Me' },
      },
      {
        id: 'ev_new',
        occurrenceStepId: 'ostep_3',
        mimeType: 'image/png; evidence=photo',
        sizeBytes: 3,
        storageRef: null,
        contentHash: 'b'.repeat(64),
        uploaderStaffProfileId: ACTOR.staffProfileId,
        capturedAt: AFTER,
        createdAt: AFTER,
        uploader: { displayName: 'Me' },
      },
    ],
    verifications: [
      {
        id: 'ver_reject_1',
        action: 'REJECT',
        reason: 'Blurry',
        createdAt: new Date('2026-11-04T08:30:00.000Z'),
        actor: { displayName: 'Rehan' },
      },
      {
        id: 'ver_reject_2',
        action: 'REJECT',
        reason: 'Fridge reading is from yesterday.',
        createdAt: T_REJECT,
        actor: { displayName: 'Sana' },
      },
    ],
  };
  db.restaurantSopOccurrence.findUnique.mockResolvedValue(detail);
  db.pharmacySopRecordLink.findMany.mockResolvedValue([
    {
      id: 'link_old',
      occurrenceStepId: 'ostep_1',
      recordType: 'TEMPERATURE_LOG',
      recordId: 'log_old',
      note: null,
      createdAt: BEFORE,
      linkedByStaffProfileId: ACTOR.staffProfileId,
    },
    {
      id: 'link_new',
      occurrenceStepId: 'ostep_1',
      recordType: 'TEMPERATURE_LOG',
      recordId: 'log_new',
      note: null,
      createdAt: AFTER,
      linkedByStaffProfileId: ACTOR.staffProfileId,
    },
    {
      id: 'link_gone',
      occurrenceStepId: 'ostep_2',
      recordType: 'TEMPERATURE_LOG',
      recordId: 'log_elsewhere',
      note: null,
      createdAt: AFTER,
      linkedByStaffProfileId: ACTOR.staffProfileId,
    },
  ]);
  db.pharmacyTemperatureLog.findMany.mockResolvedValue([
    {
      id: 'log_old',
      recordedAt: new Date('2026-11-03T10:20:00.000Z'),
      temperatureC: 9.04,
      outOfRange: true,
      location: { name: 'QA Fridge', coldChain: true },
    },
    {
      id: 'log_new',
      recordedAt: new Date('2026-11-04T10:20:00.000Z'), // 15:20 Asia/Karachi
      temperatureC: 11.5,
      outOfRange: false,
      location: { name: 'QA Fridge', coldChain: true },
    },
  ]);
  db.pharmacySopReworkNote.findMany.mockResolvedValue([
    {
      id: 'note_first_round',
      occurrenceStepId: null,
      rejectionVerificationId: 'ver_reject_1',
      note: 'Retook the photo.',
      createdAt: new Date('2026-11-04T08:45:00.000Z'),
      authorStaffProfileId: ACTOR.staffProfileId,
    },
    {
      id: 'note_now',
      occurrenceStepId: 'ostep_1',
      rejectionVerificationId: 'ver_reject_2',
      note: 'Linked today’s reading.',
      createdAt: AFTER,
      authorStaffProfileId: ACTOR.staffProfileId,
    },
  ]);
  db.restaurantStaffProfile.findMany.mockResolvedValue([
    { id: ACTOR.staffProfileId, displayName: 'Me' },
  ]);
  return detail;
}

describe('occurrence read after a send-back', () => {
  it('summarises the latest send-back and every rework note by name', async () => {
    arrangeOccurrenceRead();
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.rework).toEqual({
      latestRejection: {
        reason: 'Fridge reading is from yesterday.',
        createdAt: T_REJECT,
        reviewerName: 'Sana',
      },
      notes: [
        {
          id: 'note_first_round',
          occurrenceStepId: null,
          note: 'Retook the photo.',
          createdAt: new Date('2026-11-04T08:45:00.000Z'),
          authorName: 'Me',
          afterLatestRejection: false,
        },
        {
          id: 'note_now',
          occurrenceStepId: 'ostep_1',
          note: 'Linked today’s reading.',
          createdAt: AFTER,
          authorName: 'Me',
          afterLatestRejection: true,
        },
      ],
    });
    // Notes are read for this occurrence at this pharmacy branch only.
    expect(db.pharmacySopReworkNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { occurrenceId: 'occ_1', pharmacyBranchId: SITE.pharmacyBranchId },
      })
    );
  });

  it('flags proof and links added after the latest send-back', async () => {
    arrangeOccurrenceRead();
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.evidence.map((row) => [row.id, row.createdAfterLatestRejection])).toEqual([
      ['ev_old', false],
      ['ev_new', true],
    ]);
    expect(read.recordLinks.map((link) => [link.id, link.createdAfterLatestRejection])).toEqual([
      ['link_old', false],
      ['link_new', true],
      ['link_gone', true],
    ]);
  });

  it('describes each linked record in plain words, read at this branch only', async () => {
    arrangeOccurrenceRead();
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.recordLinks.map((link) => link.detail)).toEqual([
      {
        kind: 'TEMPERATURE_LOG',
        label: 'QA Fridge · 9.0 °C at 15:20',
        value: '9.0 °C',
        location: 'QA Fridge',
        recordedAt: new Date('2026-11-03T10:20:00.000Z'),
        outOfRange: true,
        statusLabel: 'Out of range',
      },
      {
        kind: 'TEMPERATURE_LOG',
        label: 'QA Fridge · 11.5 °C at 15:20',
        value: '11.5 °C',
        location: 'QA Fridge',
        recordedAt: new Date('2026-11-04T10:20:00.000Z'),
        outOfRange: false,
        statusLabel: 'In range',
      },
      // Not readable at this branch: never fetched from another branch.
      {
        kind: 'TEMPERATURE_LOG',
        label: 'This record is no longer available at this branch.',
        value: null,
        location: null,
        recordedAt: null,
        outOfRange: null,
        statusLabel: null,
      },
    ]);
    expect(db.pharmacyTemperatureLog.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          id: { in: ['log_old', 'log_new', 'log_elsewhere'] },
          organizationId: 'org_1',
          branchId: SITE.pharmacyBranchId,
        },
      })
    );
  });

  it('has an empty rework summary for a procedure never sent back', async () => {
    const detail = arrangeOccurrenceRead();
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ ...detail, verifications: [] });
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.rework).toEqual({ latestRejection: null, notes: [] });
    expect(read.evidence.every((row) => row.createdAfterLatestRejection === false)).toBe(true);
    expect(db.pharmacySopReworkNote.findMany).not.toHaveBeenCalled();
  });

  it('names the storage zone each temperature step takes', async () => {
    arrangeOccurrenceRead();
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.steps.map((step) => step.temperatureZone)).toEqual(['COLD_CHAIN', 'AMBIENT', null]);
  });
});

// ── Linkable records ─────────────────────────────────────────────────────────

describe('linkableRecords', () => {
  const window = {
    dueAt: new Date('2026-11-04T08:00:00.000Z'),
    windowEndsAt: new Date('2026-11-04T12:00:00.000Z'),
  };

  it('labels candidates in plain words, never with a raw status code', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: receiving.name },
    });
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(window);
    db.pharmacyGoodsReceipt.findMany.mockResolvedValue([
      {
        id: 'gr_1',
        reference: 'GRN-0042',
        status: 'DRAFT',
        receivedAt: new Date('2026-11-04T09:00:00.000Z'),
        supplierInvoiceRef: 'INV-9',
        supplier: { name: 'Medline Traders' },
      },
    ]);
    const [row] = await caller().linkableRecords({ ...OCC_INPUT, recordType: 'GOODS_RECEIPT' });
    expect(row).toEqual({
      id: 'gr_1',
      recordType: 'GOODS_RECEIPT',
      label: 'Receipt GRN-0042 · Medline Traders',
      occurredAt: new Date('2026-11-04T09:00:00.000Z'),
      outOfRange: null,
      detail: {
        kind: 'GOODS_RECEIPT',
        label: 'Receipt GRN-0042 · Medline Traders',
        value: 'Invoice INV-9',
        location: null,
        recordedAt: new Date('2026-11-04T09:00:00.000Z'),
        outOfRange: null,
        statusLabel: 'Draft',
      },
    });
    expect(JSON.stringify(row)).not.toMatch(/DRAFT|POSTED/);
    // A cancelled receipt never happened, so the picker never offers one.
    expect(db.pharmacyGoodsReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { notIn: ['CANCELLED', 'REVERSED'] } }),
      })
    );
  });

  it.each([
    ['ostep_1', 0, true],
    ['ostep_2', 1, false],
  ] as const)(
    'a temperature step (%s) offers only readings from its own storage zone',
    async (occurrenceStepId, index, coldChain) => {
      db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
        template: { name: temperatureLog.name },
      });
      db.restaurantSopOccurrence.findUnique.mockResolvedValue(window);
      db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue({
        templateStep: { title: temperatureLog.steps[index]!.title, stepOrder: index + 1 },
      });
      await caller().linkableRecords({
        ...OCC_INPUT,
        recordType: 'TEMPERATURE_LOG',
        occurrenceStepId,
      });
      expect(db.pharmacyTemperatureLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org_1',
            branchId: SITE.pharmacyBranchId,
            recordedAt: { gte: new Date('2026-11-03T08:00:00.000Z'), lte: window.windowEndsAt },
            location: { coldChain },
          },
        })
      );
    }
  );

  it('without a step, offers every zone', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: temperatureLog.name },
    });
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(window);
    await caller().linkableRecords({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG' });
    const [args] = db.pharmacyTemperatureLog.findMany.mock.calls[0]!;
    expect((args as { where: Record<string, unknown> }).where).not.toHaveProperty('location');
  });

  it('linkRecord hands the adapter the step’s storage zone to enforce', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: temperatureLog.name },
    });
    for (const [index, zone] of [
      [0, 'COLD_CHAIN'],
      [1, 'AMBIENT'],
    ] as const) {
      db.restaurantSopOccurrenceStep.findFirst.mockResolvedValueOnce({
        templateStep: { title: temperatureLog.steps[index]!.title, stepOrder: index + 1 },
      });
      await caller().linkRecord({
        ...OCC_INPUT,
        occurrenceStepId: `ostep_${index + 1}`,
        recordType: 'TEMPERATURE_LOG',
        recordId: 'log_1',
      });
      expect(mocks.adapter.linkPharmacySopRecord).toHaveBeenLastCalledWith(
        db,
        expect.objectContaining({ temperatureZone: zone })
      );
    }
  });
});

// ── Engine refusals in plain words ───────────────────────────────────────────

describe('engine refusals never reach the user as engine text', () => {
  const refusal = (err: unknown, command?: SopCommand) => {
    try {
      mapSopError(err, command);
    } catch (caught) {
      return { code: (caught as TRPCError).code, message: (caught as TRPCError).message };
    }
    throw new Error('mapSopError returned');
  };

  it.each([
    [
      new SopExecutionError(
        'Cannot start an occurrence in status SUBMITTED. Expected SCHEDULED or REJECTED.',
        'INVALID_STATE'
      ),
      'start',
      'CONFLICT',
      SOP_STATE_MESSAGES.changed,
    ],
    [
      new SopExecutionError(
        'Cannot complete a step on an occurrence in status SUBMITTED. Expected IN_PROGRESS.',
        'INVALID_STATE'
      ),
      'completeStep',
      'CONFLICT',
      SOP_STATE_MESSAGES.changed,
    ],
    [
      new SopExecutionError('Only the assigned or claiming staff member…', 'NOT_OWNER'),
      'completeStep',
      'FORBIDDEN',
      SOP_STATE_MESSAGES.ownWork,
    ],
    [
      new SopExecutionError('Claim this role-pool occurrence before working on it.', 'NOT_OWNER'),
      'start',
      'FORBIDDEN',
      SOP_STATE_MESSAGES.claimFirst,
    ],
    [
      new SopExecutionError('Step tstep_1 is complete.', 'STEP_ALREADY_COMPLETED'),
      'completeStep',
      'CONFLICT',
      SOP_STATE_MESSAGES.stepDone,
    ],
    [
      new SopExecutionError(
        'Photo proof is required before completing this step.',
        'PROOF_REQUIRED'
      ),
      'completeStep',
      'BAD_REQUEST',
      'Add the photo this step needs before marking it done.',
    ],
    [
      new SopExecutionError(
        'Signature proof is required before completing this step.',
        'PROOF_REQUIRED'
      ),
      'completeStep',
      'BAD_REQUEST',
      'Add the signature this step needs before marking it done.',
    ],
    [
      new SopExecutionError(
        'A completion note is required before completing this step.',
        'PROOF_REQUIRED'
      ),
      'completeStep',
      'BAD_REQUEST',
      'Add the note this step needs before marking it done.',
    ],
    [
      new SopExecutionError(
        'Complete every checklist step before submitting for review.',
        'PROOF_REQUIRED'
      ),
      'submit',
      'BAD_REQUEST',
      'Finish every step before sending it for review.',
    ],
    [
      new SopExecutionError('Something internal about occ_secret_1.', 'PROOF_REQUIRED'),
      'submit',
      'BAD_REQUEST',
      'Add every note and proof the steps need before sending it for review.',
    ],
    [
      new SopExecutionError('sizeBytes must be non-negative.', 'INVALID'),
      'other',
      'BAD_REQUEST',
      SOP_STATE_MESSAGES.invalid,
    ],
    [
      new SopVerificationError(
        'Cannot reject an occurrence in status VERIFIED. Expected SUBMITTED or LATE.',
        'INVALID_STATE'
      ),
      'reject',
      'CONFLICT',
      SOP_STATE_MESSAGES.alreadyChecked,
    ],
    [
      new SopVerificationError(
        'Cannot verify an occurrence in status REJECTED. Expected SUBMITTED or LATE.',
        'INVALID_STATE'
      ),
      'verify',
      'CONFLICT',
      SOP_STATE_MESSAGES.alreadyChecked,
    ],
    [
      new SopVerificationError('Waiving needs co-authorization abc.', 'CO_AUTH_REQUIRED'),
      'other',
      'FORBIDDEN',
      'A second person must approve this before it can go ahead.',
    ],
    [
      new SopVerificationError('reason must be set', 'INVALID'),
      'reject',
      'BAD_REQUEST',
      SOP_STATE_MESSAGES.invalid,
    ],
    [
      new SopTemplateError('A superseded assignment cannot be reactivated.', 'INVALID_STATE'),
      'schedule',
      'CONFLICT',
      SOP_STATE_MESSAGES.scheduleReplaced,
    ],
    [
      new SopTemplateError('Version v_1 is PUBLISHED.', 'VERSION_NOT_DRAFT'),
      'other',
      'CONFLICT',
      SOP_STATE_MESSAGES.templateChanged,
    ],
    [
      new SopTemplateError('Template tpl_1 has reached TEMPLATE_LIMIT.', 'TEMPLATE_LIMIT_REACHED'),
      'other',
      'CONFLICT',
      'This workspace has reached its procedure template limit.',
    ],
    [
      new SopTemplateError('Version v_1 has NO_STEPS.', 'NO_STEPS'),
      'other',
      'BAD_REQUEST',
      'This procedure has no steps yet.',
    ],
    [
      new RecurrenceError('intervalEndTimeMinutes is only valid for INTERVAL recurrence.'),
      'schedule',
      'BAD_REQUEST',
      'Check the schedule’s days and times and try again.',
    ],
    [
      new RecurrenceError('INTERVAL end time must be later than its start time.'),
      'schedule',
      'BAD_REQUEST',
      'Choose a last check time later than the first check time.',
    ],
    [
      new AssigneeTargetError('Job role role_1 is inactive.', 'ROLE_INACTIVE'),
      'schedule',
      'CONFLICT',
      'That role is no longer active at this branch.',
    ],
    [
      new AssigneeTargetError('A ROLE assignment is missing its job role.', 'INVALID'),
      'schedule',
      'BAD_REQUEST',
      'Choose who this procedure is assigned to.',
    ],
  ] as const)('%s → fixed wording', (err, command, code, message) => {
    const mapped = refusal(err, command);
    expect(mapped).toEqual({ code, message });
    // Never the engine's own text, a state name or an id.
    expect(mapped.message).not.toBe(err.message);
    expect(mapped.message).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b|\bstatus\b|\bExpected\b|_\d|occ_/);
  });
});

describe('review decisions on a procedure that is no longer in review', () => {
  it('reject on an already-verified procedure: "already been checked", never the engine text', async () => {
    occurrenceRow = { ...occurrenceRow, status: 'VERIFIED', assignedStaffProfileId: 'staff_op' };
    await expect(caller().reject({ ...OCC_INPUT, reason: 'Missing proof' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.alreadyChecked,
    });
    expect(mocks.engine.rejectOccurrence).not.toHaveBeenCalled();
  });

  it('verify on a procedure still being worked on: "not been sent for review yet"', async () => {
    occurrenceRow = { ...occurrenceRow, status: 'IN_PROGRESS', assignedStaffProfileId: 'staff_op' };
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.notInReview,
    });
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();
  });

  it('a decision that loses a race to another reviewer is mapped, not forwarded', async () => {
    occurrenceRow = { ...occurrenceRow, status: 'SUBMITTED', assignedStaffProfileId: 'staff_op' };
    mocks.engine.rejectOccurrence.mockRejectedValue(
      new SopVerificationError(
        'Cannot reject an occurrence in status VERIFIED. Expected SUBMITTED or LATE.',
        'INVALID_STATE'
      )
    );
    await expect(caller().reject({ ...OCC_INPUT, reason: 'Missing proof' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.alreadyChecked,
    });
  });

  it('a start that loses a race is mapped, not forwarded', async () => {
    mocks.engine.startOccurrence.mockRejectedValue(
      new SopExecutionError(
        'Cannot start an occurrence in status SUBMITTED. Expected SCHEDULED or REJECTED.',
        'INVALID_STATE'
      )
    );
    await expect(caller().start(OCC_INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.changed,
    });
  });
});

// ── Pause / resume notice ────────────────────────────────────────────────────

describe('setAssignmentActive notice', () => {
  const input = { pharmacyBranchId: SITE.pharmacyBranchId, assignmentId: 'asg_1' };

  it('returns the schedule name and the role it is for', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue({
      id: 'asg_1',
      branchId: SITE.sopBranchId,
      frequency: 'INTERVAL',
      assigneeTargetType: 'ROLE',
      assigneeJobRoleId: 'role_asst',
      assigneeStaff: null,
      template: { name: temperatureLog.name },
    });
    db.restaurantJobRole.findMany.mockResolvedValue([
      { id: 'role_asst', key: 'pharmacy-assistant' },
    ]);
    mocks.engine.setAssignmentActive.mockResolvedValue({ id: 'asg_1', active: false });
    await expect(caller().setAssignmentActive({ ...input, active: false })).resolves.toEqual({
      id: 'asg_1',
      active: false,
      templateName: temperatureLog.name,
      assigneeType: 'ROLE',
      assigneeLabel: 'Pharmacy assistant',
      roleKey: 'pharmacy-assistant',
    });
  });

  it('returns the person’s name for a person schedule', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue({
      id: 'asg_1',
      branchId: SITE.sopBranchId,
      frequency: 'WEEKLY',
      assigneeTargetType: 'PERSON',
      assigneeJobRoleId: null,
      assigneeStaff: { displayName: 'Ayesha Khan' },
      template: { name: training.name },
    });
    mocks.engine.setAssignmentActive.mockResolvedValue({ id: 'asg_1', active: true });
    await expect(caller().setAssignmentActive({ ...input, active: true })).resolves.toMatchObject({
      active: true,
      templateName: training.name,
      assigneeType: 'PERSON',
      assigneeLabel: 'Ayesha Khan',
      roleKey: null,
    });
  });

  it('a replaced schedule says so plainly', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue({
      id: 'asg_1',
      branchId: SITE.sopBranchId,
      frequency: 'DAILY',
      assigneeTargetType: 'ROLE',
      assigneeJobRoleId: null,
      assigneeStaff: null,
      template: { name: temperatureLog.name },
    });
    mocks.engine.setAssignmentActive.mockRejectedValue(
      new SopTemplateError('A superseded assignment cannot be reactivated.', 'INVALID_STATE')
    );
    await expect(caller().setAssignmentActive({ ...input, active: true })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SOP_STATE_MESSAGES.scheduleReplaced,
    });
  });
});
