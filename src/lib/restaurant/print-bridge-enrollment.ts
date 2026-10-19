import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { generateDeviceSecret } from './devices';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

const CODE_PREFIX = 'pbe_';
export const PRINT_BRIDGE_ENROLLMENT_TTL_MS = 10 * 60_000;

function hashCode(code: string) {
  return createHash('sha256').update(code).digest('hex');
}

export async function issuePrintBridgeEnrollmentCode(
  db: ScopedDb,
  deviceId: string,
  now = new Date()
) {
  const code = `${CODE_PREFIX}${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + PRINT_BRIDGE_ENROLLMENT_TTL_MS);
  await db.restaurantPrintBridgeEnrollmentCode.create({
    data: { deviceId, codeHash: hashCode(code), expiresAt },
  });
  return { code, expiresAt };
}

export async function exchangePrintBridgeEnrollmentCode(code: string, now = new Date()) {
  if (!code.startsWith(CODE_PREFIX)) return null;
  const codeHash = hashCode(code);
  const discovery = await withPlatformDb((db) =>
    db.restaurantPrintBridgeEnrollmentCode.findUnique({
      where: { codeHash },
      select: { organizationId: true },
    })
  );
  if (!discovery) return null;
  return withTenantDb(discovery.organizationId, async (db) => {
    const rows = await db.$queryRaw<
      Array<{ id: string; deviceId: string; expiresAt: Date; usedAt: Date | null }>
    >`SELECT id, "deviceId", "expiresAt", "usedAt" FROM restaurant_print_bridge_enrollment_codes WHERE "codeHash" = ${codeHash} FOR UPDATE`;
    const enrollment = rows[0];
    if (!enrollment || enrollment.usedAt || enrollment.expiresAt <= now) return null;
    const device = await db.restaurantRegisteredDevice.findUnique({
      where: { id: enrollment.deviceId },
      select: { id: true, kind: true, status: true, revokedAt: true },
    });
    if (
      !device ||
      device.kind !== 'PRINT_BRIDGE' ||
      device.status !== 'ACTIVE' ||
      device.revokedAt
    ) {
      return null;
    }
    const { secret, secretHash } = generateDeviceSecret();
    await db.restaurantRegisteredDevice.update({
      where: { id: device.id },
      data: { deviceSecretHash: secretHash, lastSeenAt: now },
    });
    await db.restaurantPrintBridgeEnrollmentCode.update({
      where: { id: enrollment.id },
      data: { usedAt: now },
    });
    return { token: secret, deviceId: device.id };
  });
}
