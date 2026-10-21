import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  createJobRole: vi.fn(),
  seedPersonas: vi.fn(),
  grantJobRole: vi.fn(),
  setJobRoleCapabilities: vi.fn(),
  updateJobRole: vi.fn(),
  operatorHasCapability: vi.fn(),
  createShift: vi.fn(),
  createStaffProfile: vi.fn(),
  updateStaffProfile: vi.fn(),
  configureLoyaltyProgram: vi.fn(),
  createCustomer: vi.fn(),
  appendCustomerConsent: vi.fn(),
  enrollLoyaltyAccount: vi.fn(),
  adjustLoyaltyPoints: vi.fn(),
  createPromotion: vi.fn(),
  createTemplate: vi.fn(),
  addStep: vi.fn(),
  publishVersion: vi.fn(),
  createAssignment: vi.fn(),
  generateOccurrences: vi.fn(),
  occurrenceId: vi.fn(),
  startOccurrence: vi.fn(),
  completeStep: vi.fn(),
  attachEvidence: vi.fn(),
  submitOccurrence: vi.fn(),
  verifyOccurrence: vi.fn(),
  deliverNotification: vi.fn(),
  notificationRequestId: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/job-roles', () => ({
  ensureDefaultJobRoles: vi.fn(),
  createJobRole: mocks.createJobRole,
  grantJobRole: mocks.grantJobRole,
  setJobRoleCapabilities: mocks.setJobRoleCapabilities,
  updateJobRole: mocks.updateJobRole,
}));
vi.mock('./seed-personas', () => ({ seedDemoPersonas: mocks.seedPersonas }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));
vi.mock('@/lib/restaurant/shifts', () => ({ createShift: mocks.createShift }));
vi.mock('@/lib/restaurant/staff', () => ({
  createStaffProfile: mocks.createStaffProfile,
  updateStaffProfile: mocks.updateStaffProfile,
}));
vi.mock('@/lib/restaurant/customers', () => ({
  createCustomer: mocks.createCustomer,
  appendCustomerConsent: mocks.appendCustomerConsent,
}));
vi.mock('@/lib/restaurant/loyalty', () => ({
  configureLoyaltyProgram: mocks.configureLoyaltyProgram,
  enrollLoyaltyAccount: mocks.enrollLoyaltyAccount,
  adjustLoyaltyPoints: mocks.adjustLoyaltyPoints,
}));
vi.mock('@/lib/restaurant/promotions', () => ({
  createPublishedOrderPercentagePromotion: mocks.createPromotion,
}));
vi.mock('@/lib/restaurant/sop-templates', () => ({
  createTemplate: mocks.createTemplate,
  addStep: mocks.addStep,
  publishVersion: mocks.publishVersion,
  createAssignment: mocks.createAssignment,
}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: mocks.generateOccurrences,
  occurrenceId: mocks.occurrenceId,
}));
vi.mock('@/lib/restaurant/sop-execution', () => ({
  startOccurrence: mocks.startOccurrence,
  completeStep: mocks.completeStep,
  attachEvidence: mocks.attachEvidence,
  submitOccurrence: mocks.submitOccurrence,
}));
vi.mock('@/lib/restaurant/sop-verification', () => ({
  verifyOccurrence: mocks.verifyOccurrence,
}));
vi.mock('@/lib/restaurant/notifications', () => ({
  deliverNotificationRequest: mocks.deliverNotification,
  notificationRequestId: mocks.notificationRequestId,
}));
vi.mock('@/lib/vertical-catalog', () => ({
  RESTAURANT_CAPABILITIES: ['coauth:approve', 'pos:operate', 'staff:manage'],
}));
vi.mock('./seed-bootstrap', () => ({
  DEMO_RESTAURANT_JOB_ROLE_KEY: 'demo-restaurant-operator',
}));

import { buildDemoRestaurantSeed } from './seed-data';
import type { DemoRestaurantCatalogIds } from './seed-catalog';
import { seedDemoRestaurantOperations } from './seed-operations';

const seed = buildDemoRestaurantSeed(new Date('2026-09-04T22:05:00.000Z'), 5);
const catalog = {
  branch: Object.fromEntries(seed.branches.map((branch) => [branch.id, `db_${branch.id}`])),
  floor: {},
  table: {},
  station: {},
  product: {},
  variant: {},
  menuItem: {},
  modifierGroup: {},
  modifierOption: {},
  unit: {},
  ingredient: {},
  recipe: {},
  stockLocation: {},
  stockItem: {},
} satisfies DemoRestaurantCatalogIds;

const database = {
  restaurantStaffProfile: { findFirst: vi.fn() },
  restaurantJobRole: { findUnique: vi.fn(), findMany: vi.fn() },
} as unknown as ScopedDb;
const context = {
  db: database,
  entitlements: {
    organizationId: seed.identity.organizationId,
    limits: {
      'loyalty.activeCustomers.max': 25_000,
      'sop.templates.max': 100,
    },
  },
} as unknown as TRPCContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seedPersonas.mockResolvedValue({
    cashier: 'cashier_staff',
    waiter: 'waiter_staff',
    kitchen: 'kitchen_staff',
  });
  vi.mocked(database.restaurantJobRole.findMany).mockResolvedValue(
    ['manager', 'shift-supervisor', 'cashier', 'server', 'kitchen'].map((key) => ({
      id: `role_${key}`,
      key,
    })) as never
  );
  const findStaff = database.restaurantStaffProfile.findFirst as ReturnType<typeof vi.fn>;
  findStaff
    .mockResolvedValueOnce({ id: 'manager_staff', userId: seed.identity.managerUserId })
    .mockResolvedValueOnce({
      id: 'approver_staff',
      userId: 'user_demo_restaurant_seat_5_approver',
    });
  const findRole = database.restaurantJobRole.findUnique as ReturnType<typeof vi.fn>;
  findRole.mockResolvedValue({ id: 'role_demo', active: true });

  mocks.operatorHasCapability.mockResolvedValue(true);
  mocks.createJobRole.mockResolvedValue({ id: 'role_demo', active: true });
  mocks.grantJobRole.mockResolvedValue({ changed: true });
  mocks.setJobRoleCapabilities.mockResolvedValue({ added: [], removed: 0 });
  mocks.updateJobRole.mockResolvedValue({ id: 'role_demo', active: true });
  mocks.updateStaffProfile.mockResolvedValue({});
  let staffIndex = 0;
  mocks.createStaffProfile.mockImplementation(async () => ({ id: `staff_${++staffIndex}` }));
  mocks.createShift.mockResolvedValue({ id: 'shift' });

  mocks.configureLoyaltyProgram.mockResolvedValue({ id: 'program_1', versionNumber: 1 });
  let customerIndex = 0;
  mocks.createCustomer.mockImplementation(async () => ({ id: `customer_${++customerIndex}` }));
  mocks.appendCustomerConsent.mockResolvedValue({ id: 'consent' });
  mocks.enrollLoyaltyAccount.mockImplementation(async (_db, input) => ({
    id: `account_${input.customerId}`,
  }));
  mocks.adjustLoyaltyPoints.mockResolvedValue({ id: 'points' });
  mocks.createPromotion.mockResolvedValue({
    promotion: { id: 'promotion_1' },
    version: { id: 'promotion_version_1' },
  });

  let templateIndex = 0;
  mocks.createTemplate.mockImplementation(async () => {
    templateIndex += 1;
    return { id: `template_${templateIndex}`, versions: [{ id: `version_${templateIndex}` }] };
  });
  let stepIndex = 0;
  mocks.addStep.mockImplementation(async () => ({ id: `step_${++stepIndex}` }));
  mocks.publishVersion.mockResolvedValue({ id: 'version' });
  let assignmentIndex = 0;
  mocks.createAssignment.mockImplementation(async () => ({
    id: `assignment_${++assignmentIndex}`,
  }));
  mocks.occurrenceId.mockImplementation((assignmentId) => `occurrence_${assignmentId}`);
  mocks.generateOccurrences.mockResolvedValue({ assignmentsProcessed: 9, created: 9, skipped: 0 });
  mocks.startOccurrence.mockResolvedValue({ status: 'IN_PROGRESS' });
  let occurrenceStepIndex = 0;
  mocks.completeStep.mockImplementation(async () => ({
    occurrenceStepId: `occurrence_step_${++occurrenceStepIndex}`,
    completed: true,
  }));
  mocks.attachEvidence.mockResolvedValue({ created: true });
  mocks.submitOccurrence.mockResolvedValue({ status: 'SUBMITTED' });
  mocks.verifyOccurrence.mockResolvedValue({ action: 'VERIFY' });
  mocks.notificationRequestId.mockImplementation((...parts) => parts.join(':'));
  mocks.deliverNotification.mockResolvedValue({ notificationCount: 1, deliveryCount: 1 });
});

describe('seedDemoRestaurantOperations', () => {
  it('persists every domain and preserves canonical manager and approver identities', async () => {
    const ids = await seedDemoRestaurantOperations(database, seed, catalog, context);
    const firstBranch = seed.branches[0]!;
    const managerDescriptor = seed.workforce.staff.find(
      (staff) => staff.branchId === firstBranch.id && staff.role === 'BRANCH_MANAGER'
    )!;
    const approverDescriptor = seed.workforce.staff.find(
      (staff) => staff.branchId === firstBranch.id && staff.role === 'SHIFT_SUPERVISOR'
    )!;

    expect(ids.managerStaffProfileId).toBe('manager_staff');
    expect(ids.approverStaffProfileId).toBe('approver_staff');
    expect(ids.staff[managerDescriptor.id]).toBe('manager_staff');
    expect(ids.staff[approverDescriptor.id]).toBe('approver_staff');
    expect(Object.keys(ids.staff)).toHaveLength(seed.workforce.staff.length);
    expect(mocks.createStaffProfile).toHaveBeenCalledTimes(seed.workforce.staff.length - 5);
    expect(
      mocks.grantJobRole.mock.calls
        .filter(([, input]) => input.jobRoleId === 'role_demo')
        .every(([, input]) => input.staffProfileId === 'manager_staff')
    ).toBe(true);
    expect(
      mocks.grantJobRole.mock.calls.find(
        ([, input]) => input.staffProfileId === 'waiter_staff'
      )?.[1].jobRoleId
    ).toBe('role_server');
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      database,
      'approver_staff',
      'coauth:approve',
      new Date(seed.generatedAt),
      catalog.branch[seed.branches[0].id]
    );

    const expectedBranches = Object.values(catalog.branch).sort();
    for (const staffProfileId of ['manager_staff', 'approver_staff']) {
      expect(
        mocks.grantJobRole.mock.calls
          .filter(([, grant]) => grant.staffProfileId === staffProfileId)
          .map(([, grant]) => grant.branchId)
          .sort()
      ).toEqual(expectedBranches);
    }
    expect(mocks.createShift).toHaveBeenCalledTimes(seed.workforce.roster.length);

    expect(Object.keys(ids.customer)).toHaveLength(seed.loyalty.customers.length);
    expect(mocks.createCustomer).toHaveBeenCalledTimes(seed.loyalty.customers.length);
    expect(mocks.appendCustomerConsent).toHaveBeenCalledTimes(seed.loyalty.customers.length);
    expect(mocks.enrollLoyaltyAccount).toHaveBeenCalledTimes(seed.loyalty.customers.length);
    expect(mocks.adjustLoyaltyPoints).toHaveBeenCalledTimes(seed.loyalty.customers.length);
    expect(ids.promotion[seed.loyalty.promotions[0]!.id]).toBe('promotion_1');

    expect(mocks.createTemplate).toHaveBeenCalledTimes(seed.operations.sopTemplates.length);
    expect(mocks.createAssignment).toHaveBeenCalledTimes(seed.operations.sopOccurrences.length);
    expect(mocks.generateOccurrences).toHaveBeenCalledWith(database, {
      now: new Date(seed.generatedAt),
      lookbackDays: 7,
      horizonDays: 0,
    });
    expect(
      mocks.createAssignment.mock.calls.map(([, assignment]) => [
        assignment.startDate,
        assignment.endDate,
      ])
    ).toEqual(
      seed.operations.sopOccurrences.map((occurrence) => {
        const businessDate = occurrence.scheduledFor.slice(0, 10);
        return [businessDate, businessDate];
      })
    );
    expect(
      mocks.createAssignment.mock.calls.every(
        ([, assignment]) =>
          assignment.startDate >= '2026-08-28' && assignment.endDate <= '2026-09-04'
      )
    ).toBe(true);
    expect(mocks.startOccurrence.mock.calls.map(([, input]) => input.occurrenceId)).toEqual(
      mocks.occurrenceId.mock.results.map(({ value }) => value)
    );
    expect(mocks.generateOccurrences.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startOccurrence.mock.invocationCallOrder[0]!
    );
    expect(mocks.startOccurrence).toHaveBeenCalledTimes(seed.operations.sopOccurrences.length);
    expect(mocks.completeStep).toHaveBeenCalledTimes(
      seed.operations.sopOccurrences.reduce(
        (total, occurrence) =>
          total +
          seed.operations.sopTemplates.find(({ id }) => id === occurrence.templateId)!.steps.length,
        0
      )
    );
    expect(mocks.attachEvidence).toHaveBeenCalledTimes(seed.operations.sopEvidence.length);
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        mimeType: 'text/plain; evidence=note; synthetic=true',
        uploaderStaffProfileId: expect.any(String),
      })
    );
    expect(mocks.verifyOccurrence).toHaveBeenCalledTimes(seed.operations.sopOccurrences.length);
    expect(mocks.deliverNotification).toHaveBeenCalledTimes(seed.operations.notifications.length);
    for (const [, notification] of mocks.deliverNotification.mock.calls) {
      expect(notification.channels).toEqual(['IN_APP']);
    }
  });

  it('propagates a domain failure so the caller-owned transaction can roll back', async () => {
    const failure = new Error('overlapping shift');
    mocks.createShift.mockRejectedValueOnce(failure);

    try {
      await seedDemoRestaurantOperations(database, seed, catalog, context);
      throw new Error('Expected workforce seeding to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Failed to seed restaurant demo workforce.');
      expect((error as Error & { cause: unknown }).cause).toBe(failure);
    }
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.createPromotion).not.toHaveBeenCalled();
  });

  it('rejects a mismatched caller transaction before any service call', async () => {
    await expect(
      seedDemoRestaurantOperations(database, seed, catalog, {
        ...context,
        db: {} as ScopedDb,
      })
    ).rejects.toThrow('context.db to be the provided scoped transaction');
    expect(database.restaurantStaffProfile.findFirst).not.toHaveBeenCalled();
  });
});
