import 'server-only';

import { randomUUID } from 'node:crypto';
import { assertStorageAvailable, putUpload } from '@/lib/storage';
import { isAcceptableCameraSnapshot } from './png-still';

export { CAMERA_SNAPSHOT_MAX_BYTES, isAcceptableCameraSnapshot } from './png-still';

/**
 * Everything the server already authorized about the camera a still is for.
 * A configured gateway read is matched on all of it; the simulator ignores it.
 */
export type CameraSnapshotTarget = {
  organizationId: string;
  branchId: string;
  gatewayId: string;
  gatewayBranchId: string;
  gatewayBaseUrl: string;
  /** The camera row id. */
  cameraId: string;
};

/**
 * A source of PNG stills. The simulator's `getSnapshot(cameraRef)` fits this
 * shape; a configured gateway source also requires the target.
 */
export type CameraSnapshotSource = {
  getSnapshot(cameraRef: string, target?: CameraSnapshotTarget): Promise<Uint8Array>;
};

/**
 * Capture a PNG in private organization storage. The server caller must authorize
 * the organization, branch and camera first; this helper is not an access check.
 * The returned filename is an opaque storage key, never a public URL.
 */
export async function storeCameraSnapshot(
  adapter: CameraSnapshotSource,
  input: { organizationId: string; cameraId: string; target?: CameraSnapshotTarget }
): Promise<{ filename: string; contentType: 'image/png'; byteLength: number }> {
  // Local storage treats the organization as a directory: reject path syntax.
  if (!/^[A-Za-z0-9_-]+$/.test(input.organizationId)) {
    throw new Error('Invalid snapshot organization.');
  }
  if (input.target && input.target.organizationId !== input.organizationId) {
    throw new Error('Invalid snapshot organization.');
  }

  assertStorageAvailable();
  const bytes = await adapter.getSnapshot(input.cameraId, input.target);
  // One fixed message: never reflect adapter output, size or camera input.
  if (!isAcceptableCameraSnapshot(bytes)) throw new Error('Camera snapshot unavailable.');

  const filename = `camera-snapshot-${randomUUID()}.png`;
  await putUpload(input.organizationId, filename, Buffer.from(bytes), 'image/png');
  return { filename, contentType: 'image/png', byteLength: bytes.byteLength };
}
