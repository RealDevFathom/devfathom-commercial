/**
 * The RETAIL TERMINAL seam (PRD §11): classifying one replay response.
 *
 * This module is an EXTRACTION of the classifier half of
 * `src/lib/restaurant/pos-command-queue.ts`, which now re-exports it. The rule is
 * identical for any enrolled terminal replaying a queued command, and it must
 * stay identical, because the important part is what it REFUSES to do: a generic
 * 401/403/423 PAUSES replay and keeps the queued work, and only a CONFIRMED
 * device revocation — as judged by the shared terminal failure classifier —
 * purges. A vertical that reimplemented this would sooner or later invent a
 * second, softer definition of revocation.
 *
 * CLIENT-SAFE and PURE: status in, decision out.
 */
import { classifyTerminalFailure } from '@/components/terminal/terminal-state';

export type TerminalReplayOutcome =
  | { action: 'ACK' }
  | {
      action: 'RETRY';
      reason: 'NETWORK' | 'TIMEOUT' | 'SERVER' | 'RATE_LIMITED';
      retryAfterMs: number | null;
    }
  | { action: 'REVIEW'; reason: 'CATALOG_CONFLICT'; message: string }
  | { action: 'QUARANTINE'; reason: 'REJECTED'; message: string }
  | { action: 'PAUSE'; reason: 'REAUTH'; message: string }
  | { action: 'PURGE'; reason: 'DEVICE_REVOKED'; message: string };

/** `Retry-After` in seconds. A non-numeric (HTTP-date) value yields null and the
 * caller falls back to its own backoff rather than guessing at a clock. */
export function parseRetryAfterMs(retryAfter: string | null): number | null {
  const seconds = Number.parseInt(retryAfter ?? '', 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * Classify one replay response (status 0 means "the request never reached the
 * server"). The 401/403/423 branch defers to the EXISTING terminal failure
 * classifier so this module cannot invent a second, softer definition of
 * revocation: only its `revoked` verdict purges; everything else pauses for
 * re-authentication and keeps the queued work.
 */
export function classifyReplayOutcome(input: {
  status: number;
  serverMessage?: string;
  retryAfter?: string | null;
}): TerminalReplayOutcome {
  const { status } = input;
  if (status >= 200 && status < 300) return { action: 'ACK' };

  if (status === 0) return { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null };
  if (status === 408) return { action: 'RETRY', reason: 'TIMEOUT', retryAfterMs: null };
  if (status === 429) {
    return {
      action: 'RETRY',
      reason: 'RATE_LIMITED',
      retryAfterMs: parseRetryAfterMs(input.retryAfter ?? null),
    };
  }
  if (status >= 500) return { action: 'RETRY', reason: 'SERVER', retryAfterMs: null };

  if (status === 401 || status === 403 || status === 423) {
    const failure = classifyTerminalFailure(status, input.serverMessage, input.retryAfter ?? null);
    if (failure.kind === 'revoked') {
      return { action: 'PURGE', reason: 'DEVICE_REVOKED', message: failure.message };
    }
    return { action: 'PAUSE', reason: 'REAUTH', message: failure.message };
  }

  if (status === 409) {
    return {
      action: 'REVIEW',
      reason: 'CATALOG_CONFLICT',
      message: 'The server state changed since this order was composed. Review it before sending.',
    };
  }

  // 400/404 and every other unexpected non-2xx: quarantine rather than retry, so a
  // permanently unacceptable command can never loop against the server.
  return {
    action: 'QUARANTINE',
    reason: 'REJECTED',
    message: 'The server refused this queued order. Review or discard it.',
  };
}
