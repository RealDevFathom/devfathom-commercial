import type { Session } from 'next-auth';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted, type EntitlementView } from '@/lib/module-catalog';

// Only tools already composed in lib/ai/tools.ts. These reads filter results to
// the acting user. No privileged/financial suggestions: the current client
// session has role/status, but no resolved ABAC grants (including overrides).
export const ASSISTANT_SUGGESTION_CONDITIONS = [
  { text: 'Show my open tasks', module: 'projects', tool: 'listMyTasks', vertical: 'AGENCY' },
  {
    text: 'Which projects are behind schedule?',
    module: 'projects',
    tool: 'findProjectsBehindSchedule',
    vertical: 'AGENCY',
  },
  { text: 'Find notes I can access', module: 'notes', tool: 'searchNotes' },
  { text: 'What meetings are on my schedule?', module: 'meetings', tool: 'listMeetings' },
] as const;

export type AssistantShortcut = { label: string; href: string };

// #1221: counter work happens in the Counter, not in Ask Fathom (no assistant
// tool reads counter stock or records returns), so these are links, never
// chat prompts. Offered only when the server confirms counter access.
export const PHARMACY_COUNTER_SHORTCUTS: readonly AssistantShortcut[] = [
  { label: 'Look up stock at the Counter', href: '/pharmacy/counter' },
  { label: 'Find a receipt for a return at the Counter', href: '/pharmacy/counter' },
];

/** Whether the empty state needs the server-checked Pharmacy capabilities. */
export function assistantNeedsPharmacyAccess(entitlements: EntitlementView) {
  return entitlements.vertical === 'PHARMACY';
}

/**
 * `pharmacyCapabilities` is the server ABAC answer from
 * `pharmacyAccess.navigation` for this user, or `null` while it is unknown.
 * Unknown access never promises reports or counter shortcuts.
 */
export function assistantEntry(
  entitlements: EntitlementView,
  user: Session['user'] | undefined,
  sessionStatus: 'loading' | 'authenticated' | 'unauthenticated',
  pharmacyCapabilities: readonly string[] | null = null
) {
  const neutral = {
    title: 'Ask Fathom',
    suggestions: [] as string[],
    shortcuts: [] as AssistantShortcut[],
    canChat: false,
  };
  if (sessionStatus === 'loading') {
    return { ...neutral, description: 'Loading your workspace access…' };
  }
  const verdict = evaluateSessionUser(user);
  if (sessionStatus !== 'authenticated' || !verdict.ok) {
    return {
      ...neutral,
      description: verdict.ok ? 'Sign in to use Ask Fathom.' : verdict.message,
    };
  }
  if (!user?.id || !user.organizationId || entitlements.organizationId !== user.organizationId) {
    return {
      ...neutral,
      description: 'Workspace access changed. Reload this workspace to continue.',
    };
  }
  const vertical = entitlements.vertical;
  if (vertical !== 'AGENCY' && vertical !== 'RESTAURANT' && vertical !== 'PHARMACY') {
    return { ...neutral, description: 'Workspace context is unavailable. Reload to try again.' };
  }

  const suggestions = ASSISTANT_SUGGESTION_CONDITIONS.filter(
    (suggestion) =>
      (!('vertical' in suggestion) || suggestion.vertical === vertical) &&
      isModuleGranted(suggestion.module, entitlements.enabledModules)
  ).map(({ text }) => text);

  const pharmacyReports = isModuleGranted('pharmacy-reports', entitlements.enabledModules);
  const shortcuts =
    vertical === 'PHARMACY' && pharmacyCapabilities?.includes('pharmacy:counter')
      ? [...PHARMACY_COUNTER_SHORTCUTS]
      : [];

  const description =
    vertical === 'AGENCY'
      ? 'Ask about the workspace information you can access. Available starting points are shown below.'
      : vertical === 'RESTAURANT'
        ? isModuleGranted('restaurant-core', entitlements.enabledModules)
          ? 'Ask about available workspace information or Restaurant and Catering reports. Report access is checked when you ask. Operational changes are unavailable here.'
          : 'Ask about available workspace information. Restaurant reports are not enabled for this workspace.'
        : !pharmacyReports
          ? 'Ask about available workspace information. Pharmacy reports are not enabled for this workspace. Patient and clinical actions are unavailable here.'
          : pharmacyCapabilities?.includes('reports:operational')
            ? 'Ask about available workspace information or pharmacy reports. Report access is checked when you ask. Patient and clinical actions are unavailable here.'
            : pharmacyCapabilities
              ? 'Ask about available workspace information. Pharmacy reports are not part of your access. Patient and clinical actions are unavailable here.'
              : 'Ask about available workspace information. Patient and clinical actions are unavailable here.';

  return {
    title:
      vertical === 'AGENCY'
        ? 'Your agency workspace'
        : vertical === 'RESTAURANT'
          ? 'Your restaurant workspace'
          : 'Your pharmacy workspace',
    description,
    suggestions,
    shortcuts,
    canChat: true,
  };
}
