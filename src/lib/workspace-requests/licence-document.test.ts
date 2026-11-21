// @vitest-environment node
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAX_LICENCE_FILE_BYTES, verifyLicenceDocument } from './licence-document';
import { syntheticLicencePdf, syntheticLicencePdfWithObjectStream } from './licence-test-fixtures';

const pdf = syntheticLicencePdf();
let png: Buffer;
let jpg: Buffer;

beforeAll(async () => {
  const image = sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } });
  [png, jpg] = await Promise.all([
    image.clone().png().toBuffer(),
    image.jpeg({ progressive: true }).toBuffer(),
  ]);
});

describe('public licence document structure', () => {
  it.each([
    ['application/pdf', 'licence.pdf', () => pdf, Buffer.from('%PDF-1.7\n')],
    ['image/png', 'licence.png', () => png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['image/jpeg', 'licence.jpg', () => jpg, Buffer.from([255, 216, 255])],
  ])(
    'accepts a complete %s, refusing a prefix, truncation, wrong claim and trailing bytes',
    async (type, name, bytes, prefix) => {
      await expect(verifyLicenceDocument(bytes(), type)).resolves.toEqual({ type, name });
      await expect(verifyLicenceDocument(prefix, type)).resolves.toBeNull();
      await expect(
        verifyLicenceDocument(bytes().subarray(0, bytes().length - 8), type)
      ).resolves.toBeNull();
      await expect(verifyLicenceDocument(bytes(), 'application/octet-stream')).resolves.toBeNull();
      await expect(
        verifyLicenceDocument(Buffer.concat([bytes(), Buffer.from('extra data')]), type)
      ).resolves.toBeNull();
    }
  );

  it('refuses files containing two complete document containers', async () => {
    await expect(
      verifyLicenceDocument(Buffer.concat([pdf, png]), 'application/pdf')
    ).resolves.toBeNull();
    await expect(verifyLicenceDocument(Buffer.concat([png, jpg]), 'image/png')).resolves.toBeNull();
    await expect(
      verifyLicenceDocument(Buffer.concat([jpg, pdf]), 'image/jpeg')
    ).resolves.toBeNull();
  });

  it('parses cross-reference and compressed object streams', async () => {
    await expect(
      verifyLicenceDocument(syntheticLicencePdfWithObjectStream(), 'application/pdf')
    ).resolves.toEqual({
      type: 'application/pdf',
      name: 'licence.pdf',
    });
  });

  it('rejects a bad object offset and an inconsistent page count even with a valid footer', async () => {
    const invalidOffset = Buffer.from(
      pdf.toString().replace('0000000009 00000', '0000000010 00000')
    );
    const invalidPageCount = Buffer.from(pdf.toString().replace('/Count 1', '/Count 2'));
    await expect(verifyLicenceDocument(invalidOffset, 'application/pdf')).resolves.toBeNull();
    await expect(verifyLicenceDocument(invalidPageCount, 'application/pdf')).resolves.toBeNull();
  });

  it('rejects an image with a corrupt chunk and a mismatched recognized MIME type', async () => {
    const damagedPng = Buffer.from(png);
    damagedPng[30] ^= 1;
    await expect(verifyLicenceDocument(damagedPng, 'image/png')).resolves.toBeNull();
    await expect(verifyLicenceDocument(jpg, 'image/png')).resolves.toBeNull();
  });

  it('accepts the 1 MiB file boundary and rejects the next byte', async () => {
    const padding = MAX_LICENCE_FILE_BYTES - 512;
    const overhead = syntheticLicencePdf(padding).length - padding;
    const atLimit = syntheticLicencePdf(MAX_LICENCE_FILE_BYTES - overhead);
    expect(atLimit.length).toBe(MAX_LICENCE_FILE_BYTES);
    await expect(verifyLicenceDocument(atLimit, 'application/pdf')).resolves.not.toBeNull();
    await expect(
      verifyLicenceDocument(Buffer.concat([atLimit, Buffer.from('\n')]), 'application/pdf')
    ).resolves.toBeNull();
  });
});
