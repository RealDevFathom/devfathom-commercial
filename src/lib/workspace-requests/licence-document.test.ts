// @vitest-environment node
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAX_LICENCE_FILE_BYTES, verifyLicenceDocument } from './licence-document';
import {
  syntheticClassicLicence,
  syntheticHybridLicence,
  syntheticLicencePdf,
  syntheticLicencePdfWithObjectStream,
  syntheticLicenceRevision,
  syntheticLicenceStreamRevision,
  syntheticLinearizedLicence,
  syntheticScannerLicence,
  syntheticWordLicence,
} from './licence-test-fixtures';

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

describe('licence PDF formats and inactive content policy', () => {
  it.each([
    ['scanner', syntheticScannerLicence],
    ['linearized', syntheticLinearizedLicence],
    [
      'incrementally updated linearized',
      () =>
        syntheticLicenceRevision(syntheticLinearizedLicence(), '', false, {
          catalog: 3,
          pages: 1,
          size: 6,
        }),
    ],
    ['incremental', () => syntheticLicenceRevision(pdf)],
    ['incremental with a sparse xref stream', () => syntheticLicenceStreamRevision(pdf)],
    [
      'signed revision with inert signature metadata',
      () => syntheticLicenceRevision(pdf, '', true),
    ],
    ['hybrid-reference', syntheticHybridLicence],
    [
      'ImageMagick-style version spacing',
      () => syntheticClassicLicence({ header: '%PDF-1.7 \r\n' }),
    ],
    ['Pillow-style free entry', () => syntheticClassicLicence({ freeGeneration: 65536 })],
    ['Word-style metadata and opening destination', syntheticWordLicence],
  ])('accepts a generated %s PDF', async (_label, make) => {
    await expect(verifyLicenceDocument(make(), 'application/pdf')).resolves.toEqual({
      type: 'application/pdf',
      name: 'licence.pdf',
    });
  });

  it.each([
    ['password protection', '/Encrypt << /Filter /Standard >>', ''],
    ['JavaScript name tree', '', '/Names << /JavaScript << >> >>'],
    ['script entry', '', '/JS null'],
    ['escaped script name', '', '/J#53 null'],
    ['coded opening action', '', '/OpenAction << /S /JavaScript >>'],
    ['launch action', '', '/OpenAction << /S /Launch >>'],
    ['additional action with indirect name', '', '/AA << /O << /S 4 0 R >> >>'],
    ['embedded files tree', '', '/Names << /EmbeddedFiles << >> >>'],
    [
      'file specification with embedded stream metadata',
      '',
      '/AF [<< /Type /Filespec /EF << /F 4 0 R >> >>]',
    ],
    ['rich media annotation metadata', '', '/Annots [<< /Subtype /RichMedia >>]'],
  ])('refuses %s using inert metadata', async (_label, trailer, catalog) => {
    const extras = catalog.includes('4 0 R') ? [Buffer.from('4 0 obj\n/Launch\nendobj\n')] : [];
    await expect(
      verifyLicenceDocument(
        syntheticClassicLicence({ trailer, catalog, extras }),
        'application/pdf'
      )
    ).resolves.toBeNull();
  });

  it('checks the parsed objects inside structural streams for forbidden entries', async () => {
    await expect(
      verifyLicenceDocument(syntheticLicencePdfWithObjectStream('/JS null'), 'application/pdf')
    ).resolves.toBeNull();
  });

  it('checks older revisions even when the active catalog replaces their metadata', async () => {
    const base = syntheticClassicLicence({ catalog: '/JS null' });
    await expect(
      verifyLicenceDocument(syntheticLicenceRevision(base), 'application/pdf')
    ).resolves.toBeNull();
  });

  it('validates historical cross-reference entries and rejects an unlinked revision', async () => {
    const badBase = Buffer.from(pdf.toString().replace('0000000009 00000', '0000000010 00000'));
    await expect(
      verifyLicenceDocument(syntheticLicenceRevision(badBase), 'application/pdf')
    ).resolves.toBeNull();
    const revision = syntheticLicenceRevision(pdf);
    const unlinked = Buffer.from(
      revision
        .toString()
        .replace(/\/Prev (\d+)/, (_match, value: string) => ' '.repeat(value.length + 6))
    );
    await expect(verifyLicenceDocument(unlinked, 'application/pdf')).resolves.toBeNull();
  });
});
