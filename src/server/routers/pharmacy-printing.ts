import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  bridgeView,
  selectPharmacyPrintBridge,
  enqueuePharmacyReceiptPrint,
  enrollPharmacyPrintBridge,
  listPharmacyPrintBridges,
  PharmacyPrintQueueError,
  printJobView,
  readPharmacyPrintJob,
  retryPharmacyPrintJob,
  revokePharmacyPrintBridge,
  type PharmacyPrintQueueErrorReason,
} from '@/lib/pharmacy/receipt-print-queue';
import { readPharmacyReceiptFormat, PharmacyReceiptPrintError } from '@/lib/pharmacy/receipt-print';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { adminProcedure, auditedProtectedProcedure, router } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';
import {
  branchScopeOrForbidden,
  allocateSettledCounterReceiptPrintJob,
  requireCounterReceiptAccess,
} from './pharmacy-sales';

/**
 * DEV-741 — Pharmacy thermal receipt transport (server side only; the settings
 * and test-print screens belong to DEV-742).
 *
 * Provenance (DEV-168): no procedure here accepts printable content. A receipt
 * job is always built by `allocateSettledCounterReceiptPrintJob` from the settled
 * sale, under the same receipt authorization as the download path, and
 * reprints carry the existing "REPRINT - not a new sale" marking.
 */

const id = z.string().trim().min(1).max(128);
/** One key per operator click; replays of the same click never print twice. */
const requestKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Use 8–64 letters, digits, "-" or "_".');

const BROWSER_FALLBACK: Partial<Record<PharmacyPrintQueueErrorReason, string>> = {
  NO_BRIDGE: 'No thermal print bridge is set up for this branch. Use the browser print dialog.',
  BRIDGE_OFFLINE:
    'The thermal print bridge is offline. Nothing was queued. Use the browser print dialog.',
};

const QUEUE_ERRORS: Record<
  PharmacyPrintQueueErrorReason,
  { code: TRPCError['code']; message: string }
> = {
  NO_BRIDGE: { code: 'PRECONDITION_FAILED', message: BROWSER_FALLBACK.NO_BRIDGE! },
  BRIDGE_OFFLINE: { code: 'PRECONDITION_FAILED', message: BROWSER_FALLBACK.BRIDGE_OFFLINE! },
  BRIDGE_REQUIRED: {
    code: 'BAD_REQUEST',
    message: 'This branch has more than one thermal printer. Choose one.',
  },
  BRIDGE_NOT_FOUND: { code: 'NOT_FOUND', message: 'Print bridge not found.' },
  BRIDGE_REVOKED: {
    code: 'PRECONDITION_FAILED',
    message: 'This job’s print bridge was revoked. Print the receipt again from the sale.',
  },
  REPRINT_KEY_REQUIRED: { code: 'BAD_REQUEST', message: 'A reprint needs a request key.' },
  JOB_NOT_FOUND: { code: 'NOT_FOUND', message: 'Print job not found.' },
  NOT_RETRYABLE: {
    code: 'CONFLICT',
    message: 'This print job is still in progress or was already sent to the printer.',
  },
  PAPER_CHECK_REQUIRED: {
    code: 'PRECONDITION_FAILED',
    message:
      'The printer may already have printed this receipt. Check the printer, then confirm no paper came out.',
  },
  CHANGED: { code: 'CONFLICT', message: 'The print job changed. Refresh and try again.' },
  INVALID_NAME: { code: 'BAD_REQUEST', message: 'Enter a bridge name of 1–80 characters.' },
  INVALID_PRINTER: {
    code: 'BAD_REQUEST',
    message: 'Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.',
  },
};

function queueError(error: unknown): never {
  if (error instanceof PharmacyPrintQueueError) {
    const mapped = QUEUE_ERRORS[error.reason];
    throw new TRPCError({ code: mapped.code, message: mapped.message, cause: error });
  }
  throw error;
}

function thermalFormatMismatch(
  layout: { browserPaper?: 'THERMAL' | 'A4'; paperWidth: 58 | 80 },
  paper: 'THERMAL_58' | 'THERMAL_80'
) {
  const code =
    layout.browserPaper === 'A4'
      ? 'A4_OUTPUT'
      : layout.paperWidth !== (paper === 'THERMAL_58' ? 58 : 80)
        ? 'PAPER_MISMATCH'
        : null;
  return code
    ? {
        status: 'FALLBACK' as const,
        code,
        fallback: 'BROWSER_OS' as const,
        message: 'Printer paper settings changed. Use the browser print dialog.',
      }
    : null;
}

export const pharmacyPrintingRouter = router({
  /** Bridge health for counter staff. No printer address, no credential. */
  printerStatus: auditedProtectedProcedure
    .input(z.object({ branchId: id }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      const now = new Date();
      const bridges = await listPharmacyPrintBridges(ctx.db, scope);
      return {
        bridges: bridges
          .filter((bridge) => bridge.status === 'ACTIVE')
          .map((bridge) => bridgeView(bridge, now)),
        paperConfirmation: 'UNAVAILABLE' as const,
      };
    }),

  /** Full bridge list including the host printer target. Admins only. */
  bridges: adminProcedure
    .input(z.object({ branchId: id }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      const now = new Date();
      return (await listPharmacyPrintBridges(ctx.db, scope)).map((bridge) => ({
        ...bridgeView(bridge, now),
        printerId: bridge.printerId,
        createdAt: bridge.createdAt.toISOString(),
      }));
    }),

  /**
   * Enroll a bridge for one host printer. The credential is shown ONCE; only
   * its hash is stored and the audit log records inputs, never this output.
   */
  enrollBridge: adminProcedure
    .meta(refuseSupportSession)
    .input(
      z
        .object({
          branchId: id,
          name: z.string().trim().min(1).max(80),
          printerId: z.string().min(1).max(128),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      try {
        const { bridge, credential } = await enrollPharmacyPrintBridge(ctx.db, scope, input);
        return {
          bridge: { ...bridgeView(bridge, new Date()), printerId: bridge.printerId },
          credential,
          notice:
            'Store this credential in the bridge host’s owner-only token file now. It is not shown again.',
        };
      } catch (error) {
        queueError(error);
      }
    }),

  revokeBridge: adminProcedure
    .meta(refuseSupportSession)
    .input(z.object({ branchId: id, bridgeId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      try {
        const bridge = await revokePharmacyPrintBridge(ctx.db, scope, input.bridgeId, new Date());
        return { bridgeId: bridge.id, status: bridge.status };
      } catch (error) {
        queueError(error);
      }
    }),

  /** Server-authored receipt, one durable copy allocation per operator click. */
  enqueueReceipt: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId: id,
          saleId: id,
          locale: z.enum(['en', 'ur']),
          paper: z.enum(['THERMAL_58', 'THERMAL_80']),
          requestKey,
          bridgeId: id.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          // Replay before copy allocation or settings/offline checks.
          const key = createHash('sha256')
            .update(JSON.stringify([input.saleId, scope.actorId, input.requestKey]))
            .digest('hex');
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key + ':' + scope.organizationId + ':' + scope.branchId}, 0))`;
          const prior = await tx.pharmacyPrintJob.findUnique({
            where: {
              organizationId_branchId_idempotencyKey: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                idempotencyKey: key,
              },
            },
          });
          if (prior)
            return {
              status: 'QUEUED' as const,
              replayed: true,
              job: printJobView(prior, new Date()),
            };
          // Serialize against settings changes, including saved A4 and roll width.
          await tx.$queryRaw`SELECT id FROM pharmacy_branches WHERE id = ${scope.branchId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
          const format = await readPharmacyReceiptFormat(tx, scope);
          const mismatch = thermalFormatMismatch(format.layout, input.paper);
          if (mismatch) return mismatch;
          const now = new Date();
          const bridge = await selectPharmacyPrintBridge(
            tx as ScopedDb,
            scope,
            input.bridgeId,
            now
          );
          const built = await allocateSettledCounterReceiptPrintJob(ctx, tx, scope, input);
          const { job, replayed } = await enqueuePharmacyReceiptPrint(tx as ScopedDb, {
            ...scope,
            saleId: input.saleId,
            receiptNumber: built.receiptNumber,
            reprint: built.result.reprint,
            copyNumber: built.result.copyNumber,
            idempotencyKey: key,
            requestKey: input.requestKey,
            bridgeId: bridge.id,
            selectedBridge: bridge,
            document: built.result.document,
            byteCount: built.result.escPos.byteCount,
            paperWidth: built.result.paperWidth,
            now,
          });
          return { status: 'QUEUED' as const, replayed, job: printJobView(job, now) };
        });
      } catch (error) {
        if (error instanceof RawPrintValidationError)
          return {
            status: 'FALLBACK' as const,
            code: error.code,
            fallback: error.fallback,
            message: error.message,
          };
        if (error instanceof PharmacyReceiptPrintError)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This bill is not settled, so it has no receipt to print.',
          });
        if (error instanceof PharmacyPrintQueueError && BROWSER_FALLBACK[error.reason]) {
          return {
            status: 'FALLBACK' as const,
            code: error.reason,
            fallback: 'BROWSER_OS' as const,
            message: BROWSER_FALLBACK[error.reason]!,
          };
        }
        queueError(error);
      }
    }),

  jobStatus: auditedProtectedProcedure
    .input(z.object({ branchId: id, jobId: id }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        return printJobView(await readPharmacyPrintJob(ctx.db, scope, input.jobId), new Date());
      } catch (error) {
        queueError(error);
      }
    }),

  /**
   * Resend the SAME job (same document and reprint marking). Never automatic.
   * After FAILED/UNCONFIRMED the operator must confirm no paper came out.
   */
  retryJob: auditedProtectedProcedure
    .input(
      z
        .object({ branchId: id, jobId: id, confirmNoPaperPrinted: z.boolean().default(false) })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      const now = new Date();
      try {
        const job = await ctx.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM pharmacy_branches WHERE id = ${scope.branchId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
          const existing = await readPharmacyPrintJob(tx as ScopedDb, scope, input.jobId);
          const format = await readPharmacyReceiptFormat(tx, scope);
          if (
            thermalFormatMismatch(
              format.layout,
              existing.paperWidth === 58 ? 'THERMAL_58' : 'THERMAL_80'
            )
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Printer paper settings changed. Use the browser print dialog.',
            });
          }
          return retryPharmacyPrintJob(tx as ScopedDb, scope, {
            jobId: input.jobId,
            paperChecked: input.confirmNoPaperPrinted,
            now,
          });
        });
        return printJobView(job, now);
      } catch (error) {
        queueError(error);
      }
    }),
});
