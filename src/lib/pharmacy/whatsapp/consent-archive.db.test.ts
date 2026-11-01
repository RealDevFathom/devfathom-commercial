// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient, type Prisma } from '@/generated/prisma/client';

import { deleteExpiredWhatsAppConsentArchives } from './consent-archive';

// Use a migrated throwaway database. RLS assertions require a runtime role
// without SUPERUSER or BYPASSRLS; wider visibility would hide the defect.
const url = process.env.TEST_DATABASE_URL;
const describeIfDatabase = url ? describe : describe.skip;
let db: PrismaClient;
const now = new Date('2026-10-31T12:00:00.000Z');

function evidence(expiresAt = new Date('2032-10-31T12:00:00.000Z')) {
  return {
    id: randomUUID(),
    organizationFingerprint: randomBytes(32).toString('hex'),
    customerFingerprint: randomBytes(32).toString('hex'),
    optedIn: false,
    consentChangedAt: now,
    archivedAt: new Date('2026-10-01T12:00:00.000Z'),
    expiresAt,
  };
}

// Every test rolls back, including retention's global expiry deletion.
async function rollback(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  const marker = new Error('rollback consent archive test');
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await work(tx);
      throw marker;
    })
  ).rejects.toBe(marker);
}

describeIfDatabase('WhatsApp consent archive PostgreSQL boundaries', () => {
  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it.each(['tenant-a', 'tenant-b'])('denies archive reads and writes for %s', async (tenant) => {
    await rollback(async (tx) => {
      const row = evidence();
      await tx.pharmacyWhatsAppConsentArchive.create({ data: row });
      expect(
        await tx.pharmacyWhatsAppConsentArchive.findUnique({ where: { id: row.id } })
      ).toMatchObject(row);

      await tx.$queryRaw`SELECT set_config('app.is_platform_admin', 'false', true),
        set_config('app.current_organization_id', ${tenant}, true)`;
      expect(await tx.pharmacyWhatsAppConsentArchive.findMany()).toEqual([]);
      expect(
        await tx.pharmacyWhatsAppConsentArchive.updateMany({
          where: { id: row.id },
          data: { optedIn: true },
        })
      ).toEqual({ count: 0 });
      expect(await tx.pharmacyWhatsAppConsentArchive.deleteMany()).toEqual({ count: 0 });
      await expect(tx.pharmacyWhatsAppConsentArchive.create({ data: evidence() })).rejects.toThrow(
        /row.level security/i
      );
    });
  });

  it('deletes expired evidence at the boundary and retains unexpired evidence', async () => {
    await rollback(async (tx) => {
      const expired = evidence(now);
      const current = evidence();
      await tx.pharmacyWhatsAppConsentArchive.createMany({ data: [expired, current] });

      await deleteExpiredWhatsAppConsentArchives(tx, now);

      expect(
        await tx.pharmacyWhatsAppConsentArchive.findUnique({ where: { id: expired.id } })
      ).toBeNull();
      expect(
        await tx.pharmacyWhatsAppConsentArchive.findUnique({ where: { id: current.id } })
      ).toMatchObject(current);
    });
  });
});
