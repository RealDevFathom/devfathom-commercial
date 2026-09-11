import 'dotenv/config';

import { db } from '@/lib/db';
import { seedDemoRestaurantSeats } from '@/lib/demo/seed';
import type { DemoSeedCounts } from '@/lib/demo/seed-data';

async function main(): Promise<void> {
  const seats = await seedDemoRestaurantSeats();
  const totals = seats.reduce<DemoSeedCounts | undefined>((sum, seat) => {
    if (!sum) return { ...seat.counts };
    for (const key of Object.keys(sum) as Array<keyof DemoSeedCounts>) {
      sum[key] += seat.counts[key];
    }
    return sum;
  }, undefined);

  console.log(
    JSON.stringify(
      {
        seats: seats.map(({ organizationId, seatNumber, counts }) => ({
          organizationId,
          seatNumber,
          counts,
        })),
        totals: totals ?? {},
      },
      null,
      2
    )
  );
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Restaurant demo seed failed.');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void run();
