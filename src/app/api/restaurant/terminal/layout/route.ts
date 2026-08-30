import { NextResponse } from 'next/server';

import { listFloors } from '@/lib/restaurant/floor';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

/** Friendly, device-branch-scoped floor controls for the POS terminal. */
export const GET = withTerminalAuth(async (ctx) => {
  const [floors, sections] = await Promise.all([
    listFloors(ctx.db, { branchId: ctx.device.branchId }),
    ctx.db.restaurantServerSection.findMany({
      where: { branchId: ctx.device.branchId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  return NextResponse.json({
    floors: floors.map((floor) => ({
      id: floor.id,
      name: floor.name,
      tables: floor.tables.map((table) => ({
        id: table.id,
        code: table.code,
        capacity: table.capacity,
        occupied: table.occupied,
        activeOrderIds: table.activeOrderIds,
      })),
    })),
    sections,
  });
});
