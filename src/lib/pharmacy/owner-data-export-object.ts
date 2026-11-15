import { randomBytes } from 'node:crypto';

/**
 * DEV-783 — names of stored owner data export archives.
 *
 * Every archive is stored as `owner-data-export-<jobId>-<token>.zip`, where the
 * token is 128 random bits recorded only on the job row. The only way to read
 * one is the owner's PIN-gated, audited, expiry-checked download in
 * `/api/pharmacy/data-export`: the generic `/api/files/[name]` route refuses
 * every name with this prefix, and even without that refusal a job id alone is
 * not enough to name the object.
 */
export const OWNER_DATA_EXPORT_OBJECT_PREFIX = 'owner-data-export-';

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[0-9a-f]{32}$/;

/** True for any object name in the reserved export namespace, in any letter case. */
export function isOwnerDataExportObjectName(name: string): boolean {
  return /^owner-data-export-/iu.test(name);
}

/** A fresh, unguessable object name for one export job. */
export function newOwnerDataExportObjectName(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('Invalid export job id.');
  return `${OWNER_DATA_EXPORT_OBJECT_PREFIX}${jobId}-${randomBytes(16).toString('hex')}.zip`;
}

/**
 * The archive name recorded on a job's result, accepted only when it belongs
 * to that job. Archives built before DEV-783 carry no token and are accepted
 * by their exact legacy name until their 24-hour link lapses.
 */
export function storedOwnerDataExportObjectName(jobId: string, result: unknown): string | null {
  if (!JOB_ID.test(jobId) || !result || typeof result !== 'object') return null;
  const filename = (result as { filename?: unknown }).filename;
  if (typeof filename !== 'string') return null;
  const base = `${OWNER_DATA_EXPORT_OBJECT_PREFIX}${jobId}`;
  if (filename === `${base}.zip`) return filename;
  if (!filename.startsWith(`${base}-`) || !filename.endsWith('.zip')) return null;
  return TOKEN.test(filename.slice(base.length + 1, -'.zip'.length)) ? filename : null;
}
