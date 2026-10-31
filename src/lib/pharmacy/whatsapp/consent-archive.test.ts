import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  archiveWhatsAppConsentBeforeTenantPurge,
  WHATSAPP_CONSENT_ARCHIVE_RETENTION_DAYS,
} from './consent-archive';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('archiveWhatsAppConsentBeforeTenantPurge', () => {
  it('retains only keyed fingerprints, consent state and bounded dates', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'test-only-secret');
    const changedAt = new Date('2026-10-22T09:10:11.000Z');
    const now = new Date('2026-10-28T12:00:00.000Z');
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = {
      pharmacyCustomer: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'customer-private-id', whatsappOptIn: false, whatsappOptInChangedAt: changedAt },
          ]),
      },
      pharmacyWhatsAppConsentArchive: { createMany, deleteMany },
    };

    await archiveWhatsAppConsentBeforeTenantPurge(db as never, 'organization-private-id', now);

    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: now } } });
    const record = createMany.mock.calls[0]![0].data[0];
    expect(record).toMatchObject({ optedIn: false, consentChangedAt: changedAt, archivedAt: now });
    expect(record.expiresAt).toEqual(
      new Date(now.getTime() + WHATSAPP_CONSENT_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    );
    expect(record.organizationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(record.customerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('private-id');
  });

  it('does not silently create linkable hashes without the platform secret', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '');
    const db = {
      pharmacyCustomer: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'customer-id', whatsappOptIn: true, whatsappOptInChangedAt: new Date() },
          ]),
      },
      pharmacyWhatsAppConsentArchive: { createMany: vi.fn(), deleteMany: vi.fn() },
    };

    await expect(
      archiveWhatsAppConsentBeforeTenantPurge(db as never, 'organization-id')
    ).rejects.toThrow(/PLATFORM_ENCRYPTION_KEY/);
    expect(db.pharmacyWhatsAppConsentArchive.deleteMany).not.toHaveBeenCalled();
    expect(db.pharmacyWhatsAppConsentArchive.createMany).not.toHaveBeenCalled();
  });

  it('allows purges without a platform secret when there is no consent to retain', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '');
    const db = {
      pharmacyCustomer: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyWhatsAppConsentArchive: { createMany: vi.fn(), deleteMany: vi.fn() },
    };

    await expect(
      archiveWhatsAppConsentBeforeTenantPurge(db as never, 'organization-id')
    ).resolves.toBeUndefined();
    expect(db.pharmacyWhatsAppConsentArchive.createMany).not.toHaveBeenCalled();
  });
});
