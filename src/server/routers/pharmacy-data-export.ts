import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  listPharmacyDataExports,
  PharmacyDataExportError,
  readPharmacyDataExportArchive,
  requestPharmacyDataExport,
} from '@/lib/pharmacy/data-export';
import { annotateAudit } from '@/server/audit';
import { PharmacyCatalogueImportError } from '@/lib/pharmacy/data-export-catalogue';
import { importCatalogueSource } from '@/lib/pharmacy/migration/workbench';

import { adminProcedure, router, type TRPCContext } from '../trpc';

/**
 * #716 — owner "Download my data". Every procedure is `adminProcedure`: the
 * ABAC `admin:access` capability (the pharmacy owner role), audited for reads
 * as well as mutations, and gated on the pharmacy module. A support session
 * acting inside the tenant is refused: the export is the owner's own action.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const exportId = z.string().trim().min(1).max(128);

function ownerOrganizationId(ctx: TRPCContext): { organizationId: string; actorId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const user = ctx.session?.user;
  if (!organizationId || !user?.id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (
    ctx.organization?.vertical !== 'PHARMACY' ||
    ctx.organization.id !== organizationId ||
    user.organizationId !== organizationId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Data export is for pharmacy workspaces.' });
  }
  if (user.role !== 'ADMIN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
  }
  if (user.isSupportSession) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the workspace owner can export the workspace data.',
    });
  }
  return { organizationId, actorId: user.id };
}

function fail(error: unknown): never {
  if (error instanceof PharmacyDataExportError) {
    const map = {
      INVALID_RANGE: {
        code: 'BAD_REQUEST',
        message: 'Choose a sales range of at most 366 days that ends today or earlier.',
      },
      RATE_LIMITED: {
        code: 'TOO_MANY_REQUESTS',
        message: 'You have requested five exports in the last 24 hours. Try again later.',
      },
      NOT_FOUND: { code: 'NOT_FOUND', message: 'Export not found.' },
      NOT_READY: { code: 'BAD_REQUEST', message: 'This export is not ready to download.' },
      EXPIRED: {
        code: 'NOT_FOUND',
        message: 'This download link has expired. Request a new export.',
      },
      STORAGE_UNAVAILABLE: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Export storage is unavailable. Try again shortly.',
      },
    } as const;
    throw new TRPCError(map[error.reason]);
  }
  throw error;
}

export const pharmacyDataExportRouter = router({
  importCatalogue: adminProcedure
    .input(z.object({ csv: z.string().max(5_000_000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const { organizationId } = ownerOrganizationId(ctx);
      try {
        // Through the migration wizard: source evidence + profiled batch + drafts, atomically.
        const result = await importCatalogueSource(ctx.db, {
          organizationId,
          fileName: 'medicines.csv',
          csv: input.csv,
        });
        annotateAudit(ctx, {
          category: 'pharmacy',
          operation: 'CREATE',
          action: 'pharmacy.dataExport.catalogueImported',
          description: 'Owner imported catalogue drafts from medicines.csv for review.',
          targetType: 'Medicine',
          metadata: result,
        });
        return result;
      } catch (error) {
        if (error instanceof PharmacyCatalogueImportError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  list: adminProcedure.query(async ({ ctx }) => {
    const { organizationId } = ownerOrganizationId(ctx);
    return listPharmacyDataExports(ctx.db, organizationId);
  }),

  request: adminProcedure
    .input(z.object({ from: day, to: day }).strict())
    .mutation(async ({ ctx, input }) => {
      const { organizationId, actorId } = ownerOrganizationId(ctx);
      try {
        const result = await requestPharmacyDataExport(ctx.db, {
          organizationId,
          actorId,
          range: input,
        });
        annotateAudit(ctx, {
          category: 'pharmacy',
          operation: 'EXECUTE',
          action: 'pharmacy.dataExport.requested',
          description: result.created
            ? 'Owner requested a full data export.'
            : 'Owner re-requested a data export that is still being prepared.',
          targetType: 'PharmacyDataExport',
          targetId: result.export.id,
          metadata: { salesFrom: input.from, salesTo: input.to, created: result.created },
        });
        return result;
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * Server-side only: the download route calls this through `createCaller` and
   * streams the bytes. Audited as a read by `adminProcedure`; the bytes are
   * never written to the audit row.
   */
  download: adminProcedure
    .input(z.object({ id: exportId }).strict())
    .query(async ({ ctx, input }) => {
      const { organizationId } = ownerOrganizationId(ctx);
      try {
        const archive = await readPharmacyDataExportArchive(ctx.db, {
          organizationId,
          exportId: input.id,
        });
        annotateAudit(ctx, {
          category: 'pharmacy',
          operation: 'READ',
          action: 'pharmacy.dataExport.downloaded',
          description: 'Owner downloaded a data export archive.',
          targetType: 'PharmacyDataExport',
          targetId: input.id,
          metadata: { sizeBytes: archive.data.length, sha256: archive.sha256 },
        });
        return archive;
      } catch (error) {
        fail(error);
      }
    }),
});
