/**
 * DEV-742 — the fixed client contract for the DEV-741 thermal print queue
 * (`trpc.pharmacyPrinting.*`). UI components import from here; they never
 * invent job states, codes or wording of their own.
 *
 * Honesty rules: no state means "printed". `SENT_TO_PRINTER` means the host
 * transport accepted the bytes; paper is never confirmed by any system here.
 */
import type { CounterReceiptFormat } from './counter-browser-print';

export type PrintJobState =
  'QUEUED' | 'SENDING' | 'SENT_TO_PRINTER' | 'FAILED' | 'UNCONFIRMED' | 'EXPIRED';

export type PrintJobKind = 'RECEIPT' | 'TEST_PAGE';

/** Mirrors `printJobView` on the server. */
export type PrintJobView = {
  id: string;
  kind: PrintJobKind;
  saleId: string | null;
  receiptNumber: number | null;
  reprint: boolean;
  bridgeId: string;
  paperWidth: number;
  state: PrintJobState;
  attemptCount: number;
  queuedAt: string;
  lastAttemptAt: string | null;
  acceptedAt: string | null;
  failureCode: string | null;
  paperConfirmed: false;
  retryable: boolean;
  retryRequiresPaperCheck: boolean;
};

/** Thermal paper the bridge can be asked for. A4 is not expressible. */
export type ThermalPaper = 'THERMAL_58' | 'THERMAL_80';

/** `null` means "never send this to the thermal bridge" (A4, labels). */
export function thermalPaperForFormat(format: CounterReceiptFormat): ThermalPaper | null {
  if (format === 'THERMAL_58') return 'THERMAL_58';
  if (format === 'THERMAL') return 'THERMAL_80';
  return null;
}

export function thermalPaperForWidth(paperWidth: 58 | 80): ThermalPaper {
  return paperWidth === 58 ? 'THERMAL_58' : 'THERMAL_80';
}

/** Codes a `{ status: 'FALLBACK' }` enqueue result can carry. Nothing was queued. */
export type PrintFallbackCode =
  | 'NO_BRIDGE'
  | 'BRIDGE_OFFLINE'
  | 'A4_OUTPUT'
  | 'PAPER_MISMATCH'
  | 'UNSUPPORTED_PRINT_TEXT'
  | 'INVALID_PRINT_DOCUMENT';

export const PRINT_FALLBACK_TEXT: Record<PrintFallbackCode, string> = {
  NO_BRIDGE:
    'No thermal print bridge is set up for this branch. Nothing was sent. Use the browser print dialog.',
  BRIDGE_OFFLINE:
    'The thermal print bridge is offline. Nothing was sent. Use the browser print dialog.',
  A4_OUTPUT:
    'This branch prints receipts on A4, so nothing was sent to the thermal printer. Use the browser print dialog.',
  PAPER_MISMATCH:
    'The paper chosen here does not match the branch’s saved thermal roll width. Nothing was sent. Reload, or change the paper.',
  UNSUPPORTED_PRINT_TEXT:
    'The thermal printer cannot print this text (for example Urdu). Nothing was sent. Use the browser print dialog.',
  INVALID_PRINT_DOCUMENT:
    'This receipt could not be prepared for the thermal printer. Nothing was sent. Use the browser print dialog.',
};

export function fallbackText(code: string | undefined | null): string {
  return (code && PRINT_FALLBACK_TEXT[code as PrintFallbackCode]) || PRINT_FALLBACK_TEXT.NO_BRIDGE;
}

/** Visible text + StatusPill tone per state. Never says "printed". */
export const PRINT_JOB_STATE_TEXT: Record<
  PrintJobState,
  { label: string; tone: 'info' | 'warning' | 'success' | 'danger' | 'neutral'; detail: string }
> = {
  QUEUED: {
    label: 'Waiting for bridge',
    tone: 'info',
    detail:
      'Queued for the thermal print bridge. It expires after 5 minutes if no bridge collects it.',
  },
  SENDING: {
    label: 'Sending',
    tone: 'info',
    detail: 'The bridge collected the job and is sending it to the printer.',
  },
  SENT_TO_PRINTER: {
    label: 'Sent to printer',
    tone: 'success',
    detail:
      'The printer connection accepted the job. DevFathom cannot see paper — check the printer.',
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    detail: 'The bridge reported that sending failed. Check the printer before trying again.',
  },
  UNCONFIRMED: {
    label: 'Not confirmed',
    tone: 'warning',
    detail:
      'The bridge collected the job but never reported back. It may or may not have printed — check the printer before trying again.',
  },
  EXPIRED: {
    label: 'Expired, not sent',
    tone: 'neutral',
    detail: 'No bridge collected the job in time, so it was never sent.',
  },
};

/** States after which polling stops. */
export function isPrintJobSettled(state: PrintJobState): boolean {
  return state !== 'QUEUED' && state !== 'SENDING';
}

export const PRINT_JOB_POLL_MS = 2_000;

/** One key per operator click (server regex `^[A-Za-z0-9_-]{8,64}$`). Reuse it for retries of the same click. */
export function newPrintRequestKey(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `k-${random}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}
