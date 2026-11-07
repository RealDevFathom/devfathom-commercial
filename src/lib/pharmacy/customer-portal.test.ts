import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { customerPortalSettingsSchema } from './customer-portal-contract';
import {
  customerPortalScope,
  createPortalRequest,
  portalHash,
  portalReceipt,
  updatePortalRequest,
} from './customer-portal';
import { sendCustomerSms } from './customer-otp-delivery';
import {
  assertPortalStaffBranch,
  readableCustomerRequestPhoto,
  reauthenticatePortalStaff,
} from './customer-portal-staff';
import { readCounterReceipt } from './counter';
import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';

vi.mock('./counter', () => ({ readCounterReceipt: vi.fn() }));
vi.mock('./prescription-files', async (original) => ({
  ...(await original<typeof import('./prescription-files')>()),
  persistPrescriptionFile: vi.fn(),
}));
vi.mock('./family-khata', () => ({ readKhataBalance: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: vi.fn(), subjectFromSession: (u: unknown) => u }));
vi.mock('@/lib/restaurant/operator-credentials', async (original) => ({
  ...(await original<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(),
}));

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  customerId: 'customer-a',
  patientId: 'patient-a',
};
const request = {
  ...scope,
  id: 'request-a',
  status: 'AWAITING_PHARMACIST',
  kind: 'RX_PHOTO',
  sourceFileRef: '/api/pharmacy/prescription-files?id=photo-a',
  createdAt: new Date('2026-01-01'),
};
function fixture() {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a', name: 'Branch A' }) },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyCustomer: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ patientId: 'patient-a', patient: { phone: '03001234567' } }),
    },
    pharmacySale: { findFirst: vi.fn() },
    restaurantStaffProfile: { findFirst: vi.fn().mockResolvedValue({ id: 'profile-a' }) },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'credential-a',
        failedAttempts: 4,
        lockedUntil: null,
        credentialHash: 'hash',
      }),
      update: vi.fn(),
    },
  };
}
beforeEach(() => vi.clearAllMocks());

describe('customer portal identity and requests', () => {
  it('never treats a staff cookie or an arbitrary token as a customer identity', async () => {
    const f = fixture();
    for (const token of [null, 'authjs.session-token=staff', 'short'])
      await expect(
        customerPortalScope(f as unknown as ScopedDb, 'org-a', token)
      ).rejects.toMatchObject({ status: 401 });
    expect(f.$queryRaw).not.toHaveBeenCalled();
  });
  it('rejects a missing, revoked, expired or foreign-tenant session', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([]);
    await expect(
      customerPortalScope(f as unknown as ScopedDb, 'org-b', 'a'.repeat(43))
    ).rejects.toMatchObject({ status: 401 });
    expect(f.$queryRaw.mock.calls[0][0].values).toContain('org-b');
    expect(f.pharmacyCustomer.findFirst).not.toHaveBeenCalled();
  });
  it('invalidates a session when the registered phone changes', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([
      { branchId: 'branch-a', customerId: 'customer-a', phoneHash: portalHash('923009999999') },
    ]);
    await expect(
      customerPortalScope(f as unknown as ScopedDb, 'org-a', 'a'.repeat(43))
    ).rejects.toMatchObject({ status: 401 });
  });
  it('binds a valid identity to the server-read customer, patient, and active branch', async () => {
    const f = fixture();
    f.$queryRaw
      .mockResolvedValueOnce([
        { branchId: 'branch-a', customerId: 'customer-a', phoneHash: portalHash('923001234567') },
      ])
      .mockResolvedValueOnce([{ config: { enabled: true } }])
      .mockResolvedValue([]);
    await expect(
      customerPortalScope(f as unknown as ScopedDb, 'org-a', 'a'.repeat(43))
    ).resolves.toEqual(scope);
  });
  it('checks receipt ownership before invoking the existing receipt reader', async () => {
    const f = fixture();
    f.pharmacySale.findFirst.mockResolvedValue(null);
    await expect(
      portalReceipt(f as unknown as ScopedDb, scope, 'sale-b', 'PKR')
    ).rejects.toMatchObject({ status: 404 });
    expect(f.pharmacySale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          customerId: 'customer-a',
          id: 'sale-b',
        }),
      })
    );
    expect(readCounterReceipt).not.toHaveBeenCalled();
  });
  it('rejects a refill of another customer’s purchase without writing a request', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([]);
    f.pharmacySale.findFirst.mockResolvedValue(null);
    await expect(
      createPortalRequest(f as unknown as ScopedDb, scope, {
        action: 'refill',
        saleId: 'sale-b',
        idempotencyKey: 'key',
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(f.$executeRaw).not.toHaveBeenCalled();
  });
  it('replays a request retry without duplicating it', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...request,
        kind: 'REFILL',
        sourceSaleId: 'sale-a',
        payloadHash: portalHash(JSON.stringify(['REFILL', 'sale-a'])),
      },
    ]);
    await expect(
      createPortalRequest(f as unknown as ScopedDb, scope, {
        action: 'refill',
        saleId: 'sale-a',
        idempotencyKey: 'key',
      })
    ).resolves.toMatchObject({ id: request.id, replayed: true });
    expect(f.$executeRaw).not.toHaveBeenCalled();
  });
  it('blocks fulfilment until pharmacist approval', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([request]);
    await expect(
      updatePortalRequest(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        request.id,
        'FULFIL',
        'sale-a'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(f.pharmacySale.findFirst).not.toHaveBeenCalled();
  });
  it('refuses a sale already used to fulfil another request', async () => {
    const f = fixture();
    f.$queryRaw
      .mockResolvedValueOnce([{ ...request, status: 'APPROVED' }])
      .mockResolvedValueOnce([{ id: 'sale-a' }])
      .mockResolvedValueOnce([{ id: 'other-request' }]);
    await expect(
      updatePortalRequest(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        request.id,
        'FULFIL',
        'sale-a'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(f.$executeRaw).not.toHaveBeenCalled();
    expect(f.pharmacySale.findFirst).not.toHaveBeenCalled();
  });
  it.each<
    [string, { medicineId: string; presentationId: string; canonicalUnits: number }[], boolean]
  >([
    ['wrong item', [{ medicineId: 'other', presentationId: 'pack', canonicalUnits: 10 }], false],
    [
      'wrong presentation',
      [{ medicineId: 'medicine', presentationId: 'other', canonicalUnits: 10 }],
      false,
    ],
    [
      'wrong quantity',
      [{ medicineId: 'medicine', presentationId: 'pack', canonicalUnits: 5 }],
      false,
    ],
    ['empty purchase', [], false],
    [
      'matching split lines',
      [
        { medicineId: 'medicine', presentationId: 'pack', canonicalUnits: 4 },
        { medicineId: 'medicine', presentationId: 'pack', canonicalUnits: 6 },
      ],
      true,
    ],
  ])('checks refill items and canonical quantities: %s', async (_name, lines, allowed) => {
    const f = fixture();
    f.$queryRaw
      .mockResolvedValueOnce([
        { ...request, kind: 'REFILL', status: 'APPROVED', sourceSaleId: 'source-sale' },
      ])
      .mockResolvedValue([]);
    f.pharmacySale.findFirst.mockResolvedValueOnce({ lines }).mockResolvedValueOnce({
      lines: [{ medicineId: 'medicine', presentationId: 'pack', canonicalUnits: 10 }],
    });
    const work = updatePortalRequest(
      f as unknown as ScopedDb,
      { ...scope, actorId: 'owner-a' },
      request.id,
      'FULFIL',
      'sale-a'
    );
    if (allowed) await expect(work).resolves.toMatchObject({ status: 'FULFILLED' });
    else {
      await expect(work).rejects.toMatchObject({ status: 409 });
      expect(f.$executeRaw).not.toHaveBeenCalled();
    }
  });
  it('does not link a photo after its cleanup job has been claimed', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([]);
    await expect(
      createPortalRequest(
        f as unknown as ScopedDb,
        scope,
        {
          action: 'photo',
          contentType: 'image/png',
          dataBase64: 'aGVsbG8=',
          idempotencyKey: 'key',
        },
        {
          sourceFileRef: '/api/pharmacy/prescription-files?id=cc56d757-2cd8-4bbf-b077-18def61fa649',
          cleanupEffectId: 'cleanup-a',
        }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(f.$queryRaw.mock.calls[0][0].text).toContain("status='PENDING'");
    expect(f.$executeRaw).not.toHaveBeenCalled();
  });
  it('requires an approved photo request’s completed sale to reference the original Rx', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValueOnce([{ ...request, status: 'APPROVED' }]).mockResolvedValue([]);
    f.pharmacySale.findFirst.mockResolvedValue({
      lines: [{ prescriptionLine: { prescription: { sourceFileRef: 'other' } } }],
    });
    await expect(
      updatePortalRequest(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        request.id,
        'FULFIL',
        'sale-a'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(f.$executeRaw).not.toHaveBeenCalled();
    f.$queryRaw.mockResolvedValueOnce([{ ...request, status: 'APPROVED' }]);
    f.pharmacySale.findFirst.mockResolvedValue({
      lines: [{ prescriptionLine: { prescription: { sourceFileRef: request.sourceFileRef } } }],
    });
    await expect(
      updatePortalRequest(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        request.id,
        'FULFIL',
        'sale-a'
      )
    ).resolves.toMatchObject({ status: 'FULFILLED' });
    expect(f.pharmacySale.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          customerId: 'customer-a',
          status: 'COMPLETED',
        }),
      })
    );
  });
});

describe('pharmacist and solo owner controls', () => {
  it('requires active branch assignment for non-administrators', async () => {
    const f = fixture();
    await expect(
      assertPortalStaffBranch(
        f as unknown as ScopedDb,
        'org-a',
        { id: 'user-a', role: 'EMPLOYEE' },
        'branch-a'
      )
    ).rejects.toMatchObject({ status: 403 });
  });
  it('commits PIN lockout evidence on a failed self-approval', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([]);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    expect(
      await reauthenticatePortalStaff(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        '9999'
      )
    ).toBe(false);
    expect(f.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-a' },
      data: { failedAttempts: 0, lockedUntil: expect.any(Date) },
    });
    expect(f.$executeRaw.mock.calls[0][0].values).toContain('STAFF_PIN_FAILED');
  });
  it('allows the current solo owner’s own PIN and records verification', async () => {
    const f = fixture();
    f.$queryRaw.mockResolvedValue([]);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    expect(
      await reauthenticatePortalStaff(
        f as unknown as ScopedDb,
        { ...scope, actorId: 'owner-a' },
        '1234'
      )
    ).toBe(true);
    expect(f.restaurantStaffProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'owner-a' }) })
    );
    expect(f.$executeRaw.mock.calls[0][0].values).toContain('STAFF_PIN_VERIFIED');
  });
  it('does not expose customer images without dispensing permission', async () => {
    const f = fixture();
    vi.mocked(can).mockResolvedValue(false);
    expect(
      await readableCustomerRequestPhoto(
        f as unknown as ScopedDb,
        'org-a',
        { id: 'user-a' },
        { patientId: 'patient-a', uploadedByUserId: 'customer:customer-a' },
        'file-a'
      )
    ).toBe(false);
    expect(f.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('delivery and configurable values', () => {
  it('fails closed without a tenant-bound SMS sender', async () => {
    const fetcher = vi.fn();
    await expect(sendCustomerSms('org-a', '923001234567', '123456', fetcher, {})).rejects.toThrow(
      'CUSTOMER_SMS_UNAVAILABLE'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only a six-digit OTP through the configured sender', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ sid: 'SM123', status: 'queued' }));
    const env = {
      PLATFORM_ENCRYPTION_KEY: 'test-only-queue-encryption-key',
      PHARMACY_CUSTOMER_SMS_ORGANIZATION_ID: 'org-a',
      PHARMACY_CUSTOMER_SMS_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
      PHARMACY_CUSTOMER_SMS_AUTH_TOKEN: 'secret',
      PHARMACY_CUSTOMER_SMS_FROM: '+15551234567',
    };
    await sendCustomerSms('org-a', '923001234567', '123456', fetcher, env);
    const body = new URLSearchParams(fetcher.mock.calls[0][1].body);
    expect(body.get('To')).toBe('+923001234567');
    expect(body.get('Body')).toContain('123456');
    expect(body.get('Body')).not.toMatch(/medicine|drug|salt|prescription/i);
    await expect(
      sendCustomerSms('org-b', '923001234567', '123456', fetcher, env)
    ).rejects.toThrow();
    await expect(
      sendCustomerSms('org-a', '923001234567', 'clinical detail', fetcher, env)
    ).rejects.toThrow();
  });
  it('validates limits, Raast pairs, and enables only non-drug service offers', () => {
    expect(customerPortalSettingsSchema.parse({}).enabled).toBe(false);
    expect(customerPortalSettingsSchema.safeParse({ otpMaxAttempts: 99 }).success).toBe(false);
    expect(customerPortalSettingsSchema.safeParse({ raastId: '03001234567' }).success).toBe(false);
    expect(customerPortalSettingsSchema.safeParse({ drugOffer: 'medicine' }).success).toBe(false);
  });
});
