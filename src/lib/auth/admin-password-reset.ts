import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The one administrative password-reset policy (AUTH-01, DEV-838).
 *
 * Every path an administrator uses to reset another member's password — the
 * team page, the organization admin page and the assistant — writes these
 * fields, so a reset always:
 *   - bumps `tokenVersion`, which makes every already-issued JWT fail its next
 *     revalidation (src/lib/auth.ts), and
 *   - clears `passwordChangedAt` and sets `mustChangePassword`, so the next
 *     sign-in is forced through a password rotation.
 *
 * `passwordHash` is the bcrypt hash of the new credential. The by-hand admin
 * screens pass the temporary password the administrator typed. The assistant
 * never chooses one: it passes `unusablePasswordHash()`, which retires the old
 * (possibly compromised) password, and emails the member a private, single-use
 * reset link so only the member ever chooses (or sees) the replacement.
 */
export function adminPasswordResetData(passwordHash: string): Prisma.UserUpdateInput {
  return {
    password: passwordHash,
    passwordChangedAt: null,
    mustChangePassword: true,
    tokenVersion: { increment: 1 },
  };
}

/** How long an emailed password-reset link stays usable (mirrors passwordReset.request). */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A bcrypt hash of 256 random bits that is never stored, returned or logged in
 * plaintext. Installing it invalidates the member's previous password without
 * creating a credential anyone knows: sign-in resumes only through the emailed
 * single-use reset link (or the public forgot-password flow).
 */
export async function unusablePasswordHash(): Promise<string> {
  return hash(randomBytes(32).toString('base64url'), 12);
}
