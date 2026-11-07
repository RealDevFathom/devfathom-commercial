import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '@/lib/secret-crypto';
import { runCustomerPortalEffect, stagePortalPhoto } from './customer-portal-effects';
import { sendCustomerSms } from './customer-otp-delivery';
import { deletePrescriptionFile } from './prescription-files';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  outboundEffect: { createMany: vi.fn() },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_org: string, fn: (client: unknown) => unknown) => fn(db),
}));
vi.mock('./counter', () => ({ readCounterReceipt: vi.fn() }));
vi.mock('./family-khata', () => ({ readKhataBalance: vi.fn() }));
vi.mock('./customer-otp-delivery', () => ({ sendCustomerSms: vi.fn() }));
vi.mock('./prescription-files', async (original) => ({
  ...(await original<typeof import('./prescription-files')>()),
  deletePrescriptionFile: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'test-only-queue-encryption-key');
  db.$queryRaw.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe('customer portal committed effects', () => {
  const photo = '/api/pharmacy/prescription-files?id=cc56d757-2cd8-4bbf-b077-18def61fa649';
  const sms = (organizationId = 'org-a') => ({
    challengeId: 'cc56d757-2cd8-4bbf-b077-18def61fa649',
    encrypted: encryptSecret(
      JSON.stringify({ organizationId, phone: '923001234567', code: '123456' })
    ),
  });

  it('does not send expired, consumed, locked or superseded codes', async () => {
    await runCustomerPortalEffect('pharmacy-customer-sms', sms(), 'org-a');
    expect(sendCustomerSms).not.toHaveBeenCalled();
    const query = db.$queryRaw.mock.calls[0][0];
    expect(query.text).toContain('"consumedAt" IS NULL');
    expect(query.text).toContain('attempts<"maxAttempts"');
    expect(query.text).toContain('"expiresAt">CURRENT_TIMESTAMP');
    expect(query.values).toContain('org-a');
  });

  it('delivers a live code and rejects encrypted payloads for another tenant', async () => {
    db.$queryRaw.mockResolvedValue([{ id: 'live' }]);
    await runCustomerPortalEffect('pharmacy-customer-sms', sms(), 'org-a');
    expect(sendCustomerSms).toHaveBeenCalledWith('org-a', '923001234567', '123456');
    vi.mocked(sendCustomerSms).mockClear();
    await expect(
      runCustomerPortalEffect('pharmacy-customer-sms', sms('org-b'), 'org-a')
    ).rejects.toThrow();
    expect(sendCustomerSms).not.toHaveBeenCalled();
  });

  it('leaves provider errors available for worker retry', async () => {
    db.$queryRaw.mockResolvedValue([{ id: 'live' }]);
    vi.mocked(sendCustomerSms).mockRejectedValueOnce(new Error('provider failed'));
    await expect(runCustomerPortalEffect('pharmacy-customer-sms', sms(), 'org-a')).rejects.toThrow(
      'provider failed'
    );
  });

  it('cleans orphaned photos and keeps photos linked by a successful retry', async () => {
    await runCustomerPortalEffect(
      'pharmacy-customer-photo-cleanup',
      { sourceFileRef: photo },
      'org-a'
    );
    expect(deletePrescriptionFile).toHaveBeenCalledWith('org-a', photo);
    vi.mocked(deletePrescriptionFile).mockClear();
    db.$queryRaw.mockResolvedValue([{ id: 'request-a' }]);
    await runCustomerPortalEffect(
      'pharmacy-customer-photo-cleanup',
      { sourceFileRef: photo },
      'org-a'
    );
    expect(deletePrescriptionFile).not.toHaveBeenCalled();
  });

  it('records a future cleanup for each unique staged upload', async () => {
    const first = await stagePortalPhoto(db as unknown as ScopedDb, 'org-a');
    const retry = await stagePortalPhoto(db as unknown as ScopedDb, 'org-a');
    expect(first.sourceFileRef).not.toBe(retry.sourceFileRef);
    expect(db.outboundEffect.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: first.cleanupEffectId,
          organizationId: 'org-a',
          kind: 'pharmacy-customer-photo-cleanup',
          payload: { sourceFileRef: first.sourceFileRef },
          availableAt: expect.any(Date),
        }),
      ],
    });
  });

  it('purges only expired credentials within the worker tenant', async () => {
    await runCustomerPortalEffect('pharmacy-customer-credential-cleanup', {}, 'org-a');
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    for (const [query] of db.$executeRaw.mock.calls) {
      expect(query.text).toContain('"expiresAt"<=CURRENT_TIMESTAMP');
      expect(query.values).toEqual(['org-a']);
    }
  });
});
