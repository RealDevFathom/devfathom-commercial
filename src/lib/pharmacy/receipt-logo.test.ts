// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@/lib/storage', () => ({
  putUpload: async (org: string, key: string, bytes: Buffer) => objects.set(org + '/' + key, bytes),
  getUpload: async (org: string, key: string) => {
    const bytes = objects.get(org + '/' + key);
    if (!bytes) throw Error('missing');
    return bytes;
  },
}));
import { uploadReceiptLogo, readReceiptLogo } from './receipt-logo';
const scope = { organizationId: 'tenant', branchId: 'north' };
describe('receipt logo pipeline', () => {
  it('re-encodes a bounded single raster, strips metadata, and resolves it only in the uploading branch', async () => {
    const source = await sharp({
      create: { width: 800, height: 800, channels: 3, background: 'white' },
    })
      .withMetadata()
      .jpeg()
      .toBuffer();
    const result = await uploadReceiptLogo(scope, {
      branchId: scope.branchId,
      contentType: 'image/jpeg',
      dataBase64: source.toString('base64'),
    });
    const stored = Buffer.from(await readReceiptLogo(scope, result.assetId), 'base64');
    const metadata = await sharp(stored).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeLessThanOrEqual(384);
    expect(metadata.height).toBeLessThanOrEqual(240);
    expect(metadata.exif).toBeUndefined();
    expect(stored.length).toBeLessThan(128 * 1024);
    for (const other of [
      { ...scope, branchId: 'south' },
      { ...scope, organizationId: 'other' },
    ])
      await expect(readReceiptLogo(other, result.assetId)).rejects.toThrow();
  });
  it.each([Buffer.from('<svg/>'), Buffer.from('<html/>'), Buffer.alloc(1024 * 1024 + 1)])(
    'declines non-raster and oversized input without adding an object',
    async (bytes) => {
      const before = objects.size;
      await expect(
        uploadReceiptLogo(scope, {
          branchId: scope.branchId,
          contentType: 'image/png',
          dataBase64: bytes.toString('base64'),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(objects.size).toBe(before);
    }
  );
});
