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
  {
    text: "What are today's sales?",
    module: 'pharmacy-reports',
    tool: 'askPharmacyReports',
    vertical: 'PHARMACY',
  },
  {
    text: 'Which medicines are expiring soon?',
    module: 'pharmacy-reports',
    tool: 'askPharmacyReports',
    vertical: 'PHARMACY',
  },
  {
    text: 'Which items are running low on stock?',
    module: 'pharmacy-reports',
    tool: 'askPharmacyReports',
    vertical: 'PHARMACY',
  },
  {
    text: "How did today's orders go?",
    module: 'restaurant-core',
    tool: 'askRestaurantReports',
    vertical: 'RESTAURANT',
  },
] as const;

export function assistantEntry(
  entitlements: EntitlementView,
  user: Session['user'] | undefined,
  sessionStatus: 'loading' | 'authenticated' | 'unauthenticated'
) {
  const neutral = { title: 'Ask Fathom', suggestions: [] as string[], canChat: false };
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

  const description =
    vertical === 'AGENCY'
      ? 'Ask about the workspace information you can access. Available starting points are shown below.'
      : vertical === 'RESTAURANT'
        ? isModuleGranted('restaurant-core', entitlements.enabledModules)
          ? 'Ask about available workspace information or Restaurant and Catering reports. Report access is checked when you ask. Operational changes are unavailable here.'
          : 'Ask about available workspace information. Restaurant reports are not enabled for this workspace.'
        : isModuleGranted('pharmacy-reports', entitlements.enabledModules)
          ? 'Ask about available workspace information or pharmacy reports. Report access is checked when you ask. Patient and clinical actions are unavailable here.'
          : 'Ask about available workspace information. Pharmacy reports are not enabled for this workspace. Patient and clinical actions are unavailable here.';

  return {
    title:
      vertical === 'AGENCY'
        ? 'Your agency workspace'
        : vertical === 'RESTAURANT'
          ? 'Your restaurant workspace'
          : 'Your pharmacy workspace',
    description,
    suggestions,
    canChat: true,
  };
}
