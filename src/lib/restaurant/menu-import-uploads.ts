/**
 * R-lane / WHA-194 — the menu-upload ingestion boundary.
 *
 * Everything a restaurant uploads here is a file from outside the system, so
 * this module is where the untrusted bytes are constrained before anything
 * expensive happens to them:
 *
 *  - The declared MIME type is IGNORED in favour of a magic-byte sniff. A caller
 *    can label a zip `image/png`; only the leading bytes decide.
 *  - Size and page count are capped so one upload cannot exhaust a worker, a
 *    provider quota, or the review queue.
 *  - Storage keys are derived, never taken from the client. Combined with the
 *    org prefix `putUpload` applies, every object lands under its own tenant.
 *
 * Deliberately dependency-free: no image or PDF library is added for this. Page
 * counting reads the PDF page tree directly, which is enough for the cap and
 * keeps an untrusted parser out of the request path.
 */

import { createHash } from 'node:crypto';

/** Per-file ceiling. A phone photo of a menu is ~2-6 MB; 25 MB is generous. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Per-import ceiling across all files. */
export const MAX_PAGES_PER_IMPORT = 10;

export const ALLOWED_MENU_UPLOAD_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

export type MenuUploadMimeType = (typeof ALLOWED_MENU_UPLOAD_TYPES)[number];

export type UploadRejectionReason =
  'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'TYPE_MISMATCH' | 'TOO_MANY_PAGES' | 'UNREADABLE';

export class MenuUploadError extends Error {
  constructor(
    message: string,
    readonly reason: UploadRejectionReason
  ) {
    super(message);
    this.name = 'MenuUploadError';
  }
}

/** Sniff the real type from the leading bytes. Returns null for anything else. */
export function sniffMimeType(content: Buffer): MenuUploadMimeType | null {
  if (content.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    content[0] === 0x89 &&
    content[1] === 0x50 &&
    content[2] === 0x4e &&
    content[3] === 0x47 &&
    content[4] === 0x0d &&
    content[5] === 0x0a &&
    content[6] === 0x1a &&
    content[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';

  // WebP: "RIFF" .... "WEBP"
  if (content.toString('latin1', 0, 4) === 'RIFF' && content.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  // PDF: "%PDF-"
  if (content.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';

  return null;
}

/**
 * Count pages in a PDF by reading its page tree. Prefers the `/Count` on the
 * root `/Type /Pages` node and falls back to counting `/Type /Page` objects,
 * which is what an incrementally-updated or linearized file needs.
 *
 * Only ever used to ENFORCE A CAP. An over-count rejects an upload the user can
 * split; it never silently drops content, because extraction reads the file
 * again through the adapter.
 */
export function countPdfPages(content: Buffer): number {
  const text = content.toString('latin1');

  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^]{0,400}?\/Count\s+(\d+)/g)].map((match) =>
    Number.parseInt(match[1]!, 10)
  );
  const declared = counts.length ? Math.max(...counts) : 0;

  // `/Type /Page` must not also match `/Type /Pages`.
  const objects = [...text.matchAll(/\/Type\s*\/Page(?![s\w])/g)].length;

  const pages = Math.max(declared, objects);
  if (pages < 1) {
    throw new MenuUploadError('The PDF has no readable pages.', 'UNREADABLE');
  }
  return pages;
}

export type ValidatedUpload = {
  mimeType: MenuUploadMimeType;
  byteSize: number;
  pageCount: number;
  /** SHA-256 of the bytes — the idempotency anchor for re-uploads. */
  checksum: string;
  content: Buffer;
};

export type ValidateUploadInput = {
  content: Buffer;
  /** What the client CLAIMS the file is. Cross-checked, never trusted alone. */
  declaredMimeType?: string | null;
};

/**
 * Validate one uploaded file. Throws `MenuUploadError` with a reason the router
 * maps to a status; never returns a partially-validated result.
 */
export function validateMenuUpload(input: ValidateUploadInput): ValidatedUpload {
  const content = input.content;
  if (!content || content.length === 0) {
    throw new MenuUploadError('The uploaded file is empty.', 'EMPTY');
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new MenuUploadError(
      `The file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
      'TOO_LARGE'
    );
  }

  const sniffed = sniffMimeType(content);
  if (!sniffed) {
    throw new MenuUploadError('Upload a PNG, JPEG, WebP or PDF of the menu.', 'UNSUPPORTED_TYPE');
  }

  // A declared type that disagrees with the bytes is reported separately from an
  // unsupported one: it is the signal worth looking at, not a user typo.
  const declared = input.declaredMimeType?.trim().toLowerCase().split(';')[0];
  if (declared && declared !== sniffed) {
    throw new MenuUploadError(
      `The file contents are ${sniffed}, not the declared ${declared}.`,
      'TYPE_MISMATCH'
    );
  }

  const pageCount = sniffed === 'application/pdf' ? countPdfPages(content) : 1;
  if (pageCount > MAX_PAGES_PER_IMPORT) {
    throw new MenuUploadError(
      `The file has ${pageCount} pages; the limit is ${MAX_PAGES_PER_IMPORT} per import.`,
      'TOO_MANY_PAGES'
    );
  }

  return {
    mimeType: sniffed,
    byteSize: content.length,
    pageCount,
    checksum: createHash('sha256').update(content).digest('hex'),
    content,
  };
}

const EXTENSIONS: Record<MenuUploadMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * The storage object name for an import's source file. `putUpload` prefixes the
 * organization id, so the full key is `<organizationId>/<this>` — tenant-scoped
 * by construction.
 *
 * Flat on purpose: the local-filesystem backend of `putUpload` creates only the
 * org directory, so a name containing a separator would fail to write. The id is
 * asserted to be a plain identifier, which also rules out traversal.
 */
export function menuImportObjectName(importId: string, mimeType: MenuUploadMimeType): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(importId)) {
    throw new MenuUploadError('The import id is not a storable identifier.', 'UNREADABLE');
  }
  return `restaurant-menu-import__${importId}.${EXTENSIONS[mimeType]}`;
}
