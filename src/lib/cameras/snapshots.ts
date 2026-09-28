import 'server-only';

import { randomUUID } from 'node:crypto';
import { putUpload } from '@/lib/storage';
import type { CameraGatewayAdapter } from './contract';

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

  const bytes = await adapter.getSnapshot(input.cameraId);
  if (bytes.byteLength === 0) throw new Error('Camera snapshot unavailable.');

  const filename = `camera-snapshot-${randomUUID()}.png`;
  await putUpload(input.organizationId, filename, Buffer.from(bytes), 'image/png');
  return { filename, contentType: 'image/png', byteLength: bytes.byteLength };
}
