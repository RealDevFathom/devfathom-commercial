/**
 * DEV-751 — pharmacy SOP proof provenance through capture receipts.
 *
 * Runs the real router against an in-memory db (same harness as
 * `pharmacy-sop.test.ts`) and pins how submit, verify and the occurrence read
 * treat the four provenance classes: a server-issued receipt (authoritative,
 * survives AUTH_SECRET rotation), a legacy HMAC name that verifies under the
 * current secret, a pharmacy-style name that no longer verifies (proof exists,
 * capture unconfirmed — never reported as missing), and foreign proof.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    assertOccurrenceAtSite: vi.fn(),
    assertIndependentPharmacyVerifier: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
  },
  engine: {
    submitOccurrence: vi.fn(),
    verifyOccurrence: vi.fn(),
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
  annotateAudit: vi.fn(),
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
  submitOccurrence: mocks.engine.submitOccurrence,
}));
vi.mock('@/lib/restaurant/sop-verification', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-verification')>(
    '@/lib/restaurant/sop-verification'
  )),
  verifyOccurrence: mocks.engine.verifyOccurrence,
}));
vi.mock('@/lib/restaurant/sop-audit', () => ({
  getOccurrenceAuditTrail: mocks.engine.getOccurrenceAuditTrail,
}));

import { router } from '../trpc';
import { pharmacySopRouter } from './pharmacy-sop';
import { pharmacySopEvidenceFilename } from '@/lib/pharmacy/sop-evidence';
import { findPharmacySopPack } from '@/lib/pharmacy/sop-library';

const ORIGINAL_SECRET = process.env.AUTH_SECRET;
const SECRET_BEFORE = 'pharmacy-sop-receipts-fixture-secret-one';
const SECRET_AFTER = 'pharmacy-sop-receipts-fixture-secret-two';

const app = router({ pharmacySop: pharmacySopRouter });
const SITE = {
  pharmacyBranchId: 'pbranch_1',
  sopBranchId: 'sopbranch_1',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const ACTOR = { staffProfileId: 'staff_me', displayName: 'Me', userId: 'user_1' };
const OCC_INPUT = { pharmacyBranchId: SITE.pharmacyBranchId, occurrenceId: 'occ_1' };
const training = findPharmacySopPack('training-attestation')!;

const UNCONFIRMED_VERIFY =
  'Proof is attached to this procedure, but its pharmacy capture can’t be confirmed. Ask a manager to run the legacy receipt backfill, or send it back so it can be captured again.';
const FOREIGN_VERIFY =
  'Proof on this procedure was not captured through the pharmacy workspace. Ask a manager to review it.';

type EvidenceRow = {
  id: string;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
};

/** Proof as the pharmacy route stores it, named under the secret in force now. */
function pharmacyEvidence(id: string, stepId: string, purpose: 'photo' | 'signature') {
  const row = {
    occurrenceStepId: stepId,
    contentHash: id.padEnd(64, 'a').slice(0, 64),
    mimeType: `image/png; evidence=${purpose}`,
    uploaderStaffProfileId: ACTOR.staffProfileId,
  };
  const name = pharmacySopEvidenceFilename(
    { organizationId: 'org_1', occurrenceId: 'occ_1', ...row },
    'png'
  );
  return { id, ...row, storageRef: `/api/files/${name}` } satisfies EvidenceRow;
}

/** The same kind of proof attached through a restaurant surface. */
function foreignEvidence(id: string, stepId: string, purpose: 'photo' | 'signature') {
  return {
    id,
    occurrenceStepId: stepId,
    contentHash: 'b'.repeat(64),
    mimeType: `image/png; evidence=${purpose}`,
    uploaderStaffProfileId: ACTOR.staffProfileId,
    storageRef: '/api/files/sop-11111111-2222-4333-8444-555555555555.png',
  } satisfies EvidenceRow;
}

function receiptFor(row: EvidenceRow, overrides: Record<string, string> = {}) {
  return {
    evidenceId: row.id,
    occurrenceId: 'occ_1',
    contentHash: row.contentHash,
    ...overrides,
  };
}

type Delegate = Record<string, ReturnType<typeof vi.fn>>;
const model = (): Delegate => ({
  findFirst: vi.fn().mockResolvedValue(null),
  findUnique: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
});

function makeDb() {
  const db = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopTemplateVersion: model(),
    restaurantStaffProfile: model(),
    restaurantJobRole: model(),
    pharmacySopRecordLink: model(),
    pharmacyTemperatureLog: model(),
    restaurantSopEvidence: model(),
    pharmacySopEvidenceCapture: model(),
    restaurantSopVerification: model(),
    pharmacySopReworkNote: model(),
  };
  const typed = db as Record<keyof typeof db, Delegate> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  typed.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(typed));
  return typed;
}

let db: ReturnType<typeof makeDb>;
let occurrenceStatus = 'IN_PROGRESS';

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

/** The training pack: step 2 needs a note, step 3 a signature. */
function arrangeSubmission(signatures: EvidenceRow[]) {
  db.restaurantSopOccurrence.findUnique.mockResolvedValue({
    assignment: { template: { name: training.name } },
    steps: training.steps.map((step, index) => ({
      id: `ostep_${index + 1}`,
      note: index === 1 ? 'None' : null,
      templateStep: {
        title: step.title,
        stepOrder: index + 1,
        requiresPhoto: false,
        requiresSignature: index === 2,
      },
      evidence: index === 2 ? signatures : [],
    })),
  });
}

function arrangeOccurrenceRead(rows: EvidenceRow[]) {
  db.restaurantSopOccurrence.findUnique.mockResolvedValue({
    id: 'occ_1',
    status: 'SUBMITTED',
    businessDate: new Date(Date.UTC(2026, 10, 4)),
    dueAt: new Date(),
    windowEndsAt: new Date(Date.now() + 3_600_000),
    startedAt: new Date(),
    claimedAt: null,
    submittedAt: new Date(),
    resolvedAt: null,
    assignedStaffProfileId: ACTOR.staffProfileId,
    claimedByStaffProfileId: null,
    poolJobRoleId: null,
    assignedStaff: { displayName: 'Me' },
    claimedBy: null,
    assignment: {
      graceMinutes: 0,
      template: { id: 'tpl', name: training.name, category: 'Training' },
    },
    steps: [],
    evidence: rows.map((row) => ({
      ...row,
      sizeBytes: 3,
      capturedAt: new Date(),
      uploader: { displayName: 'Me' },
    })),
    verifications: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = SECRET_BEFORE;
  db = makeDb();
  mocks.granted = new Set(['sop:manage', 'sop:complete', 'sop:verify']);
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
  mocks.adapter.resolvePharmacySopActor.mockResolvedValue(ACTOR);
  // Stateful: a submit moves it into review, where verify finds it.
  occurrenceStatus = 'IN_PROGRESS';
  mocks.adapter.assertOccurrenceAtSite.mockImplementation(async () => ({
    id: 'occ_1',
    status: occurrenceStatus,
    templateVersionId: 'ver_1',
    assignedStaffProfileId: ACTOR.staffProfileId,
    claimedByStaffProfileId: null,
    poolJobRoleId: null,
  }));
  mocks.adapter.assertIndependentPharmacyVerifier.mockResolvedValue(undefined);
  mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-manager']);
  mocks.engine.submitOccurrence.mockImplementation(async () => {
    occurrenceStatus = 'SUBMITTED';
    return { occurrenceId: 'occ_1', status: 'SUBMITTED', submittedAt: new Date() };
  });
  mocks.engine.verifyOccurrence.mockResolvedValue({ verificationId: 'v_1', action: 'VERIFY' });
  mocks.engine.getOccurrenceAuditTrail.mockResolvedValue([]);
});

afterAll(() => {
  process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe('receipt-backed proof', () => {
  it('submits and verifies after AUTH_SECRET rotates', async () => {
    const signature = pharmacyEvidence('ev_sig', 'ostep_3', 'signature');
    db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([receiptFor(signature)]);
    process.env.AUTH_SECRET = SECRET_AFTER;

    arrangeSubmission([signature]);
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });

    db.restaurantSopEvidence.findMany.mockResolvedValue([signature]);
    await caller().verify(OCC_INPUT);
    expect(mocks.engine.verifyOccurrence).toHaveBeenCalledOnce();

    // One receipt read per decision, scoped to the tenant and the rows at hand.
    expect(db.pharmacySopEvidenceCapture.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', evidenceId: { in: ['ev_sig'] } },
      select: { evidenceId: true, occurrenceId: true, contentHash: true },
    });
  });

  it('survives even with no secret configured at all', async () => {
    const signature = pharmacyEvidence('ev_sig', 'ostep_3', 'signature');
    db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([receiptFor(signature)]);
    occurrenceStatus = 'SUBMITTED';
    delete process.env.AUTH_SECRET;
    db.restaurantSopEvidence.findMany.mockResolvedValue([signature]);
    await caller().verify(OCC_INPUT);
    expect(mocks.engine.verifyOccurrence).toHaveBeenCalledOnce();
  });

  it('ignores a receipt that does not describe its row', async () => {
    occurrenceStatus = 'SUBMITTED';
    const foreign = foreignEvidence('ev_foreign', 'ostep_3', 'signature');
    for (const receipt of [
      receiptFor(foreign, { occurrenceId: 'occ_other' }),
      receiptFor(foreign, { contentHash: 'c'.repeat(64) }),
    ]) {
      db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([receipt]);
      db.restaurantSopEvidence.findMany.mockResolvedValue([foreign]);
      await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: FOREIGN_VERIFY,
      });
    }
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();
  });
});

describe('legacy HMAC proof without a receipt', () => {
  it('is accepted while its name verifies under the current secret', async () => {
    const signature = pharmacyEvidence('ev_sig', 'ostep_3', 'signature');
    arrangeSubmission([signature]);
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
    db.restaurantSopEvidence.findMany.mockResolvedValue([signature]);
    await caller().verify(OCC_INPUT);
    expect(mocks.engine.verifyOccurrence).toHaveBeenCalledOnce();
  });

  it('after rotation: reported UNCONFIRMED, and verify/submit say so without calling it missing', async () => {
    const signature = pharmacyEvidence('ev_sig', 'ostep_3', 'signature');
    process.env.AUTH_SECRET = SECRET_AFTER;

    arrangeOccurrenceRead([signature]);
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.evidence).toEqual([
      expect.objectContaining({
        id: 'ev_sig',
        provenance: 'UNCONFIRMED',
        capturedInPharmacy: false,
      }),
    ]);

    occurrenceStatus = 'SUBMITTED';
    db.restaurantSopEvidence.findMany.mockResolvedValue([signature]);
    const verify = caller().verify(OCC_INPUT);
    await expect(verify).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: UNCONFIRMED_VERIFY,
    });
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();

    mocks.adapter.assertOccurrenceAtSite.mockResolvedValue({
      id: 'occ_1',
      status: 'IN_PROGRESS',
      templateVersionId: 'ver_1',
      assignedStaffProfileId: ACTOR.staffProfileId,
      claimedByStaffProfileId: null,
      poolJobRoleId: null,
    });
    arrangeSubmission([signature]);
    const submit = await caller()
      .submit(OCC_INPUT)
      .then(
        () => null,
        (error: { code: string; message: string }) => error
      );
    expect(submit).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(submit!.message).toContain('signature proof');
    expect(submit!.message).toContain('can’t be confirmed');
    expect(submit!.message).toContain('legacy receipt backfill');
    expect(submit!.message).not.toMatch(/missing|capture the/i);
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });

  it('a receipt written before rotation (the backfill) makes it verify again', async () => {
    const signature = pharmacyEvidence('ev_sig', 'ostep_3', 'signature');
    process.env.AUTH_SECRET = SECRET_AFTER;
    occurrenceStatus = 'SUBMITTED';
    db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([receiptFor(signature)]);
    db.restaurantSopEvidence.findMany.mockResolvedValue([signature]);
    await caller().verify(OCC_INPUT);
    expect(mocks.engine.verifyOccurrence).toHaveBeenCalledOnce();
  });
});

describe('foreign proof', () => {
  it('is still refused by verify with the foreign message, ahead of unconfirmed proof', async () => {
    const legacy = pharmacyEvidence('ev_legacy', 'ostep_3', 'signature');
    const foreign = foreignEvidence('ev_foreign', 'ostep_3', 'signature');
    process.env.AUTH_SECRET = SECRET_AFTER;
    occurrenceStatus = 'SUBMITTED';
    db.restaurantSopEvidence.findMany.mockResolvedValue([legacy, foreign]);
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FOREIGN_VERIFY,
    });
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();
  });

  it('never satisfies a required signature on submit', async () => {
    arrangeSubmission([foreignEvidence('ev_foreign', 'ostep_3', 'signature')]);
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('Capture the signature proof'),
    });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });
});

describe('occurrence read', () => {
  it('reports provenance per row and keeps capturedInPharmacy for older readers', async () => {
    const receipted = pharmacyEvidence('ev_receipt', 'ostep_3', 'signature');
    process.env.AUTH_SECRET = 'pharmacy-sop-receipts-fixture-secret-old';
    const rotated = pharmacyEvidence('ev_rotated', 'ostep_3', 'signature');
    process.env.AUTH_SECRET = SECRET_BEFORE;
    const legacy = pharmacyEvidence('ev_legacy', 'ostep_3', 'signature');
    const foreign = foreignEvidence('ev_foreign', 'ostep_3', 'signature');
    db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([receiptFor(receipted)]);
    // The receipted row's name was minted under the current secret too, but the
    // receipt is what classifies it.
    arrangeOccurrenceRead([receipted, legacy, rotated, foreign]);
    const read = await caller().occurrence(OCC_INPUT);
    expect(read.evidence.map((row) => [row.id, row.provenance, row.capturedInPharmacy])).toEqual([
      ['ev_receipt', 'RECEIPT', true],
      ['ev_legacy', 'LEGACY_HMAC', true],
      ['ev_rotated', 'UNCONFIRMED', false],
      ['ev_foreign', 'FOREIGN', false],
    ]);
  });
});
