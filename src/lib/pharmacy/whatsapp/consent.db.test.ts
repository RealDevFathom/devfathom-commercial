// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Keep every handler transaction inside one rollback-only database fixture.
const scope = vi.hoisted(() => ({ tx: null as ScopedDb | null }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_organizationId: string, run: (db: ScopedDb) => Promise<unknown>) => {
    if (!scope.tx) throw new Error('Missing database fixture');
    return run(scope.tx);
  },
}));

import { writePatientConsent } from '../consent-writer';
import { marketingConsent } from '../marketing-service';
import { handleInboundWhatsAppMessage } from './inbound';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : null;
const describeDatabase = url ? describe : describe.skip;
afterAll(async () => prisma?.$disconnect());

async function fixture(
  run: (
    db: ScopedDb,
    organizationId: string,
    patientId: string,
    customerId: string
  ) => Promise<void>
) {
  const rollback = new Error('Rollback fixture');
  await expect(
    prisma!.$transaction(async (tx) => {
      const organizationId = `consent_${randomUUID().replaceAll('-', '')}`;
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true),
        set_config('app.is_platform_admin', 'false', true)`;
      await tx.$executeRaw`INSERT INTO organizations
        (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
        VALUES (${organizationId}, ${organizationId}, 'Consent test', 'Consent test',
          'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`;
      const patient = await tx.pharmacyPatient.create({
        data: { organizationId, displayName: 'Consent test', phone: '0300-1234567' },
      });
      const customer = await tx.pharmacyCustomer.create({
        data: {
          organizationId,
          patientId: patient.id,
          displayName: 'Consent test',
          whatsappOptIn: false,
        },
      });
      scope.tx = tx as ScopedDb;
      await run(scope.tx, organizationId, patient.id, customer.id);
      throw rollback;
    })
  ).rejects.toBe(rollback);
  scope.tx = null;
}

describeDatabase('WhatsApp purpose consent database regressions', () => {
  const now = new Date('2026-10-06T13:00:00Z');
  const provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
  const message = (text: string, timestamp: string) => ({
    providerMessageId: `wamid.${randomUUID()}`,
    from: '923001234567',
    text,
    receivedAt: new Date(timestamp),
    phoneNumberId: null,
  });
  const marketingScope = (organizationId: string) => ({
    organizationId,
    branchId: 'unused',
    actorId: 'staff-test',
    timezone: 'UTC',
  });

  it('START leaves a utility-only customer ineligible for campaigns', async () => {
    await fixture(async (db, organizationId, patientId, customerId) => {
      await writePatientConsent(
        db,
        organizationId,
        'staff-test',
        {
          patientId,
          purpose: 'REMINDERS',
          channel: 'WHATSAPP',
          granted: true,
        },
        new Date('2026-10-06T09:00:00Z')
      );
      expect(
        await handleInboundWhatsAppMessage(
          organizationId,
          provider,
          message('START', '2026-10-06T10:00:00Z'),
          now
        )
      ).toBe('OPTED_IN');
      expect(
        await db.patientConsent.count({ where: { organizationId, purpose: 'MARKETING' } })
      ).toBe(0);
      expect(await marketingConsent(db, marketingScope(organizationId), customerId, now)).toBe(
        'NO_CONSENT'
      );
    });
  });

  it.each(['COUNTER_TABLET', 'QR'] as const)(
    'delayed START preserves a newer %s refusal',
    async (source) => {
      await fixture(async (db, organizationId, patientId, customerId) => {
        const refusal = await writePatientConsent(
          db,
          organizationId,
          'staff-test',
          {
            patientId,
            purpose: 'MARKETING',
            channel: 'WHATSAPP',
            granted: false,
            source,
          },
          new Date('2026-10-06T11:00:00Z')
        );
        expect(
          await handleInboundWhatsAppMessage(
            organizationId,
            provider,
            message('START', '2026-10-06T10:00:00Z'),
            now
          )
        ).toBe('OPTED_IN');
        expect(await db.patientConsent.findMany({ where: { organizationId } })).toEqual([refusal]);
        expect(await marketingConsent(db, marketingScope(organizationId), customerId, now)).toBe(
          'OPTED_OUT'
        );
      });
    }
  );

  it('delayed STOP preserves newer purpose history while disabling WhatsApp', async () => {
    await fixture(async (db, organizationId, patientId, customerId) => {
      const grant = await writePatientConsent(
        db,
        organizationId,
        'staff-test',
        {
          patientId,
          purpose: 'MARKETING',
          channel: 'WHATSAPP',
          granted: true,
          source: 'QR',
        },
        new Date('2026-10-06T11:00:00Z')
      );
      expect(
        await handleInboundWhatsAppMessage(
          organizationId,
          provider,
          message('STOP', '2026-10-06T10:00:00Z'),
          now
        )
      ).toBe('OPTED_OUT');
      expect(await db.patientConsent.findMany({ where: { organizationId } })).toEqual([grant]);
      expect(await marketingConsent(db, marketingScope(organizationId), customerId, now)).toBe(
        'OPTED_OUT'
      );
    });
  });

  it('excludes a March 1 minor on leap day and admits them on their birthday', async () => {
    await fixture(async (db, organizationId, patientId, customerId) => {
      await db.pharmacyPatient.update({
        where: { id: patientId },
        data: { dateOfBirth: new Date('2010-03-01') },
      });
      await db.pharmacyCustomer.update({
        where: { id: customerId },
        data: { whatsappOptIn: true },
      });
      await writePatientConsent(
        db,
        organizationId,
        'staff-test',
        {
          patientId,
          purpose: 'MARKETING',
          channel: 'WHATSAPP',
          granted: true,
        },
        now
      );
      expect(
        await marketingConsent(
          db,
          marketingScope(organizationId),
          customerId,
          new Date('2028-02-29')
        )
      ).toBe('UNDER_18');
      expect(
        await marketingConsent(
          db,
          marketingScope(organizationId),
          customerId,
          new Date('2028-03-01')
        )
      ).toBeNull();
    });
  });
});
