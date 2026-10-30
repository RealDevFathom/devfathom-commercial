import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import {
  HOTEL_JOURNEY_MOMENTS,
  validateJourneyTemplate,
  type HotelJourneyTemplateSeed,
} from '@/lib/hotel/journey-templates';
import { DEFAULT_HOTEL_MEAL_PLANS } from '@/lib/hotel/meal-plans';
import { HOSPITALITY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { PlatformCommandForm } from '@/components/platform/platform-command-form';

const mocks = vi.hoisted(() => ({
  form: vi.fn(),
  read: vi.fn(),
  roleCreate: vi.fn(),
  packageFindMany: vi.fn(),
  propertyCreate: vi.fn(),
  assignmentCreate: vi.fn(),
  mealPlanCreateMany: vi.fn(),
  journeyCreateMany: vi.fn(),
  orgCreate: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'synthetic-hash'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/platform/page-access', () => ({ requirePlatformRead: mocks.read }));
vi.mock('@/lib/platform/provisioning-config', () => ({
  isDedicatedProvisioningConfigured: () => false,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(db)),
}));
vi.mock('@/components/platform/platform-command-form', () => ({
  PlatformCommandForm: (props: ComponentProps<typeof PlatformCommandForm>) => {
    mocks.form(props);
    return <div>Form</div>;
  },
}));

const record = () => vi.fn(async () => ({ id: 'synthetic' }));
const db = {
  platformPackage: {
    findUnique: vi.fn(async () => ({
      id: 'package_1',
      active: true,
      vertical: 'HOSPITALITY',
      defaultSeats: 10,
      moduleLinks: [],
    })),
    findMany: mocks.packageFindMany,
  },
  organization: { create: mocks.orgCreate, findUnique: vi.fn(), update: record() },
  organizationRole: { create: mocks.roleCreate, count: vi.fn() },
  organizationDepartment: { createMany: record() },
  user: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'named_admin' })) },
  hotelProperty: { create: mocks.propertyCreate, findFirst: vi.fn() },
  hotelPropertyAssignment: { create: mocks.assignmentCreate },
  hotelMealPlan: { createMany: mocks.mealPlanCreateMany },
  hotelJourneyTemplate: { createMany: mocks.journeyCreateMany },
  hotelRoomType: { count: vi.fn(async () => 0) },
  hotelFunctionSpace: { count: vi.fn(async () => 0) },
  organizationBrand: { create: record() },
  organizationEmailSettings: { create: record() },
  organizationDeployment: { create: record() },
  platformJob: { create: record() },
  organizationLifecycleEvent: { create: record() },
  platformAuditLog: { create: record() },
};
import { executePlatformCommand } from './commands';
import NewOrganizationPage from '@/app/platform/(console)/organizations/new/page';
const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://synthetic.invalid/api/platform/control', { method: 'POST' });
const payload = {
  vertical: 'HOSPITALITY',
  slug: 'example-hotel',
  legalName: 'Example Hotel',
  displayName: 'Example',
  deploymentMode: 'SHARED',
  packageId: 'package_1',
  timezone: 'Asia/Karachi',
  locale: 'en',
  currency: 'PKR',
  seatLimit: 10,
  primaryContactName: 'Operator',
  primaryContactEmail: 'operator@example.invalid',
  adminName: 'Named Admin',
  adminEmail: 'admin@example.invalid',
  adminPassword: 'Synthetic-password-123',
  firstBranchName: 'Example Property',
  firstBranchAddress: 'Synthetic street',
  firstBranchCity: 'Lahore',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.orgCreate.mockResolvedValue({ id: 'org_new', slug: 'example-hotel' });
  mocks.roleCreate.mockImplementation(async ({ data }: { data: { key: string } }) => ({
    id: 'role_' + data.key,
  }));
  mocks.propertyCreate.mockResolvedValue({ branchId: 'created_property' });
  mocks.assignmentCreate.mockResolvedValue({ id: 'assignment_1' });
  mocks.mealPlanCreateMany.mockResolvedValue({ count: DEFAULT_HOTEL_MEAL_PLANS.length });
  mocks.journeyCreateMany.mockResolvedValue({ count: 20 });
  mocks.packageFindMany.mockResolvedValue([
    { id: 'package_1', name: 'Hotel Essentials', defaultSeats: 10 },
  ]);
});

describe('Hospitality provisioning foundation', () => {
  it('rejects activation at the command boundary despite complete other evidence and a stored readiness claim', async () => {
    db.organization.findUnique.mockResolvedValue({
      id: 'org_new',
      status: 'ONBOARDING',
      vertical: 'HOSPITALITY',
      packageId: 'package_1',
      package: { moduleLinks: [{ enabled: true }] },
      modules: [],
      users: [{ id: 'named_admin' }],
      deployments: [{ status: 'READY' }],
      onboardingReady: true,
    });
    db.organizationRole.count.mockResolvedValue(15);
    db.hotelProperty.findFirst.mockResolvedValue({
      mode: 'HOTEL',
      name: 'Example Property',
      addressLine: 'Synthetic street',
      city: 'Lahore',
      timezone: 'Asia/Karachi',
      checkInTime: '14:00',
      checkOutTime: '12:00',
      auditTime: '03:00',
      taxProfileId: 'tax_1',
      businessDatePolicy: { rollover: 'audit' },
    });
    await expect(
      executePlatformCommand(
        actor,
        'organization.transition',
        { id: 'org_new', status: 'ACTIVE', reason: 'Synthetic activation check' },
        request
      )
    ).rejects.toThrow('ROOM_TYPES');
    expect(db.hotelProperty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_new', active: true } })
    );
    expect(db.organization.update).not.toHaveBeenCalled();
    expect(db.organizationLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('activates once the property holds one active room type, counted under that property', async () => {
    db.organization.findUnique.mockResolvedValue({
      id: 'org_new',
      status: 'ONBOARDING',
      vertical: 'HOSPITALITY',
      packageId: 'package_1',
      package: { moduleLinks: [{ enabled: true }] },
      modules: [],
      users: [{ id: 'named_admin' }],
      deployments: [{ status: 'READY' }],
      activatedAt: null,
    });
    db.organizationRole.count.mockResolvedValue(15);
    db.hotelProperty.findFirst.mockResolvedValue({
      branchId: 'created_property',
      mode: 'HOTEL',
      name: 'Example Property',
      addressLine: 'Synthetic street',
      city: 'Lahore',
      timezone: 'Asia/Karachi',
      checkInTime: '14:00',
      checkOutTime: '12:00',
      auditTime: '03:00',
      taxProfileId: 'tax_1',
      businessDatePolicy: { rollover: 'audit' },
    });
    db.hotelRoomType.count.mockResolvedValue(1);
    await executePlatformCommand(
      actor,
      'organization.transition',
      { id: 'org_new', status: 'ACTIVE', reason: 'Synthetic activation check' },
      request
    );
    expect(db.hotelRoomType.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_new', branchId: 'created_property', active: true },
    });
    expect(db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org_new' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      })
    );
    expect(db.organizationLifecycleEvent.create).toHaveBeenCalledTimes(1);
  });

  describe('a venue, whose configuration sells no room inventory', () => {
    const venueOrganization = {
      id: 'org_new',
      status: 'ONBOARDING',
      vertical: 'HOSPITALITY',
      packageId: 'package_1',
      package: { moduleLinks: [{ enabled: true }] },
      modules: [],
      users: [{ id: 'named_admin' }],
      deployments: [{ status: 'READY' }],
      activatedAt: null,
    };
    const venueProperty = {
      branchId: 'created_property',
      mode: 'VENUE',
      modeOverrides: null,
      name: 'Example Venue',
      addressLine: 'Synthetic street',
      city: 'Lahore',
      timezone: 'Asia/Karachi',
      checkInTime: '14:00',
      checkOutTime: '12:00',
      auditTime: '03:00',
      taxProfileId: 'tax_1',
      businessDatePolicy: { rollover: 'audit' },
    };

    it('refuses activation without an active function space, naming that step, even with room types', async () => {
      db.organization.findUnique.mockResolvedValue(venueOrganization);
      db.organizationRole.count.mockResolvedValue(15);
      db.hotelProperty.findFirst.mockResolvedValue(venueProperty);
      db.hotelRoomType.count.mockResolvedValue(2);
      db.hotelFunctionSpace.count.mockResolvedValue(0);
      await expect(
        executePlatformCommand(
          actor,
          'organization.transition',
          { id: 'org_new', status: 'ACTIVE', reason: 'Synthetic activation check' },
          request
        )
      ).rejects.toThrow('hotel onboarding steps not done (FUNCTION_SPACES)');
      expect(db.organization.update).not.toHaveBeenCalled();
      expect(db.organizationLifecycleEvent.create).not.toHaveBeenCalled();
    });

    it('activates once the venue holds one active function space, counted under that property, with no room type', async () => {
      db.organization.findUnique.mockResolvedValue(venueOrganization);
      db.organizationRole.count.mockResolvedValue(15);
      db.hotelProperty.findFirst.mockResolvedValue(venueProperty);
      db.hotelRoomType.count.mockResolvedValue(0);
      db.hotelFunctionSpace.count.mockResolvedValue(1);
      await executePlatformCommand(
        actor,
        'organization.transition',
        { id: 'org_new', status: 'ACTIVE', reason: 'Synthetic activation check' },
        request
      );
      expect(db.hotelFunctionSpace.count).toHaveBeenCalledWith({
        where: { organizationId: 'org_new', branchId: 'created_property', active: true },
      });
      expect(db.hotelRoomType.count).not.toHaveBeenCalled();
      expect(db.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org_new' },
          data: expect.objectContaining({ status: 'ACTIVE' }),
        })
      );
      expect(db.organizationLifecycleEvent.create).toHaveBeenCalledTimes(1);
    });
  });

  it('assigns only the named administrator to the created property using this organization Owner role', async () => {
    await executePlatformCommand(actor, 'organization.create', payload, request);
    expect(mocks.assignmentCreate).toHaveBeenCalledExactlyOnceWith({
      data: {
        organizationId: 'org_new',
        branchId: 'created_property',
        userId: 'named_admin',
        organizationRoleId: 'role_owner',
        active: true,
      },
    });
    expect(mocks.propertyCreate).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_new',
        name: 'Example Property',
        addressLine: 'Synthetic street',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        bookingEngineSlug: 'example-hotel-example-property',
      },
    });
    expect(mocks.roleCreate.mock.calls.map(([arg]) => arg.data.key)).toEqual([
      'admin',
      ...HOSPITALITY_ROLE_TEMPLATES.map((role) => role.key),
    ]);
    expect(mocks.roleCreate.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.propertyCreate.mock.invocationCallOrder[0]
    );
  });
  it('opens the created property with the four standard meal plans, MAP and AP inactive', async () => {
    await executePlatformCommand(actor, 'organization.create', payload, request);
    // H1-07 / H-D15 — hung off the property row that was just created, never
    // off an id the payload supplied, and written after the administrator's
    // assignment so a failed assignment leaves no plan behind.
    expect(mocks.mealPlanCreateMany).toHaveBeenCalledTimes(1);
    const seeded = (
      mocks.mealPlanCreateMany.mock.calls[0]![0] as {
        data: {
          organizationId: string;
          branchId: string;
          code: string;
          name: string;
          nameUr: string;
          meals: unknown[];
          active: boolean;
        }[];
      }
    ).data;
    expect(seeded.map((plan) => plan.code)).toEqual(['EP', 'CP', 'MAP', 'AP']);
    for (const plan of seeded) {
      expect(plan).toMatchObject({ organizationId: 'org_new', branchId: 'created_property' });
      expect(plan.nameUr.trim().length).toBeGreaterThan(0);
    }
    expect(seeded.filter((plan) => plan.active).map((plan) => plan.code)).toEqual(['EP', 'CP']);
    expect(seeded.find((plan) => plan.code === 'AP')!.meals).toHaveLength(3);
    expect(mocks.assignmentCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mealPlanCreateMany.mock.invocationCallOrder[0]!
    );
  });
  it('seeds no meal plan when the administrator’s assignment fails', async () => {
    mocks.assignmentCreate.mockRejectedValueOnce(new Error('assignment refused'));
    await expect(
      executePlatformCommand(actor, 'organization.create', payload, request)
    ).rejects.toThrow('assignment refused');
    expect(mocks.mealPlanCreateMany).not.toHaveBeenCalled();
    expect(mocks.journeyCreateMany).not.toHaveBeenCalled();
  });
  it('opens the created property with English and Urdu guest-message drafts, every one a draft to approve', async () => {
    await executePlatformCommand(actor, 'organization.create', payload, request);
    // H1-14 / UPS-04 — hung off the property row that was just created and
    // attributed to the named administrator, written after the assignment so a
    // failed assignment leaves no draft behind; never an APPROVED row, because
    // nobody at the property has read these words yet.
    expect(mocks.journeyCreateMany).toHaveBeenCalledTimes(1);
    const seeded = (
      mocks.journeyCreateMany.mock.calls[0]![0] as {
        data: (HotelJourneyTemplateSeed & {
          organizationId: string;
          branchId: string;
          createdByUserId: string;
        })[];
      }
    ).data;
    expect(seeded).toHaveLength(20);
    for (const seed of seeded) {
      expect(seed).toMatchObject({
        organizationId: 'org_new',
        branchId: 'created_property',
        createdByUserId: 'named_admin',
        status: 'DRAFT',
        version: 1,
      });
      expect(() => validateJourneyTemplate(seed)).not.toThrow();
    }
    for (const moment of HOTEL_JOURNEY_MOMENTS) {
      for (const language of ['EN', 'UR'] as const) {
        expect(seeded).toContainEqual(
          expect.objectContaining({ moment, language, channel: 'WHATSAPP', subject: null })
        );
      }
    }
    expect(
      seeded.filter((seed) => seed.channel === 'EMAIL').map((seed) => [seed.moment, seed.language])
    ).toEqual([
      ['BOOKING_CONFIRMED', 'EN'],
      ['BOOKING_CONFIRMED', 'UR'],
      ['INVOICE', 'EN'],
      ['INVOICE', 'UR'],
    ]);
    for (const seed of seeded.filter((entry) => entry.channel === 'EMAIL'))
      expect(seed.subject?.trim().length).toBeGreaterThan(0);
    expect(mocks.assignmentCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.journeyCreateMany.mock.invocationCallOrder[0]!
    );
  });
  it.each(['firstBranchName', 'firstBranchAddress', 'firstBranchCity'])(
    'rejects missing %s before provisioning writes',
    async (field) => {
      await expect(
        executePlatformCommand(
          actor,
          'organization.create',
          { ...payload, [field]: undefined },
          request
        )
      ).rejects.toThrow();
      expect(mocks.orgCreate).not.toHaveBeenCalled();
      expect(mocks.propertyCreate).not.toHaveBeenCalled();
      expect(mocks.assignmentCreate).not.toHaveBeenCalled();
      expect(mocks.mealPlanCreateMany).not.toHaveBeenCalled();
      expect(mocks.journeyCreateMany).not.toHaveBeenCalled();
    }
  );
  it('fails closed before property creation when the Owner role did not return an identity', async () => {
    mocks.roleCreate.mockImplementation(async ({ data }: { data: { key: string } }) => ({
      id: data.key === 'owner' ? '' : 'role_' + data.key,
    }));
    await expect(
      executePlatformCommand(actor, 'organization.create', payload, request)
    ).rejects.toThrow('Owner role was not provisioned');
    expect(mocks.propertyCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });
  it('does not substitute a guessed property or administrator when assignment fails', async () => {
    mocks.assignmentCreate.mockRejectedValueOnce(new Error('assignment refused'));
    await expect(
      executePlatformCommand(actor, 'organization.create', payload, request)
    ).rejects.toThrow('assignment refused');
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(1);
  });
  it('offers every required property field using the existing form and tenant-filtered package query', async () => {
    renderToStaticMarkup(
      await NewOrganizationPage({ searchParams: Promise.resolve({ vertical: 'HOSPITALITY' }) })
    );
    expect(mocks.read).toHaveBeenCalledWith('/platform/organizations');
    expect(mocks.packageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, vertical: 'HOSPITALITY' } })
    );
    const props = mocks.form.mock.calls[0][0] as ComponentProps<typeof PlatformCommandForm>;
    for (const name of ['firstBranchName', 'firstBranchAddress', 'firstBranchCity'])
      expect(props.fields?.find((field) => field.name === name)).toMatchObject({ required: true });
    expect(props.fields?.find((field) => field.name === 'timezone')).toMatchObject({
      defaultValue: 'Asia/Karachi',
    });
  });
  it('does not show a usable form or query packages when read access is denied', async () => {
    mocks.read.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      NewOrganizationPage({ searchParams: Promise.resolve({ vertical: 'HOSPITALITY' }) })
    ).rejects.toThrow('forbidden');
    expect(mocks.packageFindMany).not.toHaveBeenCalled();
    expect(mocks.form).not.toHaveBeenCalled();
  });
});
