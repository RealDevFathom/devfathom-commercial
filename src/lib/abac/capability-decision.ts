// Minimal resolver ported identically from #163; remove when the base exports it.
import type { AuthzDb } from '@/lib/authz';
import { capabilityMatches } from './capabilities';

export async function customDecision(
  db: AuthzDb,
  userId: string,
  action: string,
  now: Date
): Promise<boolean | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  const overrides = user.permissionOverrides.filter((rule) =>
    capabilityMatches(rule.capability, action)
  );
  if (overrides.some((rule) => rule.effect === 'DENY')) return false;
  if (overrides.some((rule) => rule.effect === 'ALLOW')) return true;
  const roleRules = (user.organizationRole?.permissions ?? []).filter((rule) =>
    capabilityMatches(rule.capability, action)
  );
  if (roleRules.some((rule) => rule.effect === 'DENY')) return false;
  if (roleRules.some((rule) => rule.effect === 'ALLOW')) return true;
  return null;
}
