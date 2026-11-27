import 'server-only';
import { withOwnerReauthenticationScope } from './owner-reauthentication';

import {
  demoSeatFromOrganizationId,
  isCanonicalDemoOrganization,
  isReservedDemoOrganizationId,
} from '@/lib/tenancy/demo-identity';

import { hash as bcryptHash } from 'bcryptjs';
import { NextResponse } from 'next/server';

import type {
  RestaurantRegisteredDevice,
  RestaurantTerminalSession,
} from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import { getDemoSeatCount } from '@/lib/demo/config';
import {
  DEMO_PERSONAS,
  demoPersonaForUser,
  demoPersonaCanUseDevice,
  demoPersonaDeviceName,
  demoPersonaUserRole,
} from '@/lib/demo/personas';
import { trustedRequestOrigin } from '@/lib/http-origin';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isDeviceSecretFormat,
  isDeviceUsable,
  resolveDeviceBySecret,
  touchDeviceLastSeen,
} from '@/lib/restaurant/devices';
import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  OPERATOR_CREDENTIAL_BCRYPT_COST,
  clearLockout,
  isLockedOut,
  remainingLockoutMs,
  verifyOperatorCredential,
  type OperatorCredentialType,
} from '@/lib/restaurant/operator-credentials';
import { deviceBaseCapability, operatorHasCapability } from './operator-capability';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import type { RestaurantApproverRight } from '@/lib/approval-approver-rights';
import { resolveShiftEligibility, type ShiftDenialReason } from '@/lib/restaurant/shifts';
import {
  evaluateTerminalSession,
  isTerminalSessionTokenFormat,
  hashTerminalSessionToken,
  lockDeniedOperator,
  touchSession,
  type TerminalInvalidReason,
  type TerminalSessionState,
} from '@/lib/restaurant/terminal-session';
import { type ScopedDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor, type TenantActor } from '@/lib/tenancy/tenant-actor';

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
  /** Present only for demo devices after the live Auth.js actor is bound. */
  demoActor: TenantActor | null;
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
export const TERMINAL_DEVICE_COOKIE = 'devfathom-terminal';

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
 * brute-force evidence and the device check-in must survive a refusal. Only a
 * THROW rolls the request back.
 */
export type TerminalErrorMapper = (err: unknown) => Response | null;

export type TerminalRouteOptions = {
  /** Shape a domain error into its public response, OUTSIDE the owning transaction. */
  mapError?: TerminalErrorMapper;
  /**
   * Reject a malformed request before tenant scope and persistent device/session
   * check-ins. The validator must be side-effect free and inspect a cloned body.
   */
  preflight?: (request: Request) => Promise<Response | null> | Response | null;
};

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

function forbidden(message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 403, headers: { 'X-Terminal-Access': 'denied' } }
  );
}

function tooManyRequests(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

/** Extract the raw device secret from the Authorization header, if well-formed. */
function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function deviceSecretFromRequest(request: Request): { secret: string; cookie: boolean } | null {
  const header = request.headers.get('authorization');
  const cookieSecret = cookieValue(request, TERMINAL_DEVICE_COOKIE);
  // Two credential channels make precedence ambiguous and can accidentally bind a
  // browser request to a different device than its enrolled cookie. Fail closed.
  if (header && cookieSecret) return null;
  if (header?.startsWith(BEARER_PREFIX)) {
    const secret = header.slice(BEARER_PREFIX.length).trim();
    return isDeviceSecretFormat(secret) ? { secret, cookie: false } : null;
  }
  return cookieSecret && isDeviceSecretFormat(cookieSecret)
    ? { secret: cookieSecret, cookie: true }
    : null;
}

function cookieOriginAllowed(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    // DEV-957 phase 2: never trusts a client-supplied X-Forwarded-Host (http-origin.ts).
    return new URL(origin).origin.toLowerCase() === trustedRequestOrigin(request);
  } catch {
    return false;
  }
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

/**
 * WHA-138 Lane A — POS/KDS terminals are licensed by the `restaurant-pos`
 * module, so the terminal transport enforces the EFFECTIVE entitlement
 * (package → contract → override) on every device- and session-authenticated
 * request. Navigation hiding is UX only; a disabled module must be rejected
 * here independent of anything a client renders. Resolved FRESH inside the
 * request's tenant transaction (no trust cache — an operator override that
 * disables POS takes effect on the terminal's very next request). Returns the
 * 403 to send, or null when the module is enabled.
 */
const TERMINAL_MODULE_KEY = 'restaurant-pos';

async function rejectDisabledTerminalModule(
  db: ScopedDb,
  organizationId: string
): Promise<NextResponse | null> {
  const entitlements = await resolveOrganizationEntitlements(organizationId, db);
  if (!hasModule(entitlements, TERMINAL_MODULE_KEY)) {
    return forbidden('The POS and Fulfilment module is not enabled for this organization.');
  }
  return null;
}

type DeviceDiscovery = {
  deviceId: string;
  organizationId: string;
  isDemo: boolean;
  demoActor: TenantActor | null;
};

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
      select: { status: true, isDemo: true },
    });
    if (!organization || !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(organization.status)) {
      return null;
    }
    return {
      deviceId: device.id,
      organizationId: device.organizationId,
      isDemo: organization.isDemo,
      demoActor: null,
    };
  });
}

async function bindDemoActor(
  request: Request,
  discovery: DeviceDiscovery
): Promise<DeviceDiscovery | NextResponse> {
  if (!discovery.isDemo) {
    // Reserved demo devices cannot turn into production credentials if the flag changes.
    return isReservedDemoOrganizationId(discovery.organizationId)
      ? unauthorized('Demo access is unavailable.')
      : discovery;
  }
  const actor = await resolveTenantActor({ request });
  const seat = demoSeatFromOrganizationId(discovery.organizationId, getDemoSeatCount());
  if (
    !actor ||
    actor.support ||
    !seat ||
    !actor.organization.isDemo ||
    actor.organization.id !== discovery.organizationId ||
    actor.session.user.organizationId !== discovery.organizationId ||
    !isCanonicalDemoOrganization(actor.organization, getDemoSeatCount()) ||
    !demoPersonaForUser(seat, actor.session.user) ||
    !liveDemoAccessExpiry(actor.session.user.demoAccessExpiresAt)
  ) {
    return unauthorized('Demo access has expired; reopen the restaurant demo.');
  }
  return { ...discovery, demoActor: actor };
}

async function demoDeviceActorMatches(
  db: ScopedDb,
  actor: TenantActor | null,
  device: RestaurantRegisteredDevice,
  activeStaffProfileId?: string | null
): Promise<boolean> {
  if (!actor) return true;
  const seat = demoSeatFromOrganizationId(actor.organization.id, getDemoSeatCount());
  const persona = seat ? demoPersonaForUser(seat, actor.session.user) : null;
  if (
    !seat ||
    !persona ||
    !demoPersonaCanUseDevice(persona, device.kind) ||
    (persona === 'manager'
      ? !device.name.startsWith(`Demo ${device.kind} S${seat} `)
      : device.name !== demoPersonaDeviceName(seat, persona, device.kind as 'POS' | 'KDS'))
  )
    return false;
  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      userId: actor.session.user.id,
      status: 'ACTIVE',
      primaryBranchId: device.branchId,
      user: {
        organizationId: actor.organization.id,
        email: actor.session.user.email!,
        status: 'ACTIVE',
        password: null,
        role: demoPersonaUserRole(persona),
        organizationRole: { key: DEMO_PERSONAS[persona].roleKey },
      },
    },
    select: { id: true },
    take: 2,
  });
  return (
    profiles.length === 1 && (!activeStaffProfileId || profiles[0]!.id === activeStaffProfileId)
  );
}

/** Run flood controls and resolve the device; returns the discovery or an error response. */
async function authenticateDevice(request: Request): Promise<DeviceDiscovery | NextResponse> {
  // Pre-auth per-IP throttle so a stream of invalid secrets can't run unbounded
  // lookups (mirrors REST-04 on the API transport).
  const ip = clientIp(request);
  const ipGate = await rateLimit(`terminal:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!ipGate.ok) return tooManyRequests(ipGate.retryAfter);

  const credential = deviceSecretFromRequest(request);
  if (!credential) return unauthorized('Terminal browser is not enrolled.');
  if (credential.cookie && !cookieOriginAllowed(request)) {
    return forbidden('Terminal request origin was not accepted.');
  }

  const discovered = await discoverDevice(credential.secret);
  if (!discovered) return unauthorized('Unknown or unauthorized device.');

  const discovery = await bindDemoActor(request, discovered);
  if (discovery instanceof NextResponse) return discovery;

  const deviceGate = await rateLimit(
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
  options: TerminalRouteOptions & {
    allowedDeviceKinds?: readonly RestaurantRegisteredDevice['kind'][];
  } = {}
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
        if (!(options.allowedDeviceKinds ?? ['POS', 'KDS']).includes(device.kind)) {
          return forbidden('This device cannot use this terminal endpoint.');
        }
        if (!(await demoDeviceActorMatches(db, auth.demoActor, device))) {
          return forbidden('Demo device does not belong to this persona.');
        }
        const branch = await db.restaurantBranch.findUnique({
          where: { id: device.branchId },
          select: { active: true },
        });
        if (!branch?.active) {
          return forbidden('This branch is inactive. Contact a restaurant administrator.');
        }
        const entitlementRejection = await rejectDisabledTerminalModule(db, auth.organizationId);
        if (entitlementRejection) return entitlementRejection;
        await touchDeviceLastSeen(db, device.id, now);
        return handler(
          { organizationId: auth.organizationId, device, demoActor: auth.demoActor, db },
          request,
          ...args
        );
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
      const preflightRejection = await options.preflight?.(request);
      if (preflightRejection) return preflightRejection;

      return await withTenantDb(auth.organizationId, async (db) => {
        const now = new Date();
        // C5: authoritative, FRESH reads inside one consistent transaction.
        const [device, [session]] = await Promise.all([
          db.restaurantRegisteredDevice.findUnique({ where: { id: auth.deviceId } }),
          // Serialize requests and access revocations on the same binding.
          db.$queryRaw<RestaurantTerminalSession[]>`
            SELECT * FROM restaurant_terminal_sessions
            WHERE "tokenHash" = ${hashTerminalSessionToken(sessionToken)} AND "deviceId" = ${auth.deviceId}
            FOR UPDATE
          `,
        ]);
        if (!device) return forbidden('This device has been revoked.');
        if (device.kind !== 'POS' && device.kind !== 'KDS')
          return forbidden('This device cannot use a terminal session.');
        if (!session)
          return unauthorized('Terminal session is no longer valid; re-establish the session.');
        if (
          !(await demoDeviceActorMatches(db, auth.demoActor, device, session.activeStaffProfileId))
        ) {
          return forbidden('Demo terminal session does not belong to this persona.');
        }

        const verdict = evaluateTerminalSession(session, device, now);
        if (!verdict.ok) return sessionRejection(verdict.reason);

        const branch = await db.restaurantBranch.findUnique({
          where: { id: device.branchId },
          select: { active: true },
        });
        if (!branch?.active) {
          return forbidden('This branch is inactive. Contact a restaurant administrator.');
        }

        const entitlementRejection = await rejectDisabledTerminalModule(db, auth.organizationId);
        if (entitlementRejection) {
          return entitlementRejection;
        }

        if (session.activeStaffProfileId !== null) {
          const capability = deviceBaseCapability(device.kind);
          if (
            !(await operatorHasCapability(
              db,
              session.activeStaffProfileId,
              capability,
              now,
              device.branchId,
              true
            ))
          ) {
            await lockDeniedOperator(db, session.id);
            return forbidden(
              `To use this terminal, the operator must be active, assigned to this branch, and have the "${capability}" capability.`
            );
          }
        }

        await touchDeviceLastSeen(db, device.id, now);
        const response = await withOwnerReauthenticationScope(
          {
            actingStaffProfileId: session.activeStaffProfileId,
            deviceId: device.id,
            terminalSessionId: session.id,
          },
          () =>
            handler(
              {
                organizationId: auth.organizationId,
                device,
                demoActor: auth.demoActor,
                db,
                session,
                state: verdict.state,
              },
              request,
              ...args
            )
        );
        if (response.ok) await touchSession(db, session.id, new Date());
        return response;
      });
    } catch (err) {
      return respondToEscapedError('Terminal session-auth error:', err, options.mapError);
    }
  };
}

/** Device-only KDS reads are also used by an established display. When it
 * presents a session, authenticate that exact binding before serving the read. */
export function withKdsReadAuth(
  handler: (ctx: TerminalDeviceContext, request: Request) => Promise<Response>
) {
  const deviceRead = withDeviceAuth(handler);
  const sessionRead = withTerminalAuth(handler);
  return (request: Request) =>
    request.headers.has(SESSION_HEADER) ? sessionRead(request) : deviceRead(request);
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
  | { ok: false; reason: 'LOCKED'; retryAfterMs: number }
  /**
   * Completion wave: the credential is GENUINE but the branch enforces rostered
   * sign-in and this operator holds no active, eligible shift. It is a distinct
   * result from `INVALID` on purpose — nothing secret is disclosed by it (the
   * caller already proved the credential), and a terminal that cannot tell "not
   * on shift" from "wrong PIN" makes staff retype a correct PIN until it locks.
   */
  | {
      ok: false;
      reason: 'NO_ACTIVE_SHIFT';
      shiftReason: ShiftDenialReason;
      nextShiftStartsAt: Date | null;
    };

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
 * DEV-1055: count one attempt against a credential, atomically. Returns false
 * when the credential is locked (or no longer live), in which case the caller
 * must not compare the secret. The arithmetic is `registerFailedAttempt`: the
 * `MAX_FAILED_ATTEMPTS`-th charge locks the credential for `LOCKOUT_DURATION_MS`
 * and resets the strikes; an expired lock is cleared by the next charge. Only
 * the lockout columns are written, so the DEV-1015 trigger on the credential
 * hash and revocation does not fire.
 */
async function chargeOperatorAttempt(
  db: ScopedDb,
  credentialId: string,
  now: Date
): Promise<boolean> {
  // Timestamps are stored as UTC wall time without a zone; pass them the same way.
  const nowUtc = now.toISOString();
  const lockUntilUtc = new Date(now.getTime() + LOCKOUT_DURATION_MS).toISOString();
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE restaurant_operator_credentials
       SET "lockedUntil" = CASE
             WHEN "failedAttempts" + 1 >= ${MAX_FAILED_ATTEMPTS} THEN ${lockUntilUtc}::timestamp
             ELSE NULL
           END,
           "failedAttempts" = CASE
             WHEN "failedAttempts" + 1 >= ${MAX_FAILED_ATTEMPTS} THEN 0
             ELSE "failedAttempts" + 1
           END,
           "updatedAt" = ${nowUtc}::timestamp
     WHERE id = ${credentialId}
       AND "revokedAt" IS NULL
       AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${nowUtc}::timestamp)
    RETURNING id
  `;
  return rows.length === 1;
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
 *
 * When `branchId` is supplied (the terminal path) and that branch opted into
 * `shiftSignInEnforced`, a proven credential is additionally checked against the
 * roster and may be refused with `NO_ACTIVE_SHIFT` (see `shifts.ts`). Branches
 * that do not roster are unaffected — the column defaults to false.
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
    forTerminalBinding?: boolean;
    /** DEV-879: set when the credential approves an action rather than signing in. An
     * approver who enrolled an approval authenticator must then enter its current code
     * instead of their PIN (see `verifyApprovalSecret`). */
    approval?: {
      action: string;
      /** DEV-961: the approver right the route requires (see approval-approver-rights). */
      approverRight: RestaurantApproverRight;
      requestedByStaffProfileId?: string | null;
    };
  }
): Promise<OperatorAuthResult> {
  const { staffProfileId, deviceId, branchId, type, secret, now, approval } = params;

  const [profile, branch, credentials] = await Promise.all([
    db.restaurantStaffProfile.findUnique({
      where: { id: staffProfileId },
      select: { id: true, primaryBranchId: true, status: true, userId: true },
    }),
    // Completion wave: whether THIS branch requires a rostered shift. Read
    // alongside the profile so the enforced path costs no extra round trip, and
    // read from the DB every time so turning rostering on takes effect at the
    // next sign-in rather than when some cache expires.
    branchId === undefined
      ? Promise.resolve(null)
      : db.restaurantBranch.findUnique({
          where: { id: branchId },
          select: { id: true, shiftSignInEnforced: true },
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

  // DEV-1055: charge the attempt BEFORE any compare, in one statement on the
  // credential row. Reading the counter, comparing, then writing it back let
  // guesses sent at the same moment all read the same count and all be compared,
  // so the five-attempt lockout never engaged. This UPDATE takes the row lock, so
  // concurrent attempts queue behind it and each re-evaluates the predicate
  // against the committed row: the fifth charge sets the lock, and every attempt
  // after it matches no row and is refused without a compare.
  const charged = await chargeOperatorAttempt(db, credential.id, now);
  if (!charged) {
    // No row: the credential is locked, or was revoked since it was read.
    const current = await db.restaurantOperatorCredential.findUnique({
      where: { id: credential.id },
      select: { failedAttempts: true, lockedUntil: true, revokedAt: true },
    });
    if (current && current.revokedAt === null && isLockedOut(current, now)) {
      return { ok: false, reason: 'LOCKED', retryAfterMs: remainingLockoutMs(current, now) };
    }
    await verifyOperatorCredential(type, secret, await getDummyHash());
    return { ok: false, reason: 'INVALID' };
  }

  // DEV-961: every approval, by PIN or by badge, goes through the shared verifier, so a
  // badge cannot approve for a web member who must use the app (a badge counts as a PIN).
  const valid = approval
    ? (await verifyApprovalSecret(db, {
        organizationId: credential.organizationId,
        approverUserId: profile.userId,
        credentialHash: credential.credentialHash,
        credentialType: type,
        secret,
        action: approval.action,
        approverRight: approval.approverRight,
        requestedByStaffProfileId: approval.requestedByStaffProfileId ?? null,
        now,
      })) !== null
    : await verifyOperatorCredential(type, secret, credential.credentialHash);
  // A wrong secret keeps the charge already made above.
  if (!valid) return { ok: false, reason: 'INVALID' };

  // A correct secret clears the strikes, including the charge for this attempt.
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });

  // Completion wave: the shift gate runs AFTER the credential is proven, so a
  // roster lookup can never become an oracle for which staff ids or PINs exist,
  // and a correct PIN still clears the lockout counters above even when the
  // operator turns out not to be on shift.
  if (branchId !== undefined && branch?.shiftSignInEnforced) {
    const eligibility = await resolveShiftEligibility(db, { staffProfileId, branchId, now });
    if (!eligibility.eligible) {
      return {
        ok: false,
        reason: 'NO_ACTIVE_SHIFT',
        shiftReason: eligibility.reason,
        nextShiftStartsAt: eligibility.nextShiftStartsAt,
      };
    }
  }

  if (params.forTerminalBinding) {
    // A reset or deactivation may have committed during credential verification.
    // Recheck the exact proof and profile under shared row locks through bind.
    const verified = await db.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM restaurant_operator_credentials c
      JOIN restaurant_staff_profiles p ON (p."organizationId", p.id) = (c."organizationId", c."staffProfileId")
      WHERE c.id = ${credential.id} AND c."credentialHash" = ${credential.credentialHash}
        AND c."revokedAt" IS NULL AND p.id = ${staffProfileId}
        AND p.status = 'ACTIVE' AND p."primaryBranchId" = ${branchId}
        AND (p."userId" IS NULL OR EXISTS (
          SELECT 1 FROM users u WHERE (u."organizationId", u.id) = (p."organizationId", p."userId")
            AND u.status = 'ACTIVE' FOR SHARE OF u
        ))
      FOR SHARE OF c, p
    `;
    if (!verified.length) return { ok: false, reason: 'INVALID' };
  }
  return { ok: true, credentialId: credential.id, staffProfileId };
}
