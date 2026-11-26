import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
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

const SHARED_RECORD_TYPES = [
  'CLIENT_LOGO',
  'CHAT_ATTACHMENT',
  'PHARMACY_LICENCE_EVIDENCE',
  'PHARMACY_COVERAGE_ROSTER',
] as const;
export const UPLOAD_OWNER_TYPES = [
  'PROJECT_FILE',
  'TASK_ATTACHMENT',
  'CONTRACT',
  ...SHARED_RECORD_TYPES,
] as const;

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
  if (name === undefined || (input.owner.type === 'CLIENT_LOGO' && !isLogoImage(name)))
    throw new UploadReferenceError();
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

function isLogoImage(name: string) {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(name);
}

type Reader = Parameters<typeof subjectFromSession>[0];

export async function mayReadPharmacyDocument(
  db: ScopedDb,
  user: Reader,
  branch: Prisma.PharmacyBranchWhereInput,
  licence: boolean
) {
  if (user.role === 'ADMIN') return true;
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      userId: user.id,
      active: true,
      user: { status: 'ACTIVE' },
      branch: { ...branch, active: true },
    },
    select: { id: true },
  });
  return (
    !!assignment &&
    (!licence ||
      (await can(subjectFromSession(user), 'pharmacy:manage', undefined, { db, source: 'TRPC' })))
  );
}

/**
 * The current read policy of the record a file is bound to. A deleted owner
 * (tombstone) or an unknown owner kind denies.
 */
export async function canReadBoundUpload(
  db: ScopedDb,
  user: Reader,
  binding: { name: string; ownerType: string; ownerId: string | null }
): Promise<boolean> {
  if (!binding.ownerId) return false;
  switch (binding.ownerType) {
    case 'CLIENT_LOGO':
      return (
        isLogoImage(binding.name) &&
        !!(await db.client.findFirst({
          where: { id: binding.ownerId, logo: FILE_REF_PREFIX + binding.name },
          select: { id: true },
        }))
      );
    case 'CHAT_ATTACHMENT': {
      const attachment = await db.messageAttachment.findFirst({
        where: {
          id: binding.ownerId,
          url: FILE_REF_PREFIX + binding.name,
          message: { deletedAt: null },
        },
        select: { message: { select: { channelId: true } } },
      });
      return (
        !!attachment &&
        !!(await db.channelMember.findUnique({
          where: { channelId_userId: { channelId: attachment.message.channelId, userId: user.id } },
          select: { id: true },
        }))
      );
    }
    case 'PHARMACY_COVERAGE_ROSTER':
    case 'PHARMACY_LICENCE_EVIDENCE': {
      const licence = binding.ownerType === 'PHARMACY_LICENCE_EVIDENCE';
      const field = licence ? 'licenceEvidenceFileRef' : 'qualifiedPersonCoverageRosterRef';
      const profile = await db.branchRegulatoryProfile.findFirst({
        where: { branchId: binding.ownerId, [field]: FILE_REF_PREFIX + binding.name },
        select: { id: true },
      });
      return !!profile && mayReadPharmacyDocument(db, user, { id: binding.ownerId }, licence);
    }
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
  user: Reader,
  upload: { name: string; ownerType: string; ownerId: string | null }
): Promise<boolean> {
  if (await canReadBoundUpload(db, user, upload)) return true;
  const grandfathered = await db.uploadedFileLegacyBinding.findMany({
    where: { name: upload.name },
    select: { ownerType: true, ownerId: true },
  });
  for (const binding of grandfathered) {
    if (binding.ownerType === upload.ownerType && binding.ownerId === upload.ownerId) continue;
    if (await canReadBoundUpload(db, user, { ...binding, name: upload.name })) return true;
  }
  return false;
}

/** A new typed owner checks its exact live reference, including channel membership.
 * Older registrations and SOP captures still require the historical reference guards. */
export async function registeredReadDecision(db: ScopedDb, user: Reader, name: string) {
  const upload = await db.uploadedFile.findFirst({
    where: { name },
    select: { ownerType: true, ownerId: true, uploadedById: true },
  });
  if (!upload) return 'DENY';
  const { ownerType, ownerId } = upload;
  if (ownerType === null) return upload.uploadedById === user.id ? 'LEGACY' : 'DENY';
  if (!(await canReadUpload(db, user, { name, ownerId, ownerType }))) return 'DENY';
  return SHARED_RECORD_TYPES.some((type) => type === ownerType) ? 'TYPED' : 'LEGACY';
}
