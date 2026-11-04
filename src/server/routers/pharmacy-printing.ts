import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  PRINT_FALLBACK_TEXT,
  thermalPaperForWidth,
  type PrintFallbackCode,
} from '@/lib/pharmacy/print-job-ui';
import { buildPrinterTestPrintJob } from '@/lib/pharmacy/printer-test-escpos';
import { readPharmacyReceiptFormat } from '@/lib/pharmacy/receipt-print';
import {
  bridgeView,
  enqueuePharmacyReceiptPrint,
  enqueuePharmacyTestPagePrint,
  enrollPharmacyPrintBridge,
  listPharmacyPrintBridges,
  PharmacyPrintQueueError,
  printJobView,
  readPharmacyPrintJob,
  retryPharmacyPrintJob,
  revokePharmacyPrintBridge,
  type PharmacyPrintQueueErrorReason,
} from '@/lib/pharmacy/receipt-print-queue';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { adminProcedure, auditedProtectedProcedure, router } from '../trpc';
import {
  branchScopeOrForbidden,
  buildSettledCounterReceiptPrintJob,
  requireCounterReceiptAccess,
} from './pharmacy-sales';

/**
 * DEV-741 — Pharmacy thermal receipt transport (server side only; the settings
 * and test-print screens belong to DEV-742).
 *
 * Provenance (DEV-168): no procedure here accepts printable content. A receipt
 * job is always built by `buildSettledCounterReceiptPrintJob` from the settled
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

/**
 * DEV-742 thermal paper. Only roll widths are expressible: an A4 intent cannot
 * be sent to the bridge at all.
 */
const thermalPaper = z.enum(['THERMAL_58', 'THERMAL_80']);

function outputFallback(code: PrintFallbackCode) {
  return {
    status: 'FALLBACK' as const,
    code,
    fallback: 'BROWSER_OS' as const,
    message: PRINT_FALLBACK_TEXT[code],
  };
}

/**
 * DEV-742 output guard, evaluated on the server before anything is queued: a
 * branch whose saved paper is A4 never uses the thermal bridge, and the
 * caller's paper must equal the saved roll width, so a stale or still-loading
 * client default cannot misroute a job.
 */
async function thermalOutputRefusal(
  db: Parameters<typeof readPharmacyReceiptFormat>[0],
  scope: { organizationId: string; branchId: string },
  paper: z.infer<typeof thermalPaper>
) {
  const format = await readPharmacyReceiptFormat(db, scope);
  if (format.output === 'A4') return outputFallback('A4_OUTPUT');
  if (thermalPaperForWidth(format.layout.paperWidth) !== paper) {
    return outputFallback('PAPER_MISMATCH');
  }
  return null;
}

function queueError(error: unknown): never {
  if (error instanceof PharmacyPrintQueueError) {
    const mapped = QUEUE_ERRORS[error.reason];
    throw new TRPCError({ code: mapped.code, message: mapped.message, cause: error });
  }
  throw error;
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

  /**
   * Queue the settled receipt for this branch's thermal bridge. An original is
   * queued at most once per sale; a reprint needs a fresh `requestKey` per
   * click. Unprintable text, no bridge, or an offline bridge returns the
   * browser/OS fallback and queues nothing.
   */
  enqueueReceipt: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId: id,
          saleId: id,
          locale: z.enum(['en', 'ur']),
          reprint: z.boolean(),
          paper: thermalPaper,
          requestKey: requestKey.optional(),
          bridgeId: id.optional(),
        })
        .strict()
        .refine((value) => !value.reprint || !!value.requestKey, {
          message: 'A reprint needs a request key.',
          path: ['requestKey'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      const refusal = await thermalOutputRefusal(ctx.db, scope, input.paper);
      if (refusal) return refusal;
      const built = await buildSettledCounterReceiptPrintJob(ctx, input);
      if (built.status !== 'READY') return built;
      // The format may have changed between the guard and the build; never queue a width
      // the caller did not ask for.
      if (thermalPaperForWidth(built.job.paperWidth) !== input.paper) {
        return outputFallback('PAPER_MISMATCH');
      }
      const now = new Date();
      try {
        const { job, replayed } = await ctx.db.$transaction((tx) =>
          enqueuePharmacyReceiptPrint(tx as ScopedDb, {
            organizationId: built.scope.organizationId,
            branchId: built.scope.branchId,
            actorId: built.scope.actorId,
            saleId: input.saleId,
            receiptNumber: built.receiptNumber,
            reprint: input.reprint,
            requestKey: input.requestKey,
            bridgeId: input.bridgeId,
            document: built.job.document,
            byteCount: built.job.escPos.byteCount,
            paperWidth: built.job.paperWidth,
            now,
          })
        );
        return { status: 'QUEUED' as const, replayed, job: printJobView(job, now) };
      } catch (error) {
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

  /**
   * DEV-742 — queue the fixed thermal TEST PAGE (server-built ASCII, no sale,
   * no receipt number) for this branch's bridge. Same receipt access, output
   * guard, bridge selection and offline fallback as receipts. One job per click
   * key; a replay of the same key never prints twice.
   */
  enqueueTestPage: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId: id,
          paper: thermalPaper,
          requestKey,
          bridgeId: id.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      const refusal = await thermalOutputRefusal(ctx.db, scope, input.paper);
      if (refusal) return refusal;
      const now = new Date();
      const built = buildPrinterTestPrintJob({
        paperWidth: input.paper === 'THERMAL_58' ? 58 : 80,
        now,
      });
      try {
        const { job, replayed } = await ctx.db.$transaction((tx) =>
          enqueuePharmacyTestPagePrint(tx as ScopedDb, {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            actorId: scope.actorId,
            requestKey: input.requestKey,
            bridgeId: input.bridgeId,
            document: built.document,
            byteCount: built.byteCount,
            paperWidth: built.paperWidth,
            now,
          })
        );
        return { status: 'QUEUED' as const, replayed, job: printJobView(job, now) };
      } catch (error) {
        if (error instanceof PharmacyPrintQueueError && BROWSER_FALLBACK[error.reason]) {
          return outputFallback(error.reason as PrintFallbackCode);
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
        const job = await ctx.db.$transaction((tx) =>
          retryPharmacyPrintJob(tx as ScopedDb, scope, {
            jobId: input.jobId,
            paperChecked: input.confirmNoPaperPrinted,
            now,
          })
        );
        return printJobView(job, now);
      } catch (error) {
        queueError(error);
      }
    }),
});
