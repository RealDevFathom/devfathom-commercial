// RT-05 — authenticated attachment delivery (DEV local-FS storage).
//
// Previously uploads were written to public/uploads and served statically with
// ZERO authorization — anyone who obtained the URL (a since-removed member, a
// referer/log leak, link sharing) could fetch private-DM voice notes/files
// forever. This route requires a valid session before streaming the bytes, so a
// stale URL no longer leaks to anonymous or signed-out users. IMP-RT-05 adds
// per-channel membership enforcement for chat attachments below; signed-URL
// delivery against object storage remains the linked production enhancement.

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { getUpload, StorageUnavailableError } from '@/lib/storage';
import {
  PHARMACY_SOP_EVIDENCE_FILE_PREFIX,
  pharmacySopEvidenceReadDecision,
} from '@/lib/pharmacy/sop-evidence';
import { isOwnerDataExportObjectName } from '@/lib/pharmacy/owner-data-export-object';
import { canReadUpload } from '@/lib/uploads/registry';

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
  const pharmacyDecision = sopEvidence
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

  // DEV-837 (F15): every object other than SOP proof must be one that
  // /api/upload registered. An object bound to a project file, task attachment
  // or contract follows that record's CURRENT read policy (or, for a file
  // several records shared before the registry, any one of those records'), and
  // a deleted owner leaves a tombstone binding that denies. Client-supplied references never
  // bind or re-bind an object. An object the registry does not know (a legacy
  // file nothing references any more) is unresolved and is never served.
  if (!sopEvidence) {
    const upload = await withTenantDb(organization.id, (db) =>
      db.uploadedFile.findFirst({
        where: { name },
        select: { ownerType: true, ownerId: true },
      })
    );
    if (!upload) return new Response('Not found', { status: 404 });
    const ownerType = upload.ownerType;
    if (ownerType !== null) {
      const allowed = await withTenantDb(organization.id, (db) =>
        canReadUpload(db, session.user, { name, ownerType, ownerId: upload.ownerId })
      );
      if (!allowed) return new Response('Not found', { status: 404 });
    }
  }

  // IMP-RT-05: per-channel membership enforcement. If this file is a chat
  // attachment, only members of its channel may fetch it — a stale URL no longer
  // leaks a private-channel/DM file to any signed-in user. Uploads no record has
  // bound (client logos, licence evidence) keep their existing rules.
  const attachment = await withTenantDb(organization.id, (db) =>
    db.messageAttachment.findFirst({
      where: { url: fileRef },
      select: { message: { select: { channelId: true } } },
    })
  );
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
        // Require fresh authorization on every download, including in the same browser.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return new Response('Files are unavailable.', { status: 503 });
    }
    return new Response('Not found', { status: 404 });
  }
}
