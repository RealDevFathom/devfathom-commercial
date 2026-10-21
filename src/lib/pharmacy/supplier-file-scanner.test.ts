import { describe, expect, it } from 'vitest';
import { structuralSupplierFileScanner } from './supplier-file-scanner';

describe('supplier structural file scanner — invariant 28', () => {
  it.each([
    ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
  ])(
    'accepts allow-listed %s bytes and records STRUCTURAL mode',
    async (declaredMimeType, content) => {
      await expect(
        structuralSupplierFileScanner.scan({ content, declaredMimeType })
      ).resolves.toMatchObject({
        mode: 'STRUCTURAL',
        mimeType: declaredMimeType,
        byteSize: content.length,
      });
    }
  );

  it('fails closed on unknown bytes and declared/actual mismatch', async () => {
    await expect(
      structuralSupplierFileScanner.scan({
        content: Buffer.from('plain text'),
        declaredMimeType: 'text/plain',
      })
    ).rejects.toThrow();
    await expect(
      structuralSupplierFileScanner.scan({
        content: Buffer.from('%PDF-1.7'),
        declaredMimeType: 'image/jpeg',
      })
    ).rejects.toThrow();
  });
});
