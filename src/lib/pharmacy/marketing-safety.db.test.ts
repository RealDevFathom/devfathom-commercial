// @vitest-environment node
// Uses an already migrated disposable database; never applies migrations.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { parseMarketingQualityUpdates, recordMarketingQualityUpdate } from './marketing-safety';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const db = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : null;
const org = `quality775_${randomUUID()}`;
const foreignOrg = `quality775_${randomUUID()}`;
const sender = () => randomUUID();

async function tenant<T>(organizationId: string, run: (db: ScopedDb) => Promise<T>) {
  return db!.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT
      set_config('app.current_organization_id', ${organizationId}, true),
      set_config('app.is_platform_admin', 'false', true)`);
    return run(tx as ScopedDb);
  });
}

function evidence(quality: string, time = 1790000000, senderId = 'sender-a') {
  return parseMarketingQualityUpdates(
    {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'account-a',
          time,
          changes: [{ field: 'account_update', value: { new_quality_score: quality } }],
        },
      ],
    },
    senderId,
    'account-a'
  )[0];
}
const write = (senderId: string, quality: string, time?: number) =>
  tenant(org, (tx) =>
    recordMarketingQualityUpdate(tx, org, senderId, evidence(quality, time, senderId))
  );
const state = (senderId: string) =>
  tenant(org, (tx) =>
    tx.pharmacyMarketingSafetyState.findUniqueOrThrow({
      where: { organizationId_senderId: { organizationId: org, senderId } },
    })
  );

suite('marketing quality state under PostgreSQL RLS', () => {
  beforeAll(async () => {
    const role = await db!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  afterAll(async () => {
    try {
      for (const organizationId of [org, foreignOrg])
        await tenant(organizationId, (tx) =>
          tx.pharmacyMarketingSafetyState.deleteMany({ where: { organizationId } })
        );
    } finally {
      await db!.$disconnect();
    }
  });

  it('keeps a newer RED pause when stale GREEN or duplicate evidence is delivered', async () => {
    const id = sender();
    expect(await write(id, 'RED', 1790000002)).toBe(1);
    expect(await write(id, 'GREEN', 1790000001)).toBe(0);
    expect(await write(id, 'RED', 1790000002)).toBe(0);
    expect(await state(id)).toMatchObject({
      paused: true,
      quality: 'RED',
      occurredAt: new Date(1790000002000),
    });
    expect(await write(id, 'GREEN', 1790000003)).toBe(1);
    expect(await state(id)).toMatchObject({ paused: false, quality: 'GREEN' });
    expect(await write(id, 'RED', 1790000002)).toBe(0);
  });

  it('resolves equal-time contradictory evidence to a pause in either arrival order', async () => {
    for (const qualities of [
      ['GREEN', 'RED'],
      ['RED', 'GREEN'],
    ]) {
      const id = sender();
      for (const quality of qualities) await write(id, quality);
      expect(await state(id)).toMatchObject({ paused: true, quality: 'RED' });
    }
  });

  it('atomically preserves the newest evidence during competing first inserts and updates', async () => {
    const id = sender();
    await Promise.all([write(id, 'GREEN', 1790000001), write(id, 'RED', 1790000002)]);
    expect(await state(id)).toMatchObject({ paused: true, quality: 'RED' });
    await Promise.all([write(id, 'GREEN', 1790000003), write(id, 'RED', 1790000004)]);
    expect(await state(id)).toMatchObject({
      paused: true,
      quality: 'RED',
      occurredAt: new Date(1790000004000),
    });
  });

  it('rolls back a state transition with the surrounding transaction', async () => {
    const id = sender();
    await write(id, 'RED');
    await expect(
      tenant(org, async (tx) => {
        await recordMarketingQualityUpdate(tx, org, id, evidence('GREEN', 1790000001, id));
        throw new Error('rollback quality transition');
      })
    ).rejects.toThrow('rollback quality transition');
    expect(await state(id)).toMatchObject({ paused: true, quality: 'RED' });
  });

  it('isolates tenants and rejects foreign writes through the atomic writer', async () => {
    const id = sender();
    await tenant(foreignOrg, (tx) =>
      recordMarketingQualityUpdate(tx, foreignOrg, id, evidence('RED', undefined, id))
    );
    for (const organizationId of [org, ''])
      expect(
        await tenant(organizationId, (tx) =>
          tx.pharmacyMarketingSafetyState.findMany({ where: { organizationId: foreignOrg } })
        )
      ).toEqual([]);
    await expect(
      tenant(org, (tx) =>
        recordMarketingQualityUpdate(tx, foreignOrg, id, evidence('GREEN', 1790000001, id))
      )
    ).rejects.toThrow();
    expect(
      await tenant(foreignOrg, (tx) =>
        tx.pharmacyMarketingSafetyState.findFirst({ where: { senderId: id } })
      )
    ).toMatchObject({ paused: true });
  });
});
