import 'server-only';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { portalHash, type PreparedPortalPhoto } from './customer-portal';
import { sendCustomerSms } from './customer-otp-delivery';
import { deletePrescriptionFile, prescriptionFileRefSchema } from './prescription-files';

export async function queuePortalSms(
  db: ScopedDb,
  organizationId: string,
  challengeId: string,
  delivery: { phone: string; code: string }
) {
  await db.outboundEffect.createMany({
    data: [
      {
        organizationId,
        kind: 'pharmacy-customer-sms',
        payload: {
          challengeId,
          encrypted: encryptSecret(JSON.stringify({ organizationId, ...delivery })),
        },
      },
    ],
  });
}

/** Schedule expiry cleanup even if this customer never visits the portal again. */
export async function queuePortalCredentialCleanup(
  db: ScopedDb,
  organizationId: string,
  availableAt: Date
) {
  await db.outboundEffect.createMany({
    data: [
      { organizationId, kind: 'pharmacy-customer-credential-cleanup', payload: {}, availableAt },
    ],
  });
}

/** Commit this cleanup before touching storage; rollback and retries cannot orphan a photo. */
export async function stagePortalPhoto(
  db: ScopedDb,
  organizationId: string
): Promise<PreparedPortalPhoto> {
  const photo = {
    sourceFileRef: `/api/pharmacy/prescription-files?id=${randomUUID()}`,
    cleanupEffectId: randomUUID(),
  };
  await db.outboundEffect.createMany({
    data: [
      {
        id: photo.cleanupEffectId,
        organizationId,
        kind: 'pharmacy-customer-photo-cleanup',
        payload: { sourceFileRef: photo.sourceFileRef },
        availableAt: new Date(Date.now() + 60 * 60_000),
      },
    ],
  });
  return photo;
}

/** Runs only on committed queue rows, using the worker's tenant rather than a payload tenant. */
export async function runCustomerPortalEffect(
  kind: string,
  payload: Prisma.JsonValue,
  organizationId: string
) {
  if (kind === 'pharmacy-customer-sms') {
    const queued = z.object({ challengeId: z.uuid(), encrypted: z.string() }).parse(payload);
    const delivery = z
      .object({
        organizationId: z.literal(organizationId),
        phone: z.string().regex(/^[1-9]\d{7,14}$/),
        code: z.string().regex(/^\d{6}$/),
      })
      .parse(JSON.parse(decryptSecret(queued.encrypted)));
    const live = await withTenantDb(
      organizationId,
      (db) =>
        db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM pharmacy_customer_otp_challenges WHERE id=${queued.challengeId}
        AND "organizationId"=${organizationId} AND "phoneHash"=${portalHash(delivery.phone)}
        AND "consumedAt" IS NULL AND attempts<"maxAttempts" AND "expiresAt">CURRENT_TIMESTAMP`),
      { skipDrain: true }
    );
    // A resend or queue delay must never deliver a consumed/expired code.
    if (live[0]) await sendCustomerSms(organizationId, delivery.phone, delivery.code);
    return;
  }
  if (kind === 'pharmacy-customer-photo-cleanup') {
    const { sourceFileRef } = z.object({ sourceFileRef: prescriptionFileRefSchema }).parse(payload);
    const linked = await withTenantDb(
      organizationId,
      (db) =>
        db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM pharmacy_customer_requests WHERE "organizationId"=${organizationId}
        AND "sourceFileRef"=${sourceFileRef} LIMIT 1`),
      { skipDrain: true }
    );
    // Claiming the cleanup job blocks any future link to this staging record.
    if (!linked[0]) await deletePrescriptionFile(organizationId, sourceFileRef);
    return;
  }
  if (kind === 'pharmacy-customer-credential-cleanup') {
    await withTenantDb(
      organizationId,
      async (db) => {
        await db.$executeRaw(Prisma.sql`DELETE FROM pharmacy_customer_otp_challenges
        WHERE "organizationId"=${organizationId} AND "expiresAt"<=CURRENT_TIMESTAMP`);
        await db.$executeRaw(Prisma.sql`DELETE FROM pharmacy_customer_sessions
        WHERE "organizationId"=${organizationId} AND "expiresAt"<=CURRENT_TIMESTAMP`);
      },
      { skipDrain: true }
    );
    return;
  }
  throw new Error('Unsupported customer portal effect');
}
