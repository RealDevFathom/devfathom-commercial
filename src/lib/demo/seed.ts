import 'server-only';

import { provisionDemoRestaurantSeatInTransaction } from '@/lib/demo/seed-bootstrap';
import { demoSeatIdentity, parseDemoSeatCount } from '@/lib/demo/seed-data';
import { DEMO_RESET_TRANSACTION_TIMEOUT_MS, scheduleDemoReset } from '@/lib/demo/jobs';
import { resetDemoSeatInTransaction } from '@/lib/demo/reset';
import type { DemoRestaurantSeatResult } from '@/lib/demo/seed-seat';
import { activateDemoRestaurantOrganizationInTransaction } from '@/lib/platform/commands';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { syncPlatformCatalog } from '../../../prisma/catalog-sync';

export type { DemoRestaurantSeatResult } from '@/lib/demo/seed-seat';

const TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: DEMO_RESET_TRANSACTION_TIMEOUT_MS,
} as const;

function resetDate(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Restaurant demo seed requires a valid date.');
  }
  return now;
}

export async function seedDemoRestaurantSeats(
  options: { seats?: number; now?: Date } = {}
): Promise<DemoRestaurantSeatResult[]> {
  const seatCount = parseDemoSeatCount(options.seats);
  const now = resetDate(options.now);
  const results: DemoRestaurantSeatResult[] = [];

  await withPlatformDb((db) => syncPlatformCatalog(db));

  for (let seat = 1; seat <= seatCount; seat += 1) {
    const identity = demoSeatIdentity(seat);
    results.push(
      await withPlatformDb(async (db) => {
        await provisionDemoRestaurantSeatInTransaction(db, identity, now);
        await db.$queryRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.is_platform_admin', 'false', true)`,
          identity.organizationId
        );
        const result = await resetDemoSeatInTransaction(db, {
          organizationId: identity.organizationId,
          now,
        });
        await scheduleDemoReset(db, { organizationId: identity.organizationId, now });
        await db.$executeRaw`SET CONSTRAINTS restaurant_tax_refund_allocation_cap IMMEDIATE`;
        await db.$queryRawUnsafe(
          `SELECT set_config('app.current_organization_id', '', true),
                  set_config('app.is_platform_admin', 'true', true)`
        );
        await activateDemoRestaurantOrganizationInTransaction(db, identity, now);
        return result;
      }, TRANSACTION_OPTIONS)
    );
  }
  return results;
}

export function resetDemoRestaurantSeat(input: {
  organizationId: string;
  now?: Date;
}): Promise<DemoRestaurantSeatResult> {
  const now = resetDate(input.now);
  return withTenantDb(
    input.organizationId,
    (db) => resetDemoSeatInTransaction(db, { organizationId: input.organizationId, now }),
    TRANSACTION_OPTIONS
  );
}
