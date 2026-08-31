import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  can: vi.fn<typeof import('@/lib/abac').can>(async () => true),
  annotateAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
  requireBranchScope: vi.fn<(ctx: unknown, branchId: string) => Promise<void>>(
    async () => undefined
  ),
  listDeliveryZones: vi.fn(),
  createDeliveryZone: vi.fn(),
  updateDeliveryZone: vi.fn(),
  deactivateDeliveryZone: vi.fn(),
  listDeliveryAddresses: vi.fn(),
  createDeliveryAddress: vi.fn(),
  updateDeliveryAddress: vi.fn(),
  setDefaultDeliveryAddress: vi.fn(),
  deleteDeliveryAddress: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/restaurant-branch-scope', () => ({
  requireRestaurantBranchScope: mocks.requireBranchScope,
}));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    annotateAudit: (...args: Parameters<typeof actual.annotateAudit>) => {
      mocks.annotateAudit(...args);
      actual.annotateAudit(...args);
    },
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: (...args: Parameters<typeof actual.recordTrpcAudit>) => {
      const [entry] = args;
      mocks.recordTrpcAudit({
        ...entry,
        input: entry.ctx.audit?.detail.skipInput ? '[skipped]' : entry.input,
      });
    },
  };
});
vi.mock('@/lib/restaurant/delivery', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/delivery')>(
    '@/lib/restaurant/delivery'
  );
  return {
    ...actual,
    listDeliveryZones: mocks.listDeliveryZones,
    createDeliveryZone: mocks.createDeliveryZone,
    updateDeliveryZone: mocks.updateDeliveryZone,
    deactivateDeliveryZone: mocks.deactivateDeliveryZone,
    listDeliveryAddresses: mocks.listDeliveryAddresses,
    createDeliveryAddress: mocks.createDeliveryAddress,
    updateDeliveryAddress: mocks.updateDeliveryAddress,
    setDefaultDeliveryAddress: mocks.setDefaultDeliveryAddress,
    deleteDeliveryAddress: mocks.deleteDeliveryAddress,
  };
});

import { DeliveryError } from '@/lib/restaurant/delivery';
import type { TRPCContext } from '../trpc';
import { restaurantDeliveryRouter } from './restaurant-delivery';

const db = { marker: 'scoped-db' };
const zoneInput = {
  branchId: 'branch_1',
  name: 'Central',
  fixedFee: '4.50',
  minimumSubtotal: '20.00',
  promisedMinutes: 30,
};
const addressInput = {
  customerId: 'customer_1',
  label: 'Home',
  recipientName: 'Private Person',
  phone: '+12025550123',
  addressLine1: '42 Private Street',
  locality: 'Lahore',
  countryCode: 'PK',
  latitude: '31.520400',
  longitude: '74.358700',
};
const zone = {
  id: 'zone_1',
  fixedFee: new Prisma.Decimal('4.50'),
  minimumSubtotal: new Prisma.Decimal('20.00'),
};
const address = {
  id: 'address_1',
  latitude: new Prisma.Decimal('31.520400'),
  longitude: new Prisma.Decimal('74.358700'),
};

function caller() {
  return restaurantDeliveryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'organization_server',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.requireBranchScope.mockResolvedValue(undefined);
  mocks.listDeliveryZones.mockResolvedValue([zone]);
  mocks.createDeliveryZone.mockResolvedValue(zone);
  mocks.updateDeliveryZone.mockResolvedValue(zone);
  mocks.deactivateDeliveryZone.mockResolvedValue(undefined);
  mocks.listDeliveryAddresses.mockResolvedValue([address]);
  mocks.createDeliveryAddress.mockResolvedValue(address);
  mocks.updateDeliveryAddress.mockResolvedValue(address);
  mocks.setDefaultDeliveryAddress.mockResolvedValue(address);
  mocks.deleteDeliveryAddress.mockResolvedValue(undefined);
});

describe('authorization and server-owned scope', () => {
  it('uses configure for every zone operation and customer capabilities for addresses', async () => {
    const api = caller();
    await api.listZones({ branchId: 'branch_1' });
    await api.createZone(zoneInput);
    await api.updateZone({ ...zoneInput, zoneId: 'zone_1' });
    await api.deactivateZone({ branchId: 'branch_1', zoneId: 'zone_1' });
    await api.listAddresses({ customerId: 'customer_1' });
    await api.createAddress(addressInput);
    await api.updateAddress({ ...addressInput, addressId: 'address_1' });
    await api.setDefaultAddress({ customerId: 'customer_1', addressId: 'address_1' });
    await api.deleteAddress({ customerId: 'customer_1', addressId: 'address_1' });

    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      ...Array(4).fill('restaurant:configure'),
      'customers:read',
      ...Array(4).fill('customers:manage'),
    ]);
    expect(mocks.requireBranchScope).toHaveBeenCalledTimes(4);
    expect(mocks.requireBranchScope.mock.calls.map((call) => call[1])).toEqual(
      Array(4).fill('branch_1')
    );
  });

  it('fails closed on capability and branch denial before command delegation', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().listAddresses({ customerId: 'customer_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.listDeliveryAddresses).not.toHaveBeenCalled();

    mocks.can.mockResolvedValue(true);
    mocks.requireBranchScope.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'denied' })
    );
    await expect(caller().createZone(zoneInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.createDeliveryZone).not.toHaveBeenCalled();
  });

  it('delegates tenant, customer, and branch IDs without accepting tenant authority', async () => {
    const api = caller();
    await api.createZone(zoneInput);
    await api.createAddress(addressInput);
    await api.listAddresses({ customerId: 'customer_1' });

    expect(mocks.createDeliveryZone).toHaveBeenCalledWith(db, {
      ...zoneInput,
      organizationId: 'organization_server',
    });
    expect(mocks.createDeliveryAddress).toHaveBeenCalledWith(db, {
      ...addressInput,
      organizationId: 'organization_server',
    });
    expect(mocks.listDeliveryAddresses).toHaveBeenCalledWith(
      db,
      'organization_server',
      'customer_1'
    );
  });
});

describe('strict public contract and serialization', () => {
  it.each([
    ['organizationId', 'organization_client'],
    ['paymentMode', 'PREPAID'],
    ['fixedFeeSnapshot', '1.00'],
    ['taxSnapshot', '1.00'],
    ['tenderId', 'tender_1'],
    ['deliveryStatus', 'DELIVERED'],
    ['createdAt', new Date()],
  ])('rejects unknown authority field %s', async (field, value) => {
    await expect(
      caller().createAddress({ ...addressInput, [field]: value } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createDeliveryAddress).not.toHaveBeenCalled();
  });

  it('rejects zone authority fields too', async () => {
    await expect(
      caller().createZone({ ...zoneInput, organizationId: 'organization_client' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createDeliveryZone).not.toHaveBeenCalled();
  });

  it('serializes all Decimal money and coordinates as strings', async () => {
    const api = caller();
    const zones = await api.listZones({ branchId: 'branch_1' });
    const addresses = await api.listAddresses({ customerId: 'customer_1' });

    expect(zones[0]).toMatchObject({ fixedFee: '4.5', minimumSubtotal: '20' });
    expect(addresses[0]).toMatchObject({ latitude: '31.5204', longitude: '74.3587' });
  });
});

describe('audit privacy and errors', () => {
  it('never records address or phone contents in audit input or metadata', async () => {
    await caller().createAddress(addressInput);

    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ input: '[skipped]' })
    );
    const auditText = JSON.stringify(mocks.recordTrpcAudit.mock.calls);
    expect(auditText).not.toContain(addressInput.phone);
    expect(auditText).not.toContain(addressInput.addressLine1);
    expect(mocks.annotateAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'RestaurantCustomerAddress',
        targetId: 'address_1',
        skipInput: true,
      })
    );
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['INVALID_INPUT', 'BAD_REQUEST'],
    ['ALREADY_EXISTS', 'CONFLICT'],
  ] as const)('maps %s to %s', async (reason, code) => {
    mocks.createDeliveryAddress.mockRejectedValueOnce(new DeliveryError('domain failure', reason));
    await expect(caller().createAddress(addressInput)).rejects.toMatchObject({
      code,
      message: 'domain failure',
    });
  });
});
