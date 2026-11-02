import { afterEach, expect, it, vi } from 'vitest';
import { paymentSandboxAdmitted } from './payment-sandbox-admission';
import { executeSandboxPayment, nextSandboxPaymentState } from './payment-sandbox';
import { applyPharmacyTender } from './settlement';
vi.mock('./settlement', () => ({ applyPharmacyTender: vi.fn(), refundPharmacyTender: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('admits only explicit disposable loopback payment simulation', () => {
  const env = {
    PHARMACY_PAYMENT_SANDBOX_ADMITTED: 'true',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1:55625/wha1364_business_disposable_20261008',
  };
  expect(paymentSandboxAdmitted(env)).toBe(true);
  for (const url of [
    'postgresql://fixture@127.0.0.1:55621/catalogue',
    'postgresql://fixture@external:55625/wha1364_business_disposable_20261008',
    'postgresql://fixture@127.0.0.1:55620/wha1364_business_disposable_20261008',
  ])
    expect(paymentSandboxAdmitted({ ...env, DATABASE_URL: url })).toBe(false);
  expect(paymentSandboxAdmitted({ ...env, PHARMACY_PAYMENT_SANDBOX_ADMITTED: '' })).toBe(false);
});
it('rejects production even with the sandbox flag and disposable database admitted', () => {
  const env = {
    PHARMACY_PAYMENT_SANDBOX_ADMITTED: 'true',
    DATABASE_URL: 'postgresql://fixture@localhost:55625/wha1364_business_disposable_20261008',
  };
  expect(paymentSandboxAdmitted({ ...env, NODE_ENV: 'production' })).toBe(false);
  expect(paymentSandboxAdmitted({ ...env, NODE_ENV: 'development' })).toBe(true);
  expect(paymentSandboxAdmitted({ ...env, NODE_ENV: 'test' })).toBe(true);

  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PHARMACY_PAYMENT_SANDBOX_ADMITTED', env.PHARMACY_PAYMENT_SANDBOX_ADMITTED);
  vi.stubEnv('DATABASE_URL', env.DATABASE_URL);
  expect(paymentSandboxAdmitted()).toBe(false);
});
it('never automatically resends an unknown operation', () => {
  expect(() => nextSandboxPaymentState('UNKNOWN', 'APPROVED', 'RETRY')).toThrow(
    'RECONCILIATION_REQUIRED'
  );
  expect(() => nextSandboxPaymentState('UNKNOWN', 'APPROVED', 'EXECUTE')).toThrow(
    'RECONCILIATION_REQUIRED'
  );
  expect(nextSandboxPaymentState('UNKNOWN', 'APPROVED', 'RECONCILE')).toBe('APPROVED');
});
it('permits definite failure retry and preserves approved replay', () => {
  expect(nextSandboxPaymentState('FAILED', 'APPROVED', 'RETRY')).toBe('APPROVED');
  expect(nextSandboxPaymentState('APPROVED', 'FAILED', 'EXECUTE')).toBe('APPROVED');
  expect(() => nextSandboxPaymentState(null, 'APPROVED', 'RECONCILE')).toThrow('INVALID_STATE');
});
it('persists unknown, refuses automatic retry, then reconciles exactly once through settlement', async () => {
  vi.stubEnv('PHARMACY_PAYMENT_SANDBOX_ADMITTED', 'true');
  vi.stubEnv(
    'DATABASE_URL',
    'postgresql://fixture@127.0.0.1:55625/wha1364_business_disposable_20261008'
  );
  let saved: Record<string, unknown> | null = null;
  const db = {
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ id: 'sale-a' }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(async (query) => {
      saved ??= {
        id: query.values[0],
        deviceId: query.values[2],
        key: query.values[3],
        commandType: 'sandbox_payment',
        payloadHash: query.values[4],
        resultPayload: null,
      };
    }),
    pharmacyMoneyIdempotencyKey: {
      findFirst: vi.fn(async () => saved),
      findMany: vi.fn(async () =>
        saved && (saved.resultPayload as { status?: string } | null)?.status === 'UNKNOWN'
          ? [saved]
          : []
      ),
      findUnique: vi.fn(async () => saved),
      update: vi.fn(async ({ data }) => {
        saved = { ...saved, ...data };
        return saved;
      }),
    },
  };
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
  const input = {
    branchId: scope.branchId,
    saleId: 'sale-a',
    action: 'SALE' as const,
    type: 'CARD' as const,
    deviceId: 'device-a',
    businessDate: new Date('2026-10-08'),
    amountMinor: 700,
    operationKey: 'ordinary-a',
    outcome: 'UNKNOWN' as const,
    mode: 'EXECUTE' as const,
    reason: 'synthetic test',
  };
  expect(await executeSandboxPayment(db as never, scope, input)).toMatchObject({
    status: 'UNKNOWN',
    simulated: true,
  });
  expect(applyPharmacyTender).not.toHaveBeenCalled();
  await expect(
    executeSandboxPayment(db as never, scope, { ...input, outcome: 'APPROVED', mode: 'RETRY' })
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
  // A different operation key must not bypass UNKNOWN, even with changed money/type.
  db.pharmacyMoneyIdempotencyKey.findFirst.mockResolvedValueOnce(null);
  await expect(
    executeSandboxPayment(db as never, scope, {
      ...input,
      operationKey: 'fresh-key',
      amountMinor: 300,
      type: 'WALLET',
      outcome: 'APPROVED',
    })
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect(applyPharmacyTender).not.toHaveBeenCalled();
  const resolved = await executeSandboxPayment(db as never, scope, {
    ...input,
    outcome: 'APPROVED',
    mode: 'RECONCILE',
  });
  expect(resolved.history.map((entry) => entry.status)).toEqual(['UNKNOWN', 'APPROVED']);
  expect(applyPharmacyTender).toHaveBeenCalledOnce();
  expect(await executeSandboxPayment(db as never, scope, input)).toMatchObject({
    status: 'APPROVED',
    replayed: true,
  });
  expect(applyPharmacyTender).toHaveBeenCalledOnce();
  await expect(
    executeSandboxPayment(db as never, scope, { ...input, deviceId: 'device-b' })
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
