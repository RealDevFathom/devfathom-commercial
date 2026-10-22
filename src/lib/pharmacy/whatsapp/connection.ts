import 'server-only';

import { decryptSecret, encryptSecret, encryptionConfigured } from '@/lib/secret-crypto';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

import { readWhatsAppConfig, type WhatsAppConfig } from './provider';

export type EmbeddedSignupResult = {
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string | null;
};

type ConnectionRow = {
  organizationId: string;
  phoneNumberId: string;
  encryptedAccessToken: string;
  enabled: boolean;
};

/**
 * Persistence seam for the Embedded Signup callback. The sibling signup UI may
 * call this without owning credential storage. Live delivery remains disabled
 * by createWhatsAppProvider's code-level block even when `enabled` is true.
 */
export async function saveEmbeddedSignupConnection(
  organizationId: string,
  result: EmbeddedSignupResult,
  db: {
    pharmacyWhatsAppConnection: {
      upsert(args: unknown): Promise<unknown>;
    };
  }
) {
  if (!encryptionConfigured()) throw new Error('Organization secret encryption is not configured.');
  if (!/^\d{5,32}$/.test(result.phoneNumberId) || !result.accessToken.trim())
    throw new Error('Invalid WhatsApp Embedded Signup result.');
  return db.pharmacyWhatsAppConnection.upsert({
    where: { organizationId },
    create: {
      organizationId,
      phoneNumberId: result.phoneNumberId,
      wabaId: result.wabaId ?? null,
      encryptedAccessToken: encryptSecret(result.accessToken),
      enabled: false,
    },
    update: {
      phoneNumberId: result.phoneNumberId,
      wabaId: result.wabaId ?? null,
      encryptedAccessToken: encryptSecret(result.accessToken),
      enabled: false,
    },
  });
}

/** Resolve an inbound sender globally, then return only its owning tenant id and
 * decrypted runtime config. Callers must enter that tenant's scoped DB before
 * touching tenant data. Errors deliberately contain no credential material. */
export async function findWhatsAppConnectionByPhoneNumberId(
  phoneNumberId: string
): Promise<{ organizationId: string; config: WhatsAppConfig } | null> {
  if (!/^\d{5,32}$/.test(phoneNumberId) || !encryptionConfigured()) return null;
  const row = (await withPlatformDb((db) =>
    db.pharmacyWhatsAppConnection.findUnique({
      where: { phoneNumberId },
      select: {
        organizationId: true,
        phoneNumberId: true,
        encryptedAccessToken: true,
        enabled: true,
      },
    })
  )) as ConnectionRow | null;
  if (!row?.enabled) return null;
  try {
    return {
      organizationId: row.organizationId,
      config: {
        ...readWhatsAppConfig(),
        provider: 'meta',
        organizationId: row.organizationId,
        phoneNumberId: row.phoneNumberId,
        accessToken: decryptSecret(row.encryptedAccessToken),
      },
    };
  } catch {
    return null;
  }
}
