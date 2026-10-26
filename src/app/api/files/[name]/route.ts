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
  if (/^camera-snapshot-/iu.test(name)) {
    return new Response('Not found', { status: 404 });
  }
  const organization = actor.organization;
  const fileRef = `/api/files/${name}`;

  const sopEvidence = await withTenantDb(organization.id, (db) =>
    db.restaurantSopEvidence.findFirst({
      where: { storageRef: fileRef },
      select: { occurrence: { select: { branchId: true } } },
    })
  );
  if (sopEvidence && session.user.role !== 'ADMIN') {
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

  // The regulatory profile itself is admin-only. Apply the same role gate to
  // its licence evidence so knowing (or leaking) the otherwise opaque URL does
  // not let an ordinary tenant member bypass that profile's authorization.
  // The tenant-scoped transaction and explicit predicate keep the lookup from
  // classifying a file referenced by another organization as this tenant's.
  if (session.user.role !== 'ADMIN') {
    const licenceEvidence = await withTenantDb(organization.id, (db) =>
      db.branchRegulatoryProfile.findFirst({
        where: {
          organizationId: organization.id,
          licenceEvidenceFileRef: fileRef,
        },
        select: { id: true },
      })
    );
    if (licenceEvidence) {
      return new Response('Not found', { status: 404 });
    }
  }

  // IMP-RT-05: per-channel membership enforcement. If this file is a chat
  // attachment, only members of its channel may fetch it — a stale URL no longer
  // leaks a private-channel/DM file to any signed-in user. Non-chat uploads
  // (project files, avatars, client logos) keep the session-only gate; they have
  // their own visibility model and aren't in this ticket's scope.
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
