import 'server-only';

import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@/generated/prisma/client';

/** Consent evidence is no longer useful after this bounded compliance window. */
export const WHATSAPP_CONSENT_ARCHIVE_RETENTION_DAYS = 6 * 365;

type ArchiveDb = Pick<PrismaClient, 'pharmacyCustomer' | 'pharmacyWhatsAppConsentArchive'>;

function archiveKey(): string {
  const key = process.env.PLATFORM_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is required to archive WhatsApp consent.');
  return key;
}

function fingerprint(key: string, domain: string, value: string): string {
  return createHmac('sha256', key).update(`whatsapp-consent:${domain}:${value}`).digest('hex');
}

/** Run from the platform worker even when no tenants are waiting for purge. */
export async function deleteExpiredWhatsAppConsentArchives(
  db: Pick<ArchiveDb, 'pharmacyWhatsAppConsentArchive'>,
  now = new Date()
): Promise<void> {
  await db.pharmacyWhatsAppConsentArchive.deleteMany({ where: { expiresAt: { lte: now } } });
}

/**
 * Preserve the minimum proof needed before tenant erasure. This deliberately
 * excludes names, phone fragments, message IDs and organization IDs.
 */
export async function archiveWhatsAppConsentBeforeTenantPurge(
  db: ArchiveDb,
  organizationId: string,
  now = new Date()
): Promise<void> {
  const consent = await db.pharmacyCustomer.findMany({
    where: { organizationId, whatsappOptIn: { not: null }, whatsappOptInChangedAt: { not: null } },
    select: { id: true, whatsappOptIn: true, whatsappOptInChangedAt: true },
  });
  // Other verticals, and tenants without recorded consent, need no archive key.
  if (!consent.length) return;
  const key = archiveKey();
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + WHATSAPP_CONSENT_ARCHIVE_RETENTION_DAYS);

  await deleteExpiredWhatsAppConsentArchives(db, now);
  const organizationFingerprint = fingerprint(key, 'organization', organizationId);
  await db.pharmacyWhatsAppConsentArchive.createMany({
    data: consent.map((row) => ({
      organizationFingerprint,
      customerFingerprint: fingerprint(key, 'customer', `${organizationId}:${row.id}`),
      optedIn: row.whatsappOptIn!,
      consentChangedAt: row.whatsappOptInChangedAt!,
      archivedAt: now,
      expiresAt,
    })),
    skipDuplicates: true,
  });
}
