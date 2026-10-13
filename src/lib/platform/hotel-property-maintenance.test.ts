import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
vi.mock('server-only', () => ({}));
const security = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: security.assert }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(db)),
}));
import { canPlatformRole } from './capabilities';
import { PlatformSecurityError } from './security';
import { executePlatformCommand } from './commands';

import {
  recoverHotelPropertyManager,
  deactivateHotelProperty,
  reactivateHotelProperty,
} from './hotel-property-maintenance';
const tuple = {
  organizationId: 'org_1',
  branchId: 'property_1',
  userId: 'user_1',
  organizationRoleId: 'role_1',
};
const facts = {
  mode: 'HOTEL',
  name: 'Synthetic',
  addressLine: 'Example street',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_1',
  businessDatePolicy: { rollover: 'audit' },
};
const db = {
  platformAuditLog: { create: vi.fn() },
  $queryRawUnsafe: vi.fn(),
  organization: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  organizationRole: { findFirst: vi.fn(), count: vi.fn() },
  hotelProperty: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
  hotelPropertyAssignment: { findFirst: vi.fn(), upsert: vi.fn(), count: vi.fn() },
};
const client = db as unknown as PrismaClient;
beforeEach(() => {
  vi.clearAllMocks();
  security.assert.mockImplementation(
    (actor: { role: 'SUPER_ADMIN' | 'OPERATIONS' }, capability: string) => {
      if (!canPlatformRole(actor.role, capability))
        throw new PlatformSecurityError('Forbidden', 403);
    }
  );
  db.$queryRawUnsafe.mockResolvedValue([
    { branchId: 'property_1', active: false, name: 'Synthetic' },
  ]);
  db.organization.findUnique.mockResolvedValue({
    id: 'org_1',
    status: 'ACTIVE',
    vertical: 'HOSPITALITY',
  });
  db.user.findFirst.mockResolvedValue({ id: 'user_1', name: 'Named user' });
  db.organizationRole.findFirst.mockResolvedValue({ id: 'role_1', key: 'owner', name: 'Owner' });
  db.organizationRole.count.mockResolvedValue(15);
  db.hotelPropertyAssignment.findFirst.mockResolvedValue(null);
  db.hotelPropertyAssignment.upsert.mockResolvedValue({
    organizationRoleId: 'role_1',
    active: true,
  });
  db.hotelPropertyAssignment.count.mockResolvedValue(1);
  db.hotelProperty.findUniqueOrThrow.mockResolvedValue(facts);
  db.hotelProperty.update.mockImplementation(async ({ data }: { data: { active: boolean } }) => ({
    branchId: 'property_1',
    name: 'Synthetic',
    active: data.active,
  }));
});
describe('platform Hotel property maintenance', () => {
  it('recovers exactly the named tuple under a scoped property lock, without claiming access to an inactive property', async () => {
    const result = await recoverHotelPropertyManager(client, tuple);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      'org_1',
      'property_1'
    );
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1', organizationId: 'org_1', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      })
    );
    expect(db.hotelPropertyAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_branchId_userId: {
            organizationId: 'org_1',
            branchId: 'property_1',
            userId: 'user_1',
          },
        },
        create: { ...tuple, active: true },
      })
    );
    expect(result.audit).toMatchObject({
      ...tuple,
      propertyActive: false,
      resolvesTenantScope: false,
    });
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.user.findFirst.mock.invocationCallOrder[0]
    );
  });
  it('records the previous role without granting the bootstrap admin tenant scope', async () => {
    db.hotelPropertyAssignment.findFirst.mockResolvedValue({
      organizationRoleId: 'old_role',
      active: false,
      role: { key: 'owner' },
    });
    db.organizationRole.findFirst.mockResolvedValue({
      id: 'role_1',
      key: 'admin',
      name: 'Administrator',
    });
    const r = await recoverHotelPropertyManager(client, tuple);
    expect(r.audit.roleKey).toBe('admin');
    expect(r.audit.resolvesTenantScope).toBe(false);
    expect(r.auditBefore).toMatchObject({ organizationRoleId: 'old_role', active: false });
  });
  it.each([
    'missing-property',
    'wrong-vertical',
    'missing-user',
    'missing-role',
    'unrecognized-role',
  ])('refuses %s without changing assignments', async (reason) => {
    if (reason === 'missing-property') db.$queryRawUnsafe.mockResolvedValue([]);
    if (reason === 'wrong-vertical')
      db.organization.findUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    if (reason === 'missing-user') db.user.findFirst.mockResolvedValue(null);
    if (reason === 'missing-role') db.organizationRole.findFirst.mockResolvedValue(null);
    if (reason === 'unrecognized-role')
      db.organizationRole.findFirst.mockResolvedValue({ key: 'foreign-template' });
    await expect(recoverHotelPropertyManager(client, tuple)).rejects.toThrow();
    expect(db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });
  it('deactivates the locked property without deleting its assignments', async () => {
    db.$queryRawUnsafe.mockResolvedValue([
      { branchId: 'property_1', active: true, name: 'Synthetic' },
    ]);
    expect(await deactivateHotelProperty(client, 'org_1', 'property_1')).toMatchObject({
      active: false,
    });
    expect(db.hotelProperty.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: 'property_1' }, data: { active: false } })
    );
    expect(db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });
  it.each(['SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED'])(
    'never reactivates a property in a %s organization',
    async (status) => {
      db.organization.findUnique.mockResolvedValue({ vertical: 'HOSPITALITY', status });
      await expect(reactivateHotelProperty(client, 'org_1', 'property_1')).rejects.toThrow(
        'cannot return'
      );
      expect(db.hotelProperty.update).not.toHaveBeenCalled();
    }
  );
  it.each(['no-manager', 'missing-tax', 'missing-policy', 'missing-roles'])(
    'refuses reactivation with %s',
    async (reason) => {
      if (reason === 'no-manager') db.hotelPropertyAssignment.count.mockResolvedValue(0);
      if (reason === 'missing-tax')
        db.hotelProperty.findUniqueOrThrow.mockResolvedValue({ ...facts, taxProfileId: null });
      if (reason === 'missing-policy')
        db.hotelProperty.findUniqueOrThrow.mockResolvedValue({ ...facts, businessDatePolicy: {} });
      if (reason === 'missing-roles') db.organizationRole.count.mockResolvedValue(0);
      await expect(reactivateHotelProperty(client, 'org_1', 'property_1')).rejects.toThrow();
      expect(db.hotelProperty.update).not.toHaveBeenCalled();
    }
  );
  it('restores an existing property only with concrete facts and eligible manager; does not activate the organization', async () => {
    expect(await reactivateHotelProperty(client, 'org_1', 'property_1')).toMatchObject({
      active: true,
    });
    expect(db.hotelPropertyAssignment.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'property_1',
          active: true,
          user: { organizationId: 'org_1', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
          role: expect.any(Object),
        }),
      })
    );
  });
});

describe('Hotel maintenance command policy', () => {
  const request = new Request('https://synthetic.invalid/api/platform/control', { method: 'POST' });
  it.each(['recover', 'deactivate', 'reactivate'])(
    'requires the accepted security-write capability for %s',
    async (action) => {
      await expect(
        executePlatformCommand(
          { id: 'operator_1', role: 'OPERATIONS' } as never,
          'organization.hotelproperty.' + action,
          { ...tuple, reason: 'Synthetic maintenance request' },
          request
        )
      ).rejects.toThrow('Forbidden');
      expect(security.assert).toHaveBeenCalledWith(
        expect.any(Object),
        'organizations:security:write'
      );
      expect(
        db.$queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('hotel_properties'))
      ).toBe(false);
      expect(db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
      expect(db.hotelProperty.update).not.toHaveBeenCalled();
    }
  );
  it('rejects a short recovery reason before taking the property lock', async () => {
    await expect(
      executePlatformCommand(
        { id: 'operator_1', role: 'SUPER_ADMIN' } as never,
        'organization.hotelproperty.recover',
        { ...tuple, reason: 'fix' },
        request
      )
    ).rejects.toThrow();
    expect(
      db.$queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('hotel_properties'))
    ).toBe(false);
    expect(db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
    expect(db.hotelProperty.update).not.toHaveBeenCalled();
  });
  it('records explicit recovery reason and assignment tuple in the success audit', async () => {
    await executePlatformCommand(
      { id: 'operator_1', role: 'SUPER_ADMIN' } as never,
      'organization.hotelproperty.recover',
      { ...tuple, reason: 'Synthetic manager recovery' },
      request
    );
    expect(db.platformAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'organization.hotelproperty.recover',
          organizationId: 'org_1',
          after: expect.objectContaining({ ...tuple, reason: 'Synthetic manager recovery' }),
        }),
      })
    );
  });
});
