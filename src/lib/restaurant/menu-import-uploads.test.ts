/**
 * R-lane / WHA-194 — the ingestion boundary.
 *
 * These are the checks that stand between an arbitrary uploaded file and a paid
 * vision-model call, so the cases worth pinning are the adversarial ones: a
 * payload wearing a PNG's declared type, a PDF claiming more pages than it has,
 * and a storage key someone tries to steer.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MENU_UPLOAD_TYPES,
  MAX_PAGES_PER_IMPORT,
  MAX_UPLOAD_BYTES,
  MenuUploadError,
  countPdfPages,
  menuImportObjectName,
  sniffMimeType,
  validateMenuUpload,
} from './menu-import-uploads';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64, 3),
]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 4)]);

function pdf(pages: number): Buffer {
  const objects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`
  ).join('');
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${objects}%%EOF\n`,
    'latin1'
  );
}

/** Assert a rejection reason without letting a pass-through slip by unnoticed. */
function expectRejection(run: () => unknown, reason: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MenuUploadError);
    expect((error as MenuUploadError).reason).toBe(reason);
    return;
  }
  throw new Error(`Expected a ${reason} rejection, but the upload was accepted.`);
}

describe('type sniffing', () => {
  it('identifies each supported format from its leading bytes', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(WEBP)).toBe('image/webp');
    expect(sniffMimeType(pdf(1))).toBe('application/pdf');
  });

  it('rejects a format that is not on the list', () => {
    expect(sniffMimeType(ZIP)).toBeNull();
    expect(sniffMimeType(Buffer.from('<?xml version="1.0"?>', 'latin1'))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(4))).toBeNull();
  });

  it('does not mistake a RIFF container that is not WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(sniffMimeType(wav)).toBeNull();
  });
});

describe('validateMenuUpload', () => {
  it('accepts each supported format and reports its own facts', () => {
    for (const content of [PNG, JPEG, WEBP]) {
      const result = validateMenuUpload({ content });
      expect(ALLOWED_MENU_UPLOAD_TYPES).toContain(result.mimeType);
      expect(result.pageCount).toBe(1);
      expect(result.byteSize).toBe(content.length);
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('gives identical bytes an identical checksum, which is what makes a re-upload idempotent', () => {
    expect(validateMenuUpload({ content: PNG }).checksum).toBe(
      validateMenuUpload({ content: Buffer.from(PNG) }).checksum
    );
    expect(validateMenuUpload({ content: PNG }).checksum).not.toBe(
      validateMenuUpload({ content: JPEG }).checksum
    );
  });

  it('believes the bytes over the declared type', () => {
    // A zip labelled as a PNG is caught by the sniff, not by the label.
    expectRejection(
      () => validateMenuUpload({ content: ZIP, declaredMimeType: 'image/png' }),
      'UNSUPPORTED_TYPE'
    );
    // A real JPEG mislabelled as a PNG is a mismatch, reported distinctly.
    expectRejection(
      () => validateMenuUpload({ content: JPEG, declaredMimeType: 'image/png' }),
      'TYPE_MISMATCH'
    );
  });

  it('tolerates a browser-style content type with parameters', () => {
    expect(
      validateMenuUpload({ content: PNG, declaredMimeType: 'image/png; charset=binary' }).mimeType
    ).toBe('image/png');
  });

  it('rejects an empty upload', () => {
    expectRejection(() => validateMenuUpload({ content: Buffer.alloc(0) }), 'EMPTY');
  });

  it('rejects a file over the size cap', () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expectRejection(() => validateMenuUpload({ content: oversized }), 'TOO_LARGE');
  });

  it('rejects a PDF with more pages than one import may carry', () => {
    expect(validateMenuUpload({ content: pdf(MAX_PAGES_PER_IMPORT) }).pageCount).toBe(
      MAX_PAGES_PER_IMPORT
    );
    expectRejection(
      () => validateMenuUpload({ content: pdf(MAX_PAGES_PER_IMPORT + 1) }),
      'TOO_MANY_PAGES'
    );
  });
});

describe('countPdfPages', () => {
  it('reads the page-tree count', () => {
    expect(countPdfPages(pdf(1))).toBe(1);
    expect(countPdfPages(pdf(7))).toBe(7);
  });

  it('falls back to counting page objects when no /Count is declared', () => {
    const noCount = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF',
      'latin1'
    );
    expect(countPdfPages(noCount)).toBe(2);
  });

  it('takes the larger of the two readings, so an under-declared count cannot slip the cap', () => {
    // /Count claims one page; the file actually carries three.
    const understated = Buffer.from(
      '%PDF-1.4\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Type /Page >>\nendobj\n' +
        '5 0 obj\n<< /Type /Page >>\nendobj\n%%EOF',
      'latin1'
    );
    expect(countPdfPages(understated)).toBe(3);
  });

  it('rejects a PDF with no readable page structure', () => {
    expectRejection(
      () => countPdfPages(Buffer.from('%PDF-1.4\ntrailer\n%%EOF', 'latin1')),
      'UNREADABLE'
    );
  });
});

describe('menuImportObjectName', () => {
  it('derives a flat, extension-correct key from the import id', () => {
    expect(menuImportObjectName('abc123', 'image/png')).toBe('restaurant-menu-import__abc123.png');
    expect(menuImportObjectName('abc123', 'application/pdf')).toBe(
      'restaurant-menu-import__abc123.pdf'
    );
  });

  it('refuses an id that could steer the storage path', () => {
    for (const id of ['../escape', 'a/b', '', 'x'.repeat(65), 'has space']) {
      expectRejection(() => menuImportObjectName(id, 'image/png'), 'UNREADABLE');
    }
  });
});
