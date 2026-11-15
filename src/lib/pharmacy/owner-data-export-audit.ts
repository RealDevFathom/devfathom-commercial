import 'server-only';

import { recordAudit } from '@/server/audit';
import type { TRPCContext } from '@/server/trpc';

export type OwnerDataExportAuditAction =
  'pharmacy.dataExport.request' | 'pharmacy.dataExport.download' | 'pharmacy.dataExport.list';

/**
 * DEV-93 / DEV-783 — one audit row per export request, download and list view
 * (the settings page and the list API), refusals and wrong PINs included. The
 * write is awaited: callers release nothing when it fails.
 */
export async function auditOwnerDataExport(
  ctx: Pick<TRPCContext, 'organization' | 'entitlements' | 'session' | 'requestMeta' | 'db'>,
  input: {
    path: string;
    method: 'GET' | 'POST';
    action: OwnerDataExportAuditAction;
    operation: 'READ' | 'CREATE';
    status: number;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const organizationId = ctx.organization?.id ?? ctx.entitlements.organizationId;
  if (!organizationId) return;
  await recordAudit(
    {
      organizationId,
      actorType: 'USER',
      actorId: ctx.session?.user?.id,
      actorRole: ctx.session?.user?.role,
      source: 'SYSTEM',
      category: 'PHARMACY_DATA_EXPORT',
      operation: input.operation,
      action: input.action,
      path: input.path,
      httpMethod: input.method,
      statusCode: input.status,
      outcome: input.status < 400 ? 'SUCCESS' : 'FAILURE',
      ip: ctx.requestMeta.ip,
      userAgent: ctx.requestMeta.userAgent,
      metadata: { ...input.metadata, attemptedAt: new Date().toISOString() },
    },
    ctx.db
  );
}
