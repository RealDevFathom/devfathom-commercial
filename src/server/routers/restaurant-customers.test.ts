import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<typeof import('@/lib/abac').can>(async () => true),
  annotateAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  correctCustomer: vi.fn(),
  attachCustomerToOrder: vi.fn(),
  appendCustomerInteraction: vi.fn(),
  appendCustomerConsent: vi.fn(),
  createCustomerTag: vi.fn(),
  listCustomerTags: vi.fn(),
  assignCustomerTag: vi.fn(),
  unassignCustomerTag: vi.fn(),
  exportCustomerData: vi.fn(),
  anonymizeCustomer: vi.fn(),
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
vi.mock('@/lib/restaurant/customers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/customers')>(
    '@/lib/restaurant/customers'
  );
  return {
    ...actual,
    listCustomers: mocks.listCustomers,
    getCustomer: mocks.getCustomer,
    createCustomer: mocks.createCustomer,
    correctCustomer: mocks.correctCustomer,
    attachCustomerToOrder: mocks.attachCustomerToOrder,
    appendCustomerInteraction: mocks.appendCustomerInteraction,
    appendCustomerConsent: mocks.appendCustomerConsent,
    createCustomerTag: mocks.createCustomerTag,
    listCustomerTags: mocks.listCustomerTags,
    assignCustomerTag: mocks.assignCustomerTag,
    unassignCustomerTag: mocks.unassignCustomerTag,
  };
});
vi.mock('@/lib/restaurant/customer-privacy', () => ({
  exportCustomerData: mocks.exportCustomerData,
  anonymizeCustomer: mocks.anonymizeCustomer,
}));

import { CustomerError } from '@/lib/restaurant/customers';
import type { TRPCContext } from '../trpc';
import { restaurantCustomersRouter } from './restaurant-customers';

const db = { marker: 'scoped-db' };

function caller() {
  return restaurantCustomersRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role: 'ADMIN',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
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
  for (const mock of [
    mocks.listCustomers,
    mocks.getCustomer,
    mocks.createCustomer,
    mocks.correctCustomer,
    mocks.attachCustomerToOrder,
    mocks.appendCustomerInteraction,
    mocks.appendCustomerConsent,
    mocks.createCustomerTag,
    mocks.listCustomerTags,
    mocks.assignCustomerTag,
    mocks.unassignCustomerTag,
    mocks.exportCustomerData,
    mocks.anonymizeCustomer,
  ]) {
    mock.mockResolvedValue({ ok: true });
  }
});

describe('capabilities and delegation', () => {
  it('gates reads separately from management, export, and anonymization', async () => {
    const api = caller();
    await api.list({});
    await api.detail({ customerId: 'customer_1' });
    await api.create({});
    await api.correct({ customerId: 'customer_1' });
    await api.attachToOrder({ customerId: 'customer_1', orderId: 'order_1' });
    await api.appendInteraction({
      customerId: 'customer_1',
      branchId: 'branch_1',
      type: 'NOTE',
      idempotencyKey: 'interaction_1',
    });
    await api.appendConsent({
      customerId: 'customer_1',
      channel: 'EMAIL',
      granted: true,
      source: 'checkout',
      policyVersion: 'v1',
      idempotencyKey: 'consent_1',
    });
    await api.createTag({ name: 'Regular' });
    await api.listTags({});
    await api.assignTag({ customerId: 'customer_1', tagId: 'tag_1' });
    await api.unassignTag({ customerId: 'customer_1', tagId: 'tag_1' });
    await api.export({ customerId: 'customer_1' });
    await api.anonymize({ customerId: 'customer_1' });

    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'customers:read',
      'customers:read',
      ...Array(6).fill('customers:manage'),
      'customers:read',
      ...Array(3).fill('customers:manage'),
      'restaurant:configure',
    ]);
    expect(mocks.attachCustomerToOrder).toHaveBeenCalledWith(db, {
      customerId: 'customer_1',
      orderId: 'order_1',
    });
    expect(mocks.appendCustomerInteraction).toHaveBeenCalledWith(db, {
      customerId: 'customer_1',
      branchId: 'branch_1',
      type: 'NOTE',
      idempotencyKey: 'interaction_1',
    });
    expect(mocks.appendCustomerConsent).toHaveBeenCalledWith(db, {
      customerId: 'customer_1',
      channel: 'EMAIL',
      granted: true,
      source: 'checkout',
      actorId: 'user_1',
      policyVersion: 'v1',
      idempotencyKey: 'consent_1',
    });
    expect(mocks.anonymizeCustomer).toHaveBeenCalledWith(db, { customerId: 'customer_1' });
  });

  it('allows read-only access while denying writes and full-profile export', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'customers:read');
    const api = caller();

    await expect(api.list({})).resolves.toEqual({ ok: true });
    await expect(api.detail({ customerId: 'customer_1' })).resolves.toEqual({ ok: true });
    await expect(api.listTags({})).resolves.toEqual({ ok: true });
    await expect(api.create({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.export({ customerId: 'customer_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.exportCustomerData).not.toHaveBeenCalled();
  });

  it('allows customer managers to mutate and export', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'customers:manage');
    const api = caller();

    await expect(api.create({})).resolves.toEqual({ ok: true });
    await expect(api.export({ customerId: 'customer_1' })).resolves.toEqual({ ok: true });
  });

  it('fails closed before domain delegation', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().anonymize({ customerId: 'customer_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
    expect(mocks.anonymizeCustomer).not.toHaveBeenCalled();
  });
});

describe('strict boundary validation', () => {
  it('rejects top-level and nested unknown keys', async () => {
    await expect(caller().list({ unknown: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().create({
        identifiers: [{ kind: 'EMAIL', value: 'person@example.com', unknown: true }],
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each([
    { kind: 'EMAIL', value: 'not-an-email' },
    { kind: 'PHONE', value: '555-0100' },
  ] as const)('rejects invalid $kind identifiers', async (badIdentifier) => {
    await expect(caller().create({ identifiers: [badIdentifier] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ['payload', { customer: 'private' }],
    ['occurredAt', new Date('2026-08-21T00:00:00.000Z')],
  ] as const)('rejects caller-owned interaction %s', async (key, value) => {
    await expect(
      caller().appendInteraction({
        customerId: 'customer_1',
        branchId: 'branch_1',
        type: 'NOTE',
        idempotencyKey: 'interaction_1',
        [key]: value,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.appendCustomerInteraction).not.toHaveBeenCalled();
  });

  it.each([
    ['actorId', 'caller_owned_actor'],
    ['occurredAt', new Date('2026-08-21T00:00:00.000Z')],
  ] as const)('rejects caller-owned consent %s', async (key, value) => {
    await expect(
      caller().appendConsent({
        customerId: 'customer_1',
        channel: 'EMAIL',
        granted: true,
        source: 'checkout',
        policyVersion: 'v1',
        idempotencyKey: 'consent_1',
        [key]: value,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.appendCustomerConsent).not.toHaveBeenCalled();
  });

  it('rejects caller-owned anonymization time', async () => {
    await expect(
      caller().anonymize({
        customerId: 'customer_1',
        at: new Date('2026-08-21T00:00:00.000Z'),
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.anonymizeCustomer).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['INVALID_IDENTIFIER', 'BAD_REQUEST'],
    ['INVALID_STATE', 'CONFLICT'],
    ['DUPLICATE_IDENTIFIER', 'CONFLICT'],
    ['DUPLICATE_TAG', 'CONFLICT'],
    ['ANONYMIZED', 'CONFLICT'],
  ] as const)('maps %s to %s', async (reason, code) => {
    mocks.getCustomer.mockRejectedValueOnce(new CustomerError(`customer ${reason}`, reason));
    await expect(caller().detail({ customerId: 'customer_1' })).rejects.toMatchObject({
      code,
      message: `customer ${reason}`,
    });
  });
});

describe('privacy audit', () => {
  it.each([
    ['export', 'restaurantCustomers.export', mocks.exportCustomerData],
    ['anonymize', 'restaurantCustomers.anonymize', mocks.anonymizeCustomer],
  ] as const)(
    '%s records only target metadata and skips input',
    async (operation, action, domain) => {
      const input = { customerId: 'customer_1' };
      await caller()[operation](input);

      expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
        action,
        targetType: 'RestaurantCustomer',
        targetId: 'customer_1',
        skipInput: true,
      });
      expect(mocks.annotateAudit.mock.invocationCallOrder[0]).toBeLessThan(
        domain.mock.invocationCallOrder[0] ?? Infinity
      );
      const detail = mocks.recordTrpcAudit.mock.calls[0]?.[0].ctx.audit.detail;
      expect(detail).toEqual({
        action,
        targetType: 'RestaurantCustomer',
        targetId: 'customer_1',
        skipInput: true,
      });
      expect(mocks.recordTrpcAudit.mock.calls[0]?.[0].input).toBe('[skipped]');
      expect(JSON.stringify(detail)).not.toMatch(
        /email|phone|name|notes|payload|consent|exported/i
      );
    }
  );

  it('suppresses PII before input validation fails', async () => {
    await expect(
      caller().create({ displayName: 'Private Person', unknown: 'private@example.com' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.annotateAudit.mock.calls[0]?.[1]).toEqual({ skipInput: true });
    expect(mocks.recordTrpcAudit.mock.calls[0]?.[0]).toMatchObject({
      input: '[skipped]',
      outcome: 'FAILURE',
    });
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });
});

it('trims and normalizes email before domain delegation and preserves Dates', async () => {
  const verifiedAt = new Date('2026-08-21T00:00:00.000Z');
  await caller().create({
    identifiers: [{ kind: 'EMAIL', value: '  Person@Example.COM  ', verifiedAt }],
  });
  expect(mocks.createCustomer).toHaveBeenCalledWith(db, {
    identifiers: [{ kind: 'EMAIL', value: 'person@example.com', verifiedAt }],
  });

  await caller().correct({
    customerId: 'customer_1',
    identifiers: [
      { id: 'identifier_1', kind: 'EMAIL', value: 'Corrected@Example.COM', verifiedAt },
    ],
  });
  expect(mocks.correctCustomer).toHaveBeenCalledWith(db, {
    customerId: 'customer_1',
    identifiers: [
      { id: 'identifier_1', kind: 'EMAIL', value: 'corrected@example.com', verifiedAt },
    ],
  });
});
