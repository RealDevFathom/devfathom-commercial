import {
  classifyReplayOutcome,
  type TerminalReplayOutcome,
} from '@/lib/retail-terminal/replay-outcome';
import type { CounterReplayRequest } from './counter-command-queue';
import type { CounterReplayResponse } from './counter-offline-runtime';

export function canQuarantineOfflineReceipt(code?: string) {
  return (
    code === 'offline_chain_broken' ||
    code === 'INVALID_COMMAND_SIGNATURE' ||
    code === 'invalid_snapshot'
  );
}

export function canRetryOfflineReceipt(code?: string): boolean {
  switch (code) {
    case 'DAY_CLOSED':
    case 'DRAWER_NOT_OPEN':
    case 'INSUFFICIENT_STOCK':
    case 'quota_exhausted':
    case 'QUOTA_EXHAUSTED':
    case 'offline_total_changed':
    case 'OVER_TENDER':
      return true;
    default:
      return false;
  }
}

function counterConflictMessage(code?: string): string {
  switch (code) {
    case 'DAY_CLOSED':
      return 'The shop day for this sale is closed. Ask a manager to check the receipt and cash.';
    case 'DRAWER_NOT_OPEN':
      return 'The drawer for this sale is closed. Open it before trying again.';
    case 'OVER_TENDER':
    case 'offline_total_changed':
      return 'The price changed. Check the price printed on the receipt before trying again.';
    case 'PERIOD_CLOSED':
      return 'The accounting period is closed. Ask a manager to check the receipt and cash.';
    case 'offline_selling_off':
      return 'Offline selling is switched off. Ask a manager to reconcile this receipt.';
    case 'quota_exhausted':
    case 'QUOTA_EXHAUSTED':
    case 'INSUFFICIENT_STOCK':
      return 'The stock set aside for this sale is no longer available.';
    case 'medicine_not_offline_otc':
      return 'This medicine cannot be sold offline. Ask a manager to review the receipt and cash.';
    case 'invalid_pack':
      return 'The server could not verify the pack sold on this receipt.';
    case 'INVALID_COMMAND_SIGNATURE':
    case 'invalid_snapshot':
    case 'offline_chain_broken':
    case 'INVALID_RECEIPT_LEASE':
      return 'The server could not verify the sealed sale or its receipt number.';
    default:
      return 'The server refused this sale. Ask a manager to review the receipt and cash.';
  }
}

export function classifyCounterReplay(response: CounterReplayResponse): TerminalReplayOutcome {
  const { status, serverMessage } = response;
  // These refusals are about the sealed receipt. Signing in again cannot change it.
  if (
    (status === 403 &&
      (serverMessage === 'invalid_snapshot' ||
        serverMessage === 'medicine_not_offline_otc' ||
        serverMessage === 'invalid_pack')) ||
    (status === 401 && serverMessage === 'INVALID_COMMAND_SIGNATURE')
  ) {
    return {
      action: 'QUARANTINE',
      reason: 'REJECTED',
      message: counterConflictMessage(serverMessage),
    };
  }
  const outcome = classifyReplayOutcome(
    status === 401 && serverMessage === 'device_revoked' ? { ...response, status: 403 } : response
  );
  if (outcome.action === 'REVIEW' || outcome.action === 'QUARANTINE') {
    outcome.message = counterConflictMessage(serverMessage);
  }
  return outcome;
}

/** An HTTP success without a booking or an audited rejection cannot settle a local sale. */
export async function sendCounterReplay(
  token: string,
  request: CounterReplayRequest,
  rejectionReason?: string,
  reviewAction: 'reject' | 'retry' | 'quarantine' = 'reject'
): Promise<CounterReplayResponse> {
  const reviewing = rejectionReason !== undefined;
  const rejecting = reviewing && reviewAction === 'reject';
  const response = await fetch(reviewing ? `/api/pharmacy/counter/${reviewAction}` : request.path, {
    method: request.method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...request.headers,
      'content-type': 'application/json',
      'x-terminal-session': token,
    },
    body: JSON.stringify(
      reviewing && reviewAction !== 'quarantine'
        ? { command: request.body, reason: rejectionReason }
        : request.body
    ),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    return {
      status: response.status,
      serverMessage: typeof body?.error === 'string' ? body.error : undefined,
      retryAfter: response.headers.get('retry-after'),
    };
  const ref =
    reviewAction === 'quarantine'
      ? body?.status === 'QUARANTINED' && body.commandId
      : rejecting
        ? body?.status === 'REJECTED' && body.commandId
        : body?.saleId;
  return typeof ref === 'string' && ref.length > 0
    ? { status: response.status, serverRef: ref }
    : { status: 503 };
}
