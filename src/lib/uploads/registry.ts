import 'server-only';

import { canAccessProject, projectIdOfTask } from '@/lib/authz';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-837 (security scan F15/F17) — server-recorded ownership of uploads.
 *
 * `/api/upload` registers every object it writes with the uploader the server
 * saw. Records that protect a file — a project file, a task attachment, a
 * contract's signed document — bind that registration to themselves on attach,
 * and only the uploader can make that first binding. The binding is write-once
 * (a database trigger refuses changes) and has no foreign key, so when the
 * owning row is deleted the binding stays behind as a tombstone and the file is
 * denied rather than served to the whole workspace.
 *
 * A file reference supplied by a client is therefore never authority: it can
 * neither bind someone else's upload nor re-bind one that already has an owner.
 */

export const UPLOAD_OWNER_TYPES = ['PROJECT_FILE', 'TASK_ATTACHMENT', 'CONTRACT'] as const;
export type UploadOwnerType = (typeof UPLOAD_OWNER_TYPES)[number];
export type UploadOwner = { type: UploadOwnerType; id: string };

const FILE_REF_PREFIX = '/api/files/';

/** True for a bare stored-object name that `/api/files/[name]` would serve. */
export function isUploadName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
  );
}

/**
 * The stored-object name a reference points at, `null` for a reference that is
 * not one of this workspace's uploads (an external link, free text), or
 * `undefined` for a malformed `/api/files` reference that must be refused.
 */
export function uploadNameFromRef(ref: string): string | null | undefined {
  const trimmed = ref.trim();
  if (trimmed.startsWith(FILE_REF_PREFIX)) {
    const name = trimmed.slice(FILE_REF_PREFIX.length);
    return isUploadName(name) ? name : undefined;
  }
  // Absolute, encoded or otherwise disguised forms of a file link are refused
  // rather than stored as an unaccountable reference to a protected object.
  return /\/api\/files/iu.test(decodeURIComponentSafe(trimmed)) ? undefined : null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type RegistryDb = Pick<ScopedDb, 'uploadedFile' | 'uploadedFileLegacyBinding'>;

/** Record a freshly written upload and the user who uploaded it. */
export async function registerUpload(
  db: RegistryDb,
  input: { name: string; uploadedById: string }
): Promise<void> {
  await db.uploadedFile.create({
    data: { name: input.name, uploadedById: input.uploadedById },
    select: { id: true },
  });
}

export class UploadReferenceError extends Error {
  constructor(message = 'Upload this file again to attach it here.') {
    super(message);
    this.name = 'UploadReferenceError';
  }
}

/**
 * Accept `ref` as the file of `owner`, binding the upload to it when this is
 * the first attach. Allowed only for the caller's own unattached upload, or for
 * an upload already bound to this same record (re-saving an unchanged form),
 * including a binding grandfathered from before the registry existed.
 * Anything else — someone else's upload, an upload bound elsewhere, an unknown
 * or malformed file reference — is refused and nothing is written.
 */
export async function claimUploadReference(
  db: RegistryDb,
  input: { ref: string | null | undefined; userId: string; owner: UploadOwner }
): Promise<void> {
  if (!input.ref) return;
  const name = uploadNameFromRef(input.ref);
  if (name === null) return;
  if (name === undefined) throw new UploadReferenceError();
  const upload = await db.uploadedFile.findFirst({
    where: { name },
    select: { id: true, uploadedById: true, ownerType: true, ownerId: true },
  });
  if (!upload) throw new UploadReferenceError();
  if (upload.ownerType !== null) {
    if (upload.ownerType === input.owner.type && upload.ownerId === input.owner.id) return;
    const grandfathered = await db.uploadedFileLegacyBinding.findFirst({
      where: { name, ownerType: input.owner.type, ownerId: input.owner.id },
      select: { id: true },
    });
    if (grandfathered) return;
    throw new UploadReferenceError();
  }
  if (!upload.uploadedById || upload.uploadedById !== input.userId) {
    throw new UploadReferenceError();
  }
  const bound = await db.uploadedFile.updateMany({
    where: { id: upload.id, ownerType: null },
    data: { ownerType: input.owner.type, ownerId: input.owner.id, boundAt: new Date() },
  });
  // Lost a race with another attach of the same upload.
  if (bound.count !== 1) throw new UploadReferenceError();
}

/**
 * The current read policy of the record a file is bound to. A deleted owner
 * (tombstone) or an unknown owner kind denies.
 */
export async function canReadBoundUpload(
  db: ScopedDb,
  user: { id: string; role?: string | null },
  binding: { ownerType: string; ownerId: string | null }
): Promise<boolean> {
  if (!binding.ownerId) return false;
  switch (binding.ownerType) {
    case 'PROJECT_FILE': {
      const file = await db.projectFile.findUnique({
        where: { id: binding.ownerId },
        select: { projectId: true },
      });
      return !!file && canAccessProject(db, user.id, user.role, file.projectId);
    }
    case 'TASK_ATTACHMENT': {
      const attachment = await db.taskAttachment.findUnique({
        where: { id: binding.ownerId },
        select: { taskId: true },
      });
      if (!attachment) return false;
      const projectId = await projectIdOfTask(db, attachment.taskId);
      return !!projectId && canAccessProject(db, user.id, user.role, projectId);
    }
    case 'CONTRACT': {
      // The client detail read rule: signed contracts are for current admins.
      const contract = await db.contract.findUnique({
        where: { id: binding.ownerId },
        select: { id: true },
      });
      return !!contract && user.role === 'ADMIN';
    }
    default:
      return false;
  }
}

/**
 * Read decision for a bound upload: its primary binding, or — for a file that
 * several records shared before the registry existed — any of its grandfathered
 * bindings. New uploads only ever have the primary binding.
 */
export async function canReadUpload(
  db: ScopedDb,
  user: { id: string; role?: string | null },
  upload: { name: string; ownerType: string; ownerId: string | null }
): Promise<boolean> {
  if (await canReadBoundUpload(db, user, upload)) return true;
  const grandfathered = await db.uploadedFileLegacyBinding.findMany({
    where: { name: upload.name },
    select: { ownerType: true, ownerId: true },
  });
  for (const binding of grandfathered) {
    if (binding.ownerType === upload.ownerType && binding.ownerId === upload.ownerId) continue;
    if (await canReadBoundUpload(db, user, binding)) return true;
  }
  return false;
}
