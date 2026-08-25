import 'server-only';

import { hash as bcryptHash } from 'bcryptjs';
import { NextResponse } from 'next/server';

import type {
  RestaurantRegisteredDevice,
  RestaurantTerminalSession,
} from '@/generated/prisma/client';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isDeviceSecretFormat,
  isDeviceUsable,
  resolveDeviceBySecret,
  touchDeviceLastSeen,
} from '@/lib/restaurant/devices';
import {
  OPERATOR_CREDENTIAL_BCRYPT_COST,
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  remainingLockoutMs,
  verifyOperatorCredential,
  type OperatorCredentialType,
} from '@/lib/restaurant/operator-credentials';
import {
  evaluateTerminalSession,
  isTerminalSessionTokenFormat,
  resolveSessionByToken,
  touchSession,
  type TerminalInvalidReason,
  type TerminalSessionState,
} from '@/lib/restaurant/terminal-session';
import { type ScopedDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * M2-L3 / §5 / C2 & C5 — device-authenticated terminal transport.
 *
 * This is the terminal analogue of `src/lib/api-auth.ts`, and deliberately NOT
 * NextAuth: an operator terminal never carries a web-login session (C2 —
 * operator credentials are structurally unreachable from web login). A terminal
 * proves itself with a device secret (`Authorization: Bearer rdk_…`) and, for an
 * established session, a session token (`X-Terminal-Session: rts_…`).
 *
 * Tenant discovery mirrors `authenticateApiRequest`: the device's organization
 * is unknown until the secret is resolved, so the hash lookup runs once in the
 * explicit platform scope; every subsequent read/write is returned to the
 * device's own tenant scope. The device and session rows are then re-read
 * FRESH inside that tenant transaction and revalidated on every call (C5 — no
 * trust cache, client time untrusted), so a revoked device or an ended session
 * is rejected on its very next request.
 *
 * The default transport is REST route handlers (deviation recorded in
 * BUILD-ASSUMPTIONS).
 */

/** REST-04-style flood controls, keyed by IP (pre-auth) then device. */
const IP_WINDOW_MS = 60_000;
const IP_LIMIT = 120;
const DEVICE_WINDOW_MS = 60_000;
const DEVICE_LIMIT = 240;

/** Context handed to a device-authenticated handler (no session required). */
export type TerminalDeviceContext = {
  organizationId: string;
  device: RestaurantRegisteredDevice;
  /** Tenant-scoped transaction for the device's organization. */
  db: ScopedDb;
};

/** Context handed to a session-authenticated handler (device + live session). */
export type TerminalContext = TerminalDeviceContext & {
  session: RestaurantTerminalSession;
  state: TerminalSessionState;
};

const BEARER_PREFIX = 'Bearer ';
const SESSION_HEADER = 'x-terminal-session';

/**
 * Shape a domain error thrown by a terminal handler into its public HTTP response, or
 * return null for an error that is NOT part of the route's domain contract so the
 * transport answers a generic 500 (no internals leaked).
 *
 * WHY THE TRANSPORT OWNS THIS (M8 correction E). The wrappers below own the request's
 * PostgreSQL transaction, and a nested `$transaction` on the scoped client REUSES that
 * transaction without opening a savepoint (`exposeNestedTransaction`) — so nothing
 * running inside the callback can undo a write. A route factory that caught its domain
 * error inside the callback and returned an error `Response` therefore COMMITTED every
 * write the failed command had already made: a comp that released a loyalty redemption
 * and then refused the comp kept the release, and a void-and-recut that released, voided
 * and then failed split planning kept the voids plus a burnt idempotency key that wedged
 * the retry. The mapper is handed to the transport instead — the error escapes the
 * transaction owner, PostgreSQL rolls the whole request back, and only THEN is the error
 * mapped. Mapping must stay PURE: it runs after the transaction is gone, so it can no
 * longer read or write the database.
 *
 * A handler that RETURNS a response still commits, deliberately. `authenticateOperator`
 * advances the durable failed-attempt counter and the route then answers 401/423; that
 * brute-force evidence, and the device/session check-in, must survive a refusal. Only a
 * THROW rolls the request back.
 */
export type TerminalErrorMapper = (err: unknown) => Response | null;

export type TerminalRouteOptions = {
  /** Shape a domain error into its public response, OUTSIDE the owning transaction. */
  mapError?: TerminalErrorMapper;
};

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

function forbidden(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

function tooManyRequests(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

/** Extract the raw device secret from the Authorization header, if well-formed. */
function deviceSecretFromRequest(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const secret = header.slice(BEARER_PREFIX.length).trim();
  return isDeviceSecretFormat(secret) ? secret : null;
}

/** Map a C5 revalidation failure to an HTTP status + message. */
function sessionRejection(reason: TerminalInvalidReason): NextResponse {
  if (reason === 'DEVICE_REVOKED') {
    return forbidden('This device has been revoked.');
  }
  // ENDED / EXPIRED / MISMATCH — the terminal must re-establish a session.
  return unauthorized('Terminal session is no longer valid; re-establish the session.');
}

/**
 * Answer an error that ESCAPED the tenant transaction — by the time this runs the
 * transaction is already rolled back, so nothing the failed command wrote survives. The
 * route's own mapper claims a domain error and shapes its public status; anything else is
 * logged once (the error only, never a request payload, token or credential) and answered
 * as a generic 500.
 */
function respondToEscapedError(
  label: string,
  err: unknown,
  mapError: TerminalErrorMapper | undefined
): Response {
  const mapped = mapError?.(err) ?? null;
  if (mapped) return mapped;
  console.error(label, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type DeviceDiscovery = { deviceId: string; organizationId: string };

/**
 * Resolve a device secret to its organization in the explicit platform scope
 * (the tenant is unknown until the secret is resolved). Returns only the ids
 * needed to enter tenant scope — the authoritative, revalidated device row is
 * re-read inside the tenant transaction by the caller (C5). Returns null for an
 * unknown secret or a device whose organization is not in an operable state.
 */
async function discoverDevice(secret: string): Promise<DeviceDiscovery | null> {
  return withPlatformDb(async (platformDb) => {
    const device = await resolveDeviceBySecret(platformDb, secret);
    if (!device) return null;
    const organization = await platformDb.organization.findUnique({
      where: { id: device.organizationId },
      select: { status: true },
    });
    if (!organization || !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(organization.status)) {
      return null;
    }
    return { deviceId: device.id, organizationId: device.organizationId };
  });
}

/** Run flood controls and resolve the device; returns the discovery or an error response. */
async function authenticateDevice(request: Request): Promise<DeviceDiscovery | NextResponse> {
  // Pre-auth per-IP throttle so a stream of invalid secrets can't run unbounded
  // lookups (mirrors REST-04 on the API transport).
  const ip = clientIp(request);
  const ipGate = rateLimit(`terminal:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!ipGate.ok) return tooManyRequests(ipGate.retryAfter);

  const secret = deviceSecretFromRequest(request);
  if (!secret) return unauthorized('Missing or malformed device credential.');

  const discovery = await discoverDevice(secret);
  if (!discovery) return unauthorized('Unknown or unauthorized device.');

  const deviceGate = rateLimit(
    `terminal:device:${discovery.deviceId}`,
    DEVICE_LIMIT,
    DEVICE_WINDOW_MS
  );
  if (!deviceGate.ok) return tooManyRequests(deviceGate.retryAfter);

  return discovery;
}

/**
 * Wrap a handler that needs a trusted device but no established session (used by
 * `establish`). Re-reads the device FRESH in tenant scope, rejects a revoked
 * device, records the check-in, and runs the handler inside the tenant
 * transaction. A throw from the handler escapes that transaction (PostgreSQL rolls the
 * request back) before `options.mapError` shapes it — see `TerminalErrorMapper`.
 */
export function withDeviceAuth<T extends unknown[]>(
  handler: (
    ctx: TerminalDeviceContext,
    request: Request,
    ...args: T
  ) => Promise<Response> | Response,
  options: TerminalRouteOptions = {}
) {
  return async (request: Request, ...args: T): Promise<Response> => {
    const auth = await authenticateDevice(request);
    if (auth instanceof NextResponse) return auth;

    try {
      return await withTenantDb(auth.organizationId, async (db) => {
        const now = new Date();
        const device = await db.restaurantRegisteredDevice.findUnique({
          where: { id: auth.deviceId },
        });
        if (!device || !isDeviceUsable(device)) {
          return forbidden('This device has been revoked.');
        }
        await touchDeviceLastSeen(db, device.id, now);
        return handler({ organizationId: auth.organizationId, device, db }, request, ...args);
      });
    } catch (err) {
      return respondToEscapedError('Terminal device-auth error:', err, options.mapError);
    }
  };
}

/**
 * Wrap a handler that requires a trusted device AND a live terminal session
 * (unlock/switch/lock/co-authorize/heartbeat). Re-reads BOTH the device and the
 * session FRESH in tenant scope and revalidates them via `evaluateTerminalSession`
 * on every call (C5), then records the check-in and runs the handler inside the
 * tenant transaction.
 *
 * This is the shared money/command boundary: a throw from the handler escapes the tenant
 * transaction, so PostgreSQL rolls back every write the failed command made, and only
 * then does `options.mapError` shape it into the route's public status. Every factory
 * built on this wrapper inherits that ordering — see `TerminalErrorMapper` for why a
 * factory must never map (and return) a domain error from inside the callback.
 */
export function withTerminalAuth<T extends unknown[]>(
  handler: (ctx: TerminalContext, request: Request, ...args: T) => Promise<Response> | Response,
  options: TerminalRouteOptions = {}
) {
  return async (request: Request, ...args: T): Promise<Response> => {
    const auth = await authenticateDevice(request);
    if (auth instanceof NextResponse) return auth;

    const sessionToken = request.headers.get(SESSION_HEADER)?.trim();
    if (!sessionToken || !isTerminalSessionTokenFormat(sessionToken)) {
      return unauthorized('Missing or malformed terminal session token.');
    }

    try {
      return await withTenantDb(auth.organizationId, async (db) => {
        const now = new Date();
        // C5: authoritative, FRESH reads inside one consistent transaction.
        const [device, session] = await Promise.all([
          db.restaurantRegisteredDevice.findUnique({ where: { id: auth.deviceId } }),
          resolveSessionByToken(db, sessionToken),
        ]);
        if (!device) return forbidden('This device has been revoked.');
        if (!session)
          return unauthorized('Terminal session is no longer valid; re-establish the session.');

        const verdict = evaluateTerminalSession(session, device, now);
        if (!verdict.ok) return sessionRejection(verdict.reason);

        await Promise.all([
          touchDeviceLastSeen(db, device.id, now),
          touchSession(db, session.id, now),
        ]);

        return handler(
          { organizationId: auth.organizationId, device, db, session, state: verdict.state },
          request,
          ...args
        );
      });
    } catch (err) {
      return respondToEscapedError('Terminal session-auth error:', err, options.mapError);
    }
  };
}

// --- Operator credential authentication (C4) -------------------------------

/**
 * The result of verifying an operator credential. `LOCKED` carries the SERVER-
 * derived remaining lockout so the caller can set a `Retry-After`. `INVALID`
 * deliberately does not distinguish "no such credential" from "wrong secret".
 */
export type OperatorAuthResult =
  | { ok: true; credentialId: string; staffProfileId: string }
  | { ok: false; reason: 'INVALID' }
  | { ok: false; reason: 'LOCKED'; retryAfterMs: number };

/**
 * A constant, valid bcrypt hash used to burn a compare when no credential is
 * found, so the timing of "no such credential" is indistinguishable from "wrong
 * secret" (operator-credentials.ts explicitly invites this). Computed lazily
 * once, at the same cost factor as a real credential.
 */
let dummyCredentialHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyCredentialHash) {
    dummyCredentialHash = bcryptHash('terminal-operator-dummy', OPERATOR_CREDENTIAL_BCRYPT_COST);
  }
  return dummyCredentialHash;
}

/**
 * C4 — verify an operator credential against the durable, per-row lockout
 * counters, all inside the caller's tenant transaction. The counters
 * (`failedAttempts`/`lockedUntil`) are the AUTHORITATIVE brute-force control
 * (the per-instance rate limiter is only a cheap first line, see
 * BUILD-ASSUMPTIONS): a locked credential is rejected without a compare; a wrong
 * secret advances the durable counter; a correct secret clears it. Selects the
 * device-scoped credential over an org-wide one, and refuses a
 * non-ACTIVE staff profile. `now` is a SERVER timestamp (client time untrusted).
 */
export async function authenticateOperator(
  db: ScopedDb,
  params: {
    staffProfileId: string;
    /** The terminal's device (terminal path). Omit for a back-office check,
     * where only an organization-wide credential is accepted. */
    deviceId?: string;
    /** Trusted branch derived from the authenticated terminal device. When set,
     * only an operator whose primary branch matches may authenticate. */
    branchId?: string;
    type: OperatorCredentialType;
    secret: string;
    now: Date;
  }
): Promise<OperatorAuthResult> {
  const { staffProfileId, deviceId, branchId, type, secret, now } = params;

  const [profile, credentials] = await Promise.all([
    db.restaurantStaffProfile.findUnique({
      where: { id: staffProfileId },
      select: { id: true, primaryBranchId: true, status: true },
    }),
    db.restaurantOperatorCredential.findMany({
      where: {
        staffProfileId,
        type,
        revokedAt: null,
        // With a device: accept its scoped credential or an org-wide one. Without:
        // only org-wide credentials are eligible (no device context to scope to).
        ...(deviceId ? { OR: [{ deviceId }, { deviceId: null }] } : { deviceId: null }),
      },
    }),
  ]);

  // Prefer a device-scoped credential over an organization-wide one.
  const credential =
    (deviceId ? credentials.find((row) => row.deviceId === deviceId) : undefined) ??
    credentials.find((row) => row.deviceId === null) ??
    null;

  if (
    !profile ||
    profile.status !== 'ACTIVE' ||
    (branchId !== undefined && profile.primaryBranchId !== branchId) ||
    !credential
  ) {
    // Fail closed, but still burn a compare so absence is timing-opaque.
    await verifyOperatorCredential(type, secret, await getDummyHash());
    return { ok: false, reason: 'INVALID' };
  }

  const state = { failedAttempts: credential.failedAttempts, lockedUntil: credential.lockedUntil };
  if (isLockedOut(state, now)) {
    return { ok: false, reason: 'LOCKED', retryAfterMs: remainingLockoutMs(state, now) };
  }

  const valid = await verifyOperatorCredential(type, secret, credential.credentialHash);
  if (!valid) {
    const next = registerFailedAttempt(state, now);
    await db.restaurantOperatorCredential.update({ where: { id: credential.id }, data: next });
    return { ok: false, reason: 'INVALID' };
  }

  if (credential.failedAttempts !== 0 || credential.lockedUntil !== null) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: clearLockout(),
    });
  }
  return { ok: true, credentialId: credential.id, staffProfileId };
}
