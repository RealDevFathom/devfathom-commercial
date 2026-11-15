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

/** 128 random bits, as the hex token in an archive name. */
export function newOwnerDataExportArchiveToken(): string {
  return randomBytes(16).toString('hex');
}

/** A fresh, unguessable object name for one export job. */
export function newOwnerDataExportObjectName(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('Invalid export job id.');
  return `${OWNER_DATA_EXPORT_OBJECT_PREFIX}${jobId}-${newOwnerDataExportArchiveToken()}.zip`;
}

/**
 * DEV-844 — the archive name a job reserved when it was queued. Its token is
 * stored in the job's payload, so every attempt (a worker retry, a platform
 * retry) writes this one object instead of leaving a new, unrecorded archive
 * behind each time an upload outlives its job transaction. Null for a job
 * queued before DEV-844, which carries no token.
 */
export function reservedOwnerDataExportObjectName(jobId: string, payload: unknown): string | null {
  if (!JOB_ID.test(jobId) || !payload || typeof payload !== 'object') return null;
  const token = (payload as { archiveToken?: unknown }).archiveToken;
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return `${OWNER_DATA_EXPORT_OBJECT_PREFIX}${jobId}-${token}.zip`;
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
