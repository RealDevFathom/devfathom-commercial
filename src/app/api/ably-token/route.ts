import * as Ably from 'ably';
import { channelRoom, userRoom, typingRoom, presenceRoom } from '@/lib/chat/contract';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

/**
 * Ably token issuer.
 *
 * The browser must never hold the Ably API key. This route reads the NextAuth
 * session, then mints a short-lived Ably token whose:
 *  - `clientId` is the verified user id (so presence/typing identity can't be
 *    spoofed — Ably stamps it on every message the client publishes), and
 *  - `capability` is scoped to ONLY the channels the user may touch:
 *      • `channel:{id}` → subscribe   (server publishes; clients never do)
 *      • `typing:{id}`  → publish+subscribe (clients exchange typing pings)
 *      • `user:{id}`    → subscribe   (personal notifications)
 *      • `presence:org:{orgId}` → subscribe+presence (online roster of the
 *        verified organization only — never a cross-tenant room)
 *    Channels are derived from ChannelMember, so a user can't subscribe to a
 *    private channel / DM they don't belong to.
 *
 * Ably's client auto-renews through this same URL, picking up newly-joined
 * channels on each refresh.
 */

const ABLY_API_KEY = process.env.ABLY_API_KEY;

// Reads the session (cookies) — never cache; a cached token would be stale and
// shared across users.
export const dynamic = 'force-dynamic';

export const GET = async (request: Request) => {
  let actor;
  try {
    actor = await resolveTenantActor({ request });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    throw error;
  }
  if (!actor?.session.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!ABLY_API_KEY) {
    // Realtime not configured (e.g. env not set) — degrade gracefully so the
    // app still loads; live updates simply won't connect.
    return new Response('Realtime not configured', { status: 503 });
  }

  const userId = actor.session.user.id;
  const rest = new Ably.Rest(ABLY_API_KEY);
  const organization = actor.organization;

  const memberships = await withTenantDb(organization.id, (db) =>
    db.channelMember.findMany({
      where: { userId },
      select: { channelId: true },
    })
  );

  const capability: Record<string, string[]> = {
    [userRoom(userId)]: ['subscribe'],
    [presenceRoom(organization.id)]: ['subscribe', 'presence'],
  };
  for (const { channelId } of memberships) {
    capability[channelRoom(channelId)] = ['subscribe'];
    capability[typingRoom(channelId)] = ['publish', 'subscribe'];
  }

  const tokenRequest = await rest.auth.createTokenRequest({
    clientId: userId,
    capability: JSON.stringify(capability),
    // RT-02: a short TTL bounds how long a stale capability can linger after a
    // membership change (the client also re-authorizes immediately on a
    // membership-changed event, so this is defense-in-depth).
    ttl: 30 * 60 * 1000, // 30 minutes
  });

  return Response.json(tokenRequest);
};
