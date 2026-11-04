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
import { pharmacySopRouter } from './pharmacy-sop';
import { PharmacySopAccessError } from '@/lib/pharmacy/sop-adapter';
import { findPharmacySopPack, type PharmacySopPackStep } from '@/lib/pharmacy/sop-library';
import { SopExecutionError } from '@/lib/restaurant/sop-execution';

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
  };
  return db as Record<keyof typeof db, Delegate>;
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
}) {
  const steps = opts.pack.steps.map((step, index) => ({
    id: `ostep_${index + 1}`,
    note: opts.notes?.[index + 1] ?? null,
    templateStep: { title: step.title, stepOrder: index + 1 },
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

  it('branches needs at least one SOP capability; report needs complete or verify', async () => {
    mocks.granted = new Set();
    await expect(caller().branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.granted = new Set(['sop:manage']);
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
    });
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
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
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
    await caller().createAssignment(personInput);
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
      message: expect.stringContaining('Record refrigerator temperature'),
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
      expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledOnce();
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
