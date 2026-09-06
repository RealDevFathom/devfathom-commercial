import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { seedChaichowkOperationsFixtures, type ChaichowkOperationsFixtureContext } from './chaichowk-staging-operations-fixtures';

type Row = Record<string, any>; // Mock delegate rows deliberately cover heterogeneous Prisma models.
const context: ChaichowkOperationsFixtureContext = {
  organizationId: 'demo-org', branchId: 'demo-branch', ownerUserId: 'owner-user',
  businessDate: '2026-09-06', timezone: 'Asia/Karachi',
  id: (key) => `demo-org.demo-branch.v1.${key}`,
};
const capabilities = ['staff:manage', 'sop:manage', 'sop:complete', 'sop:verify'];
const fixtureModels = [
  'restaurantShift', 'restaurantShiftBreak', 'restaurantShiftEvent', 'restaurantShiftSwapRequest',
  'restaurantShiftSwapDecision', 'restaurantWorkforceCommand', 'restaurantSopTemplate',
  'restaurantSopTemplateVersion', 'restaurantSopTemplateStep', 'restaurantSopAssignment',
  'restaurantSopOccurrence', 'restaurantSopOccurrenceStep', 'restaurantSopEvidence',
  'restaurantSopVerification', 'restaurantNotification',
];

function harness() {
  const rows = new Map(fixtureModels.map((model) => [model, new Map<string, Row>()]));
  const writes: string[] = [];
  const profiles: Row[] = [
    { id: 'owner', userId: 'owner-user', displayName: 'Owner', email: null },
    { id: 'demo-a', userId: 'demo-user', displayName: '[DEMO] Employee', email: null },
    { id: 'demo-b', userId: null, displayName: '[DEMO] Replacement', email: null },
  ].map((row) => ({ ...row, organizationId: context.organizationId, primaryBranchId: context.branchId, status: 'ACTIVE' }));
  const state = { ownerActive: true, overlap: false, denies: [] as string[], failCreate: false };
  const tx: Row = {
    restaurantBranch: { findFirst: async ({ where }: Row) => {
      assert.equal(where.organizationId, context.organizationId);
      return { id: context.branchId, timezone: context.timezone, businessDayCutoff: '04:00' };
    } },
    user: { findFirst: async ({ where }: Row) => {
      assert.equal(where.organizationId, context.organizationId);
      assert.equal(where.status, 'ACTIVE');
      return where.id === context.ownerUserId && !state.ownerActive ? null : { id: where.id };
    } },
    restaurantStaffProfile: { findMany: async ({ where }: Row) => {
      assert.equal(where.organizationId, context.organizationId);
      assert.equal(where.primaryBranchId, context.branchId);
      assert.equal(where.status, 'ACTIVE');
      return profiles.filter((staff) => staff.status === where.status && staff.primaryBranchId === where.primaryBranchId);
    } },
    restaurantStaffJobRole: { findMany: async ({ where }: Row) => {
      assert.equal(where.organizationId, context.organizationId);
      assert.equal(where.branchId, context.branchId);
      assert.deepEqual(where.jobRole, { organizationId: context.organizationId, active: true });
      return [{ jobRole: { capabilities: capabilities.map((capability) => ({ capability })) } }];
    } },
    restaurantStaffCapabilityGrant: { findMany: async ({ where }: Row) => {
      assert.equal(where.organizationId, context.organizationId);
      assert.equal(where.branchId, context.branchId);
      return where.staffProfileId === 'owner'
        ? state.denies.flatMap((capability) => [{ capability, effect: 'ALLOW' }, { capability, effect: 'DENY' }]) : [];
    } },
  };
  for (const model of fixtureModels) tx[model] = {
    findUnique: async ({ where }: Row) => rows.get(model)!.get(where.id) ?? null,
    create: async ({ data }: Row) => {
      if (state.failCreate) throw new Error('mock transaction write failure');
      assert.equal(data.organizationId, context.organizationId);
      assert.match(data.id, /\.operations\./);
      assert.ok(!rows.get(model)!.has(data.id));
      rows.get(model)!.set(data.id, structuredClone(data));
      writes.push(model);
      return data;
    },
  };
  tx.restaurantShift.findFirst = async ({ where }: Row) => {
    assert.equal(where.organizationId, context.organizationId);
    assert.equal(where.branchId, undefined, 'overlap must include all tenant branches');
    return state.overlap ? { id: 'unrelated-shift' } : null;
  };
  const list = (model: string) => [...rows.get(model)!.values()];
  const run = (input = context) => seedChaichowkOperationsFixtures(tx as Parameters<typeof seedChaichowkOperationsFixtures>[0], input);
  return { rows, writes, profiles, state, tx, list, run };
}

test('complete fixture: observed inserts, reconciled attendance and causally ordered history', async () => {
  const h = harness();
  const report = await h.run();
  assert.deepEqual(report.gaps, []);
  assert.equal(report.inserted, h.writes.length);
  assert.equal(report.existing, 0);
  const shift = h.list('restaurantShift').find((row) => row.clockedOutAt)!;
  const rest = h.list('restaurantShiftBreak')[0];
  assert.equal(shift.startAt.toISOString(), '2026-09-04T05:00:00.000Z');
  assert.equal(shift.businessDate.toISOString(), '2026-09-04T00:00:00.000Z');
  assert.ok(shift.clockedInAt < rest.startedAt && rest.endedAt < shift.clockedOutAt);
  assert.equal((shift.clockedOutAt - shift.clockedInAt - (rest.endedAt - rest.startedAt)) / 3_600_000, 7.5);
  assert.deepEqual(shift.updatedAt, shift.clockedOutAt);
  const commands = h.list('restaurantWorkforceCommand').filter((row) => row.shiftId === shift.id);
  assert.deepEqual(commands.map((row) => row.kind), ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
  assert.ok(commands.every((row, i) => i === 0 || commands[i - 1].createdAt < row.createdAt));
  const decision = h.list('restaurantShiftSwapDecision')[0];
  const request = h.list('restaurantShiftSwapRequest').find((row) => row.id === decision.requestId)!;
  assert.equal(decision.decision, 'REJECTED');
  assert.ok(request.createdAt < decision.decidedAt);
  assert.notEqual(request.requestedByStaffProfileId, decision.decidedByStaffProfileId);
  assert.notEqual(request.replacementStaffProfileId, decision.decidedByStaffProfileId);
  assert.equal(h.list('restaurantShiftSwapRequest').length, 2);
  assert.equal(h.list('restaurantShiftSwapDecision').length, 1);
});

test('SOP board, note evidence, separate reviewer and local causal inbox', async () => {
  const h = harness(); await h.run();
  const occurrences = h.list('restaurantSopOccurrence');
  assert.deepEqual(occurrences.map((row) => row.status), ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED']);
  for (const occurrence of occurrences) {
    if (occurrence.submittedAt) {
      assert.ok(occurrence.startedAt < occurrence.submittedAt && occurrence.submittedAt < occurrence.windowEndsAt);
    }
  }
  for (const evidence of h.list('restaurantSopEvidence')) {
    const step = h.list('restaurantSopOccurrenceStep').find((row) => row.id === evidence.occurrenceStepId)!;
    assert.match(step.note, /SYNTHETIC DEMO/);
    assert.equal(evidence.contentHash, createHash('sha256').update(step.note).digest('hex'));
    assert.equal(evidence.sizeBytes, Buffer.byteLength(step.note));
    assert.equal(evidence.storageRef, null);
  }
  const review = h.list('restaurantSopVerification')[0];
  const occurrence = occurrences.find((row) => row.id === review.occurrenceId)!;
  assert.equal(review.action, 'REJECT');
  assert.notEqual(review.actorStaffProfileId, occurrence.assignedStaffProfileId);
  assert.equal(review.coAuthorizationId, null);
  assert.equal(occurrence.resolvedAt, null);
  assert.deepEqual(occurrence.updatedAt, review.createdAt);
  for (const notification of h.list('restaurantNotification')) {
    assert.ok(occurrences.some((row) => row.id === notification.entityId));
    assert.equal(notification.recipientStaffProfileId, 'owner');
    assert.match(notification.body, /SYNTHETIC DEMO/);
  }
  assert.equal(h.list('restaurantNotification').filter((row) => row.isRead).length, 1);
  // The strict mock exposes no jobs, deliveries, webhooks, auth mutations, raw SQL or client lifecycle.
  assert.ok(h.writes.every((model) => fixtureModels.includes(model)));
});

test('identical replay reports existing rows and performs no writes', async () => {
  const h = harness(); const first = await h.run(); h.writes.length = 0;
  const second = await h.run();
  assert.equal(second.inserted, 0); assert.equal(second.existing, first.inserted);
  assert.equal(h.writes.length, 0);
});

for (const [model, change] of [
  ['restaurantShift', { status: 'CANCELLED' }],
  ['restaurantShift', { organizationId: 'another-tenant' }],
  ['restaurantSopOccurrence', { status: 'WAIVED' }],
  ['restaurantSopTemplate', { description: 'User edited' }],
  ['restaurantNotification', { isRead: true }],
] as const) test(`replay refuses changed ${model} ${Object.keys(change)[0]} without overwrite`, async () => {
  const h = harness(); await h.run(); h.writes.length = 0;
  Object.assign(h.list(model)[0], change);
  await assert.rejects(h.run(), /fixture conflict/);
  assert.equal(h.writes.length, 0);
});

test('partial namespace never resurrects deleted evidence', async () => {
  const h = harness(); await h.run(); h.writes.length = 0;
  h.rows.get('restaurantSopEvidence')!.clear();
  await assert.rejects(h.run(), /namespace is partial/);
  assert.equal(h.writes.length, 0);
});

test('missing active owner returns exact prerequisite gap and zero inserts', async () => {
  const h = harness(); h.state.ownerActive = false;
  const report = await h.run();
  assert.equal(report.inserted, 0); assert.match(report.gaps[0], /^owner:/);
  assert.equal(h.writes.length, 0);
});

test('suspended, wrong-branch and unmarked real staff cannot become synthetic actors', async () => {
  const h = harness(); h.profiles[1].status = 'SUSPENDED'; h.profiles[2].primaryBranchId = 'other-branch';
  h.profiles.push({ ...h.profiles[0], id: 'real-staff', userId: 'real-user', displayName: 'Real Person' });
  const report = await h.run();
  assert.ok(report.gaps.some((gap) => gap.startsWith('workforce swaps:')));
  assert.ok(report.gaps.some((gap) => gap.startsWith('SOP reviewed:')));
  assert.equal(h.list('restaurantShiftSwapRequest').length, 0);
  assert.equal(h.list('restaurantSopVerification').length, 0);
});

test('DENY overrides role and direct ALLOW; no broad grant fallback', async () => {
  const h = harness(); h.state.denies = ['staff:manage', 'sop:manage'];
  const report = await h.run();
  assert.equal(report.inserted, 0); assert.equal(report.gaps.length, 2);
  assert.equal(h.writes.length, 0);
});

test('existing overlapping roster is preserved with exact scenario gaps', async () => {
  const h = harness(); h.state.overlap = true;
  const report = await h.run();
  assert.equal(h.list('restaurantShift').length, 0);
  assert.equal(report.gaps.filter((gap) => gap.includes('overlapping roster')).length, 4);
});

test('invalid dates and timezone mismatch refuse before inserts', async () => {
  const h = harness();
  await assert.rejects(h.run({ ...context, businessDate: '2026-02-30' }));
  const report = await h.run({ ...context, timezone: 'UTC' });
  assert.match(report.gaps[0], /timezone mismatch/); assert.equal(h.writes.length, 0);
});

test('date changes under the same version namespace refuse instead of silently moving history', async () => {
  const h = harness(); await h.run(); h.writes.length = 0;
  await assert.rejects(h.run({ ...context, businessDate: '2026-09-07' }), /fixture conflict/);
  assert.equal(h.writes.length, 0);
});

test('bad ID factory conflicts before inserts; write errors propagate to root transaction', async () => {
  const h = harness();
  await assert.rejects(h.run({ ...context, id: () => 'constant' }), /namespace collision/);
  assert.equal(h.writes.length, 0);
  h.state.failCreate = true;
  await assert.rejects(h.run(), /mock transaction write failure/);
});

test('verification DENY removes reviewed scenarios and reviewer inbox prompts', async () => {
  const h = harness(); h.state.denies = ['sop:verify'];
  const report = await h.run();
  assert.ok(report.gaps.some((gap) => gap.startsWith('SOP reviewed:')));
  assert.equal(h.list('restaurantSopVerification').length, 0);
  assert.equal(h.list('restaurantNotification').length, 1);
});

test('fixture IDs remain scoped to every supplied tenant/branch/version key', async () => {
  const h = harness(); const keys: string[] = [];
  await h.run({ ...context, id: (key) => { keys.push(key); return context.id(key); } });
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith('operations.')));
});
