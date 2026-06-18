import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { db } from '@/lib/db';
import { z } from 'zod';

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
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

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

        // Uniform null result for "no such user", "inactive", and "wrong password".
        if (!user || user.status !== 'ACTIVE' || !isValid) return null;

        // Update last active
        await db.user.update({
          where: { id: user.id },
          data: { lastActiveAt: new Date() },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          title: user.title,
          image: user.avatar,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Sign-in: the account was just verified ACTIVE in authorize().
      if (user) {
        token.id = user.id;
        token.role = (user as Record<string, unknown>).role as string;
        token.department = (user as Record<string, unknown>).department as string;
        token.title = (user as Record<string, unknown>).title as string;
        token.status = 'ACTIVE';
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
