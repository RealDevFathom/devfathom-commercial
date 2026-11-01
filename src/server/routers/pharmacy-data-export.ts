import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  listPharmacyDataExports,
  PharmacyDataExportError,
  readPharmacyDataExportArchive,
  requestPharmacyDataExport,
} from '@/lib/pharmacy/data-export';
import { verifyOwnerExportPin } from '@/lib/pharmacy/data-export-pin';
import { annotateAudit } from '@/server/audit';
import { PharmacyCatalogueImportError } from '@/lib/pharmacy/data-export-catalogue';
import { importCatalogueSource } from '@/lib/pharmacy/migration/workbench';

import { adminProcedure, assertModuleLicensed, router, type TRPCContext } from '../trpc';

/**
 * #716 — owner "Download my data". Every procedure is `adminProcedure`: the
 * ABAC `admin:access` capability (the pharmacy owner role), audited for reads
 * as well as mutations, and gated on the pharmacy module. A support session
 * acting inside the tenant is refused: the export is the owner's own action.
 *
 * The Pharmacy Core entitlement is also asserted inside every procedure, so a
 * server-side caller built from this router alone (the download route, the
 * settings page) is gated exactly like the namespaced tRPC request, whose
 * procedure path is what the shared module middleware keys on.
 *
 * Requesting and downloading an export both require the owner to re-enter
 * their own PIN: the archive carries patient, prescription and khata records.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const exportId = z.string().trim().min(1).max(128);
const pin = z.string().min(1).max(64);

const PIN_REFUSAL = {
  NO_PIN: {
    code: 'FORBIDDEN',
    message: 'Set up your staff PIN before exporting data. Your PIN confirms it is you.',
  },
  REJECTED: { code: 'UNAUTHORIZED', message: 'That PIN is not correct.' },
  LOCKED: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many incorrect PINs. Your PIN is locked for a few minutes.',
  },
} as const;

/**
 * Re-verify the owner's PIN. A refusal is audited (the shared audit middleware
 * records the failed call) under the export action it was protecting.
 */
async function requireOwnerPin(
  ctx: TRPCContext,
  owner: { organizationId: string; actorId: string },
  input: { pin: string; action: 'requested' | 'downloaded'; exportId?: string }
): Promise<void> {
  const result = await verifyOwnerExportPin(ctx.db, {
    organizationId: owner.organizationId,
    userId: owner.actorId,
    pin: input.pin,
  });
  if (result === 'OK') return;
  annotateAudit(ctx, {
    category: 'pharmacy',
    operation: input.action === 'requested' ? 'EXECUTE' : 'READ',
    action: 'pharmacy.dataExport.pinRefused',
    description: `Owner data export ${input.action === 'requested' ? 'request' : 'download'} refused: PIN not confirmed.`,
    targetType: 'PharmacyDataExport',
    ...(input.exportId ? { targetId: input.exportId } : {}),
    metadata: { reason: result, step: input.action },
  });
  throw new TRPCError(PIN_REFUSAL[result]);
}

function ownerOrganizationId(ctx: TRPCContext): { organizationId: string; actorId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const user = ctx.session?.user;
  if (!organizationId || !user?.id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  assertModuleLicensed(ctx, 'pharmacy-core');
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
    .input(z.object({ from: day, to: day, pin }).strict())
    .mutation(async ({ ctx, input }) => {
      const owner = ownerOrganizationId(ctx);
      const { organizationId, actorId } = owner;
      await requireOwnerPin(ctx, owner, { pin: input.pin, action: 'requested' });
      try {
        const result = await requestPharmacyDataExport(ctx.db, {
          organizationId,
          actorId,
          range: { from: input.from, to: input.to },
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
   * streams the bytes. Audited by `adminProcedure`; the bytes are never written
   * to the audit row. A mutation because it needs the PIN and counts the download.
   */
  download: adminProcedure
    .input(z.object({ id: exportId, pin }).strict())
    .mutation(async ({ ctx, input }) => {
      const owner = ownerOrganizationId(ctx);
      const { organizationId } = owner;
      await requireOwnerPin(ctx, owner, { pin: input.pin, action: 'downloaded', exportId: input.id });
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
