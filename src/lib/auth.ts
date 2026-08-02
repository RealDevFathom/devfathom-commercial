import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ipFromHeaders, recordAuthAudit } from '@/server/audit';
import { rateLimit } from '@/lib/rate-limit';
import { verifyTotp, hashRecoveryCode } from '@/lib/totp';
import { isTenantLifecycleAccessible, resolveOrganizationForRequest } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { parseCookie } from '@/lib/platform/security';
import { SSO_TICKET_COOKIE } from '@/lib/sso';
import type { SessionInvalidReason } from '@/lib/auth/session-state';

// Fail fast in production if the session-signing secret is missing, so the app
// can never run with unsigned/insecure sessions. (Dev lets NextAuth handle it.)
if (process.env.NODE_ENV === 'production' && !process.env.AUTH_SECRET) {
  throw new Error(
    'AUTH_SECRET is required in production. Generate one with `openssl rand -base64 33`.'
  );
}

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  // IMP-AUTH-02: a TOTP code or recovery code, required only when 2FA is enabled.
  totp: z.string().optional(),
});

// A valid bcrypt hash of a value no one will ever submit. When a login targets a
// missing/inactive account we still run a bcrypt comparison against this hash so
// the response time is independent of whether the account exists — this defeats
// the username-enumeration timing oracle.
const DUMMY_PASSWORD_HASH = '$2b$10$7Jh22HC1lxzaVDwJSaJVp./wPe52BukW8KMrtnZfsoTMNsvJxWclS';

// Account statuses permitted to authenticate. ON_LEAVE staff keep their access;
// INACTIVE (deactivated) and INVITED (not yet onboarded) accounts are blocked.
// Using an allow-list means any future/unknown status fails closed.
const SIGNIN_ALLOWED_STATUSES = new Set(['ACTIVE', 'ON_LEAVE']);

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
        const ipGate = rateLimit(`login:ip:${ip ?? 'unknown'}`, 30, 5 * 60_000);
        const acctGate = rateLimit(`login:acct:${email.toLowerCase()}`, 10, 5 * 60_000);
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

        return withTenantDb(organization.id, async (tenantDb) => {
          const user = await tenantDb.user.findFirst({
            where: { email },
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
          if (!user || !isValid) {
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

          // IMP-AUTH-02: second factor. Enforced AFTER the password is proven correct
          // (so it never reveals whether an account exists or has 2FA). Accepts a TOTP
          // code or a single-use recovery code.
          if (user.twoFactorEnabledAt) {
            const code = (parsed.data.totp ?? '').trim();
            if (!code) {
              recordAuthAudit({
                type: 'LOGIN_FAILED',
                organizationId: organization.id,
                userId: user.id,
                name: user.name,
                email,
                role: user.role,
                ip,
                userAgent,
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
                organizationId: organization.id,
                userId: user.id,
                name: user.name,
                email,
                role: user.role,
                ip,
                userAgent,
                reason: 'Invalid 2FA code',
              });
              throw new TwoFactorInvalidError();
            }
          }

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
        if (!organization || !isTenantLifecycleAccessible(organization.status)) return null;
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
        // #16: session validity is its own claim. `status` now only ever holds a
        // real UserStatus, so a revoked session can never be misreported as a
        // deactivated account (and vice versa).
        token.sessionRevoked = false;
        token.sessionInvalidReason = null;
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
                organization: { select: { slug: true, status: true } },
              },
            })
          );
          if (!fresh) {
            token.sessionRevoked = true;
            token.sessionInvalidReason = 'DELETED';
          } else if (fresh.tokenVersion !== ((token.tokenVersion as number) ?? 0)) {
            // AUTH-01 / IMP-AUTH-03: the counter was bumped (password change,
            // admin reset, lay-off, or "sign out everywhere"), so every token
            // issued before it is stale. This is permanent for this token: the
            // snapshot never catches up, so the claim can never clear itself.
            token.sessionRevoked = true;
            token.sessionInvalidReason = 'REVOKED';
          } else {
            token.role = fresh.role;
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
        // #16: every consumer of the session must be able to see that the
        // session itself was invalidated, independently of account status.
        session.user.sessionRevoked = Boolean(token.sessionRevoked);
        session.user.sessionInvalidReason =
          (token.sessionInvalidReason as SessionInvalidReason | null) ?? null;
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
    updateAge: 60 * 60, // rotate the session cookie at most hourly
  },
  secret: process.env.AUTH_SECRET,
});
