import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_sms_a_${suffix}`;
const orgB = `org_sms_b_${suffix}`;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

async function organization(organizationId: string) {
  return tenant(organizationId, async (db: ScopedDb) => {
    await db.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: {
        id: organizationId,
        slug: organizationId,
        legalName: organizationId,
        displayName: organizationId,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        currency: 'PKR',
      },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Patient', phone: '03001234567' },
    });
    return db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: 'Customer' },
    });
  });
}

let customerA: { id: string };

beforeAll(async () => {
  if (!url) return;
  tenant = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  customerA = await organization(orgA);
  await organization(orgB);
});

suite('#723 SMS fallback schema (restricted PostgreSQL)', () => {
  it('stores SMS channel rows, including ORDER_READY, under the existing dedupe key', async () => {
    const rows = await tenant(orgA, (db) =>
      db.pharmacyMessageLog.createManyAndReturn({
        data: [
          {
            organizationId: orgA,
            channel: 'SMS',
            direction: 'OUTBOUND',
            kind: 'ORDER_READY',
            status: 'PENDING',
            dedupeKey: `sms:order-ready:${suffix}`,
            customerId: customerA.id,
            phoneLast4: '4567',
          },
        ],
        skipDuplicates: true,
        select: { id: true, channel: true },
      })
    );
    expect(rows).toEqual([{ id: expect.any(String), channel: 'SMS' }]);
    const replay = await tenant(orgA, (db) =>
      db.pharmacyMessageLog.createManyAndReturn({
        data: [
          {
            organizationId: orgA,
            channel: 'SMS',
            direction: 'OUTBOUND',
            kind: 'ORDER_READY',
            status: 'PENDING',
            dedupeKey: `sms:order-ready:${suffix}`,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      })
    );
    expect(replay).toEqual([]);
  });

  it('still refuses channels and kinds outside the guard', async () => {
    const insert = (channel: string, kind: string) =>
      tenant(orgA, (db) =>
        db.pharmacyMessageLog.create({
          data: {
            organizationId: orgA,
            channel,
            direction: 'OUTBOUND',
            kind,
            status: 'PENDING',
            dedupeKey: `bad:${channel}:${kind}:${randomBytes(4).toString('hex')}`,
          },
        })
      );
    await expect(insert('EMAIL', 'REFILL_REMINDER')).rejects.toThrow();
    await expect(insert('SMS', 'PROMOTION')).rejects.toThrow();
  });

  it('keeps SMS log rows tenant-isolated', async () => {
    const foreign = await tenant(orgB, (db) =>
      db.pharmacyMessageLog.count({ where: { dedupeKey: `sms:order-ready:${suffix}` } })
    );
    expect(foreign).toBe(0);
  });

  it('persists the SMS STOP flag on the customer', async () => {
    const at = new Date();
    const updated = await tenant(orgA, (db) =>
      db.pharmacyCustomer.update({
        where: { id: customerA.id },
        data: { smsOptIn: false, smsOptInChangedAt: at },
        select: { smsOptIn: true, smsOptInChangedAt: true },
      })
    );
    expect(updated).toEqual({ smsOptIn: false, smsOptInChangedAt: at });
  });
});
