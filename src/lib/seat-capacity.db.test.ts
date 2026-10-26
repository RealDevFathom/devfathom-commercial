/**
 * @vitest-environment node
 *
 * Concurrency regression for occupied-seat creation. Requires a migrated,
 * disposable TEST_DATABASE_URL; otherwise this suite is skipped.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import { lockAndAssertSeatAvailable } from '@/lib/seat-capacity';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const db = TEST_DATABASE_URL
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 4 }) })
  : null;
const organizationId = `seat_race_${randomUUID()}`;

describeDatabase('organization seat capacity serialization', () => {
  beforeAll(async () => {
    await db!.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: 'Seat race test',
        displayName: 'Seat race test',
        status: 'ACTIVE',
        seatLimit: 2,
      },
    });
    await db!.organizationDepartment.create({
      data: { organizationId, key: 'ENGINEERING', name: 'Engineering' },
    });
    await db!.user.create({
      data: {
        organizationId,
        name: 'Existing member',
        email: `${organizationId}-existing@example.com`,
        department: 'ENGINEERING',
        title: 'Engineer',
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await db.$disconnect();
  });

  it('allows exactly one of two concurrent writes for the final seat', async () => {
    const invite = (suffix: string) =>
      db!.$transaction(async (tx) => {
        await lockAndAssertSeatAvailable(tx, organizationId, 2);
        return tx.user.create({
          data: {
            organizationId,
            name: `Invite ${suffix}`,
            email: `${organizationId}-${suffix}@example.com`,
            department: 'ENGINEERING',
            title: 'Engineer',
            status: 'INVITED',
          },
        });
      });

    const results = await Promise.allSettled([invite('one'), invite('two')]);
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: new Error('Seat limit reached (2/2).') });
    await expect(
      db!.user.count({
        where: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
      })
    ).resolves.toBe(2);
  });
});
