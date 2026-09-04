/**
 * FIN-05 / D04 fiscal boundary.
 *
 * D04 has not selected a licensed FBR integrator, so the only runnable adapter
 * is an unmistakable sandbox. Missing configuration is OFF. Sandbox responses
 * are operational evidence only and are never eligible for receipt fiscal fields.
 */

export const FISCAL_RETENTION_YEARS = 6;
export const MAX_FISCAL_RETRY_SECONDS = 60 * 60;

export type FiscalIntegratorMode = 'OFF' | 'SANDBOX';
export type FiscalDocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type FiscalDocumentStatus = 'QUEUED' | 'SUBMITTING' | 'ACCEPTED' | 'REJECTED' | 'DEAD';

export type FiscalSubmission = {
  localReference: string;
  kind: FiscalDocumentKind;
  originalLocalReference: string | null;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
};

export type FiscalIntegratorResult =
  | { outcome: 'ACCEPTED'; externalReference: string; externalQr: string | null }
  | { outcome: 'REJECTED'; reason: string };

export interface FiscalIntegrator {
  readonly mode: Exclude<FiscalIntegratorMode, 'OFF'>;
  submit(document: FiscalSubmission): Promise<FiscalIntegratorResult>;
}

/** The one non-production adapter. It performs no network request. */
export class SandboxIntegrator implements FiscalIntegrator {
  readonly mode = 'SANDBOX' as const;
  readonly submissions: FiscalSubmission[] = [];

  async submit(document: FiscalSubmission): Promise<FiscalIntegratorResult> {
    this.submissions.push(structuredClone(document));
    return {
      outcome: 'ACCEPTED',
      externalReference: `SANDBOX-${document.localReference}`,
      externalQr: null,
    };
  }
}

/** Undefined/missing configuration is intentionally OFF. */
export function selectFiscalIntegrator(
  mode: FiscalIntegratorMode | null | undefined
): FiscalIntegrator | null {
  return mode === 'SANDBOX' ? new SandboxIntegrator() : null;
}

export function assertFiscalLinkage(input: {
  kind: FiscalDocumentKind;
  originalDocumentId?: string | null;
  originalKind?: FiscalDocumentKind | null;
}) {
  const hasOriginal = Boolean(input.originalDocumentId?.trim());
  if (input.kind === 'INVOICE' && hasOriginal)
    throw new Error('An invoice cannot link to an original fiscal document.');
  if (input.kind !== 'INVOICE' && !hasOriginal)
    throw new Error(`${input.kind} must link to its original fiscal invoice.`);
  if (input.kind !== 'INVOICE' && input.originalKind && input.originalKind !== 'INVOICE')
    throw new Error(`${input.kind} must link to an invoice, not another note.`);
}

export function fiscalRetentionUntil(createdAt: Date): Date {
  const retained = new Date(createdAt);
  retained.setUTCFullYear(retained.getUTCFullYear() + FISCAL_RETENTION_YEARS);
  return retained;
}

export function fiscalRetryDelaySeconds(attempt: number, baseRetrySeconds: number): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error('Attempt must be a positive integer.');
  if (!Number.isInteger(baseRetrySeconds) || baseRetrySeconds < 1)
    throw new Error('Retry base must be a positive integer.');
  return Math.min(MAX_FISCAL_RETRY_SECONDS, baseRetrySeconds * 2 ** (attempt - 1));
}

export type FiscalQueueItem = {
  status: FiscalDocumentStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  externalReference: string | null;
  externalQr: string | null;
  lastError: string | null;
};

export function beginFiscalAttempt(item: FiscalQueueItem): FiscalQueueItem {
  if (item.status !== 'QUEUED') throw new Error('Only queued fiscal documents can be submitted.');
  if (item.attempts >= item.maxAttempts) throw new Error('Fiscal retry budget is exhausted.');
  return { ...item, status: 'SUBMITTING', attempts: item.attempts + 1, nextAttemptAt: null };
}

export function settleFiscalAttempt(
  item: FiscalQueueItem,
  outcome: FiscalIntegratorResult | { outcome: 'TRANSIENT_ERROR'; reason: string },
  now: Date,
  baseRetrySeconds: number
): FiscalQueueItem {
  if (item.status !== 'SUBMITTING') throw new Error('Only an active submission can settle.');
  if (outcome.outcome === 'ACCEPTED') {
    return {
      ...item,
      status: 'ACCEPTED',
      externalReference: outcome.externalReference,
      externalQr: outcome.externalQr,
      lastError: null,
    };
  }
  if (outcome.outcome === 'REJECTED') {
    return { ...item, status: 'REJECTED', lastError: outcome.reason };
  }
  if (item.attempts >= item.maxAttempts) {
    return { ...item, status: 'DEAD', nextAttemptAt: null, lastError: outcome.reason };
  }
  return {
    ...item,
    status: 'QUEUED',
    nextAttemptAt: new Date(
      now.getTime() + fiscalRetryDelaySeconds(item.attempts, baseRetrySeconds) * 1_000
    ),
    lastError: outcome.reason,
  };
}

/** Receipt safety boundary: current OFF and SANDBOX modes expose no fiscal fields. */
export function receiptFiscalFields(input: {
  mode: FiscalIntegratorMode | null | undefined;
  externalReference: string | null;
  externalQr: string | null;
}): undefined {
  void input;
  return undefined;
}
