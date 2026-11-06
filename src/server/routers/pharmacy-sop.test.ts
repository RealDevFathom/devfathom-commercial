/**
 * DEV-751 — pharmacy SOP router. Runs the real router (with the real tRPC
 * middleware, mounted under its `pharmacySop` namespace so the module catalog
 * gate applies) against an in-memory db. The adapter and the engine commands
 * are mocked: this suite pins the mapping layer — gates, scope, server-derived
 * actor, strict inputs and the pharmacy-only submission requirements — not the
 * engine's own state machine, which has its own suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  annotateAudit: vi.fn(),
  adapter: {
    listPharmacySopBranches: vi.fn(),
    resolvePharmacySopSite: vi.fn(),
    enablePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    ensurePharmacySopStaffProfile: vi.fn(),
    ensurePharmacySopJobRoles: vi.fn(),
    setPharmacySopRoleHolding: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
    assertOccurrenceAtSite: vi.fn(),
    assertIndependentPharmacyVerifier: vi.fn(),
    linkPharmacySopRecord: vi.fn(),
  },
  engine: {
    startOccurrence: vi.fn(),
    completeStep: vi.fn(),
    submitOccurrence: vi.fn(),
    verifyOccurrence: vi.fn(),
    rejectOccurrence: vi.fn(),
    claimSopOccurrence: vi.fn(),
    listStaffSopOccurrences: vi.fn(),
    listClaimablePoolOccurrences: vi.fn(),
    createAssignment: vi.fn(),
    listAssignments: vi.fn(),
    setAssignmentActive: vi.fn(),
    generateDueSopOccurrences: vi.fn(),
    getOccurrenceAuditTrail: vi.fn(),
    buildScoreReport: vi.fn(),
    installPharmacySopLibrary: vi.fn(),
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
vi.mock('@/lib/pharmacy/sop-library', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-library')>(
    '@/lib/pharmacy/sop-library'
  )),
  installPharmacySopLibrary: mocks.engine.installPharmacySopLibrary,
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
vi.mock('@/lib/restaurant/sop-assignment', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-assignment')>(
    '@/lib/restaurant/sop-assignment'
  )),
  claimSopOccurrence: mocks.engine.claimSopOccurrence,
  listStaffSopOccurrences: mocks.engine.listStaffSopOccurrences,
  listClaimablePoolOccurrences: mocks.engine.listClaimablePoolOccurrences,
}));
vi.mock('@/lib/restaurant/sop-templates', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-templates')>(
    '@/lib/restaurant/sop-templates'
  )),
  createAssignment: mocks.engine.createAssignment,
  listAssignments: mocks.engine.listAssignments,
  setAssignmentActive: mocks.engine.setAssignmentActive,
}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: mocks.engine.generateDueSopOccurrences,
}));
vi.mock('@/lib/restaurant/sop-audit', () => ({
  getOccurrenceAuditTrail: mocks.engine.getOccurrenceAuditTrail,
}));
vi.mock('@/lib/restaurant/sop-score', () => ({
  buildScoreReport: mocks.engine.buildScoreReport,
}));

import { router } from '../trpc';
import {
  mapSopError,
  notOwnedOrClaimedBy,
  pharmacySopRouter,
  SOP_STATE_MESSAGES,
} from './pharmacy-sop';
import { PharmacySopAccessError } from '@/lib/pharmacy/sop-adapter';
import { pharmacySopEvidenceFilename } from '@/lib/pharmacy/sop-evidence';
import { PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE } from '@/lib/pharmacy/sop-shared';
import { findPharmacySopPack, type PharmacySopPackStep } from '@/lib/pharmacy/sop-library';
import { SopExecutionError } from '@/lib/restaurant/sop-execution';
import { SopTemplateError } from '@/lib/restaurant/sop-templates';
import { SopVerificationError } from '@/lib/restaurant/sop-verification';

process.env.AUTH_SECRET = 'pharmacy-sop-router-test-secret';

const app = router({ pharmacySop: pharmacySopRouter });

const SITE = {
  pharmacyBranchId: 'pbranch_1',
  sopBranchId: 'sopbranch_1',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const ACTOR = { staffProfileId: 'staff_me', displayName: 'Me', userId: 'user_1' };
const ALL_CAPS = ['sop:manage', 'sop:complete', 'sop:verify'];
const PHARMACY_MODULES = ['pharmacy-core', 'pharmacy-safety'];

const temperatureLog = findPharmacySopPack('temperature-log')!;
const receiving = findPharmacySopPack('receiving')!;
const opening = findPharmacySopPack('opening')!;
const training = findPharmacySopPack('training-attestation')!;
const controlledCounts = findPharmacySopPack('controlled-counts')!;

type EvidenceRow = {
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
};

/** An evidence row as the pharmacy evidence route stores it (a minted, bound ref). */
function pharmacyEvidence(stepId: string | null, purpose: 'photo' | 'signature'): EvidenceRow {
  const row = {
    occurrenceStepId: stepId,
    contentHash: 'a'.repeat(64),
    mimeType: `image/png; evidence=${purpose}`,
    uploaderStaffProfileId: ACTOR.staffProfileId,
  };
  const name = pharmacySopEvidenceFilename(
    { organizationId: 'org_1', occurrenceId: 'occ_1', ...row },
    'png'
  );
  return { ...row, storageRef: `/api/files/${name}` };
}

/** The same proof attached through a restaurant surface (any other ref). */
function foreignEvidence(stepId: string | null, purpose: 'photo' | 'signature'): EvidenceRow {
  return {
    occurrenceStepId: stepId,
    contentHash: 'b'.repeat(64),
    mimeType: `image/png; evidence=${purpose}`,
    uploaderStaffProfileId: ACTOR.staffProfileId,
    storageRef: '/api/files/sop-11111111-2222-4333-8444-555555555555.png',
  };
}

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
}

function makeDb() {
  const db = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopTemplate: model(),
    restaurantSopTemplateVersion: model(),
    restaurantSopAssignment: model(),
    restaurantStaffProfile: model(),
    restaurantJobRole: model(),
    pharmacyBranchAssignment: model(),
    pharmacySopRecordLink: model(),
    pharmacyTemperatureLog: model(),
    pharmacyGoodsReceipt: model(),
    restaurantSopEvidence: model(),
    pharmacySopEvidenceCapture: model(),
    organization: model(),
    restaurantSopVerification: model(),
    pharmacySopReworkNote: model(),
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

function caller(enabledModules: string[] = PHARMACY_MODULES) {
  return app.createCaller({
    db: db as never,
    entitlements: {
      organizationId: 'org_1',
      enabledModules,
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

/** The occurrence as `assertOccurrenceAtSite` returns it, owned by the actor. */
let occurrenceRow: {
  id: string;
  status: string;
  templateVersionId: string;
  assignedStaffProfileId: string | null;
  claimedByStaffProfileId: string | null;
  poolJobRoleId: string | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  mocks.granted = new Set(ALL_CAPS);
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
  mocks.adapter.ensurePharmacySopStaffProfile.mockResolvedValue({ ...ACTOR, created: false });
  mocks.adapter.assertOccurrenceAtSite.mockImplementation(async () => ({ ...occurrenceRow }));
  mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-assistant']);
  mocks.adapter.assertIndependentPharmacyVerifier.mockResolvedValue(undefined);
  mocks.adapter.ensurePharmacySopJobRoles.mockResolvedValue({
    'pharmacy-manager': 'role_mgr',
    'pharmacy-qualified-person': 'role_qp',
    'pharmacy-assistant': 'role_asst',
  });
  mocks.engine.submitOccurrence.mockResolvedValue({
    occurrenceId: 'occ_1',
    status: 'SUBMITTED',
    submittedAt: new Date(),
  });
  mocks.engine.startOccurrence.mockResolvedValue({
    occurrenceId: 'occ_1',
    status: 'IN_PROGRESS',
    startedAt: new Date(),
  });
  mocks.engine.rejectOccurrence.mockResolvedValue({ verificationId: 'v_1', action: 'REJECT' });
  mocks.engine.verifyOccurrence.mockResolvedValue({ verificationId: 'v_2', action: 'VERIFY' });
  mocks.engine.createAssignment.mockResolvedValue({ id: 'asg_new' });
  mocks.engine.generateDueSopOccurrences.mockResolvedValue({
    assignmentsProcessed: 1,
    created: 1,
    skipped: 0,
  });
});

/** Arrange the occurrence the submit pre-check reads: a pack, its steps and links. */
function arrangeSubmission(opts: {
  pack: { name: string; steps: Array<{ title: string }> };
  notes?: Record<number, string>;
  links?: Array<{ step: number | null; recordType: string; recordId: string; note?: string }>;
  outOfRange?: string[];
  requires?: Record<number, { photo?: boolean; signature?: boolean }>;
  evidence?: Record<number, EvidenceRow[]>;
}) {
  const steps = opts.pack.steps.map((step, index) => ({
    id: `ostep_${index + 1}`,
    note: opts.notes?.[index + 1] ?? null,
    templateStep: {
      title: step.title,
      stepOrder: index + 1,
      requiresPhoto: opts.requires?.[index + 1]?.photo ?? false,
      requiresSignature: opts.requires?.[index + 1]?.signature ?? false,
    },
    evidence: opts.evidence?.[index + 1] ?? [],
  }));
  db.restaurantSopOccurrence.findUnique.mockResolvedValue({
    assignment: { template: { name: opts.pack.name } },
    steps,
  });
  db.pharmacySopRecordLink.findMany.mockResolvedValue(
    (opts.links ?? []).map((link) => ({
      occurrenceStepId: link.step === null ? null : `ostep_${link.step}`,
      recordType: link.recordType,
      recordId: link.recordId,
      note: link.note ?? null,
    }))
  );
  db.pharmacyTemperatureLog.findMany.mockResolvedValue(
    (opts.outOfRange ?? []).map((id) => ({ id }))
  );
}

const BRANCH_INPUT = { pharmacyBranchId: SITE.pharmacyBranchId };
const OCC_INPUT = { ...BRANCH_INPUT, occurrenceId: 'occ_1' };

// ── Gates ────────────────────────────────────────────────────────────────────

describe('capability gates', () => {
  type Call = (c: ReturnType<typeof caller>) => Promise<unknown>;
  const cases: Array<[string, string, Call]> = [
    ['enableSite', 'sop:manage', (c) => c.enableSite({ ...BRANCH_INPUT, timezone: 'UTC' })],
    ['installLibrary', 'sop:manage', (c) => c.installLibrary()],
    ['templates', 'sop:manage', (c) => c.templates()],
    ['assignments', 'sop:manage', (c) => c.assignments(BRANCH_INPUT)],
    [
      'createAssignment',
      'sop:manage',
      (c) =>
        c.createAssignment({
          ...BRANCH_INPUT,
          templateId: 'tpl_1',
          target: { type: 'ROLE', roleKey: 'pharmacy-assistant' },
          frequency: 'DAILY',
          dueTimeMinutes: 9 * 60,
          startDate: '2026-11-04',
        }),
    ],
    [
      'setAssignmentActive',
      'sop:manage',
      (c) => c.setAssignmentActive({ ...BRANCH_INPUT, assignmentId: 'asg_1', active: false }),
    ],
    ['roleHoldings', 'sop:manage', (c) => c.roleHoldings(BRANCH_INPUT)],
    [
      'setRoleHolding',
      'sop:manage',
      (c) =>
        c.setRoleHolding({
          ...BRANCH_INPUT,
          userId: 'user_2',
          roleKey: 'pharmacy-assistant',
          held: true,
        }),
    ],
    ['generate', 'sop:manage', (c) => c.generate(BRANCH_INPUT)],
    [
      'startOnDemand',
      'sop:complete',
      (c) => c.startOnDemand({ ...BRANCH_INPUT, templateId: 'tpl_1' }),
    ],
    ['onDemandTemplates', 'sop:complete', (c) => c.onDemandTemplates(BRANCH_INPUT)],
    ['claim', 'sop:complete', (c) => c.claim(OCC_INPUT)],
    ['start', 'sop:complete', (c) => c.start(OCC_INPUT)],
    [
      'completeStep',
      'sop:complete',
      (c) => c.completeStep({ ...OCC_INPUT, templateStepId: 'tstep_1' }),
    ],
    [
      'linkRecord',
      'sop:complete',
      (c) => c.linkRecord({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG', recordId: 'log_1' }),
    ],
    [
      'linkableRecords',
      'sop:complete',
      (c) => c.linkableRecords({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG' }),
    ],
    ['evidenceTarget', 'sop:complete', (c) => c.evidenceTarget(OCC_INPUT)],
    ['submit', 'sop:complete', (c) => c.submit(OCC_INPUT)],
    ['verify', 'sop:verify', (c) => c.verify(OCC_INPUT)],
    ['reject', 'sop:verify', (c) => c.reject({ ...OCC_INPUT, reason: 'Redo the count' })],
  ];

  it.each(cases)('%s refuses a caller without %s before any scope work', async (_n, cap, call) => {
    mocks.granted = new Set(ALL_CAPS.filter((candidate) => candidate !== cap));
    await expect(call(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
    expect(mocks.adapter.enablePharmacySopSite).not.toHaveBeenCalled();
    expect(mocks.engine.installPharmacySopLibrary).not.toHaveBeenCalled();
  });

  it('branches needs at least one SOP capability; report needs manage or verify', async () => {
    mocks.granted = new Set();
    await expect(caller().branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The report names every person's work at the branch: completing alone is not enough.
    mocks.granted = new Set(['sop:complete']);
    await expect(
      caller().report({ ...BRANCH_INPUT, from: '2026-11-01', to: '2026-11-04' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.listPharmacySopBranches).not.toHaveBeenCalled();
    expect(mocks.engine.buildScoreReport).not.toHaveBeenCalled();

    mocks.granted = new Set(['sop:complete']);
    mocks.adapter.listPharmacySopBranches.mockResolvedValue([]);
    await expect(caller().branches()).resolves.toEqual([]);
    expect(mocks.adapter.listPharmacySopBranches).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
    });
  });

  it('board and occurrence need complete or verify; manage alone is refused', async () => {
    mocks.granted = new Set(['sop:manage']);
    await expect(caller().board(BRANCH_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().occurrence(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
  });

  it('a reviewer holding only sop:verify reaches the board', async () => {
    mocks.granted = new Set(['sop:verify']);
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-qualified-person']);
    mocks.engine.listStaffSopOccurrences.mockResolvedValue([]);
    mocks.engine.listClaimablePoolOccurrences.mockResolvedValue([]);
    db.restaurantSopOccurrence.findMany.mockResolvedValue([]);
    const board = await caller().board(BRANCH_INPUT);
    expect(board.canReview).toBe(true);
    expect(board.mine).toEqual([]);
    expect(mocks.adapter.resolvePharmacySopSite).toHaveBeenCalled();
  });

  it('access reports each capability separately', async () => {
    mocks.granted = new Set(['sop:complete']);
    await expect(caller().access()).resolves.toEqual({
      canManage: false,
      canComplete: true,
      canVerify: false,
      organizationTimezone: null,
    });
    expect(db.organization.findUnique).not.toHaveBeenCalled();
  });

  it('access gives a manager the organization timezone, treating the UTC default as unset', async () => {
    db.organization.findUnique.mockResolvedValueOnce({ timezone: 'Europe/London' });
    await expect(caller().access()).resolves.toMatchObject({
      canManage: true,
      organizationTimezone: 'Europe/London',
    });
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      select: { timezone: true },
    });
    db.organization.findUnique.mockResolvedValueOnce({ timezone: 'UTC' });
    await expect(caller().access()).resolves.toMatchObject({ organizationTimezone: null });
  });
});

describe('module gate', () => {
  it('refuses every procedure without the pharmacy-safety module', async () => {
    const c = caller(['pharmacy-core']);
    await expect(c.board(BRANCH_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.access()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.submit(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
  });

  it('a restaurant SOP licence alone grants nothing here', async () => {
    const c = caller(['restaurant-core', 'restaurant-sop']);
    await expect(c.board(BRANCH_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('pharmacy-safety'),
    });
    await expect(c.installLibrary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
    expect(mocks.engine.installPharmacySopLibrary).not.toHaveBeenCalled();
  });
});

// ── Scope ────────────────────────────────────────────────────────────────────

describe('branch and occurrence scope', () => {
  it('refuses a branch outside the caller scope without echoing adapter detail', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValue(
      new PharmacySopAccessError('branch pbranch_other belongs to Org B', 'BRANCH_OUT_OF_SCOPE')
    );
    const error = await caller()
      .board({ pharmacyBranchId: 'pbranch_other' })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'FORBIDDEN' });
    expect(String((error as Error).message)).not.toContain('Org B');
    expect(mocks.engine.listStaffSopOccurrences).not.toHaveBeenCalled();
  });

  it('reports a branch whose SOPs are not enabled as a precondition', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValue(
      new PharmacySopAccessError('no site', 'SITE_NOT_ENABLED')
    );
    await expect(caller().board(BRANCH_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it.each([
    ['start', (c: ReturnType<typeof caller>) => c.start(OCC_INPUT)],
    ['submit', (c: ReturnType<typeof caller>) => c.submit(OCC_INPUT)],
    ['occurrence', (c: ReturnType<typeof caller>) => c.occurrence(OCC_INPUT)],
    ['verify', (c: ReturnType<typeof caller>) => c.verify(OCC_INPUT)],
    ['claim', (c: ReturnType<typeof caller>) => c.claim(OCC_INPUT)],
  ])('%s refuses an other-branch or other-tenant occurrence as NOT_FOUND', async (_name, call) => {
    mocks.adapter.assertOccurrenceAtSite.mockRejectedValue(
      new PharmacySopAccessError('occ_1 is at branch pbranch_other', 'OCCURRENCE_OUT_OF_SCOPE')
    );
    const error = await call(caller()).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'Procedure not found.' });
    expect(mocks.adapter.assertOccurrenceAtSite).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      site: SITE,
    });
    expect(mocks.engine.startOccurrence).not.toHaveBeenCalled();
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();
    expect(mocks.engine.claimSopOccurrence).not.toHaveBeenCalled();
  });

  it('hides an in-branch occurrence that is not the caller’s and not reviewable by them', async () => {
    mocks.granted = new Set(['sop:complete']);
    occurrenceRow.assignedStaffProfileId = 'staff_other';
    await expect(caller().occurrence(OCC_INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('server-derived actor and strict inputs', () => {
  it.each([
    ['start', { ...OCC_INPUT, actorStaffProfileId: 'staff_victim' }],
    ['completeStep', { ...OCC_INPUT, templateStepId: 't', completedByStaffProfileId: 'x' }],
    ['submit', { ...OCC_INPUT, actorStaffProfileId: 'staff_victim' }],
    ['verify', { ...OCC_INPUT, actorStaffProfileId: 'staff_victim' }],
    ['reject', { ...OCC_INPUT, reason: 'r', actorStaffProfileId: 'staff_victim' }],
    [
      'linkRecord',
      { ...OCC_INPUT, recordType: 'TEMPERATURE_LOG', recordId: 'l', linkedByStaffProfileId: 'x' },
    ],
    ['evidenceTarget', { ...OCC_INPUT, uploaderStaffProfileId: 'staff_victim' }],
    ['claim', { ...OCC_INPUT, staffProfileId: 'staff_victim' }],
    ['board', { ...BRANCH_INPUT, staffProfileId: 'staff_victim' }],
    [
      'setRoleHolding',
      { ...BRANCH_INPUT, userId: 'u', roleKey: 'pharmacy-manager', held: true, grantedBy: 'x' },
    ],
  ])('%s rejects a spoofed actor field', async (name, input) => {
    const c = caller() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await expect(c[name]!(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.adapter.resolvePharmacySopSite).not.toHaveBeenCalled();
  });

  it('passes the session actor to the engine', async () => {
    await caller().start(OCC_INPUT);
    expect(mocks.adapter.resolvePharmacySopActor).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
    });
    expect(mocks.engine.startOccurrence).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      actorStaffProfileId: ACTOR.staffProfileId,
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ category: 'PHARMACY_SAFETY', action: 'pharmacy.sop.start' })
    );
  });

  describe('out-of-range reading on a procedure without an excursion step', () => {
    const steps = [
      { id: 'ostep_1', templateStepId: 'tstep_1', templateStep: { title: 'Confirm readings' } },
      { id: 'ostep_2', templateStepId: 'tstep_2', templateStep: { title: 'Open the counter' } },
    ];
    const arrange = (opts: {
      linkNote?: string | null;
      outOfRange?: boolean;
      titles?: string[];
      done?: boolean;
    }) => {
      db.restaurantSopOccurrenceStep.findMany.mockResolvedValue(
        steps.map((step, index) => ({
          ...step,
          completed: index === 0 && opts.done === true,
          ...(opts.titles ? { templateStep: { title: opts.titles[index]! } } : {}),
        }))
      );
      db.pharmacySopRecordLink.findMany.mockResolvedValue([
        { recordId: 'log_hot', note: opts.linkNote ?? null },
      ]);
      db.pharmacyTemperatureLog.findFirst.mockResolvedValue(
        opts.outOfRange === false ? null : { id: 'log_hot' }
      );
    };

    it('refuses to mark the step done without a note (it could never be submitted)', async () => {
      arrange({});
      await expect(
        caller().completeStep({ ...OCC_INPUT, templateStepId: 'tstep_1' })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('out of range'),
      });
      expect(mocks.engine.completeStep).not.toHaveBeenCalled();
      expect(db.pharmacySopRecordLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            occurrenceStepId: 'ostep_1',
            pharmacyBranchId: SITE.pharmacyBranchId,
            recordType: 'TEMPERATURE_LOG',
          }),
        })
      );
    });

    it.each([
      ['a step note', { note: 'Fridge at 9 °C; moved stock' }, {}],
      ['a note on the link', {}, { linkNote: 'Door left open; reset' }],
      ['an in-range reading', {}, { outOfRange: false }],
      ['a separate excursion step', {}, { titles: ['Confirm readings', 'Record any excursion'] }],
      ['a repeat call on a step already done', {}, { done: true }],
    ])('allows it with %s', async (_label, input, opts) => {
      arrange(opts);
      mocks.engine.completeStep.mockResolvedValue({
        occurrenceStepId: 'ostep_1',
        completed: true,
        completedAt: new Date(),
      });
      await expect(
        caller().completeStep({ ...OCC_INPUT, templateStepId: 'tstep_1', ...input })
      ).resolves.toMatchObject({ completed: true });
    });
  });

  it('maps an engine ownership refusal to FORBIDDEN', async () => {
    mocks.engine.completeStep.mockRejectedValue(
      new SopExecutionError('Only the assigned or claiming staff member…', 'NOT_OWNER')
    );
    await expect(
      caller().completeStep({ ...OCC_INPUT, templateStepId: 'tstep_1', note: 'ok' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ── Assignments ──────────────────────────────────────────────────────────────

describe('createAssignment', () => {
  const personInput = {
    ...BRANCH_INPUT,
    templateId: 'tpl_open',
    target: { type: 'PERSON' as const, userId: 'user_2' },
    frequency: 'DAILY' as const,
    dueTimeMinutes: 9 * 60,
    startDate: '2026-11-04',
  };

  beforeEach(() => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_open',
      name: opening.name,
      isActive: true,
    });
  });

  it('refuses a PERSON target who is not actively assigned to the branch', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(caller().createAssignment(personInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: SITE.pharmacyBranchId,
          userId: 'user_2',
          active: true,
        }),
      })
    );
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
  });

  it('assigns a PERSON on the engine branch through their own staff profile', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ userId: 'user_2' });
    mocks.adapter.resolvePharmacySopActor.mockResolvedValueOnce({
      staffProfileId: 'staff_2',
      displayName: 'Two',
      userId: 'user_2',
    });
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-qualified-person']);
    await caller().createAssignment(personInput);
    expect(mocks.adapter.pharmacySopRolesAt).toHaveBeenCalledWith(db, {
      staffProfileId: 'staff_2',
      sopBranchId: SITE.sopBranchId,
    });
    expect(mocks.adapter.resolvePharmacySopActor).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_2',
    });
    expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        branchId: SITE.sopBranchId,
        templateId: 'tpl_open',
        assigneeTarget: { type: 'person', staffProfileId: 'staff_2' },
      })
    );
  });

  it('refuses a PERSON who does not hold the role-owned pack’s role at the site', async () => {
    expect(opening.pharmacy.assigneeTarget).toBe('ROLE');
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ userId: 'user_2' });
    mocks.adapter.resolvePharmacySopActor.mockResolvedValueOnce({
      staffProfileId: 'staff_2',
      displayName: 'Two',
      userId: 'user_2',
    });
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-assistant']);
    await expect(caller().createAssignment(personInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That person doesn’t hold the role this procedure needs at this branch.',
    });
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
  });

  it('names anyone at the branch for a pack that is person-assigned by design', async () => {
    expect(training.pharmacy.assigneeTarget).toBe('PERSON');
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_train',
      name: training.name,
      isActive: true,
    });
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ userId: 'user_2' });
    mocks.adapter.resolvePharmacySopActor.mockResolvedValueOnce({
      staffProfileId: 'staff_2',
      displayName: 'Two',
      userId: 'user_2',
    });
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue([]);
    await caller().createAssignment({ ...personInput, templateId: 'tpl_train' });
    expect(mocks.adapter.pharmacySopRolesAt).not.toHaveBeenCalled();
    expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ assigneeTarget: { type: 'person', staffProfileId: 'staff_2' } })
    );
  });

  it('assigns a ROLE pool through the pharmacy job role id', async () => {
    await caller().createAssignment({
      ...personInput,
      target: { type: 'ROLE', roleKey: 'pharmacy-qualified-person' },
    });
    expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ assigneeTarget: { type: 'role', jobRoleId: 'role_qp' } })
    );
  });

  it('refuses a template that is not a pharmacy pack', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_open',
      name: 'Kitchen opening',
      isActive: true,
    });
    await expect(caller().createAssignment(personInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
  });

  it('refuses a non-pharmacy SOP role key and an assignment from another site', async () => {
    await expect(
      caller().createAssignment({
        ...personInput,
        target: { type: 'ROLE', roleKey: 'barista' } as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.restaurantSopAssignment.findUnique.mockResolvedValue({
      id: 'asg_1',
      branchId: 'sopbranch_other',
      template: { name: opening.name },
    });
    await expect(
      caller().setAssignmentActive({ ...BRANCH_INPUT, assignmentId: 'asg_1', active: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.engine.setAssignmentActive).not.toHaveBeenCalled();
  });
});

// ── Submission ───────────────────────────────────────────────────────────────

describe('submit', () => {
  it('blocks a step that requires a linked record until one is linked to that step', async () => {
    arrangeSubmission({ pack: temperatureLog, notes: { 3: 'None' } });
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(temperatureLog.steps[0]!.title),
    });

    // A link on another step does not satisfy this one.
    arrangeSubmission({
      pack: temperatureLog,
      notes: { 3: 'None' },
      links: [{ step: 2, recordType: 'TEMPERATURE_LOG', recordId: 'log_amb' }],
    });
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });

  it('stops counting a goods receipt that was cancelled or reversed after it was linked', async () => {
    const links = [{ step: 1, recordType: 'GOODS_RECEIPT', recordId: 'grn_1' }];
    arrangeSubmission({ pack: receiving, links, notes: { 3: 'Cold box fine', 4: 'None' } });
    db.pharmacyGoodsReceipt.findMany.mockResolvedValue([{ id: 'grn_1' }]);
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('was cancelled or reversed'),
    });
    expect(db.pharmacyGoodsReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['grn_1'] },
          organizationId: 'org_1',
          branchId: SITE.pharmacyBranchId,
          status: { in: ['CANCELLED', 'REVERSED'] },
        }),
      })
    );
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();

    // A receipt that still stands counts as before.
    arrangeSubmission({ pack: receiving, links, notes: { 3: 'Cold box fine', 4: 'None' } });
    db.pharmacyGoodsReceipt.findMany.mockResolvedValue([]);
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
  });

  it('requires an excursion note when a linked temperature reading is out of range', async () => {
    const links = [
      { step: 1, recordType: 'TEMPERATURE_LOG', recordId: 'log_fridge' },
      { step: 2, recordType: 'TEMPERATURE_LOG', recordId: 'log_amb' },
    ];
    arrangeSubmission({ pack: temperatureLog, links, outOfRange: ['log_fridge'] });
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('out of range'),
    });
    expect(db.pharmacyTemperatureLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branchId: SITE.pharmacyBranchId, outOfRange: true }),
      })
    );
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();

    arrangeSubmission({
      pack: temperatureLog,
      links,
      outOfRange: ['log_fridge'],
      notes: { 3: 'Fridge at 9 °C; moved stock, told manager.' },
    });
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
    expect(mocks.engine.submitOccurrence).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      actorStaffProfileId: ACTOR.staffProfileId,
    });
  });

  it('is safe to repeat: a second submit is a conflict and never reaches the engine', async () => {
    arrangeSubmission({
      pack: temperatureLog,
      notes: { 3: 'None' },
      links: [
        { step: 1, recordType: 'TEMPERATURE_LOG', recordId: 'log_fridge' },
        { step: 2, recordType: 'TEMPERATURE_LOG', recordId: 'log_amb' },
      ],
    });
    await caller().submit(OCC_INPUT);
    occurrenceRow.status = 'SUBMITTED';
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.engine.submitOccurrence).toHaveBeenCalledTimes(1);
  });

  it('refuses to submit someone else’s occurrence', async () => {
    occurrenceRow.assignedStaffProfileId = 'staff_other';
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe('verify and reject', () => {
  beforeEach(() => {
    occurrenceRow = { ...occurrenceRow, status: 'SUBMITTED', assignedStaffProfileId: 'staff_op' };
  });

  it('delegates independence to the adapter before deciding', async () => {
    mocks.adapter.assertIndependentPharmacyVerifier.mockRejectedValue(
      new PharmacySopAccessError('you completed step 2', 'NOT_INDEPENDENT')
    );
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().reject({ ...OCC_INPUT, reason: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.adapter.assertIndependentPharmacyVerifier).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      site: SITE,
      verifierStaffProfileId: ACTOR.staffProfileId,
    });
    expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();
    expect(mocks.engine.rejectOccurrence).not.toHaveBeenCalled();

    mocks.adapter.assertIndependentPharmacyVerifier.mockRejectedValue(
      new PharmacySopAccessError('no role', 'ROLE_REQUIRED')
    );
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('verifies as the session actor', async () => {
    await caller().verify({ ...OCC_INPUT, reason: '  ' });
    expect(mocks.engine.verifyOccurrence).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      actorStaffProfileId: ACTOR.staffProfileId,
      reason: null,
    });
  });

  it('rejection needs a reason; the assignee can then restart and resubmit', async () => {
    await expect(caller().reject(OCC_INPUT as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().reject({ ...OCC_INPUT, reason: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.engine.rejectOccurrence).not.toHaveBeenCalled();

    await caller().reject({ ...OCC_INPUT, reason: 'Fridge reading not linked' });
    expect(mocks.engine.rejectOccurrence).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      actorStaffProfileId: ACTOR.staffProfileId,
      reason: 'Fridge reading not linked',
    });

    // The assignee restarts the rework (REJECTED → IN_PROGRESS) and resubmits.
    mocks.adapter.resolvePharmacySopActor.mockResolvedValue({
      ...ACTOR,
      staffProfileId: 'staff_op',
    });
    occurrenceRow.status = 'REJECTED';
    await caller().start(OCC_INPUT);
    expect(mocks.engine.startOccurrence).toHaveBeenCalledWith(db, {
      occurrenceId: 'occ_1',
      actorStaffProfileId: 'staff_op',
    });
    occurrenceRow.status = 'IN_PROGRESS';
    arrangeSubmission({ pack: opening, notes: { 1: 'x', 2: 'x', 3: 'x', 4: 'x', 5: 'x' } });
    db.pharmacySopRecordLink.findMany.mockResolvedValue(
      (opening.steps as PharmacySopPackStep[]).flatMap((step, index) =>
        step.requiredRecordType
          ? [
              {
                occurrenceStepId: `ostep_${index + 1}`,
                recordType: step.requiredRecordType,
                recordId: `rec_${index}`,
                note: null,
              },
            ]
          : []
      )
    );
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
  });
});

// ── On-demand procedures ─────────────────────────────────────────────────────

describe('startOnDemand', () => {
  const input = { ...BRANCH_INPUT, templateId: 'tpl_recv' };

  it('only starts event-triggered packs', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_temp',
      name: temperatureLog.name,
      isActive: true,
    });
    await expect(
      caller().startOnDemand({ ...BRANCH_INPUT, templateId: 'tpl_temp' })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
  });

  describe('for an event pack', () => {
    beforeEach(() => {
      expect(receiving.pharmacy.trigger).toBe('EVENT');
      db.restaurantSopTemplate.findUnique.mockResolvedValue({
        id: 'tpl_recv',
        name: receiving.name,
        isActive: true,
      });
    });

    it('needs the pack role at this branch', async () => {
      mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-manager']);
      await expect(caller().startOnDemand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
    });

    it('creates a one-off PERSON assignment for the actor and generates it', async () => {
      db.restaurantSopOccurrence.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'occ_new' });
      await expect(caller().startOnDemand(input)).resolves.toEqual({
        occurrenceId: 'occ_new',
        created: true,
      });
      expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          branchId: SITE.sopBranchId,
          templateId: 'tpl_recv',
          frequency: 'ONCE',
          assigneeTarget: { type: 'person', staffProfileId: ACTOR.staffProfileId },
        })
      );
      // Only the new one-off assignment is materialised: never the branch's
      // other schedules (automatic scheduling may be OFF for this branch).
      expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
        now: expect.any(Date),
        branchIds: [SITE.sopBranchId],
        assignmentIds: ['asg_new'],
        skipDueBeforeAssignmentCreated: true,
      });
      expect(mocks.engine.setAssignmentActive).toHaveBeenCalledWith(db, 'asg_new', false);
    });

    it('returns the open on-demand occurrence instead of duplicating it', async () => {
      db.restaurantSopOccurrence.findFirst.mockResolvedValueOnce({ id: 'occ_open' });
      await expect(caller().startOnDemand(input)).resolves.toEqual({
        occurrenceId: 'occ_open',
        created: false,
      });
      expect(db.restaurantSopOccurrence.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            branchId: SITE.sopBranchId,
            assignedStaffProfileId: ACTOR.staffProfileId,
          }),
        })
      );
      expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
    });
  });
});

// ── Evidence authorization ───────────────────────────────────────────────────

describe('evidenceTarget', () => {
  it('returns the session actor as uploader for the caller’s own work in progress', async () => {
    await expect(caller().evidenceTarget(OCC_INPUT)).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      occurrenceId: 'occ_1',
      occurrenceStepId: null,
      uploaderStaffProfileId: ACTOR.staffProfileId,
    });
  });

  it('refuses a step from another occurrence and work that is not in progress', async () => {
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue(null);
    await expect(
      caller().evidenceTarget({ ...OCC_INPUT, occurrenceStepId: 'ostep_elsewhere' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    occurrenceRow.status = 'SUBMITTED';
    await expect(caller().evidenceTarget(OCC_INPUT)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

// ── Board ────────────────────────────────────────────────────────────────────

describe('onDemandTemplates', () => {
  it('lists only active on-demand packs whose role the caller holds at the site', async () => {
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-assistant']);
    db.restaurantSopTemplate.findMany.mockResolvedValue([
      { id: 'tpl_receiving', name: 'Pharmacy — receiving', category: 'Receiving' },
    ]);
    await expect(caller().onDemandTemplates(BRANCH_INPUT)).resolves.toEqual([
      { id: 'tpl_receiving', name: 'Pharmacy — receiving', category: 'Receiving' },
    ]);
    const where = db.restaurantSopTemplate.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    // The assistant owns receiving but not the manager-owned incident pack.
    expect(where.name.in).toEqual(['Pharmacy — receiving']);
  });

  it('returns nothing without a matching role and never queries templates', async () => {
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue([]);
    await expect(caller().onDemandTemplates(BRANCH_INPUT)).resolves.toEqual([]);
    expect(db.restaurantSopTemplate.findMany).not.toHaveBeenCalled();
  });
});

describe('board', () => {
  it('splits my work, the pool and (for an entitled verifier) the review queue', async () => {
    const past = new Date(Date.now() - 3 * 3_600_000);
    const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      status,
      businessDate: new Date(Date.UTC(2026, 10, 4)),
      dueAt: past,
      windowEndsAt: past,
      startedAt: null,
      submittedAt: null,
      assignedStaffProfileId: null,
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      assignment: {
        graceMinutes: 0,
        template: { id: 'tpl', name: temperatureLog.name, category: 'Storage' },
      },
      steps: [{ completed: true }, { completed: false }],
      ...extra,
    });
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-qualified-person']);
    mocks.engine.listStaffSopOccurrences.mockResolvedValue([
      { occurrenceId: 'occ_mine', paths: ['DIRECT'], status: 'SCHEDULED' },
      { occurrenceId: 'occ_pool', paths: ['ROLE_POOL'], status: 'SCHEDULED' },
    ]);
    mocks.engine.listClaimablePoolOccurrences.mockResolvedValue([
      { id: 'occ_pool', status: 'SCHEDULED' },
    ]);
    db.restaurantSopOccurrence.findMany
      .mockResolvedValueOnce([row('occ_mine', 'SCHEDULED')])
      .mockResolvedValueOnce([row('occ_pool', 'SCHEDULED', { poolJobRoleId: 'role_asst' })])
      .mockResolvedValueOnce([row('occ_review', 'SUBMITTED', { submittedAt: past })]);

    const board = await caller().board(BRANCH_INPUT);
    expect(board.mine.map((item) => item.occurrenceId)).toEqual(['occ_mine']);
    expect(board.pool.map((item) => item.occurrenceId)).toEqual(['occ_pool']);
    expect(board.review.map((item) => item.occurrenceId)).toEqual(['occ_review']);
    expect(board.counts).toMatchObject({ overdue: 2, awaitingReview: 1 });
    expect(mocks.engine.listStaffSopOccurrences).toHaveBeenCalledWith(
      db,
      ACTOR.staffProfileId,
      expect.objectContaining({ branchId: SITE.sopBranchId })
    );
  });

  it('shows no review queue to a caller without a verifier role', async () => {
    mocks.engine.listStaffSopOccurrences.mockResolvedValue([]);
    mocks.engine.listClaimablePoolOccurrences.mockResolvedValue([]);
    const board = await caller().board(BRANCH_INPUT);
    expect(board.canReview).toBe(false);
    expect(board.review).toEqual([]);
    expect(db.restaurantSopOccurrence.findMany).not.toHaveBeenCalled();
  });
});

// ── Security review fixes ────────────────────────────────────────────────────

describe('proof captured outside the pharmacy workspace', () => {
  it('submit counts only pharmacy-captured proof for a required signature', async () => {
    const signatureStep = { 3: { signature: true } };
    arrangeSubmission({
      pack: training,
      notes: { 2: 'None' },
      requires: signatureStep,
      evidence: { 3: [foreignEvidence('ostep_3', 'signature')] },
    });
    await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('signature proof'),
    });
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();

    arrangeSubmission({
      pack: training,
      notes: { 2: 'None' },
      requires: signatureStep,
      evidence: {
        3: [foreignEvidence('ostep_3', 'signature'), pharmacyEvidence('ostep_3', 'signature')],
      },
    });
    await expect(caller().submit(OCC_INPUT)).resolves.toMatchObject({ status: 'SUBMITTED' });
  });

  it('submit refuses a required photo backed only by foreign or tampered proof', async () => {
    const tampered = { ...pharmacyEvidence('ostep_1', 'photo'), uploaderStaffProfileId: 'staff_x' };
    const copied = { ...pharmacyEvidence('ostep_1', 'photo'), contentHash: 'c'.repeat(64) };
    const wrongKind = pharmacyEvidence('ostep_1', 'signature');
    for (const rows of [[foreignEvidence('ostep_1', 'photo')], [tampered], [copied], [wrongKind]]) {
      arrangeSubmission({
        pack: training,
        notes: { 2: 'x' },
        requires: { 1: { photo: true } },
        evidence: { 1: rows },
      });
      await expect(caller().submit(OCC_INPUT)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('photo proof'),
      });
    }
    expect(mocks.engine.submitOccurrence).not.toHaveBeenCalled();
  });

  describe('verify', () => {
    beforeEach(() => {
      occurrenceRow = { ...occurrenceRow, status: 'SUBMITTED', assignedStaffProfileId: 'staff_op' };
    });

    it('refuses while any proof on the occurrence was not captured in pharmacy', async () => {
      db.restaurantSopEvidence.findMany.mockResolvedValue([
        pharmacyEvidence('ostep_1', 'photo'),
        foreignEvidence(null, 'photo'),
      ]);
      await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message:
          'Proof on this procedure was not captured through the pharmacy workspace. Ask a manager to review it.',
      });
      expect(db.restaurantSopEvidence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { occurrenceId: 'occ_1' } })
      );
      expect(mocks.engine.verifyOccurrence).not.toHaveBeenCalled();

      // Sending it back stays possible.
      await caller().reject({ ...OCC_INPUT, reason: 'Proof came from elsewhere' });
      expect(mocks.engine.rejectOccurrence).toHaveBeenCalledOnce();
    });

    it('verifies when every proof row was captured in pharmacy', async () => {
      db.restaurantSopEvidence.findMany.mockResolvedValue([pharmacyEvidence('ostep_1', 'photo')]);
      await caller().verify(OCC_INPUT);
      expect(mocks.engine.verifyOccurrence).toHaveBeenCalledOnce();
    });
  });

  it('occurrence flags each evidence row with capturedInPharmacy', async () => {
    const genuine = pharmacyEvidence('ostep_1', 'photo');
    const foreign = foreignEvidence('ostep_1', 'photo');
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: 'occ_1',
      status: 'IN_PROGRESS',
      businessDate: new Date(Date.UTC(2026, 10, 4)),
      dueAt: new Date(),
      windowEndsAt: new Date(Date.now() + 3_600_000),
      startedAt: new Date(),
      submittedAt: null,
      resolvedAt: null,
      assignedStaffProfileId: ACTOR.staffProfileId,
      claimedByStaffProfileId: null,
      poolJobRoleId: null,
      assignment: {
        graceMinutes: 0,
        template: { id: 'tpl', name: training.name, category: 'Training' },
      },
      steps: [],
      evidence: [genuine, foreign].map((row, index) => ({
        id: `ev_${index}`,
        sizeBytes: 3,
        capturedAt: new Date(),
        uploader: { displayName: 'Me' },
        ...row,
      })),
      verifications: [],
    });
    const result = await caller().occurrence(OCC_INPUT);
    expect(result.evidence.map((row) => [row.id, row.capturedInPharmacy])).toEqual([
      ['ev_0', true],
      ['ev_1', false],
    ]);
  });
});

describe('an out-of-range reading linked where no later note can reach it', () => {
  const TEMP_STEP = opening.steps[1]!.title;
  const arrange = (opts: {
    stepNote?: string;
    done?: boolean;
    existing?: boolean;
    outOfRange?: boolean;
    excursion?: boolean;
  }) => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: opening.name },
    });
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue({
      templateStep: { title: TEMP_STEP, stepOrder: 2 },
    });
    db.restaurantSopOccurrenceStep.findMany.mockResolvedValue(
      opening.steps.map((step, index) => ({
        id: `ostep_${index + 1}`,
        completed: index === 1 ? opts.done !== false : false,
        note: index === 1 ? (opts.stepNote ?? null) : null,
        templateStep: {
          title: opts.excursion && index === 4 ? 'Record any excursion' : step.title,
        },
      }))
    );
    db.pharmacySopRecordLink.findFirst.mockResolvedValue(opts.existing ? { id: 'link_0' } : null);
    db.pharmacyTemperatureLog.findFirst.mockResolvedValue(
      opts.outOfRange === false ? null : { id: 'log_hot' }
    );
    mocks.adapter.linkPharmacySopRecord.mockResolvedValue({ linkId: 'link_1', created: true });
  };
  const link = (extra: { occurrenceStepId?: string | null; note?: string } = {}) =>
    caller().linkRecord({
      ...OCC_INPUT,
      occurrenceStepId: 'ostep_2',
      recordType: 'TEMPERATURE_LOG',
      recordId: 'log_hot',
      ...extra,
    });

  it('refuses it on a done step without a note (the procedure could never be submitted)', async () => {
    arrange({});
    await expect(link()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('out of range'),
    });
    await expect(link({ note: '   ' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.adapter.linkPharmacySopRecord).not.toHaveBeenCalled();
    expect(db.pharmacyTemperatureLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'log_hot', branchId: SITE.pharmacyBranchId, outOfRange: true },
      })
    );
  });

  it('refuses it on no step at all without a note', async () => {
    arrange({});
    await expect(link({ occurrenceStepId: null })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mocks.adapter.linkPharmacySopRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['a note on the link', { note: 'Fridge at 9 °C; moved stock' }, {}],
    ['a step not yet done', {}, { done: false }],
    ['an in-range reading', {}, { outOfRange: false }],
    ['the same reading linked again', {}, { existing: true }],
    ['a separate excursion step', {}, { excursion: true }],
    ['a done step that already has a note', {}, { stepNote: 'Fridge at 9 °C; moved stock' }],
  ])('links it with %s', async (_label, extra, opts) => {
    arrange(opts);
    await expect(link(extra)).resolves.toMatchObject({ linkId: 'link_1' });
    expect(mocks.adapter.linkPharmacySopRecord).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        recordId: 'log_hot',
        note: 'note' in extra ? extra.note : null,
      })
    );
  });
});

describe('record links follow the pack', () => {
  beforeEach(() => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: temperatureLog.name },
    });
    mocks.adapter.linkPharmacySopRecord.mockResolvedValue({ linkId: 'link_1', created: true });
  });

  it('linkableRecords refuses a record type the pack never links', async () => {
    await expect(
      caller().linkableRecords({ ...OCC_INPUT, recordType: 'CONTROLLED_REGISTER_ENTRY' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantSopOccurrence.findUnique).not.toHaveBeenCalled();

    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      dueAt: new Date(),
      windowEndsAt: new Date(),
    });
    await expect(
      caller().linkableRecords({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG' })
    ).resolves.toEqual([]);
  });

  it('linkRecord on a step needs exactly that step’s record type', async () => {
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValue({
      templateStep: { title: temperatureLog.steps[0]!.title, stepOrder: 1 },
    });
    await expect(
      caller().linkRecord({
        ...OCC_INPUT,
        occurrenceStepId: 'ostep_1',
        recordType: 'GOODS_RECEIPT',
        recordId: 'gr_1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await caller().linkRecord({
      ...OCC_INPUT,
      occurrenceStepId: 'ostep_1',
      recordType: 'TEMPERATURE_LOG',
      recordId: 'log_1',
    });
    expect(db.restaurantSopOccurrenceStep.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ostep_1', occurrenceId: 'occ_1' } })
    );
    expect(mocks.adapter.linkPharmacySopRecord).toHaveBeenCalledOnce();
  });

  it('linkRecord refuses a step that names no record type and a step from elsewhere', async () => {
    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValueOnce({
      templateStep: { title: temperatureLog.steps[2]!.title, stepOrder: 3 },
    });
    await expect(
      caller().linkRecord({
        ...OCC_INPUT,
        occurrenceStepId: 'ostep_3',
        recordType: 'TEMPERATURE_LOG',
        recordId: 'log_1',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This step does not take a linked record.',
    });

    db.restaurantSopOccurrenceStep.findFirst.mockResolvedValueOnce(null);
    await expect(
      caller().linkRecord({
        ...OCC_INPUT,
        occurrenceStepId: 'ostep_elsewhere',
        recordType: 'TEMPERATURE_LOG',
        recordId: 'log_1',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.adapter.linkPharmacySopRecord).not.toHaveBeenCalled();
  });

  it('an occurrence-level link must still be a type the pack links', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
      template: { name: controlledCounts.name },
    });
    await expect(
      caller().linkRecord({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG', recordId: 'log_1' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller().linkRecord({
      ...OCC_INPUT,
      recordType: 'CONTROLLED_REGISTER_ENTRY',
      recordId: 'cre_1',
    });
    expect(mocks.adapter.linkPharmacySopRecord).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ occurrenceStepId: null, recordType: 'CONTROLLED_REGISTER_ENTRY' })
    );
  });

  it('linkRecord and evidenceTarget need the caller’s own work in progress', async () => {
    const link = () =>
      caller().linkRecord({ ...OCC_INPUT, recordType: 'TEMPERATURE_LOG', recordId: 'log_1' });
    occurrenceRow.status = 'SUBMITTED';
    await expect(link()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(caller().evidenceTarget(OCC_INPUT)).rejects.toMatchObject({ code: 'CONFLICT' });
    occurrenceRow.status = 'IN_PROGRESS';
    occurrenceRow.assignedStaffProfileId = 'staff_other';
    await expect(link()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().evidenceTarget(OCC_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.adapter.linkPharmacySopRecord).not.toHaveBeenCalled();
  });
});

describe('report gate', () => {
  it.each([['sop:verify'], ['sop:manage']])('admits %s', async (capability) => {
    mocks.granted = new Set([capability]);
    mocks.engine.buildScoreReport.mockResolvedValue({ rows: [] });
    db.restaurantSopOccurrence.findMany.mockResolvedValue([]);
    await expect(
      caller().report({ ...BRANCH_INPUT, from: '2026-11-01', to: '2026-11-04' })
    ).resolves.toMatchObject({ score: { rows: [] } });
    expect(mocks.engine.buildScoreReport).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ branchId: SITE.sopBranchId })
    );
  });
});

describe('startOnDemand serialization', () => {
  const input = { ...BRANCH_INPUT, templateId: 'tpl_recv' };
  const lockKey = `pharmacy-sop-on-demand:org_1:${SITE.sopBranchId}:tpl_recv:${ACTOR.staffProfileId}`;

  beforeEach(() => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_recv',
      name: receiving.name,
      isActive: true,
    });
  });

  it('takes a per-tenant, site, template and actor lock before looking for open work', async () => {
    db.restaurantSopOccurrence.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'occ_new' });
    await expect(caller().startOnDemand(input)).resolves.toEqual({
      occurrenceId: 'occ_new',
      created: true,
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const sql = db.$queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(sql.values).toEqual([lockKey]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      db.restaurantSopOccurrence.findFirst.mock.invocationCallOrder[0]!
    );
  });

  it('a caller that waited on the lock finds the open occurrence and creates nothing', async () => {
    db.restaurantSopOccurrence.findFirst.mockResolvedValueOnce({ id: 'occ_first' });
    await expect(caller().startOnDemand(input)).resolves.toEqual({
      occurrenceId: 'occ_first',
      created: false,
    });
    expect(db.$queryRaw.mock.calls[0]![0]).toMatchObject({ values: [lockKey] });
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });
});

describe('engine refusals never echo internal ids', () => {
  it('maps engine NOT_FOUND refusals to fixed wording', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_open',
      name: opening.name,
      isActive: true,
    });
    mocks.engine.createAssignment.mockRejectedValueOnce(
      new SopTemplateError('Branch sopbranch_secret_1 was not found.', 'NOT_FOUND')
    );
    const assignment = await caller()
      .createAssignment({
        ...BRANCH_INPUT,
        templateId: 'tpl_open',
        target: { type: 'ROLE', roleKey: 'pharmacy-assistant' },
        frequency: 'DAILY',
        dueTimeMinutes: 9 * 60,
        startDate: '2026-11-04',
      })
      .catch((err: unknown) => err as Error);
    expect(assignment).toMatchObject({ code: 'NOT_FOUND' });
    expect(String((assignment as Error).message)).not.toContain('sopbranch_secret_1');

    mocks.engine.startOccurrence.mockRejectedValueOnce(
      new SopExecutionError('Occurrence occ_secret_1 not found.', 'NOT_FOUND')
    );
    await expect(caller().start(OCC_INPUT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Procedure not found.',
    });

    mocks.engine.completeStep.mockRejectedValueOnce(
      new SopExecutionError('Step tstep_secret_1 missing.', 'STEP_NOT_FOUND')
    );
    await expect(
      caller().completeStep({ ...OCC_INPUT, templateStepId: 'tstep_1', note: 'ok' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Step not found on this procedure.' });

    occurrenceRow = { ...occurrenceRow, status: 'SUBMITTED', assignedStaffProfileId: 'staff_op' };
    mocks.engine.verifyOccurrence.mockRejectedValueOnce(
      new SopVerificationError('Occurrence occ_secret_1 not found.', 'NOT_FOUND')
    );
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Procedure not found.',
    });
  });
});

describe('coordinator follow-ups', () => {
  it('installs the library into the session organization', async () => {
    mocks.engine.installPharmacySopLibrary.mockResolvedValue([]);
    await caller().installLibrary();
    expect(mocks.engine.installPharmacySopLibrary).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
    });
  });

  it.each([
    ['NOT_INDEPENDENT', 'You can’t give yourself a role that checks procedures.'],
    ['ROLE_REQUIRED', 'The qualified-person role needs the pharmacist dispensing permission.'],
  ] as const)('setRoleHolding passes the adapter %s wording through', async (reason, text) => {
    mocks.adapter.setPharmacySopRoleHolding.mockRejectedValueOnce(
      new PharmacySopAccessError(text, reason)
    );
    await expect(
      caller().setRoleHolding({
        ...BRANCH_INPUT,
        userId: 'user_2',
        roleKey: 'pharmacy-qualified-person',
        held: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: text });
  });

  it('verify keeps the fixed independence wording', async () => {
    occurrenceRow = { ...occurrenceRow, status: 'SUBMITTED', assignedStaffProfileId: 'staff_op' };
    mocks.adapter.assertIndependentPharmacyVerifier.mockRejectedValueOnce(
      new PharmacySopAccessError('you completed step 2 of occ_1', 'NOT_INDEPENDENT')
    );
    await expect(caller().verify(OCC_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You can’t check a procedure you worked on.',
    });
  });

  it.each([
    ['TEMPERATURE_LOG', temperatureLog.name, 'pharmacyTemperatureLog', 'recordedAt', {}],
    [
      'GOODS_RECEIPT',
      receiving.name,
      'pharmacyGoodsReceipt',
      'receivedAt',
      // A cancelled receipt is never offered.
      { status: { notIn: ['CANCELLED', 'REVERSED'] } },
    ],
  ] as const)(
    'linkableRecords bounds %s candidates to the link window',
    async (recordType, packName, delegate, column, extra) => {
      const dueAt = new Date('2026-11-04T08:00:00.000Z');
      const windowEndsAt = new Date('2026-11-04T12:00:00.000Z');
      db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({ template: { name: packName } });
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({ dueAt, windowEndsAt });
      await caller().linkableRecords({ ...OCC_INPUT, recordType });
      expect(db[delegate].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org_1',
            branchId: SITE.pharmacyBranchId,
            [column]: { gte: new Date(dueAt.getTime() - 86_400_000), lte: windowEndsAt },
            ...extra,
          },
        })
      );
    }
  );
});

// ── Visual QA follow-ups ─────────────────────────────────────────────────────

describe('refusals speak in plain operator words', () => {
  it('names a claim someone else won as a procedure', async () => {
    mocks.engine.claimSopOccurrence.mockResolvedValueOnce({ status: 'CLAIMED_BY_OTHER' });
    await expect(caller().claim(OCC_INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Someone else has already claimed this procedure.',
    });
    mocks.engine.claimSopOccurrence.mockResolvedValueOnce({
      status: 'NOT_CLAIMABLE',
      reason: 'INVALID_STATE',
    });
    await expect(caller().claim(OCC_INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This procedure is not available to claim.',
    });
  });

  it('says a procedure no longer in use, never an archived template', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_old',
      name: opening.name,
      isActive: false,
    });
    await expect(
      caller().createAssignment({
        ...BRANCH_INPUT,
        templateId: 'tpl_old',
        target: { type: 'ROLE' as const, roleKey: 'pharmacy-assistant' as const },
        frequency: 'DAILY' as const,
        dueTimeMinutes: 9 * 60,
        startDate: '2026-11-04',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This procedure is no longer in use.' });
  });

  it.each([
    ['ROLE_REQUIRED', 'FORBIDDEN', 'You don’t hold the role this procedure needs at this branch.'],
    ['NOT_INDEPENDENT', 'FORBIDDEN', 'You can’t check a procedure you worked on.'],
    ['OCCURRENCE_OUT_OF_SCOPE', 'NOT_FOUND', 'Procedure not found.'],
    ['STATE_CHANGED', 'CONFLICT', SOP_STATE_MESSAGES.changed],
  ] as const)('maps the adapter %s refusal to fixed plain words', (reason, code, message) => {
    let caught: unknown;
    try {
      mapSopError(new PharmacySopAccessError('occurrence occ_1 verifier', reason));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code, message });
    expect(String((caught as Error).message)).not.toMatch(/occurrence|verifier|SOP template/i);
  });
});

describe('review queue is null-safe', () => {
  it('excludes only the reviewer’s own work, keeping rows whose owner columns are NULL', async () => {
    expect(notOwnedOrClaimedBy('staff_me')).toEqual({
      AND: [
        {
          OR: [{ assignedStaffProfileId: null }, { assignedStaffProfileId: { not: 'staff_me' } }],
        },
        {
          OR: [{ claimedByStaffProfileId: null }, { claimedByStaffProfileId: { not: 'staff_me' } }],
        },
      ],
    });

    mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-qualified-person']);
    mocks.engine.listStaffSopOccurrences.mockResolvedValue([]);
    mocks.engine.listClaimablePoolOccurrences.mockResolvedValue([]);
    db.restaurantSopOccurrence.findMany.mockResolvedValue([]);
    await caller().board(BRANCH_INPUT);
    const [call] = db.restaurantSopOccurrence.findMany.mock.calls;
    const where = (call![0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({
      branchId: SITE.sopBranchId,
      status: { in: ['SUBMITTED', 'LATE'] },
      ...notOwnedOrClaimedBy(ACTOR.staffProfileId),
    });
    // A bare NOT over the nullable columns is the bug this replaces.
    expect(where).not.toHaveProperty('NOT');
  });
});

describe('Setup schedules hide on-demand runs', () => {
  const assignment = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    template: { id: `tpl_${id}`, name },
    assigneeTargetType: 'ROLE',
    assigneeJobRoleId: null,
    assigneeStaffProfileId: null,
    frequency: 'DAILY',
    interval: 1,
    daysOfWeek: [],
    monthDay: null,
    dueTimeMinutes: 480,
    intervalEndTimeMinutes: null,
    windowMinutes: 60,
    graceMinutes: 0,
    startDate: new Date(Date.UTC(2026, 10, 4)),
    endDate: null,
    active: true,
    supersededAt: null,
    ...extra,
  });

  it('lists schedules but not the paused ONCE PERSON runs startOnDemand creates', async () => {
    mocks.engine.listAssignments.mockResolvedValue([
      assignment('a_open', opening.name),
      assignment('a_run', receiving.name, {
        frequency: 'ONCE',
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: ACTOR.staffProfileId,
        active: false,
      }),
      // A named-person ONCE schedule of a non-event pack is a real schedule.
      assignment('a_training', training.name, {
        frequency: 'ONCE',
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: ACTOR.staffProfileId,
        active: false,
      }),
    ]);
    const rows = await caller().assignments(BRANCH_INPUT);
    expect(rows.map((row) => row.id)).toEqual(['a_open', 'a_training']);
  });

  it('refuses to schedule an event pack, and to resume an on-demand run', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_recv',
      name: receiving.name,
      isActive: true,
    });
    await expect(
      caller().createAssignment({
        ...BRANCH_INPUT,
        templateId: 'tpl_recv',
        target: { type: 'ROLE', roleKey: 'pharmacy-assistant' },
        frequency: 'DAILY',
        dueTimeMinutes: 9 * 60,
        startDate: '2026-11-04',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();

    db.restaurantSopAssignment.findUnique.mockResolvedValue({
      id: 'a_run',
      branchId: SITE.sopBranchId,
      frequency: 'ONCE',
      assigneeTargetType: 'PERSON',
      template: { name: receiving.name },
    });
    await expect(
      caller().setAssignmentActive({ ...BRANCH_INPUT, assignmentId: 'a_run', active: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.engine.setAssignmentActive).not.toHaveBeenCalled();
  });
});

describe('own staff profile', () => {
  it('maps NO_STAFF_PROFILE to the fixed wording the workspace recognises', async () => {
    mocks.adapter.resolvePharmacySopActor.mockRejectedValueOnce(
      new PharmacySopAccessError('internal detail', 'NO_STAFF_PROFILE')
    );
    mocks.granted = new Set(['sop:verify']);
    await expect(caller().board(BRANCH_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE,
    });
  });

  it('joinSite sets up the session user’s own profile, scoped to the branch', async () => {
    mocks.adapter.ensurePharmacySopStaffProfile.mockResolvedValueOnce({ ...ACTOR, created: true });
    mocks.granted = new Set(['sop:verify']);
    await expect(caller().joinSite(BRANCH_INPUT)).resolves.toEqual({
      staffProfileId: ACTOR.staffProfileId,
      created: true,
    });
    expect(mocks.adapter.resolvePharmacySopSite).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      pharmacyBranchId: SITE.pharmacyBranchId,
    });
    expect(mocks.adapter.ensurePharmacySopStaffProfile).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      pharmacyBranchId: SITE.pharmacyBranchId,
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'pharmacy.sop.joinSite' })
    );
  });

  it('joinSite needs an SOP capability, takes no user id, and fails closed', async () => {
    mocks.granted = new Set();
    await expect(caller().joinSite(BRANCH_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.granted = new Set(ALL_CAPS);
    const c = caller() as unknown as { joinSite: (input: unknown) => Promise<unknown> };
    await expect(c.joinSite({ ...BRANCH_INPUT, userId: 'user_victim' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.adapter.ensurePharmacySopStaffProfile).not.toHaveBeenCalled();
    mocks.adapter.ensurePharmacySopStaffProfile.mockRejectedValueOnce(
      new PharmacySopAccessError('x', 'AMBIGUOUS_STAFF_PROFILE')
    );
    await expect(caller().joinSite(BRANCH_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('setRoleHolding grants as the session user, setting up their profile if needed', async () => {
    mocks.adapter.ensurePharmacySopStaffProfile.mockResolvedValueOnce({
      ...ACTOR,
      staffProfileId: 'staff_new_mgr',
      created: true,
    });
    mocks.adapter.setPharmacySopRoleHolding.mockResolvedValue({
      staffProfileId: 'staff_2',
      changed: true,
    });
    await caller().setRoleHolding({
      ...BRANCH_INPUT,
      userId: 'user_2',
      roleKey: 'pharmacy-assistant',
      held: true,
    });
    expect(mocks.adapter.resolvePharmacySopActor).not.toHaveBeenCalled();
    expect(mocks.adapter.setPharmacySopRoleHolding).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ grantedByStaffProfileId: 'staff_new_mgr', targetUserId: 'user_2' })
    );
  });

  it('enableSite also sets up the enabling manager’s profile, best effort', async () => {
    mocks.adapter.enablePharmacySopSite.mockResolvedValue({ site: SITE, created: true });
    await expect(
      caller().enableSite({ ...BRANCH_INPUT, timezone: 'Asia/Karachi' })
    ).resolves.toMatchObject({ created: true, staffProfileReady: true });
    expect(mocks.adapter.ensurePharmacySopStaffProfile).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      pharmacyBranchId: SITE.pharmacyBranchId,
    });

    mocks.adapter.ensurePharmacySopStaffProfile.mockRejectedValueOnce(
      new PharmacySopAccessError('suspended', 'NO_STAFF_PROFILE')
    );
    await expect(
      caller().enableSite({ ...BRANCH_INPUT, timezone: 'Asia/Karachi' })
    ).resolves.toMatchObject({ staffProfileReady: false });
  });

  it('roleHoldings marks the viewer’s own row', async () => {
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([
      { userId: 'user_1', user: { id: 'user_1', name: 'Me', email: 'me@x' } },
      { userId: 'user_2', user: { id: 'user_2', name: 'Two', email: 'two@x' } },
    ]);
    const rows = await caller().roleHoldings(BRANCH_INPUT);
    expect(rows.map((row) => [row.userId, row.isViewer])).toEqual([
      ['user_1', true],
      ['user_2', false],
    ]);
  });
});

describe('occurrence history inputs', () => {
  it('returns claim time and the names the History view needs', async () => {
    const claimedAt = new Date('2026-11-04T08:05:00Z');
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: 'occ_1',
      status: 'SUBMITTED',
      businessDate: new Date(Date.UTC(2026, 10, 4)),
      dueAt: new Date(),
      windowEndsAt: new Date(Date.now() + 3_600_000),
      startedAt: new Date('2026-11-04T08:10:00Z'),
      claimedAt,
      submittedAt: new Date('2026-11-04T08:30:00Z'),
      resolvedAt: null,
      assignedStaffProfileId: null,
      claimedByStaffProfileId: ACTOR.staffProfileId,
      poolJobRoleId: 'role_asst',
      assignedStaff: null,
      claimedBy: { displayName: 'Claire' },
      assignment: {
        graceMinutes: 0,
        template: { id: 'tpl', name: opening.name, category: 'Opening' },
      },
      steps: [],
      evidence: [],
      verifications: [],
    });
    const result = await caller().occurrence(OCC_INPUT);
    expect(result).toMatchObject({ claimedAt, ownerName: 'Claire', claimedByName: 'Claire' });
    expect(db.restaurantSopOccurrence.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          claimedAt: true,
          assignedStaff: { select: { displayName: true } },
          claimedBy: { select: { displayName: true } },
        }),
      })
    );
  });
});
