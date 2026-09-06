import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '../src/generated/prisma/client';
import { businessDateToUtcDate, resolveBusinessDate } from '../src/lib/restaurant/business-date';
import { zonedWallTimeToUtc } from '../src/lib/restaurant/sop-recurrence';

export type ChaichowkOperationsFixtureContext = {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  businessDate: string | Date;
  timezone: string;
  /** Root-owned tenant/branch/version namespace; never include wall-clock time. */
  id(key: string): string;
};

/**
 * WHA-1382 MUST validate these through the accepted entitlement/access resolvers
 * before calling this lane. Those resolvers open a platform transaction and
 * cannot run inside this transaction-only fixture contract. No grants here.
 * The caller also owns target guards, template quota, namespace tombstones,
 * serialization against live writers, and rollback on ANY thrown conflict.
 */
export const CHAICHOWK_OPERATIONS_REQUIRED_ACCESS = {
  modules: ['restaurant-workforce', 'restaurant-sop'],
  sopDepth: ['sop.execution', 'sop.evidence', 'sop.verification'],
  ownerCapabilities: ['staff:manage', 'sop:manage'],
  additionalTemplateFamilies: 1,
} as const;

const DEMO = 'SYNTHETIC DEMO — training scenario; no actual work, safety attestation or approval.';
type Model =
  | 'restaurantShift'
  | 'restaurantShiftBreak'
  | 'restaurantShiftEvent'
  | 'restaurantShiftSwapRequest'
  | 'restaurantShiftSwapDecision'
  | 'restaurantWorkforceCommand'
  | 'restaurantSopTemplate'
  | 'restaurantSopTemplateVersion'
  | 'restaurantSopTemplateStep'
  | 'restaurantSopAssignment'
  | 'restaurantSopOccurrence'
  | 'restaurantSopOccurrenceStep'
  | 'restaurantSopEvidence'
  | 'restaurantSopVerification'
  | 'restaurantNotification';
type FixtureRow = { model: Model; data: Record<string, unknown> & { id: string } };
type Counts = { inserted: number; existing: number };
export type ChaichowkOperationsFixtureResult = Counts & {
  counts: Partial<Record<Model, Counts>>;
  gaps: string[];
};

/**
 * Additive source fixtures ONLY. Pass WHA-1382's already-guarded Prisma tx.
 * Never constructs a client, opens a transaction, enqueues work or sends data.
 * Historical rows mirror workforce.ts / sop-execution.ts / sop-verification.ts;
 * their mutation helpers open transactions, so cannot be invoked here.
 * Every supplied field is compared on replay; changed/partial fixtures refuse
 * before any insert. Complete namespace deletion needs the root tombstone.
 */
export async function seedChaichowkOperationsFixtures(
  tx: Prisma.TransactionClient,
  context: ChaichowkOperationsFixtureContext
): Promise<ChaichowkOperationsFixtureResult> {
  const { organizationId, branchId, ownerUserId, timezone } = context;
  const result: ChaichowkOperationsFixtureResult = {
    inserted: 0,
    existing: 0,
    counts: {},
    gaps: [],
  };
  const gap = (message: string) => {
    result.gaps.push(message);
  };
  const date =
    context.businessDate instanceof Date
      ? context.businessDate.toISOString().slice(0, 10)
      : context.businessDate;
  const anchor = businessDateToUtcDate(date);
  // Validate real dates/timezones even if identity prerequisites are absent.
  zonedWallTimeToUtc(date, 12 * 60, timezone);
  const day = (offset: number) =>
    new Date(anchor.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (offset: number, minutes: number) =>
    zonedWallTimeToUtc(day(offset), minutes, timezone).instant;
  const id = (key: string) => context.id(`operations.${key}`);
  const branch = await tx.restaurantBranch.findFirst({
    where: { id: branchId, organizationId },
    select: { id: true, timezone: true, businessDayCutoff: true },
  });
  if (!branch || branch.timezone !== timezone) {
    gap('branch: missing tenant branch or timezone mismatch');
    return result;
  }
  const ownerUser = await tx.user.findFirst({
    where: { id: ownerUserId, organizationId, status: 'ACTIVE' },
    select: { id: true },
  });
  const profiles = await tx.restaurantStaffProfile.findMany({
    where: { organizationId, primaryBranchId: branchId, status: 'ACTIVE' },
    select: { id: true, userId: true, displayName: true, email: true },
    orderBy: { id: 'asc' },
  });
  const owners = profiles.filter((staff) => staff.userId === ownerUserId);
  if (!ownerUser || owners.length !== 1) {
    gap('owner: requires active tenant user and exactly one active branch-pinned staff profile');
    return result;
  }
  const owner = owners[0];
  // Conservative: do not attribute simulated employee actions to unmarked real staff.
  const synthetic = profiles.filter(
    (staff) =>
      staff.id !== owner.id &&
      (/\bDEMO\b/i.test(staff.displayName) || staff.email?.endsWith('.invalid'))
  );
  const staffCapabilities = new Map<string, Set<string>>();
  for (const staff of [owner, ...synthetic]) {
    // Same role union + ALLOW - DENY rule as resolveStaffCapabilityDecision.
    // Read explicitly in this tenant transaction; no elevated resolver/client.
    const holdings = await tx.restaurantStaffJobRole.findMany({
      where: {
        organizationId,
        staffProfileId: staff.id,
        branchId,
        jobRole: { organizationId, active: true },
      },
      select: { jobRole: { select: { capabilities: { select: { capability: true } } } } },
    });
    const overrides = await tx.restaurantStaffCapabilityGrant.findMany({
      where: { organizationId, staffProfileId: staff.id, branchId },
      select: { capability: true, effect: true },
    });
    const capabilities = new Set(
      holdings.flatMap((holding) => holding.jobRole.capabilities.map((row) => row.capability))
    );
    for (const override of overrides)
      if (override.effect === 'ALLOW') capabilities.add(override.capability);
    for (const override of overrides)
      if (override.effect === 'DENY') capabilities.delete(override.capability);
    staffCapabilities.set(staff.id, capabilities);
  }
  const can = (staffId: string, capability: string) =>
    staffCapabilities.get(staffId)?.has(capability) === true;
  const plan: FixtureRow[] = [];
  function add<K extends Model>(
    model: K,
    key: string,
    data: Prisma.Args<Prisma.TransactionClient[K], 'create'>['data']
  ) {
    plan.push({ model, data: { ...data, organizationId, id: id(key) } as FixtureRow['data'] });
    return id(key);
  }
  const stamp = at(-3, 8 * 60);
  const mutable = { createdAt: stamp, updatedAt: stamp };
  const notification = (
    key: string,
    entityType: string,
    entityId: string,
    title: string,
    createdAt: Date,
    read = false
  ) =>
    add('restaurantNotification', `notification.${key}`, {
      recipientStaffProfileId: owner.id,
      branchId,
      category: 'SOP',
      title: `[DEMO] ${title}`,
      body: DEMO,
      entityType,
      entityId,
      isRead: read,
      readAt: read ? new Date(createdAt.getTime() + 60_000) : null,
      createdAt,
      updatedAt: read ? new Date(createdAt.getTime() + 60_000) : createdAt,
    });

  if (!can(owner.id, 'staff:manage')) gap('workforce: owner lacks effective branch staff:manage');
  else {
    const candidates: Array<{ key: string; offset: number; staffId: string; completed?: boolean }> =
      [
        { key: 'history', offset: -2, staffId: owner.id, completed: true },
        { key: 'schedule', offset: 0, staffId: owner.id },
      ];
    const employees = [];
    for (const staff of synthetic) {
      if (
        staff.userId &&
        (await tx.user.findFirst({
          where: { id: staff.userId, organizationId, status: 'ACTIVE' },
          select: { id: true },
        }))
      )
        employees.push(staff);
    }
    const employee = employees[0];
    const replacement = synthetic.find((staff) => staff.id !== employee?.id);
    if (employee && replacement) {
      candidates.push({ key: 'swap-pending', offset: 1, staffId: employee.id });
      candidates.push({ key: 'swap-rejected', offset: 2, staffId: employee.id });
    } else
      gap(
        'workforce swaps: need active demo employee with tenant login plus distinct active demo replacement; owner reviews'
      );
    for (const scenario of candidates) {
      const startAt = at(scenario.offset, 10 * 60);
      const endAt = at(scenario.offset, 18 * 60);
      const shiftId = id(`shift.${scenario.key}`);
      const clash = await tx.restaurantShift.findFirst({
        where: {
          organizationId,
          staffProfileId: scenario.staffId,
          status: 'SCHEDULED',
          id: { not: shiftId },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { id: true },
      });
      if (clash) {
        gap(`workforce ${scenario.key}: overlapping roster for selected staff`);
        continue;
      }
      add('restaurantShift', `shift.${scenario.key}`, {
        branchId,
        staffProfileId: scenario.staffId,
        startAt,
        endAt,
        businessDate: businessDateToUtcDate(
          resolveBusinessDate(startAt, timezone, branch.businessDayCutoff)
        ),
        role: 'DEMO training',
        notes: DEMO,
        status: 'SCHEDULED',
        version: 1,
        cancelledAt: null,
        cancelReason: null,
        clockedInAt: scenario.completed ? startAt : null,
        clockedOutAt: scenario.completed ? endAt : null,
        ...mutable,
        updatedAt: scenario.completed ? endAt : stamp,
      });
      add('restaurantShiftEvent', `shift.${scenario.key}.published`, {
        shiftId,
        kind: 'PUBLISHED',
        actorUserId: ownerUserId,
        fromStaffProfileId: null,
        toStaffProfileId: scenario.staffId,
        reason: DEMO,
        occurredAt: stamp,
      });
      if (scenario.completed) {
        const startedAt = at(scenario.offset, 14 * 60);
        const endedAt = at(scenario.offset, 14 * 60 + 30);
        const breakId = add('restaurantShiftBreak', `shift.${scenario.key}.break`, {
          shiftId,
          startedAt,
          endedAt,
          createdAt: startedAt,
          updatedAt: endedAt,
        });
        for (const [kind, createdAt] of [
          ['CLOCK_IN', startAt],
          ['BREAK_START', startedAt],
          ['BREAK_END', endedAt],
          ['CLOCK_OUT', endAt],
        ] as const)
          add('restaurantWorkforceCommand', `shift.${scenario.key}.${kind}`, {
            shiftId,
            kind,
            idempotencyKey: id(`shift.${scenario.key}.${kind}`),
            createdAt,
            breakId: kind.startsWith('BREAK') ? breakId : null,
            swapRequestId: null,
          });
      }
      if (scenario.key.startsWith('swap-') && employee && replacement) {
        const requestedAt = at(-1, 10 * 60);
        const requestId = add('restaurantShiftSwapRequest', `shift.${scenario.key}.request`, {
          shiftId,
          requestedByStaffProfileId: employee.id,
          replacementStaffProfileId: replacement.id,
          note: DEMO,
          createdAt: requestedAt,
        });
        const rejected = scenario.key === 'swap-rejected';
        for (const review of rejected ? [false, true] : [false]) {
          const occurredAt = review ? at(-1, 11 * 60) : requestedAt;
          const kind = review ? 'SWAP_REJECT' : 'SWAP_REQUEST';
          add('restaurantWorkforceCommand', `shift.${scenario.key}.${kind}`, {
            shiftId,
            swapRequestId: requestId,
            breakId: null,
            kind,
            idempotencyKey: id(`shift.${scenario.key}.${kind}`),
            createdAt: occurredAt,
          });
          add('restaurantShiftEvent', `shift.${scenario.key}.${kind}.event`, {
            shiftId,
            kind: review ? 'SWAP_REJECTED' : 'SWAP_REQUESTED',
            actorUserId: review ? ownerUserId : employee.userId!,
            fromStaffProfileId: employee.id,
            toStaffProfileId: replacement.id,
            reason: DEMO,
            occurredAt,
          });
        }
        if (rejected)
          add('restaurantShiftSwapDecision', `shift.${scenario.key}.decision`, {
            requestId,
            decision: 'REJECTED',
            decidedByUserId: ownerUserId,
            decidedByStaffProfileId: owner.id,
            reason: DEMO,
            decidedAt: at(-1, 11 * 60),
          });
      }
    }
  }

  if (!can(owner.id, 'sop:manage') || !can(owner.id, 'sop:complete')) {
    gap('SOP: owner requires effective branch sop:manage and sop:complete');
  } else {
    const templateId = add('restaurantSopTemplate', 'sop.template', {
      name: '[DEMO] Handover note practice',
      description: DEMO,
      category: 'DEMO_OPERATIONS',
      isActive: true,
      ...mutable,
    });
    const templateVersionId = add('restaurantSopTemplateVersion', 'sop.version', {
      templateId,
      versionNumber: 1,
      status: 'PUBLISHED',
      publishedAt: stamp,
      retiredAt: null,
      ...mutable,
    });
    const templateStepId = add('restaurantSopTemplateStep', 'sop.step', {
      templateVersionId,
      stepOrder: 0,
      title: '[DEMO] Write a sample handover note',
      instructions: DEMO,
      requiresPhoto: false,
      requiresSignature: false,
      requiresNote: true,
      ...mutable,
    });
    const completer = synthetic.find((staff) => can(staff.id, 'sop:complete'));
    const reviewable = completer && can(owner.id, 'sop:verify');
    const scenarios = [
      { key: 'scheduled', status: 'SCHEDULED', offset: 0, minutes: 16 * 60, staffId: owner.id },
      { key: 'started', status: 'IN_PROGRESS', offset: 0, minutes: 14 * 60, staffId: owner.id },
      {
        key: 'submitted',
        status: 'SUBMITTED',
        offset: -1,
        minutes: 12 * 60,
        staffId: completer?.id ?? owner.id,
      },
      ...(reviewable
        ? [
            {
              key: 'rejected',
              status: 'REJECTED',
              offset: -2,
              minutes: 12 * 60,
              staffId: completer.id,
            },
          ]
        : []),
    ] as const;
    if (!reviewable)
      gap(
        'SOP reviewed: need distinct active branch demo completer with sop:complete and owner with sop:verify'
      );
    for (const scenario of scenarios) {
      const businessDate = businessDateToUtcDate(day(scenario.offset));
      const dueAt = at(scenario.offset, scenario.minutes);
      const startedAt = scenario.status === 'SCHEDULED' ? null : new Date(dueAt.getTime() + 60_000);
      const completed = scenario.status === 'SUBMITTED' || scenario.status === 'REJECTED';
      const completedAt = completed ? new Date(dueAt.getTime() + 5 * 60_000) : null;
      const submittedAt = completed ? new Date(dueAt.getTime() + 10 * 60_000) : null;
      const reviewedAt =
        scenario.status === 'REJECTED' ? new Date(submittedAt!.getTime() + 5 * 60_000) : null;
      const assignmentId = add('restaurantSopAssignment', `sop.${scenario.key}.assignment`, {
        branchId,
        templateId,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: businessDate,
        endDate: businessDate,
        dueTimeMinutes: scenario.minutes,
        intervalEndTimeMinutes: null,
        windowMinutes: 60,
        graceMinutes: 0,
        active: true,
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: scenario.staffId,
        assigneeJobRoleId: null,
        supersedesAssignmentId: null,
        supersededAt: null,
        ...mutable,
      });
      const occurrenceId = add('restaurantSopOccurrence', `sop.${scenario.key}.occurrence`, {
        assignmentId,
        templateVersionId,
        branchId,
        businessDate,
        status: scenario.status as 'SCHEDULED' | 'IN_PROGRESS' | 'SUBMITTED' | 'REJECTED',
        dueAt,
        windowEndsAt: new Date(dueAt.getTime() + 60 * 60_000),
        startedAt,
        submittedAt,
        // rejectOccurrence leaves resolvedAt null; rejected work may be restarted.
        resolvedAt: null,
        assignedStaffProfileId: scenario.staffId,
        poolJobRoleId: null,
        claimedByStaffProfileId: null,
        claimedAt: null,
        ...mutable,
        updatedAt: reviewedAt ?? submittedAt ?? startedAt ?? stamp,
      });
      const note = `${DEMO} Sample handover: discuss tomorrow's training roster.`;
      const occurrenceStepId = add(
        'restaurantSopOccurrenceStep',
        `sop.${scenario.key}.completion`,
        {
          occurrenceId,
          templateStepId,
          completed,
          completedAt,
          completedByStaffProfileId: completed ? scenario.staffId : null,
          note: completed ? note : null,
          ...mutable,
          updatedAt: completedAt ?? stamp,
        }
      );
      if (completed)
        add('restaurantSopEvidence', `sop.${scenario.key}.evidence`, {
          occurrenceId,
          occurrenceStepId,
          contentHash: createHash('sha256').update(note).digest('hex'),
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(note),
          storageRef: null,
          uploaderStaffProfileId: scenario.staffId,
          capturedAt: completedAt!,
          createdAt: completedAt!,
        });
      if (scenario.status === 'REJECTED') {
        add('restaurantSopVerification', 'sop.rejected.review', {
          occurrenceId,
          action: 'REJECT',
          actorStaffProfileId: owner.id,
          coAuthorizationId: null,
          reason: `${DEMO} Sample note needs more detail.`,
          createdAt: reviewedAt!,
        });
        notification(
          scenario.key,
          'RestaurantSopOccurrence',
          occurrenceId,
          'Sample review recorded',
          reviewedAt!,
          true
        );
      } else if (scenario.status === 'SCHEDULED') {
        notification(
          scenario.key,
          'RestaurantSopOccurrence',
          occurrenceId,
          'Handover practice assigned',
          stamp
        );
      } else if (scenario.status === 'SUBMITTED' && reviewable) {
        notification(
          scenario.key,
          'RestaurantSopOccurrence',
          occurrenceId,
          'Sample handover awaits review',
          submittedAt!
        );
      }
    }
  }

  // A heterogeneous plan uses a narrow delegate port only after typed add().
  type Delegate = {
    findUnique(input: { where: { id: string } }): Promise<Record<string, unknown> | null>;
    create(input: { data: FixtureRow['data'] }): Promise<unknown>;
  };
  const delegate = (model: Model) => tx[model] as unknown as Delegate;
  const seenIds = new Set<string>();
  let existing = 0;
  for (const row of plan) {
    if (!row.data.id || seenIds.has(row.data.id))
      throw new Error('Operations fixture id namespace collision');
    seenIds.add(row.data.id);
    const current = await delegate(row.model).findUnique({ where: { id: row.data.id } });
    if (!current) continue;
    existing++;
    for (const [key, value] of Object.entries(row.data)) {
      if (!isDeepStrictEqual(current[key], value)) {
        throw new Error(
          `Operations fixture conflict: ${row.model}.${key}; existing data preserved`
        );
      }
    }
  }
  if (existing && existing !== plan.length) {
    throw new Error(
      'Operations fixture namespace is partial; refusing to recreate missing or edited history'
    );
  }
  for (const row of plan) {
    const count = (result.counts[row.model] ??= { inserted: 0, existing: 0 });
    if (existing) {
      count.existing++;
      result.existing++;
    } else {
      await delegate(row.model).create({ data: row.data });
      count.inserted++;
      result.inserted++;
    }
  }
  return result;
}
