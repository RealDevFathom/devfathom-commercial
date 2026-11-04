import 'server-only';

import { randomUUID } from 'node:crypto';
import { assertStorageAvailable, putUpload } from '@/lib/storage';
import type { CameraGatewayAdapter } from './contract';

/**
 * Upper bound for one evidence still. A camera still is far below this; anything
 * larger is refused before it reaches tenant storage.
 */
export const CAMERA_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/**
 * Stored stills are served back as `image/png`. Bytes from an adapter are not
 * trusted to be PNG just because the adapter says so: they must carry the PNG
 * signature and stay within the size bound, or nothing is stored.
 */
export function isAcceptableCameraSnapshot(bytes: unknown): bytes is Uint8Array {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength > PNG_SIGNATURE.length &&
    bytes.byteLength <= CAMERA_SNAPSHOT_MAX_BYTES &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  );
}

/**
 * Capture a PNG in private organization storage. The server caller must authorize
 * the organization, branch and camera first; this helper is not an access check.
 * The returned filename is an opaque storage key, never a public URL.
 */
export async function storeCameraSnapshot(
  adapter: Pick<CameraGatewayAdapter, 'getSnapshot'>,
  input: { organizationId: string; cameraId: string }
): Promise<{ filename: string; contentType: 'image/png'; byteLength: number }> {
  // Local storage treats the organization as a directory: reject path syntax.
  if (!/^[A-Za-z0-9_-]+$/.test(input.organizationId)) {
    throw new Error('Invalid snapshot organization.');
  }

  assertStorageAvailable();
  const bytes = await adapter.getSnapshot(input.cameraId);
  // One fixed message: never reflect adapter output, size or camera input.
  if (!isAcceptableCameraSnapshot(bytes)) throw new Error('Camera snapshot unavailable.');

  const filename = `camera-snapshot-${randomUUID()}.png`;
  await putUpload(input.organizationId, filename, Buffer.from(bytes), 'image/png');
  return { filename, contentType: 'image/png', byteLength: bytes.byteLength };
}
