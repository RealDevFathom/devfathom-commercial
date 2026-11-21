import type { CounterReplayRequest } from './counter-command-queue';
import type { CounterReplayResponse } from './counter-offline-runtime';

export function counterConflictMessage(code?: string): string {
  switch (code) {
    case 'DAY_CLOSED':
      return 'The shop day for this sale is closed. Ask a manager to check the receipt and cash.';
    case 'PERIOD_CLOSED':
      return 'The accounting period is closed. Ask a manager to check the receipt and cash.';
    case 'offline_selling_off':
      return 'Offline selling is switched off. Ask a manager to reconcile this receipt.';
    case 'quota_exhausted':
    case 'QUOTA_EXHAUSTED':
    case 'INSUFFICIENT_STOCK':
      return 'The stock set aside for this sale is no longer available.';
    case 'offline_chain_broken':
    case 'INVALID_RECEIPT_LEASE':
      return 'The server could not verify the sealed sale or its receipt number.';
    default:
      return 'The server refused this sale. Ask a manager to review the receipt and cash.';
  }
}

/** An HTTP success without a booking or an audited rejection cannot settle a local sale. */
export async function sendCounterReplay(
  token: string,
  request: CounterReplayRequest,
  rejectionReason?: string
): Promise<CounterReplayResponse> {
  const rejecting = rejectionReason !== undefined;
  const response = await fetch(rejecting ? '/api/pharmacy/counter/reject' : request.path, {
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
      rejecting ? { command: request.body, reason: rejectionReason } : request.body
    ),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    return {
      status: response.status,
      serverMessage: typeof body?.error === 'string' ? body.error : undefined,
      retryAfter: response.headers.get('retry-after'),
    };
  const ref = rejecting ? body?.status === 'REJECTED' && body.commandId : body?.saleId;
  return typeof ref === 'string' && ref.length > 0
    ? { status: response.status, serverRef: ref }
    : { status: 503 };
}
