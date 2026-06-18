import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { db } from '@/lib/db';
import { z } from 'zod';
import { ipFromHeaders, recordAuthAudit } from '@/server/audit';

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

// How long a JWT's cached role/status is trusted before being re-read from the DB.
const REVALIDATE_AFTER_MS = 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
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

        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true,
            name: true,
            email: true,
            password: true,
            role: true,
            department: true,
            title: true,
            avatar: true,
            status: true,
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

        // Correct password, but the account is not permitted to sign in
        // (INACTIVE/INVITED). Only now — after the password is proven correct — do
        // we reveal the suspended state, via a distinguishable error code that the
        // login form turns into an actionable message.
        if (!SIGNIN_ALLOWED_STATUSES.has(user.status)) {
          recordAuthAudit({
            type: 'LOGIN_FAILED',
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

        // Update last active
        await db.user.update({
          where: { id: user.id },
          data: { lastActiveAt: new Date() },
        });

        recordAuthAudit({
          type: 'LOGIN',
          userId: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          ip,
          userAgent,
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          title: user.title,
          image: user.avatar,
          status: user.status,
        };
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
        token.role = (user as Record<string, unknown>).role as string;
        token.department = (user as Record<string, unknown>).department as string;
        token.title = (user as Record<string, unknown>).title as string;
        token.status = ((user as Record<string, unknown>).status as string) ?? 'ACTIVE';
        token.lastValidatedAt = Date.now();
        return token;
      }

      // Subsequent requests: periodically re-read role/status from the DB so
      // deactivation and role changes take effect within REVALIDATE_AFTER_MS
      // rather than after the full token lifetime — stateless JWTs are otherwise
      // unrevocable. Fail OPEN on DB errors to avoid mass lockout on a blip.
      const lastValidated = typeof token.lastValidatedAt === 'number' ? token.lastValidatedAt : 0;
      const stale = Date.now() - lastValidated > REVALIDATE_AFTER_MS;
      if (token.id && stale) {
        try {
          const fresh = await db.user.findUnique({
            where: { id: token.id as string },
            select: { role: true, status: true, department: true, title: true },
          });
          if (!fresh) {
            token.status = 'DELETED';
          } else {
            token.role = fresh.role;
            token.status = fresh.status;
            token.department = fresh.department;
            token.title = fresh.title;
          }
          token.lastValidatedAt = Date.now();
        } catch {
          // Transient DB issue: keep existing claims, retry on the next request.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.department = token.department as string;
        session.user.title = token.title as string;
        session.user.status = token.status as string;
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
