import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { generateDeviceSecret } from './devices';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

export const PRINT_BRIDGE_ENROLLMENT_TTL_MS = 10 * 60_000;
const CODE_FORMAT = /^pbe_[A-Za-z0-9_-]{32}$/;
type Clock = () => Date;
type LockedDevice = {
  id: string;
  kind: string;
  status: string;
  revokedAt: Date | null;
  deviceSecretHash: string;
};
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

async function lockDevice(db: Prisma.TransactionClient, deviceId: string) {
  const rows = await db.$queryRaw<LockedDevice[]>`
    SELECT id, kind, status, "revokedAt", "deviceSecretHash"
    FROM restaurant_registered_devices
    WHERE id = ${deviceId} AND "organizationId" = current_setting('app.current_organization_id', true)
    FOR UPDATE`;
  return rows[0];
}
function eligible(device: LockedDevice | undefined): device is LockedDevice {
  return Boolean(
    device &&
    device.kind === 'PRINT_BRIDGE' &&
    device.status === 'ACTIVE' &&
    device.revokedAt === null
  );
}

/** Internal issuance for a newly created device, inside its owning transaction. */
export async function issuePrintBridgeEnrollmentCode(
  db: Prisma.TransactionClient,
  deviceId: string,
  clock: Clock = () => new Date()
) {
  const device = await lockDevice(db, deviceId);
  if (!eligible(device)) throw new Error('This device cannot be enrolled.');
  const code = `pbe_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(clock().getTime() + PRINT_BRIDGE_ENROLLMENT_TTL_MS);
  await db.restaurantPrintBridgeEnrollmentCode.create({
    data: {
      deviceId,
      codeHash: hashCode(code),
      issuedDeviceSecretHash: device.deviceSecretHash,
      expiresAt,
    },
  });
  return { code, expiresAt };
}

export async function exchangePrintBridgeEnrollmentCode(
  code: string,
  clock: Clock = () => new Date()
) {
  if (!CODE_FORMAT.test(code)) return null;
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
      Array<{
        id: string;
        deviceId: string;
        expiresAt: Date;
        usedAt: Date | null;
        issuedDeviceSecretHash: string;
      }>
    >`
      SELECT id, "deviceId", "expiresAt", "usedAt", "issuedDeviceSecretHash"
      FROM restaurant_print_bridge_enrollment_codes
      WHERE "codeHash" = ${codeHash} AND "organizationId" = ${discovery.organizationId}
      FOR UPDATE`;
    const enrollment = rows[0];
    if (!enrollment || enrollment.usedAt) return null;
    const device = await lockDevice(db, enrollment.deviceId);
    // Re-evaluate expiry after both lock waits; a queued request cannot extend a code.
    const now = clock();
    if (
      !eligible(device) ||
      enrollment.expiresAt <= now ||
      device.deviceSecretHash !== enrollment.issuedDeviceSecretHash
    )
      return null;
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
