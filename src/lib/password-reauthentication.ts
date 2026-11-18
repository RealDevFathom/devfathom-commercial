import 'server-only';

import { compare } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** The signed-in member's current password, typed again. */
export const currentPasswordInput = z.string().min(1).max(200);

/**
 * DEV-879 / DEV-931 — changing which factor approves money, stock and controlled-drug actions
 * (an approval authenticator, a personal PIN) needs more than a live session: the member
 * re-enters their current account password, an independent factor a stolen session does not
 * carry. Checked on the server against the stored hash; attempts are rate limited per member
 * and per `purpose`.
 */
export async function requirePasswordReauthentication(
  db: ScopedDb,
  input: { organizationId: string; userId: string; password: string; purpose: string }
): Promise<void> {
  const { organizationId, userId } = input;
  if (!(await rateLimit(`${input.purpose}-reauth:${userId}`, 5, 15 * 60_000)).ok)
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try later.' });
  const user = await db.user.findFirst({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: { password: true },
  });
  if (!user?.password || !(await compare(input.password, user.password)))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your current password is incorrect.' });
}
