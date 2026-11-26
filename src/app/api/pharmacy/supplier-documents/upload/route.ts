import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import { z } from 'zod';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { SUPPLIER_LINK_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';
import { trustedRequestOrigin } from '@/lib/http-origin';
import {
  assertSupplierDocumentPermission,
  SupplierLinkError,
  uploadSupplierDocument,
} from '@/lib/pharmacy/supplier-action-links';
import {
  SUPPLIER_DOCUMENT_MAX_BYTES,
  SUPPLIER_DOCUMENT_SIZE_MESSAGE,
  SUPPLIER_DOCUMENT_TOKEN_HEADER,
  SUPPLIER_DOCUMENT_TYPES,
} from '@/lib/pharmacy/supplier-document-contract';
import { StorageUnavailableError } from '@/lib/storage';
import { TenantHostError } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { uploadPost } from '@/lib/uploads/multipart-request';
import { categoryForPath, recordAudit } from '@/server/audit';
import { assertProcurementBranch } from '@/server/pharmacy-procurement-scope';
import { createTRPCContext } from '@/server/trpc';

export const runtime = 'nodejs';

const metadata = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  fileName: z.string().trim().min(1).max(255),
  declaredMimeType: z.enum(SUPPLIER_DOCUMENT_TYPES),
});

function message(status: number, body: string) {
  return new Response(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export const POST = uploadPost(async (request, readUploadForm) => {
  try {
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user.id) return message(401, 'Sign in to upload a supplier document.');

    const origin = request.headers.get('origin');
    if (origin !== trustedRequestOrigin(request)) return message(403, 'Forbidden.');

    // The token grants permission for exactly this purchase order in the signed-in
    // user's workspace. It belongs in a header, not a URL or the multipart body.
    const token = request.headers.get(SUPPLIER_DOCUMENT_TOKEN_HEADER)?.trim();
    if (!token || token.length > 200) return message(404, SUPPLIER_LINK_GENERIC_MESSAGE);
    const userId = actor.session.user.id;
    const organizationId = actor.organization.id;
    const branchAudit = await withTenantDb(
      organizationId,
      async (db) => {
        const branchId = await assertSupplierDocumentPermission(db, token);
        if (
          !(await can(subjectFromSession(actor.session.user), 'pharmacy:procurement', undefined, {
            db,
          }))
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Procurement permission is required.',
          });
        }
        const ctx = await createTRPCContext({
          req: request,
          db,
          session: actor.session,
          organization: actor.organization,
          support: actor.support,
        });
        await assertProcurementBranch(ctx, branchId, db);
        return ctx.audit.detail.metadata;
      },
      { userId }
    );

    let form: FormData;
    try {
      const result = await readUploadForm(
        userId,
        organizationId,
        'text',
        SUPPLIER_DOCUMENT_MAX_BYTES
      );
      if (result instanceof Response) return result;
      if (!result) return message(413, SUPPLIER_DOCUMENT_SIZE_MESSAGE);
      form = result;
    } catch {
      return message(400, 'The upload was incomplete or not a multipart form.');
    }

    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return message(400, 'Choose a nonempty PDF, PNG or JPEG file.');
    }
    if (file.size > SUPPLIER_DOCUMENT_MAX_BYTES)
      return message(413, SUPPLIER_DOCUMENT_SIZE_MESSAGE);
    const input = metadata.safeParse({
      idempotencyKey: form.get('idempotencyKey'),
      fileName: file.name,
      declaredMimeType: file.type,
    });
    if (!input.success) return message(400, 'Choose a PDF, PNG or JPEG with a valid file name.');

    const content = Buffer.from(await file.arrayBuffer());
    // Check the token again when writing under the existing link lock.
    const document = await withTenantDb(
      organizationId,
      (db) => uploadSupplierDocument(db, { token, ...input.data, content }),
      { userId, timeout: 60_000 }
    );
    const user = actor.session.user;
    const action = 'pharmacySupplierLinks.uploadDocument';
    recordAudit({
      organizationId,
      actorType: 'USER',
      actorId: userId,
      actorName: user.name,
      actorEmail: user.email,
      actorRole: user.role,
      source: 'REST_API',
      category: categoryForPath(action),
      operation: 'CREATE',
      action,
      targetType: 'PharmacySupplierDocument',
      targetId: document.id,
      outcome: 'SUCCESS',
      metadata: {
        ...branchAudit,
        branchId: document.branchId,
        ...(user.isSupportSession
          ? {
              supportSessionId: user.supportSessionId,
              platformUserId: user.platformUserId,
              actingAsTenantUserId: userId,
            }
          : {}),
      },
    });
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    if (error instanceof TenantHostError) return message(error.status, error.message);
    if (error instanceof TRPCError && error.code === 'FORBIDDEN')
      return message(403, error.message);
    if (error instanceof SupplierLinkError) {
      switch (error.reason) {
        case 'INVALID_LINK':
          return message(404, SUPPLIER_LINK_GENERIC_MESSAGE);
        case 'LINK_LIMIT_EXCEEDED':
          return message(429, 'This supplier link has reached its upload limit.');
        case 'IDEMPOTENCY_CONFLICT':
          return message(409, 'This upload does not match the original request.');
        default:
          return message(400, 'Choose a valid PDF, PNG or JPEG file.');
      }
    }
    if (error instanceof StorageUnavailableError) return message(503, 'Uploads are unavailable.');
    return message(500, 'The document could not be saved. Try again shortly.');
  }
});

export {
  uploadMethodResponse as GET,
  uploadMethodResponse as HEAD,
  uploadMethodResponse as PUT,
  uploadMethodResponse as PATCH,
  uploadMethodResponse as DELETE,
  uploadMethodResponse as OPTIONS,
} from '@/lib/uploads/multipart-request';
