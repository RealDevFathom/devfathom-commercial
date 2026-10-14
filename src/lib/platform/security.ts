import 'server-only';

import { timingSafeEqual } from 'node:crypto';
import { publicRequestOrigin } from '@/lib/http-origin';
import { activationPreflightMessage, type ActivationGate } from '@/lib/platform/activation-gates';

export class PlatformSecurityError extends Error {
  constructor(
    message: string,
    // 409 is the documented conflict code (docs/admin-platform/api.md); D20 uses
    // it so a duplicate email reports a conflict rather than a bad request.
    readonly status: 400 | 401 | 403 | 409 | 429 | 500 = 403
  ) {
    super(message);
    this.name = 'PlatformSecurityError';
  }
}

/**
 * WHA-1180 — a failed activation preflight, carrying the unmet gates.
 *
 * A subclass rather than a new error type so every existing `instanceof
 * PlatformSecurityError` check, the 400 status, and the joined message are all
 * unchanged; the control route adds `gates` to the response body on top.
 */
export class ActivationPreflightError extends PlatformSecurityError {
  readonly gates: readonly ActivationGate[];

  constructor(gates: ActivationGate[]) {
    super(activationPreflightMessage(gates), 400);
    this.name = 'ActivationPreflightError';
    this.gates = gates;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Cookie-authenticated platform mutations must originate from the exact host
 * serving the request. `SameSite=Strict` is defense-in-depth, not the boundary.
 */
export function assertPlatformMutationOrigin(request: Request) {
  const origin = request.headers.get('origin');
  let expectedOrigin = '';
  try {
    expectedOrigin = publicRequestOrigin(request);
  } catch {
    throw new PlatformSecurityError('The request origin is not allowed.', 403);
  }
  const fetchSite = request.headers.get('sec-fetch-site');

  let normalizedOrigin = '';
  try {
    normalizedOrigin = origin ? new URL(origin).origin.toLowerCase() : '';
  } catch {
    normalizedOrigin = '';
  }
  if (!normalizedOrigin || !safeEqual(normalizedOrigin, expectedOrigin)) {
    throw new PlatformSecurityError('The request origin is not allowed.', 403);
  }
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new PlatformSecurityError('Cross-site requests are not allowed.', 403);
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new PlatformSecurityError('Content-Type must be application/json.', 400);
  }
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
