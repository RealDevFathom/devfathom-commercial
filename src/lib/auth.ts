import {
  demoSeatFromOrganizationId,
  isCanonicalDemoOrganization,
} from '@/lib/tenancy/demo-identity';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ipFromHeaders, recordAuthAudit } from '@/server/audit';
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { verifyTotp, hashRecoveryCode } from '@/lib/totp';
import {
  isTenantLifecycleAccessible,
  resolveOrganizationById,
  resolveOrganizationForRequest,
} from '@/lib/tenancy/host';
import { withTenantDb, withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { parseCookie } from '@/lib/platform/security';
import { SSO_TICKET_COOKIE } from '@/lib/sso';
import { liveDemoAccessExpiry, type SessionInvalidReason } from '@/lib/auth/session-state';
import { DUMMY_PASSWORD_HASH, SIGNIN_ALLOWED_STATUSES } from '@/lib/auth/constants';
import { consumeLoginIntent, LOGIN_INTENT_COOKIE, peekLoginIntent } from '@/lib/auth/login-intent';
import { emailSchema } from '@/lib/email-address';
import { requestHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { getDemoSeatCount, isDemoEnabled } from '@/lib/demo/config';
import { DEMO_PERSONAS, demoPersonaForUser, demoPersonaUserRole } from '@/lib/demo/personas';

// Fail fast in production if the session-signing secret is missing, so the app
// can never run with unsigned/insecure sessions. (Dev lets NextAuth handle it.)
if (process.env.NODE_ENV === 'production' && !process.env.AUTH_SECRET) {
  throw new Error(
    'AUTH_SECRET is required in production. Generate one with `openssl rand -base64 33`.'
  );
}

const loginSchema = z.object({
  // D10: normalized at the schema layer, so the lookup below and every stored
  // address agree on one canonical form. Before this, `Alex@Company.com` could
  // not sign in at all: line 102 lowercased only the rate-limit key while the
  // query used the raw string against a case-sensitive unique index.
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  // IMP-AUTH-02: a TOTP code or recovery code, required only when 2FA is enabled.
  totp: z.string().optional(),
});

// Distinguishable credentials error for a *deactivated* account. NextAuth/@auth
// surfaces the `code` to the client (in the redirect URL's `code` param, which the
// `next-auth/react` signIn helper exposes as `result.code` when `redirect:false`).
// We throw this ONLY after the password has been verified correct, so it never
// becomes an account-enumeration oracle for attackers who don't know the password.
class SuspendedError extends CredentialsSignin {
  code = 'suspended';
}

class OrganizationSuspendedError extends CredentialsSignin {
  code = 'organization_suspended';
}
class SsoRequiredError extends CredentialsSignin {
  code = 'sso_required';
}

// IMP-AUTH-02: thrown ONLY after the password is verified correct, so 2FA state is
// never an enumeration oracle. '2fa_required' → the login form reveals the code
// field; '2fa_invalid' → the entered code was wrong.
class TwoFactorRequiredError extends CredentialsSignin {
  code = '2fa_required';
}
class TwoFactorInvalidError extends CredentialsSignin {
  code = '2fa_invalid';
}

// How long a JWT's cached role/status is trusted before being re-read from the DB.
const REVALIDATE_AFTER_MS = 60_000;

/**
 * IMP-AUTH-02: second factor. Enforced AFTER the password is proven correct (so
 * it never reveals whether an account exists or has 2FA). Accepts a TOTP code or
 * a single-use recovery code.
 *
 * Shared by the per-host credentials provider and the shared-host selection
 * provider, so the two can never enforce different second-factor rules.
 */
async function assertSecondFactor(
  tenantDb: ScopedDb,
  user: { id: string; twoFactorEnabledAt: Date | null; twoFactorSecret: string | null },
  submitted: unknown,
  audit: {
    organizationId: string;
    email: string;
    name: string | null;
    role: string | null;
    ip: string | null;
    userAgent: string | null;
  }
): Promise<void> {
  if (!user.twoFactorEnabledAt) return;

  const code = (typeof submitted === 'string' ? submitted : '').trim();
  if (!code) {
    recordAuthAudit({
      type: 'LOGIN_FAILED',
      organizationId: audit.organizationId,
      userId: user.id,
      name: audit.name,
      email: audit.email,
      role: audit.role,
      ip: audit.ip,
      userAgent: audit.userAgent,
      reason: '2FA code required',
    });
    throw new TwoFactorRequiredError();
  }

  let ok = user.twoFactorSecret ? verifyTotp(user.twoFactorSecret, code) : false;
  if (!ok) {
    // Fall back to a recovery code: match an unused hash, then consume it
    // atomically (the usedAt:null guard makes it single-use under races).
    const codeHash = hashRecoveryCode(code);
    const match = await tenantDb.twoFactorRecoveryCode.findFirst({
      where: { userId: user.id, codeHash, usedAt: null },
      select: { id: true },
    });
    if (match) {
      const res = await tenantDb.twoFactorRecoveryCode.updateMany({
        where: { id: match.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      ok = res.count === 1;
    }
  }

  if (!ok) {
    recordAuthAudit({
      type: 'LOGIN_FAILED',
      organizationId: audit.organizationId,
      userId: user.id,
      name: audit.name,
      email: audit.email,
      role: audit.role,
      ip: audit.ip,
      userAgent: audit.userAgent,
      reason: 'Invalid 2FA code',
    });
    throw new TwoFactorInvalidError();
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totp: { label: 'Authentication code', type: 'text' },
      },
      async authorize(credentials, request) {
        // Best-effort request context for the audit trail.
        const headers = request?.headers ?? null;
        const ip = ipFromHeaders(headers);
        const userAgent = headers?.get('user-agent') ?? null;

        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) {
          recordAuthAudit({
            type: 'LOGIN_FAILED',
            email: typeof credentials?.email === 'string' ? credentials.email : null,
            ip,
            userAgent,
            reason: 'Malformed credentials',
          });
          return null;
        }

        const { email, password } = parsed.data;

        // REST-04: throttle login attempts BEFORE the bcrypt compare — per IP
        // (broad) and per account — so an unthrottled flood can neither brute-
        // force a password nor burn CPU on prefix-matching bcrypt compares.
        const ipRateLimitKey = `login:ip:${ip ?? 'unknown'}`;
        const accountRateLimitKey = `login:acct:${email}`;
        const ipGate = await rateLimit(ipRateLimitKey, 30, 5 * 60_000);
        const acctGate = await rateLimit(accountRateLimitKey, 10, 5 * 60_000);
        if (!ipGate.ok || !acctGate.ok) {
          recordAuthAudit({
            type: 'LOGIN_FAILED',
            email,
            ip,
            userAgent,
            reason: 'Rate limited',
          });
          return null;
        }

        const organization = await resolveOrganizationForRequest(request);
        if (!organization) {
          await compare(password, DUMMY_PASSWORD_HASH);
          recordAuthAudit({
            type: 'LOGIN_FAILED',
            email,
            ip,
            userAgent,
            reason: 'Unknown workspace host',
          });
          return null;
        }
        if (organization.isDemo) {
          await compare(password, DUMMY_PASSWORD_HASH);
          recordAuthAudit({
            type: 'LOGIN_FAILED',
            organizationId: organization.id,
            email,
            ip,
            userAgent,
            reason: 'Demo workspace requires demo access',
          });
          return null;
        }

        return withTenantDb(organization.id, async (tenantDb) => {
          const user = await tenantDb.user.findFirst({
            where: { email, organizationId: organization.id },
            select: {
              id: true,
              organizationId: true,
              name: true,
              email: true,
              password: true,
              role: true,
              department: true,
              title: true,
              avatar: true,
              status: true,
              tokenVersion: true,
              mustChangePassword: true,
              twoFactorEnabledAt: true,
              twoFactorSecret: true,
            },
          });

          // Always perform a bcrypt comparison — against a dummy hash when the
          // account is absent — so timing does not reveal account existence.
          const isValid = await compare(password, user?.password ?? DUMMY_PASSWORD_HASH);

          // Uniform null result for "no such user" and "wrong password" — the two
          // cases an attacker who doesn't know the password could probe. Crucially,
          // a WRONG password against a deactivated account also lands here, so the
          // "suspended" signal below can never be used to enumerate accounts.
          if (!user || user.organizationId !== organization.id || !isValid) {
            // The client sees a uniform null, but the admin-only audit log records
            // the precise reason (it never leaks back to the would-be attacker).
            const reason = !user ? 'No such account' : 'Incorrect password';
            recordAuthAudit({
              type: 'LOGIN_FAILED',
              organizationId: organization.id,
              userId: user?.id ?? null,
              name: user?.name ?? null,
              email,
              role: user?.role ?? null,
              ip,
              userAgent,
              reason,
            });
            return null;
          }

          const enforcedConnection = await tenantDb.organizationIdentityConnection.findFirst({
            where: { status: 'ACTIVE', enforceSso: true },
            select: { id: true },
          });
          if (enforcedConnection) {
            recordAuthAudit({
              type: 'LOGIN_FAILED',
              organizationId: organization.id,
              userId: user.id,
              name: user.name,
              email,
              role: user.role,
              ip,
              userAgent,
              reason: 'Password sign-in disabled by SSO enforcement',
            });
            throw new SsoRequiredError();
          }

          // Correct password, but the account is not permitted to sign in
          // (INACTIVE/INVITED). Only now — after the password is proven correct — do
          // we reveal the suspended state, via a distinguishable error code that the
          // login form turns into an actionable message.
          if (!SIGNIN_ALLOWED_STATUSES.has(user.status)) {
            recordAuthAudit({
              type: 'LOGIN_FAILED',
              organizationId: organization.id,
              userId: user.id,
              name: user.name,
              email,
              role: user.role,
              ip,
              userAgent,
              reason: `Account is ${user.status}`,
            });
            throw new SuspendedError();
          }

          if (!isTenantLifecycleAccessible(organization.status)) {
            recordAuthAudit({
              type: 'LOGIN_FAILED',
              organizationId: organization.id,
              userId: user.id,
              name: user.name,
              email,
              role: user.role,
              ip,
              userAgent,
              reason: `Organization is ${organization.status}`,
            });
            throw new OrganizationSuspendedError();
          }

          await assertSecondFactor(tenantDb, user, parsed.data.totp, {
            organizationId: organization.id,
            email,
            name: user.name,
            role: user.role,
            ip,
            userAgent,
          });

          // Successful authentication must not consume the failure budget.
          // Otherwise normal serial workflows lock out the same authorized user
          // — the same reasoning, and the same remedy, as the control-plane
          // transport in src/lib/platform/auth.ts.
          //
          // Cleared only HERE, once both the password and the second factor are
          // proven. Clearing on a correct password alone would hand an attacker
          // who already holds that password an unlimited budget for grinding
          // TOTP codes. Every failing path above returns or throws before this
          // line, so a failure still consumes its unit, the limits are unchanged
          // and a throttled response stays byte-identical to a wrong password.
          await clearRateLimit(ipRateLimitKey);
          await clearRateLimit(accountRateLimitKey);

          // Update last active
          await tenantDb.user.update({
            where: { id: user.id },
            data: { lastActiveAt: new Date() },
          });

          recordAuthAudit({
            type: 'LOGIN',
            organizationId: organization.id,
            userId: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            ip,
            userAgent,
          });

          return {
            id: user.id,
            organizationId: user.organizationId,
            organizationSlug: organization.slug,
            organizationStatus: organization.status,
            name: user.name,
            email: user.email,
            role: user.role,
            department: user.department,
            title: user.title,
            image: user.avatar,
            status: user.status,
            tokenVersion: user.tokenVersion,
            mustChangePassword: user.mustChangePassword === true,
            // Issued only after this route verifies password and any second factor.
            passwordAuthenticatedAt: Date.now(),
          };
        });
      },
    }),
    /**
     * D9 — the final step of a shared-host login.
     *
     * Mirrors the `enterprise` provider: a one-use server-side handle is
     * exchanged for a normal Auth.js JWT carrying `organizationId`. No new
     * session machinery, no second cookie, no change to how a session is read.
     *
     * The submitted organization id is not authority: it is only accepted if it
     * is a member of the candidate set the server itself computed when the
     * password was proven, and only on the host the intent was minted on.
     */
    Credentials({
      id: 'login-intent',
      name: 'Workspace selection',
      credentials: {
        organizationId: { label: 'Workspace', type: 'text' },
        totp: { label: 'Authentication code', type: 'text' },
      },
      async authorize(credentials, request) {
        const host = requestHost(request);
        if (!isSharedHost(host)) return null;

        const ip = ipFromHeaders(request.headers);
        const userAgent = request.headers.get('user-agent');

        const organizationId =
          typeof credentials?.organizationId === 'string' ? credentials.organizationId : '';
        if (!organizationId) return null;

        // D18: selection is rate limited independently of the credential check,
        // so a valid intent cannot be used to grind organization ids.
        const selectionGate = await rateLimit(`login:select:${ip ?? 'unknown'}`, 30, 5 * 60_000);
        if (!selectionGate.ok) return null;

        const rawIntent = parseCookie(request.headers.get('cookie'), LOGIN_INTENT_COOKIE);
        const intent = await peekLoginIntent(rawIntent, host);
        if (!intent) return null;

        const candidate = intent.candidates.find(
          (entry) => entry.organizationId === organizationId
        );
        if (!candidate) {
          recordAuthAudit({
            type: 'LOGIN_FAILED',
            email: intent.email,
            ip,
            userAgent,
            reason: 'Workspace selection outside the verified candidate set',
          });
          return null;
        }

        const organization = await resolveOrganizationById(organizationId);
        if (!organization || !isTenantLifecycleAccessible(organization.status)) return null;
        const demoSeat = organization.isDemo
          ? demoSeatFromOrganizationId(organization.id, getDemoSeatCount())
          : null;
        const demoPersona = demoSeat
          ? demoPersonaForUser(demoSeat, { id: candidate.userId, email: intent.email })
          : null;
        // A demo intent must never become an ordinary tenant login after a state change.
        if (candidate.demoAccessExpiresAt !== undefined && !organization.isDemo) return null;
        if (
          organization.isDemo &&
          (!isDemoEnabled() ||
            !isCanonicalDemoOrganization(organization, getDemoSeatCount()) ||
            !demoPersona ||
            !liveDemoAccessExpiry(candidate.demoAccessExpiresAt))
        ) {
          return null;
        }

        return withTenantDb(organization.id, async (tenantDb) => {
          const user = await tenantDb.user.findUnique({
            where: { id: candidate.userId },
            select: {
              id: true,
              organizationId: true,
              name: true,
              email: true,
              role: true,
              department: true,
              title: true,
              avatar: true,
              status: true,
              tokenVersion: true,
              mustChangePassword: true,
              password: true,
              organizationRole: { select: { key: true } },
              twoFactorEnabledAt: true,
              twoFactorSecret: true,
            },
          });
          // Re-check everything the intent asserted. The intent is a handle to a
          // decision, not a substitute for the state it was based on: the account
          // may have been deactivated, or SSO enforced, in the five minutes since.
          if (!user || user.email !== intent.email) return null;
          if (organization.isDemo) {
            if (
              !demoPersona ||
              user.organizationId !== organization.id ||
              user.password !== null ||
              user.status !== 'ACTIVE' ||
              user.role !== demoPersonaUserRole(demoPersona) ||
              user.organizationRole?.key !== DEMO_PERSONAS[demoPersona].roleKey
            )
              return null;
            const profiles = await tenantDb.restaurantStaffProfile.findMany({
              where: { userId: user.id, status: 'ACTIVE', primaryBranch: { active: true } },
              select: { id: true },
              take: 2,
            });
            if (profiles.length !== 1) return null;
          }
          if (!SIGNIN_ALLOWED_STATUSES.has(user.status)) throw new SuspendedError();

          const enforcedConnection = await tenantDb.organizationIdentityConnection.findFirst({
            where: { status: 'ACTIVE', enforceSso: true },
            select: { id: true },
          });
          if (enforcedConnection) throw new SsoRequiredError();

          // IMP-AUTH-02: the second factor belongs to a user, and the user is only
          // known once a workspace is chosen — so it is enforced here. The intent
          // is consumed AFTER the code verifies, so a mistyped code does not force
          // the password to be entered again.
          await assertSecondFactor(tenantDb, user, credentials?.totp, {
            organizationId: organization.id,
            email: user.email,
            name: user.name,
            role: user.role,
            ip,
            userAgent,
          });

          const consumed = await consumeLoginIntent(rawIntent, host, organization.id);
          if (!consumed) return null;
          // The shared-host password route created this server-owned intent.
          // Preserve password-entry time; selecting a workspace cannot refresh it.
          const passwordIntent = organization.isDemo
            ? null
            : await withPlatformDb((db) =>
                db.pendingLoginIntent.findUnique({
                  where: { id: consumed.id },
                  select: { createdAt: true },
                })
              );

          // WHA-1570: the shared-host credential check (/api/login) spends the
          // same `login:ip` / `login:acct` budgets as the per-host provider above,
          // so a fully verified shared-host sign-in clears them the same way.
          // Cleared HERE and not in /api/login: that route proves only the
          // password, and refunding it there would let whoever holds the password
          // mint intents without limit and grind second-factor codes through them.
          // `intent.email` is the same normalized address /api/login keyed on.
          await clearRateLimit(`login:ip:${ip ?? 'unknown'}`);
          await clearRateLimit(`login:acct:${intent.email}`);

          await tenantDb.user.update({
            where: { id: user.id },
            data: { lastActiveAt: new Date() },
          });

          recordAuthAudit({
            type: 'LOGIN',
            organizationId: organization.id,
            userId: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            ip,
            userAgent,
            reason: 'Shared host workspace selection',
          });

          return {
            id: user.id,
            organizationId: user.organizationId,
            organizationSlug: organization.slug,
            organizationStatus: organization.status,
            name: user.name,
            email: user.email,
            role: user.role,
            department: user.department,
            title: user.title,
            image: user.avatar,
            status: user.status,
            tokenVersion: user.tokenVersion,
            mustChangePassword: user.mustChangePassword === true,
            passwordAuthenticatedAt: passwordIntent?.createdAt.getTime(),
            demoAccessExpiresAt: organization.isDemo ? candidate.demoAccessExpiresAt : undefined,
          };
        });
      },
    }),
    Credentials({
      id: 'enterprise',
      name: 'Enterprise SSO',
      credentials: {},
      async authorize(_credentials, request) {
        const rawTicket = parseCookie(request.headers.get('cookie'), SSO_TICKET_COOKIE);
        if (!rawTicket || rawTicket.length < 32 || rawTicket.length > 128) return null;
        const organization = await resolveOrganizationForRequest(request);
        if (
          !organization ||
          organization.isDemo ||
          !isTenantLifecycleAccessible(organization.status)
        ) {
          return null;
        }
        return withTenantDb(organization.id, async (tenantDb) => {
          const ticket = await tenantDb.tenantSsoTicket.findFirst({
            where: {
              tokenHash: createHash('sha256').update(rawTicket).digest('hex'),
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            include: { user: true },
          });
          if (!ticket || !SIGNIN_ALLOWED_STATUSES.has(ticket.user.status)) return null;
          const consumed = await tenantDb.tenantSsoTicket.updateMany({
            where: { id: ticket.id, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (consumed.count !== 1) return null;
          await tenantDb.user.update({
            where: { id: ticket.user.id },
            data: { lastActiveAt: new Date() },
          });
          recordAuthAudit({
            type: 'LOGIN',
            organizationId: organization.id,
            userId: ticket.user.id,
            name: ticket.user.name,
            email: ticket.user.email,
            role: ticket.user.role,
            ip: ipFromHeaders(request.headers),
            userAgent: request.headers.get('user-agent'),
            reason: 'Enterprise SSO',
          });
          return {
            id: ticket.user.id,
            organizationId: ticket.user.organizationId,
            organizationSlug: organization.slug,
            organizationStatus: organization.status,
            name: ticket.user.name,
            email: ticket.user.email,
            role: ticket.user.role,
            department: ticket.user.department,
            title: ticket.user.title,
            image: ticket.user.avatar,
            status: ticket.user.status,
            tokenVersion: ticket.user.tokenVersion,
          };
        });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Sign-in: the account was just verified sign-in-eligible in authorize().
      // Carry the REAL status (ACTIVE or ON_LEAVE) — not a hardcoded 'ACTIVE' —
      // so on-leave staff are gated truthfully from the first request.
      if (user) {
        token.id = user.id;
        token.organizationId = (user as Record<string, unknown>).organizationId as string;
        token.organizationSlug = (user as Record<string, unknown>).organizationSlug as string;
        token.organizationStatus = (user as Record<string, unknown>).organizationStatus as string;
        token.role = (user as Record<string, unknown>).role as string;
        token.department = (user as Record<string, unknown>).department as string;
        token.title = (user as Record<string, unknown>).title as string;
        token.status = ((user as Record<string, unknown>).status as string) ?? 'ACTIVE';
        // AUTH-01: snapshot the session-revocation counter at sign-in.
        token.tokenVersion = ((user as Record<string, unknown>).tokenVersion as number) ?? 0;
        token.mustChangePassword = (user as Record<string, unknown>).mustChangePassword === true;
        token.demoAccessExpiresAt =
          liveDemoAccessExpiry((user as Record<string, unknown>).demoAccessExpiresAt) ?? undefined;
        // #16: session validity is its own claim. `status` now only ever holds a
        // real UserStatus, so a revoked session can never be misreported as a
        // deactivated account (and vice versa).
        token.sessionRevoked = false;
        token.sessionInvalidReason = null;
        // Never infer password entry from session refresh or non-password sign-in.
        token.passwordAuthenticatedAt = user.passwordAuthenticatedAt;
        token.lastValidatedAt = Date.now();
        return token;
      }

      // Subsequent requests: periodically re-read role/status from the DB so
      // deactivation and role changes take effect within REVALIDATE_AFTER_MS
      // rather than after the full token lifetime — stateless JWTs are otherwise
      // unrevocable.
      //
      // FAIL CLOSED on database errors (#16). The previous comment here claimed
      // this path failed OPEN while the code below failed closed; the closed
      // behaviour is the intended one and is now the documented contract.
      // Rationale: an unverifiable session is not an authorized session, and the
      // application cannot serve tenant data without the same database anyway,
      // so failing open buys no availability — only an unrevocable window.
      // Recovery is a fresh sign-in, or the next successful revalidation once
      // REVALIDATE_AFTER_MS has elapsed.
      if (
        token.demoAccessExpiresAt !== undefined &&
        !liveDemoAccessExpiry(token.demoAccessExpiresAt)
      ) {
        token.sessionRevoked = true;
        token.sessionInvalidReason = 'DEMO_ACCESS_EXPIRED';
        return token;
      }

      const lastValidated = typeof token.lastValidatedAt === 'number' ? token.lastValidatedAt : 0;
      const stale = Date.now() - lastValidated > REVALIDATE_AFTER_MS;
      if (token.id && token.organizationId && stale) {
        try {
          const fresh = await withTenantDb(token.organizationId as string, (tenantDb) =>
            tenantDb.user.findUnique({
              where: { id: token.id as string },
              select: {
                role: true,
                status: true,
                department: true,
                title: true,
                tokenVersion: true,
                mustChangePassword: true,
                organization: { select: { slug: true, status: true, isDemo: true } },
              },
            })
          );
          if (!fresh) {
            token.sessionRevoked = true;
            token.sessionInvalidReason = 'DELETED';
          } else if (
            fresh.organization.isDemo &&
            !liveDemoAccessExpiry(token.demoAccessExpiresAt)
          ) {
            token.sessionRevoked = true;
            token.sessionInvalidReason = 'DEMO_ACCESS_EXPIRED';
          } else if (fresh.tokenVersion !== ((token.tokenVersion as number) ?? 0)) {
            // AUTH-01 / IMP-AUTH-03: the counter was bumped (password change,
            // admin reset, lay-off, or "sign out everywhere"), so every token
            // issued before it is stale. This is permanent for this token: the
            // snapshot never catches up, so the claim can never clear itself.
            token.sessionRevoked = true;
            token.sessionInvalidReason = 'REVOKED';
          } else {
            token.role = fresh.role;
            token.mustChangePassword = fresh.mustChangePassword === true;
            token.status = fresh.status;
            token.department = fresh.department;
            token.title = fresh.title;
            token.organizationSlug = fresh.organization.slug;
            token.organizationStatus = fresh.organization.status;
            if (!isTenantLifecycleAccessible(fresh.organization.status)) {
              token.sessionRevoked = true;
              token.sessionInvalidReason = 'ORGANIZATION_SUSPENDED';
            } else {
              // Recoverable conditions (a resumed organization, a database blip)
              // clear once the state is re-read successfully.
              token.sessionRevoked = false;
              token.sessionInvalidReason = null;
            }
          }
          token.lastValidatedAt = Date.now();
        } catch {
          token.sessionRevoked = true;
          token.sessionInvalidReason = 'REVALIDATION_FAILED';
          token.lastValidatedAt = Date.now();
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.organizationId = token.organizationId as string;
        session.user.organizationSlug = token.organizationSlug as string;
        session.user.organizationStatus = token.organizationStatus as string;
        session.user.role = token.role as string;
        session.user.department = token.department as string;
        session.user.title = token.title as string;
        session.user.status = token.status as string;
        session.user.mustChangePassword = token.mustChangePassword === true;
        // #16: every consumer of the session must be able to see that the
        // session itself was invalidated, independently of account status.
        session.user.sessionRevoked = Boolean(token.sessionRevoked);
        session.user.passwordAuthenticatedAt =
          !token.sessionRevoked &&
          typeof token.passwordAuthenticatedAt === 'number' &&
          Number.isFinite(token.passwordAuthenticatedAt)
            ? token.passwordAuthenticatedAt
            : undefined;
        session.user.sessionInvalidReason =
          (token.sessionInvalidReason as SessionInvalidReason | null) ?? null;
        session.user.demoAccessExpiresAt =
          liveDemoAccessExpiry(token.demoAccessExpiresAt) ?? undefined;
      }
      return session;
    },
  },
  events: {
    // Record sign-outs in the audit trail. Under the JWT strategy the payload
    // carries the (decoded) token with our custom `id`/`role` claims.
    async signOut(message) {
      const token =
        'token' in message && message.token ? (message.token as Record<string, unknown>) : null;
      if (token?.id) {
        recordAuthAudit({
          type: 'LOGOUT',
          organizationId:
            typeof token.organizationId === 'string' ? token.organizationId : undefined,
          userId: token.id as string,
          role: typeof token.role === 'string' ? token.role : null,
        });
      }
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    // Shorter lifetime bounds how long a stolen token is useful; combined with
    // the per-request revalidation above, effective revocation is ~1 minute.
    maxAge: 60 * 60 * 8, // 8 hours
    updateAge: 60 * 60, // Database sessions only; Auth.js refreshes JWT cookies on every read.
  },
  secret: process.env.AUTH_SECRET,
});
