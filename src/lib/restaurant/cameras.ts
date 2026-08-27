import { createHash, randomBytes } from 'node:crypto';

export const CAMERA_GATEWAY_SECRET_PREFIX = 'rcg_';
export const CAMERA_GATEWAY_STALE_AFTER_MS = 5 * 60_000;

export type CameraGatewayTrustState = {
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: Date | null;
  lastSeenAt: Date | null;
};

export type CameraGatewayHealth = 'REVOKED' | 'NEVER_SEEN' | 'STALE' | 'HEALTHY';

export function hashCameraGatewaySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function isCameraGatewaySecretFormat(secret: string): boolean {
  return /^rcg_[A-Za-z0-9_-]{43}$/.test(secret);
}

export function generateCameraGatewaySecret(): { secret: string; secretHash: string } {
  const secret = `${CAMERA_GATEWAY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, secretHash: hashCameraGatewaySecret(secret) };
}

export function isCameraGatewayUsable(gateway: CameraGatewayTrustState): boolean {
  return gateway.status === 'ACTIVE' && gateway.revokedAt === null;
}

export function gatewayHealth(gateway: CameraGatewayTrustState, now: Date): CameraGatewayHealth {
  if (!isCameraGatewayUsable(gateway)) return 'REVOKED';
  if (!gateway.lastSeenAt) return 'NEVER_SEEN';
  return now.getTime() - gateway.lastSeenAt.getTime() > CAMERA_GATEWAY_STALE_AFTER_MS
    ? 'STALE'
    : 'HEALTHY';
}

type CameraGatewayDb = {
  restaurantCameraGateway: {
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
    findUnique(args: {
      where: { gatewaySecretHash: string };
    }): Promise<Record<string, unknown> | null>;
  };
};

export async function enrollCameraGateway(
  db: CameraGatewayDb,
  input: {
    organizationId: string;
    branchId: string;
    name: string;
    baseUrl: string;
    retentionDays: number;
  }
) {
  const { secret, secretHash } = generateCameraGatewaySecret();
  const gateway = await db.restaurantCameraGateway.create({
    data: { ...input, gatewaySecretHash: secretHash },
  });
  return { gateway, secret };
}

export async function rotateCameraGatewaySecret(db: CameraGatewayDb, id: string) {
  const { secret, secretHash } = generateCameraGatewaySecret();
  const gateway = await db.restaurantCameraGateway.update({
    where: { id },
    data: { gatewaySecretHash: secretHash },
  });
  return { gateway, secret };
}

export function revokeCameraGateway(db: CameraGatewayDb, id: string, now: Date) {
  return db.restaurantCameraGateway.update({
    where: { id },
    data: { status: 'REVOKED', revokedAt: now },
  });
}

export function resolveCameraGatewayBySecret(db: CameraGatewayDb, secret: string) {
  return db.restaurantCameraGateway.findUnique({
    where: { gatewaySecretHash: hashCameraGatewaySecret(secret) },
  });
}
