// RT-05 — authenticated attachment delivery (DEV local-FS storage).
//
// Previously uploads were written to public/uploads and served statically with
// ZERO authorization — anyone who obtained the URL (a since-removed member, a
// referer/log leak, link sharing) could fetch private-DM voice notes/files
// forever. This route requires a valid session before streaming the bytes, so a
// stale URL no longer leaks to anonymous or signed-out users. IMP-RT-05 adds
// per-channel membership enforcement for chat attachments below; signed-URL
// delivery against object storage remains the linked production enhancement.

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { getUpload, StorageUnavailableError } from '@/lib/storage';
import {
  PHARMACY_SOP_EVIDENCE_FILE_PREFIX,
  pharmacySopEvidenceReadDecision,
} from '@/lib/pharmacy/sop-evidence';
import { isOwnerDataExportObjectName } from '@/lib/pharmacy/owner-data-export-object';
import { canAccessProject, projectIdOfTask } from '@/lib/authz';

// Mirrors the upload allowlist — non-executable types served inline same-origin.
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
};

// DEV-837 (F15): a menu-import source file is only ever read server-side by the
// import pipeline, so this shared handler never serves one, whatever the caller
// holds. (Owner data exports have their own DEV-783 refusal below.)
const MENU_IMPORT_SOURCE = /^restaurant-menu-import__/iu;

// DEV-837 (F17): names only the SOP capture routes ever issue. A caller-supplied
// SOP storage reference to any other file is an annotation; it never decides
// who may read that file.
const RESTAURANT_SOP_CAPTURE_NAME =
  /^sop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;

function isSopCaptureName(name: string): boolean {
  return (
    RESTAURANT_SOP_CAPTURE_NAME.test(name) || name.startsWith(PHARMACY_SOP_EVIDENCE_FILE_PREFIX)
  );
}

/**
 * DEV-837 (F15): re-check the current read policy of the record that owns this
 * file reference. The owner is the EARLIEST record that references the file —
 * the upload it was created for, since only its uploader knew the URL then.
 * Project files and task attachments need project access now (admin or current
 * member); a client contract's signed document needs a current admin (the client
 * detail read rule). A later reference (someone attaching a known URL to their
 * own project) is an annotation: it can neither widen nor restrict who may read
 * the original. Chat attachments and SOP proof keep their own checks, so when
 * one of those came first no owner check applies here. Equally early records of
 * different kinds are ambiguous and denied.
 */
async function ownerBindingAllows(
  db: ScopedDb,
  user: { id: string; role?: string | null },
  fileRef: string,
  /** When the chat attachment / SOP proof referencing this file was recorded. */
  otherOwnersAt: readonly (Date | null | undefined)[]
): Promise<boolean> {
  const earliest = { orderBy: { createdAt: 'asc' as const } };
  const [projectFile, taskAttachment, contract] = await Promise.all([
    db.projectFile.findFirst({
      where: { url: fileRef },
      ...earliest,
      select: { projectId: true, createdAt: true },
    }),
    db.taskAttachment.findFirst({
      where: { url: fileRef },
      ...earliest,
      select: { taskId: true, createdAt: true },
    }),
    db.contract.findFirst({
      where: { fileUrl: fileRef },
      ...earliest,
      select: { id: true, createdAt: true },
    }),
  ]);
  const owners = [
    projectFile && { kind: 'project' as const, at: projectFile.createdAt.getTime() },
    taskAttachment && { kind: 'task' as const, at: taskAttachment.createdAt.getTime() },
    contract && { kind: 'contract' as const, at: contract.createdAt.getTime() },
    ...otherOwnersAt.map((at) => at && { kind: 'other' as const, at: at.getTime() }),
  ].filter((owner): owner is NonNullable<typeof owner> => Boolean(owner));
  if (owners.length === 0) return true;
  const firstAt = Math.min(...owners.map((owner) => owner.at));
  const first = owners.filter((owner) => owner.at === firstAt);
  if (new Set(first.map((owner) => owner.kind)).size > 1) return false;
  const owner = first[0]!;
  if (owner.kind === 'other') return true;
  if (owner.kind === 'contract') return user.role === 'ADMIN';
  const projectId =
    owner.kind === 'project'
      ? projectFile!.projectId
      : await projectIdOfTask(db, taskAttachment!.taskId);
  // An attachment whose task no longer resolves to a project is unbound: deny.
  if (!projectId) return false;
  return canAccessProject(db, user.id, user.role, projectId);
}

export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  let actor;
  try {
    actor = await resolveTenantActor({ request });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    throw error;
  }
  if (!actor?.session.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = actor.session;

  const { name } = await ctx.params;
  // Defense-in-depth against path traversal — only a bare filename is valid.
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return new Response('Bad request', { status: 400 });
  }
  // Camera stills require their evidence reader's grant and retention checks.
  if (/^camera-snapshot-/iu.test(name) || MENU_IMPORT_SOURCE.test(name)) {
    return new Response('Not found', { status: 404 });
  }
  // DEV-783: an owner data export is released only by its own PIN-gated,
  // audited, expiry-checked download route, never as a generic file.
  if (isOwnerDataExportObjectName(name)) {
    return new Response('Not found', { status: 404 });
  }
  const organization = actor.organization;
  const fileRef = '/api/files/' + name;

  // Pharmacy licence evidence belongs to the admin-only regulatory profile.
  // Look it up inside the tenant scope before touching storage, and use a 404
  // for denials so a member cannot confirm that a guessed file reference exists.
  const licenceEvidence = await withTenantDb(organization.id, (db) =>
    db.branchRegulatoryProfile.findFirst({
      where: { licenceEvidenceFileRef: fileRef },
      select: { id: true },
    })
  );
  if (licenceEvidence && session.user.role !== 'ADMIN') {
    return new Response('Not found', { status: 404 });
  }

  const sopCaptureName = isSopCaptureName(name);
  const sopEvidenceRow = await withTenantDb(organization.id, (db) =>
    db.restaurantSopEvidence.findFirst({
      where: { storageRef: fileRef },
      // The capture route's own row (or, for proof captured before
      // `serverCaptured` existed, the first row naming the blob) governs.
      orderBy: [{ serverCaptured: 'desc' }, { createdAt: 'asc' }],
      select: {
        serverCaptured: true,
        createdAt: true,
        uploaderStaffProfileId: true,
        occurrence: {
          select: {
            branchId: true,
            templateVersionId: true,
            assignedStaffProfileId: true,
            claimedByStaffProfileId: true,
          },
        },
      },
    })
  );
  // DEV-837 (F17): only a server capture binds a file to an SOP occurrence. A
  // caller-attached reference to an unrelated file (a logo, a project file) is
  // ignored here, and a capture-named blob with no evidence row is unbound.
  const sopEvidence =
    sopEvidenceRow && (sopEvidenceRow.serverCaptured === true || sopCaptureName)
      ? sopEvidenceRow
      : null;
  if (sopCaptureName && !sopEvidence) return new Response('Not found', { status: 404 });
  // DEV-751: proof on a pharmacy SOP site is governed by pharmacy branch
  // assignment and SOP capability, not by restaurant branch membership.
  const pharmacyDecision =
    sopEvidence && session.user.role !== 'ADMIN'
      ? await withTenantDb(organization.id, (db) =>
          pharmacySopEvidenceReadDecision(db, {
            organizationId: organization.id,
            user: session.user,
            evidence: sopEvidence,
          })
        )
      : null;
  if (pharmacyDecision === 'DENY') return new Response('Not found', { status: 404 });
  if (sopEvidence && session.user.role !== 'ADMIN' && pharmacyDecision === 'NOT_PHARMACY') {
    const branchAccess = await withTenantDb(organization.id, (db) =>
      db.restaurantBranchAssignment.findUnique({
        where: {
          branchId_userId: {
            branchId: sopEvidence.occurrence.branchId,
            userId: session.user.id,
          },
        },
        select: { id: true },
      })
    );
    if (!branchAccess) return new Response('Not found', { status: 404 });
  }

  // IMP-RT-05: per-channel membership enforcement. If this file is a chat
  // attachment, only members of its channel may fetch it — a stale URL no longer
  // leaks a private-channel/DM file to any signed-in user. Project files, task
  // attachments and contract documents are re-checked by their owning record
  // (DEV-837); other uploads (avatars, client logos) keep the session-only gate.
  const attachment = await withTenantDb(organization.id, (db) =>
    db.messageAttachment.findFirst({
      where: { url: fileRef },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, message: { select: { channelId: true } } },
    })
  );
  const ownerAllowed = await withTenantDb(organization.id, (db) =>
    ownerBindingAllows(db, session.user, fileRef, [attachment?.createdAt, sopEvidence?.createdAt])
  );
  if (!ownerAllowed) return new Response('Not found', { status: 404 });
  if (attachment) {
    const member = await withTenantDb(organization.id, (db) =>
      db.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: attachment.message.channelId,
            userId: session.user.id,
          },
        },
        select: { id: true },
      })
    );
    if (!member) {
      // 404 (not 403) so non-members can't even confirm the file exists.
      return new Response('Not found', { status: 404 });
    }
  }

  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  try {
    const data = await getUpload(organization.id, name);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        // Private so shared caches never hold an authenticated user's file.
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return new Response('Files are unavailable.', { status: 503 });
    }
    return new Response('Not found', { status: 404 });
  }
}
