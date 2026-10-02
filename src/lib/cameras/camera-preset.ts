import type { CameraPreset } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type { CameraPreset };

/** CAM-3: what a camera watches. Shared by both verticals' camera surfaces. */
export const CAMERA_PRESET_LABELS: Record<CameraPreset, string> = {
  COLD_CHAIN: 'Cold chain',
  COUNTER: 'Counter',
  KITCHEN: 'Kitchen',
};

/** Restaurants have no temperature zones; the database enforces the same rule. */
export const VERTICAL_CAMERA_PRESETS = {
  pharmacy: ['COLD_CHAIN', 'COUNTER'],
  restaurant: ['KITCHEN', 'COUNTER'],
} as const satisfies Record<string, readonly CameraPreset[]>;

export class CameraPresetError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'ZONE_REQUIRED' | 'ZONE_NOT_COLD_CHAIN') {
    super(reason);
    this.name = 'CameraPresetError';
  }
}

/**
 * Set a pharmacy camera's preset. A COLD_CHAIN camera must watch an active,
 * validated cold-chain zone in its own branch; any other preset clears the
 * binding. Authorization of the actor is the caller's job.
 */
export async function setCameraPreset(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: { cameraId: string; preset: CameraPreset | null; temperatureZoneId?: string | null }
) {
  const camera = await db.camera.findFirst({
    where: { id: input.cameraId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true },
  });
  if (!camera) throw new CameraPresetError('NOT_FOUND');

  let temperatureZoneId: string | null = null;
  if (input.preset === 'COLD_CHAIN') {
    if (!input.temperatureZoneId) throw new CameraPresetError('ZONE_REQUIRED');
    const zone = await db.pharmacyStockLocation.findFirst({
      where: {
        id: input.temperatureZoneId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        active: true,
        coldChain: true,
      },
      select: { id: true },
    });
    if (!zone) throw new CameraPresetError('ZONE_NOT_COLD_CHAIN');
    temperatureZoneId = zone.id;
  }
  return db.camera.update({
    where: { id: camera.id },
    data: { preset: input.preset, temperatureZoneId },
    select: { id: true, preset: true, temperatureZoneId: true },
  });
}
