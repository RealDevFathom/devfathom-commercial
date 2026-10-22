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
  reactivateDeliveryZone: vi.fn(),
  listDeliveryAddresses: vi.fn(),
  createDeliveryAddress: vi.fn(),
  updateDeliveryAddress: vi.fn(),
  setDefaultDeliveryAddress: vi.fn(),
  deleteDeliveryAddress: vi.fn(),
  listCustomers: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((entitlements: { enabledModules: string[] }, moduleKey: string) =>
    entitlements.enabledModules.includes(moduleKey)
  ),
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
    reactivateDeliveryZone: mocks.reactivateDeliveryZone,
    listDeliveryAddresses: mocks.listDeliveryAddresses,
    createDeliveryAddress: mocks.createDeliveryAddress,
    updateDeliveryAddress: mocks.updateDeliveryAddress,
    setDefaultDeliveryAddress: mocks.setDefaultDeliveryAddress,
    deleteDeliveryAddress: mocks.deleteDeliveryAddress,
  };
});
vi.mock('@/lib/restaurant/customers', () => ({ listCustomers: mocks.listCustomers }));

import { DeliveryError } from '@/lib/restaurant/delivery';
import { router, type TRPCContext } from '../trpc';
import { restaurantDeliveryRouter } from './restaurant-delivery';

const testRouter = router({ restaurantDelivery: restaurantDeliveryRouter });

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
  return testRouter.createCaller({
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
  } as unknown as TRPCContext).restaurantDelivery;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.requireBranchScope.mockResolvedValue(undefined);
  mocks.listDeliveryZones.mockResolvedValue([zone]);
  mocks.createDeliveryZone.mockResolvedValue(zone);
  mocks.updateDeliveryZone.mockResolvedValue(zone);
  mocks.deactivateDeliveryZone.mockResolvedValue(undefined);
  mocks.reactivateDeliveryZone.mockResolvedValue(undefined);
  mocks.listDeliveryAddresses.mockResolvedValue([address]);
  mocks.createDeliveryAddress.mockResolvedValue(address);
  mocks.updateDeliveryAddress.mockResolvedValue(address);
  mocks.setDefaultDeliveryAddress.mockResolvedValue(address);
  mocks.deleteDeliveryAddress.mockResolvedValue(undefined);
  mocks.listCustomers.mockResolvedValue({
    customers: [
      {
        id: 'customer_1',
        displayName: 'Ayesha Khan',
        givenName: 'Ayesha',
        familyName: 'Khan',
        birthDate: new Date('1990-01-01'),
        notes: 'private note',
        identifiers: [{ kind: 'PHONE', normalizedValue: '+923001234567' }],
        tags: [{ id: 'tag_1', name: 'VIP' }],
        loyaltySummary: { balance: 500 },
      },
    ],
    nextCursor: 'customer_1',
  });
});

describe('authorization and server-owned scope', () => {
  it('uses configure for every zone operation and customer capabilities for addresses', async () => {
    const api = caller();
    await api.listCustomers({ limit: 20 });
    await api.listZones({ branchId: 'branch_1' });
    await api.createZone(zoneInput);
    await api.updateZone({ ...zoneInput, zoneId: 'zone_1' });
    await api.deactivateZone({ branchId: 'branch_1', zoneId: 'zone_1' });
    await api.reactivateZone({ branchId: 'branch_1', zoneId: 'zone_1' });
    await api.listAddresses({ customerId: 'customer_1' });
    await api.createAddress(addressInput);
    await api.updateAddress({ ...addressInput, addressId: 'address_1' });
    await api.setDefaultAddress({
      customerId: 'customer_1',
      addressId: 'address_1',
    });
    await api.deleteAddress({
      customerId: 'customer_1',
      addressId: 'address_1',
    });

    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'customers:read',
      ...Array(5).fill('restaurant:configure'),
      'customers:read',
      ...Array(4).fill('customers:manage'),
    ]);
    expect(mocks.requireBranchScope).toHaveBeenCalledTimes(5);
    expect(mocks.requireBranchScope.mock.calls.map((call) => call[1])).toEqual(
      Array(5).fill('branch_1')
    );
  });

  it('reactivates only through server-owned tenant and branch scope', async () => {
    await caller().reactivateZone({ branchId: 'branch_1', zoneId: 'zone_1' });

    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'branch_1');
    expect(mocks.reactivateDeliveryZone).toHaveBeenCalledWith(db, {
      organizationId: 'organization_server',
      branchId: 'branch_1',
      zoneId: 'zone_1',
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantDeliveryZone', targetId: 'zone_1' })
    );
  });

  it('fails closed on capability and branch denial before command delegation', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().listCustomers({ limit: 20 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
    await expect(caller().listAddresses({ customerId: 'customer_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.listDeliveryAddresses).not.toHaveBeenCalled();

    mocks.can.mockResolvedValue(true);
    mocks.requireBranchScope.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'denied' })
    );
    await expect(caller().createZone(zoneInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
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
  it('lists selector customers for Restaurant Core without Loyalty and returns minimal fields', async () => {
    const result = await caller().listCustomers({ query: 'Ayesha', limit: 20, cursor: 'cursor_1' });

    expect(mocks.listCustomers).toHaveBeenCalledWith(db, {
      query: 'Ayesha',
      limit: 20,
      cursor: 'cursor_1',
    });
    expect(result).toEqual({
      customers: [
        {
          id: 'customer_1',
          displayName: 'Ayesha Khan',
          givenName: 'Ayesha',
          familyName: 'Khan',
        },
      ],
      nextCursor: 'customer_1',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /birthDate|notes|identifier|normalizedValue|phone|email|tag|loyalty|address/i
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipInput: true })
    );
  });

  it.each([
    { query: '' },
    { query: 'x'.repeat(201) },
    { limit: 0 },
    { limit: 101 },
    { cursor: 'x'.repeat(201) },
    { tagId: 'tag_1' },
  ])('rejects unbounded or unsupported customer-directory input %#', async (input) => {
    await expect(caller().listCustomers(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
  });

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

  it('accepts Decimal(12,2) money boundaries', async () => {
    await caller().createZone({
      ...zoneInput,
      fixedFee: '9999999999.99',
      minimumSubtotal: '0',
    });

    expect(mocks.createDeliveryZone).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ fixedFee: '9999999999.99', minimumSubtotal: '0' })
    );
  });

  it.each(['NaN', 'Infinity', '1e2', '0.001', '10000000000', '99999999999.99'])(
    'rejects invalid or unrepresentable money %s before delegation',
    async (fixedFee) => {
      await expect(caller().createZone({ ...zoneInput, fixedFee })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.createDeliveryZone).not.toHaveBeenCalled();
    }
  );

  it('accepts Decimal(9,6) coordinate boundaries within domain ranges', async () => {
    await caller().createAddress({
      ...addressInput,
      latitude: '-90.000000',
      longitude: '180.000000',
    });

    expect(mocks.createDeliveryAddress).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ latitude: '-90.000000', longitude: '180.000000' })
    );
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1e2', '1.0000001', '1000', '-1000.000000'])(
    'rejects invalid or unrepresentable coordinate %s before delegation',
    async (latitude) => {
      await expect(caller().createAddress({ ...addressInput, latitude })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.createDeliveryAddress).not.toHaveBeenCalled();
    }
  );

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
