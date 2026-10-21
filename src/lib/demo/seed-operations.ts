import 'server-only';

import { appendCustomerConsent, createCustomer } from '@/lib/restaurant/customers';
import {
  createJobRole,
  ensureDefaultJobRoles,
  grantJobRole,
  setJobRoleCapabilities,
  updateJobRole,
} from '@/lib/restaurant/job-roles';
import {
  adjustLoyaltyPoints,
  configureLoyaltyProgram,
  enrollLoyaltyAccount,
} from '@/lib/restaurant/loyalty';
import { deliverNotificationRequest, notificationRequestId } from '@/lib/restaurant/notifications';
import { operatorHasCapability } from '@/lib/restaurant/checkout-routes';
import { createPublishedOrderPercentagePromotion } from '@/lib/restaurant/promotions';
import { createShift } from '@/lib/restaurant/shifts';
import {
  attachEvidence,
  completeStep,
  startOccurrence,
  submitOccurrence,
} from '@/lib/restaurant/sop-execution';
import {
  generateDueSopOccurrences,
  occurrenceId,
} from '@/lib/restaurant/sop-occurrence-generation';
import {
  addStep,
  createAssignment,
  createTemplate,
  publishVersion,
} from '@/lib/restaurant/sop-templates';
import { verifyOccurrence } from '@/lib/restaurant/sop-verification';
import { createStaffProfile, updateStaffProfile } from '@/lib/restaurant/staff';
import { resolveEntitlementLimit, SOP_TEMPLATES_LIMIT } from '@/lib/entitlement-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
import type { TRPCContext } from '@/server/trpc';

import { demoApproverEmail } from './approval';
import { DEMO_RESTAURANT_JOB_ROLE_KEY } from './seed-bootstrap';
import type { DemoRestaurantCatalogIds } from './seed-catalog';
import type { DemoRestaurantSeed } from './seed-data';
import { seedDemoPersonas } from './seed-personas';

export type DemoRestaurantOperationsIds = {
  staff: Record<string, string>;
  customer: Record<string, string>;
  promotion: Record<string, string>;
  managerStaffProfileId: string;
  approverStaffProfileId: string;
};

function requiredId(ids: Record<string, string>, descriptorId: string, kind: string): string {
  const id = ids[descriptorId];
  if (!id) throw new Error(`Missing persisted ${kind} for ${descriptorId}.`);
  return id;
}

function instant(value: string, kind: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${kind} timestamp: ${value}.`);
  return date;
}

async function seedWorkforce(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds
): Promise<
  Pick<DemoRestaurantOperationsIds, 'staff' | 'managerStaffProfileId' | 'approverStaffProfileId'>
> {
  const manager = await db.restaurantStaffProfile.findFirst({
    where: { userId: seed.identity.managerUserId, status: 'ACTIVE' },
    select: { id: true, userId: true },
  });
  const approver = await db.restaurantStaffProfile.findFirst({
    where: { email: demoApproverEmail(seed.identity.seatNumber), status: 'ACTIVE' },
    select: { id: true, userId: true },
  });
  const approverUserId = `user_demo_restaurant_seat_${seed.identity.seatNumber}_approver`;
  if (!manager?.userId) throw new Error('Active linked demo restaurant manager staff not found.');
  if (approver?.userId !== approverUserId) {
    throw new Error('Active linked canonical demo restaurant approver staff not found.');
  }
  if (manager.id === approver.id || manager.userId === approver.userId) {
    throw new Error('Demo restaurant manager and approver must be distinct linked users.');
  }
  const firstBranch = seed.branches[0];
  if (!firstBranch) throw new Error('Restaurant demo seed requires at least one branch.');
  const primaryBranchId = requiredId(catalog.branch, firstBranch.id, 'branch');
  await updateStaffProfile(db, manager.id, { primaryBranchId });
  await updateStaffProfile(db, approver.id, { primaryBranchId });
  if (
    !(await operatorHasCapability(
      db,
      approver.id,
      'coauth:approve',
      instant(seed.generatedAt, 'seed'),
      primaryBranchId
    ))
  ) {
    throw new Error('Demo restaurant approver organization role must grant coauth:approve.');
  }

  const existingRole = await db.restaurantJobRole.findUnique({
    where: {
      organizationId_key: {
        organizationId: seed.identity.organizationId,
        key: DEMO_RESTAURANT_JOB_ROLE_KEY,
      },
    },
    select: { id: true, active: true },
  });
  const role =
    existingRole ??
    (await createJobRole(db, {
      key: DEMO_RESTAURANT_JOB_ROLE_KEY,
      name: 'Demo Restaurant Operator',
      description: 'All restaurant capabilities for bounded demo operations.',
      isSystem: true,
      capabilities: RESTAURANT_CAPABILITIES,
    }));
  if (!role.active) await updateJobRole(db, role.id, { active: true });
  await setJobRoleCapabilities(db, role.id, RESTAURANT_CAPABILITIES);

  const managerDescriptor = seed.workforce.staff.find(
    (staff) => staff.branchId === firstBranch.id && staff.role === 'BRANCH_MANAGER'
  );
  const approverDescriptor = seed.workforce.staff.find(
    (staff) => staff.branchId === firstBranch.id && staff.role === 'SHIFT_SUPERVISOR'
  );
  if (!managerDescriptor || !approverDescriptor) {
    throw new Error('Restaurant demo seed requires manager and approver staff descriptors.');
  }

  const staff: Record<string, string> = {
    [managerDescriptor.id]: manager.id,
    [approverDescriptor.id]: approver.id,
  };
  const personas = await seedDemoPersonas(db, seed, catalog, manager.id);
  for (const [persona, descriptorRole] of [
    ['cashier', 'CASHIER'],
    ['waiter', 'SERVER'],
    ['kitchen', 'COOK'],
  ] as const) {
    const descriptor = seed.workforce.staff.find(
      (item) => item.branchId === firstBranch.id && item.role === descriptorRole
    );
    if (!descriptor || !personas[persona]) throw new Error(`Missing demo ${persona} staff.`);
    staff[descriptor.id] = personas[persona]!;
  }
  for (const descriptor of seed.workforce.staff) {
    if (staff[descriptor.id]) continue;
    const created = await createStaffProfile(db, {
      displayName: descriptor.name,
      email: descriptor.email,
      primaryBranchId: requiredId(catalog.branch, descriptor.branchId, 'branch'),
      status: 'ACTIVE',
    });
    staff[descriptor.id] = created.id;
  }

  await ensureDefaultJobRoles(db);
  const roles = await db.restaurantJobRole.findMany({ select: { id: true, key: true } });
  const roleByKey = new Map(roles.map((item) => [item.key, item.id]));
  const descriptorRoles = {
    BRANCH_MANAGER: 'manager',
    SHIFT_SUPERVISOR: 'shift-supervisor',
    CASHIER: 'cashier',
    SERVER: 'server',
    COOK: 'kitchen',
  } as const;
  const grants = new Map<string, { staffProfileId: string; branchId: string; jobRoleId: string }>();
  for (const descriptor of seed.workforce.staff) {
    const grant = {
      staffProfileId: requiredId(staff, descriptor.id, 'staff profile'),
      branchId: requiredId(catalog.branch, descriptor.branchId, 'branch'),
      jobRoleId: requiredId(
        Object.fromEntries(roleByKey),
        descriptorRoles[descriptor.role],
        'job role'
      ),
    };
    grants.set(`${grant.staffProfileId}:${grant.branchId}`, grant);
  }
  for (const branch of seed.branches) {
    const branchId = requiredId(catalog.branch, branch.id, 'branch');
    for (const staffProfileId of [manager.id, approver.id]) {
      const jobRoleId =
        staffProfileId === manager.id ? role.id : roleByKey.get('shift-supervisor')!;
      grants.set(`${staffProfileId}:${branchId}`, { staffProfileId, branchId, jobRoleId });
    }
  }
  for (const grant of grants.values()) {
    await grantJobRole(db, {
      ...grant,
      actorStaffProfileId: manager.id,
    });
  }

  for (const shift of seed.workforce.roster) {
    await createShift(db, {
      branchId: requiredId(catalog.branch, shift.branchId, 'branch'),
      staffProfileId: requiredId(staff, shift.staffId, 'staff profile'),
      startAt: instant(shift.startsAt, 'shift start'),
      endAt: instant(shift.endsAt, 'shift end'),
      role: shift.role,
      notes: 'Synthetic restaurant demo roster.',
    });
  }

  return {
    staff,
    managerStaffProfileId: manager.id,
    approverStaffProfileId: approver.id,
  };
}

function activeLoyaltyCustomerLimit(context: TRPCContext): number {
  const limits = context.entitlements.limits as Record<string, number>;
  const value =
    limits['loyalty.activeCustomers.max'] ?? limits['restaurant-core.loyalty.activeCustomers.max'];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('The loyalty active-customer entitlement limit is not configured correctly.');
  }
  return value;
}

async function seedCustomersAndPromotion(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  context: TRPCContext,
  managerStaffProfileId: string
): Promise<Pick<DemoRestaurantOperationsIds, 'customer' | 'promotion'>> {
  const earliestJoinedAt = seed.loyalty.customers.reduce<Date | null>((earliest, customer) => {
    const joinedAt = instant(customer.joinedAt, 'customer enrollment');
    return !earliest || joinedAt < earliest ? joinedAt : earliest;
  }, null);
  if (!earliestJoinedAt) throw new Error('Restaurant demo seed requires loyalty customers.');

  await configureLoyaltyProgram(db, {
    effectiveFrom: earliestJoinedAt,
    earnRate: '0.1',
    redemptionValue: '1',
    expiryDays: 365,
  });
  const activeCustomersMax = activeLoyaltyCustomerLimit(context);
  const customer: Record<string, string> = {};
  for (const descriptor of seed.loyalty.customers) {
    const joinedAt = instant(descriptor.joinedAt, 'customer enrollment');
    const created = await createCustomer(db, {
      displayName: descriptor.name,
      notes: 'Synthetic restaurant demo customer.',
      identifiers: [
        { kind: 'EMAIL', value: descriptor.email, verifiedAt: joinedAt },
        { kind: 'PHONE', value: descriptor.phone, verifiedAt: joinedAt },
      ],
    });
    customer[descriptor.id] = created.id;
    await appendCustomerConsent(db, {
      customerId: created.id,
      channel: 'EMAIL',
      granted: descriptor.marketingConsent,
      source: 'RESTAURANT_DEMO_SEED',
      actorId: seed.identity.managerUserId,
      policyVersion: 'demo-v1',
      occurredAt: joinedAt,
      idempotencyKey: `demo:${seed.identity.seatNumber}:consent:${descriptor.id}`,
    });
    const account = await enrollLoyaltyAccount(db, {
      customerId: created.id,
      activeCustomersMax,
      at: joinedAt,
    });
    await adjustLoyaltyPoints(db, {
      accountId: account.id,
      points: descriptor.points,
      actorId: seed.identity.managerUserId,
      reason: 'Synthetic opening loyalty balance.',
      idempotencyKey: `demo:${seed.identity.seatNumber}:opening-balance:${descriptor.id}`,
      at: joinedAt,
    });
  }

  const promotion: Record<string, string> = {};
  for (const descriptor of seed.loyalty.promotions) {
    const effectiveFrom = instant(descriptor.startsAt, 'promotion start');
    const published = await createPublishedOrderPercentagePromotion(db, {
      organizationId: seed.identity.organizationId,
      code: descriptor.code,
      name: descriptor.name,
      effectiveFrom,
      effectiveTo: instant(descriptor.endsAt, 'promotion end'),
      publishedAt: effectiveFrom,
      timezone: seed.timeZone,
      allowedBranchIds: descriptor.branchIds.map((branchId) =>
        requiredId(catalog.branch, branchId, 'branch')
      ),
      minimumSpend: descriptor.minimumSpendPkr,
      percentageOff: descriptor.percentageOff,
      currency: seed.currency,
      actorUserId: seed.identity.managerUserId,
      actorStaffProfileId: managerStaffProfileId,
    });
    promotion[descriptor.id] = published.promotion.id;
  }
  return { customer, promotion };
}

function localTimeMinutes(value: string): number {
  const match = /T(\d{2}):(\d{2})/.exec(value);
  if (!match) throw new Error(`Invalid branch-local timestamp: ${value}.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

async function seedSopsAndNotifications(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  staff: Record<string, string>,
  managerStaffProfileId: string,
  context: TRPCContext
): Promise<void> {
  const templateLimit = resolveEntitlementLimit(
    context.entitlements.limits as Record<string, number>,
    SOP_TEMPLATES_LIMIT
  );
  if (templateLimit.status === 'missing') {
    throw new Error('The SOP template entitlement limit is not configured correctly.');
  }

  const templateIds: Record<string, string> = {};
  const stepIds: Record<string, string> = {};
  const occurrenceIds: Record<string, string> = {};
  for (const descriptor of seed.operations.sopTemplates) {
    const template = await createTemplate(
      db,
      {
        name: descriptor.name,
        description: 'Synthetic restaurant demo operating procedure.',
        category: descriptor.key,
      },
      templateLimit.value
    );
    templateIds[descriptor.id] = template.id;
    const versionId = template.versions[0]?.id;
    if (!versionId)
      throw new Error(`SOP template ${descriptor.id} did not create a draft version.`);
    for (const step of descriptor.steps) {
      const created = await addStep(db, {
        templateVersionId: versionId,
        title: step.instruction,
        requiresNote: step.evidenceRequired,
      });
      stepIds[step.id] = created.id;
    }
    const templateOccurrences = seed.operations.sopOccurrences.filter(
      (occurrence) => occurrence.templateId === descriptor.id
    );
    const publishedAt = templateOccurrences.reduce<Date>(
      (earliest, occurrence) => {
        const dueAt = instant(occurrence.scheduledFor, 'SOP schedule');
        return dueAt < earliest ? dueAt : earliest;
      },
      instant(seed.generatedAt, 'seed')
    );
    await publishVersion(db, versionId, new Date(publishedAt.getTime() - 60_000));

    for (const occurrence of templateOccurrences) {
      const businessDate = occurrence.scheduledFor.slice(0, 10);
      const dueAt = instant(occurrence.scheduledFor, 'SOP schedule');
      const assignment = await createAssignment(db, {
        branchId: requiredId(catalog.branch, occurrence.branchId, 'branch'),
        templateId: template.id,
        graceMinutes: 30,
        assigneeTarget: {
          type: 'person',
          staffProfileId: requiredId(staff, occurrence.assignedStaffId, 'staff profile'),
        },
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: businessDate,
        endDate: businessDate,
        dueTimeMinutes: localTimeMinutes(occurrence.scheduledFor),
        windowMinutes: 120,
      });
      occurrenceIds[occurrence.id] = occurrenceId(assignment.id, dueAt);
    }
  }

  await generateDueSopOccurrences(db, {
    now: instant(seed.generatedAt, 'seed'),
    lookbackDays: 7,
    horizonDays: 0,
  });
  for (const occurrence of seed.operations.sopOccurrences) {
    const persistedOccurrenceId = requiredId(occurrenceIds, occurrence.id, 'SOP occurrence');
    const actorStaffProfileId = requiredId(staff, occurrence.assignedStaffId, 'staff profile');
    await startOccurrence(db, {
      occurrenceId: persistedOccurrenceId,
      actorStaffProfileId,
      now: instant(occurrence.scheduledFor, 'SOP schedule'),
    });
    const template = seed.operations.sopTemplates.find(({ id }) => id === occurrence.templateId);
    if (!template) throw new Error(`Missing SOP template descriptor ${occurrence.templateId}.`);
    const scheduledAt = instant(occurrence.scheduledFor, 'SOP schedule');
    for (const [stepIndex, step] of template.steps.entries()) {
      const evidence = seed.operations.sopEvidence.find(
        (item) => item.occurrenceId === occurrence.id && item.stepId === step.id
      );
      const completedStep = await completeStep(db, {
        occurrenceId: persistedOccurrenceId,
        templateStepId: requiredId(stepIds, step.id, 'SOP step'),
        note: evidence?.value,
        actorStaffProfileId,
        now: evidence
          ? instant(evidence.capturedAt, 'SOP evidence')
          : new Date(scheduledAt.getTime() + (10 + stepIndex * 5) * 60_000),
      });
      if (evidence) {
        const contentBytes = Buffer.from(evidence.value, 'utf8');
        await attachEvidence(db, {
          occurrenceId: persistedOccurrenceId,
          occurrenceStepId: completedStep.occurrenceStepId,
          contentBytes,
          mimeType: 'text/plain; evidence=note; synthetic=true',
          sizeBytes: contentBytes.byteLength,
          uploaderStaffProfileId: actorStaffProfileId,
          now: instant(evidence.capturedAt, 'SOP evidence'),
        });
      }
    }
    const completedAt = instant(occurrence.completedAt, 'SOP completion');
    await submitOccurrence(db, {
      occurrenceId: persistedOccurrenceId,
      actorStaffProfileId,
      now: completedAt,
    });
    await verifyOccurrence(db, {
      occurrenceId: persistedOccurrenceId,
      actorStaffProfileId: managerStaffProfileId,
      reason: 'Synthetic demo SOP verification.',
      now: completedAt,
    });
  }

  for (const descriptor of seed.operations.notifications) {
    await deliverNotificationRequest(db, {
      requestId: notificationRequestId(
        'restaurant-demo',
        String(seed.identity.seatNumber),
        descriptor.id
      ),
      recipientStaffProfileIds: [
        requiredId(staff, descriptor.recipientStaffId, 'notification recipient'),
      ],
      branchId: requiredId(catalog.branch, descriptor.branchId, 'branch'),
      category: descriptor.type,
      title: descriptor.title,
      body: descriptor.body,
      entityType: descriptor.type,
      entityId: occurrenceIds[descriptor.subjectId] ?? descriptor.subjectId,
      channels: ['IN_APP'],
    });
  }
}

async function domain<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`Failed to seed restaurant demo ${name}.`, { cause });
  }
}

export async function seedDemoRestaurantOperations(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  context: TRPCContext
): Promise<DemoRestaurantOperationsIds> {
  if (context.db !== db) {
    throw new Error(
      'Operations seeding requires context.db to be the provided scoped transaction.'
    );
  }
  if (context.entitlements.organizationId !== seed.identity.organizationId) {
    throw new Error('Operations seeding requires the matching demo organization context.');
  }

  const workforce = await domain('workforce', () => seedWorkforce(db, seed, catalog));
  const commercial = await domain('customer, loyalty, and promotion data', () =>
    seedCustomersAndPromotion(db, seed, catalog, context, workforce.managerStaffProfileId)
  );
  await domain('SOP and notification data', () =>
    seedSopsAndNotifications(
      db,
      seed,
      catalog,
      workforce.staff,
      workforce.managerStaffProfileId,
      context
    )
  );
  return { ...workforce, ...commercial };
}
