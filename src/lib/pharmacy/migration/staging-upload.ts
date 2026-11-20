import 'server-only';

import { gunzipSync } from 'node:zlib';
import { OwnerImportError, parseOwnerUpload } from './owner-import-upload';
import type { SourceTable } from './source-values';
import {
  STAGING_MAX_FILE_BYTES,
  STAGING_MAX_ROWS,
  STAGING_MAX_XLSX_EXPANDED_BYTES,
  type StagingUploadInput,
} from './staging-input';

const LIMIT_MESSAGE = `Upload a CSV or XLSX file up to ${STAGING_MAX_FILE_BYTES / (1024 * 1024)} MiB and ${STAGING_MAX_ROWS.toLocaleString('en-US')} rows.`;

/**
 * The original file bytes of a staging upload. A gzip transport is inflated
 * with a hard output bound, so a compressed upload can never expand past the
 * file limit in memory; the result is what gets hashed as source evidence.
 */
export function stagingSourceBytes(
  input: Pick<StagingUploadInput, 'content' | 'encoding'>
): Buffer {
  const sent = Buffer.from(input.content, 'base64');
  if ((input.encoding ?? 'identity') === 'identity') return sent;
  let bytes: Buffer;
  try {
    bytes = gunzipSync(sent, { maxOutputLength: STAGING_MAX_FILE_BYTES + 1 });
  } catch (error) {
    throw new OwnerImportError(
      error instanceof RangeError
        ? LIMIT_MESSAGE
        : 'The compressed upload is damaged. Choose the file again.'
    );
  }
  if (bytes.length > STAGING_MAX_FILE_BYTES) throw new OwnerImportError(LIMIT_MESSAGE);
  return bytes;
}

/** Parse a staged legacy export with catalogue-sized limits (about 19,000 products). */
export function parseStagingUpload(fileName: string, bytes: Buffer): Promise<SourceTable> {
  return parseOwnerUpload(fileName, bytes, {
    maxBytes: STAGING_MAX_FILE_BYTES,
    maxRows: STAGING_MAX_ROWS,
    maxExpanded: STAGING_MAX_XLSX_EXPANDED_BYTES,
  });
}
