import 'server-only';

import {
  Prisma,
  type PatientConsentChannel,
  type PatientConsentPurpose,
  type PatientConsentSource,
} from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Transaction-only protocol: patient first, then customer; never acquire in reverse. */
export async function lockPatientConsent(db: ScopedDb, organizationId: string, patientId: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_patients
    WHERE "organizationId" = ${organizationId} AND id = ${patientId} FOR UPDATE
  `);
  if (rows.length !== 1) throw new Error('Patient unavailable in this workspace.');
}

export async function lockCustomerConsent(
  db: ScopedDb,
  organizationId: string,
  customerId: string
) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId, id: customerId },
    select: { patientId: true },
  });
  if (!customer) throw new Error('Customer unavailable in this workspace.');
  await lockPatientConsent(db, organizationId, customer.patientId);
  const locked = await db.$queryRaw<Array<{ patientId: string }>>(Prisma.sql`
    SELECT "patientId" FROM pharmacy_customers
    WHERE "organizationId" = ${organizationId} AND id = ${customerId} FOR UPDATE
  `);
  if (locked.length !== 1 || locked[0].patientId !== customer.patientId)
    throw new Error('Customer identity changed; retry in a new transaction.');
}

/** Caller supplies a tenant transaction. Versions and supersession are server-owned. */
export async function writePatientConsent(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  input: {
    patientId: string;
    purpose: PatientConsentPurpose;
    channel: PatientConsentChannel;
    granted: boolean;
    source?: PatientConsentSource;
    staffId?: string;
  },
  now = new Date()
) {
  await lockPatientConsent(db, organizationId, input.patientId);
  const previous = await db.patientConsent.findFirst({
    where: {
      organizationId,
      patientId: input.patientId,
      purpose: input.purpose,
      channel: input.channel,
    },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
    select: { id: true, version: true },
  });
  return db.patientConsent.create({
    data: {
      organizationId,
      patientId: input.patientId,
      purpose: input.purpose,
      channel: input.channel,
      granted: input.granted,
      version: (previous?.version ?? 0) + 1,
      supersedesId: previous?.id ?? null,
      recordedByUserId: actorId,
      source: input.source ?? 'COUNTER_TABLET',
      staffId:
        input.staffId ?? (input.source === 'QR' || input.source === 'REPLY' ? null : actorId),
      recordedAt: now,
      revokedAt: input.granted ? null : now,
    },
  });
}
