import 'server-only';

import { readAIProviderReadiness, type AIProviderReadiness } from '@/lib/ai/provider';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Env = Record<string, string | undefined>;

export type AskFathomSettings = {
  organizationId: string;
  askFathomEnabled: boolean;
};

/** Company switch first: an administrator can act on it; provider setup is an operator task. */
export type AskFathomUnavailableReason = 'COMPANY_DISABLED' | 'AI_NOT_CONFIGURED';

export type AskFathomAvailability = AskFathomSettings & {
  available: boolean;
  unavailableReason: AskFathomUnavailableReason | null;
};

/** Read current chat policy from the tenant database, never a session or cache. */
export async function readAskFathomSettings(
  db: Pick<ScopedDb, 'organization'>,
  organizationId: string
): Promise<AskFathomSettings | null> {
  if (!organizationId) return null;
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, askFathomEnabled: true },
  });
  if (organization?.id !== organizationId || typeof organization.askFathomEnabled !== 'boolean') {
    return null;
  }
  return { organizationId, askFathomEnabled: organization.askFathomEnabled };
}

/** Combine company policy with provider readiness. Every Ask Fathom gate derives from this. */
export function askFathomAvailability(
  settings: AskFathomSettings,
  provider: AIProviderReadiness
): AskFathomAvailability {
  const unavailableReason: AskFathomUnavailableReason | null = !settings.askFathomEnabled
    ? 'COMPANY_DISABLED'
    : provider.ready
      ? null
      : 'AI_NOT_CONFIGURED';
  return {
    organizationId: settings.organizationId,
    askFathomEnabled: settings.askFathomEnabled,
    available: unavailableReason === null,
    unavailableReason,
  };
}

/**
 * The one availability check shared by `organizationAdmin.askFathomSettings` (which
 * enables the launcher) and `POST /api/assistant` (which answers), so they cannot disagree.
 * `provider` names missing settings for server logs; it never reaches the client.
 */
export async function readAskFathomAvailability(
  db: Pick<ScopedDb, 'organization'>,
  organizationId: string,
  env: Env = process.env
): Promise<{ availability: AskFathomAvailability; provider: AIProviderReadiness } | null> {
  const settings = await readAskFathomSettings(db, organizationId);
  if (!settings) return null;
  const provider = readAIProviderReadiness(env);
  return { availability: askFathomAvailability(settings, provider), provider };
}

/** Server-side diagnostic for an unconfigured provider: setting names only, never values. */
export function logAIProviderUnavailable(event: string, provider: AIProviderReadiness) {
  if (provider.ready) return;
  console.error(event, {
    reason: provider.reason,
    provider: provider.provider,
    missing: provider.missing,
    invalid: provider.invalid,
  });
}
