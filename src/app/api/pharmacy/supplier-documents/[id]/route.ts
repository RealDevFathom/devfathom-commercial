import { responseForPasswordChange } from '@/lib/auth/session-state';
import { actorCanProcure, procurementBranchIds } from '@/lib/pharmacy/procurement-access';
import { getUpload, StorageUnavailableError, StoredObjectMissingError } from '@/lib/storage';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

import { recordAudit } from '@/server/audit';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user.id) return new Response(null, { status: 401 });
    const organizationId = actor.organization.id;
    const userId = actor.session.user.id;
    const { id } = await context.params;
    const document = await withTenantDb(
      organizationId,
      async (db) => {
        if (!(await actorCanProcure(db, userId))) return null;
        const branches = await procurementBranchIds(db, organizationId, userId);
        return db.pharmacySupplierDocument.findFirst({
          where: {
            id,
            organizationId,
            ownerType: 'PHARMACY_PURCHASE_ORDER',
            branchId: { in: branches },
            submission: {
              actionLink: {
                purchaseOrder: { branchId: { in: branches }, branch: { active: true } },
              },
            },
          },
          select: {
            branchId: true,
            storageUri: true,
            mimeType: true,
            sha256: true,
            submission: { select: { actionLinkId: true } },
          },
        });
      },
      { userId }
    );
    if (!document) return new Response(null, { status: 404 });
    const linkId = document.submission.actionLinkId;
    if (!/^[0-9a-f-]{36}$/i.test(linkId) || !/^[a-f0-9]{64}$/.test(document.sha256))
      return new Response(null, { status: 404 });
    // Existing S3 objects keep their original nested key.
    if (
      document.storageUri !== `supplier-po-${linkId}-${document.sha256}` &&
      document.storageUri !== `supplier-po/${linkId}/${document.sha256}`
    )
      return new Response(null, { status: 404 });
    const bytes = await getUpload(organizationId, document.storageUri);
    await withTenantDb(
      organizationId,
      async (db) => {
        await recordAudit(
          {
            organizationId,
            actorType: 'USER',
            actorId: userId,
            source: 'REST_API',
            operation: 'READ',
            category: 'pharmacy',
            action: 'pharmacySupplierLinks.downloadDocument',
            targetType: 'PharmacySupplierDocument',
            targetId: id,
            outcome: 'SUCCESS',
            metadata: {
              branchId: document.branchId,
              actionLinkId: linkId,
              ...(actor.session.user.isSupportSession
                ? {
                    supportSessionId: actor.session.user.supportSessionId,
                    platformUserId: actor.session.user.platformUserId,
                    actingAsTenantUserId: userId,
                  }
                : {}),
            },
          },
          db
        );
      },
      { userId }
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': document.mimeType,
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const denied = responseForPasswordChange(error);
    if (denied) return denied;
    if (error instanceof StorageUnavailableError) return new Response(null, { status: 503 });
    if (
      error instanceof StoredObjectMissingError ||
      (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    )
      return new Response(null, { status: 404 });
    throw error;
  }
}
