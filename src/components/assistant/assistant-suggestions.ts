import type { Session } from 'next-auth';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted, type EntitlementView } from '@/lib/module-catalog';

export type AssistantEntry = {
  title: string;
  description: string;
  /** Tappable example questions, at most five. */
  suggestions: string[];
  canChat: boolean;
  /** True only when the signed-in role, not the workspace's modules, narrows the examples. */
  limitedByRole: boolean;
};

/** Answerable for every role: the server lists the tools it exposes for the request. */
export const ASK_WHAT_IS_POSSIBLE = 'What can you help me with?';

// Data examples name only tools composed in lib/ai/tools.ts under the same
// vertical and module gates (notes and meetings tools are Agency-only there).
// The client session carries the tenant role but no resolved ABAC grants, so
// report questions are offered to the administrator (owner) role alone and the
// server still re-checks every grant when they are asked. Front-line roles get
// how-to questions for the modules they work in, which need no workspace data.
function agencyExamples(modules: readonly string[]) {
  const granted = (...keys: string[]) => keys.every((key) => isModuleGranted(key, modules));
  return [
    granted('projects') && 'Show my open tasks',
    granted('projects') && 'Which projects are behind schedule?',
    granted('notes', 'projects', 'clients') && 'Find notes I can access',
    granted('meetings', 'projects') && 'What meetings are on my schedule?',
  ];
}

function restaurantExamples(modules: readonly string[], owner: boolean) {
  const reports = owner && isModuleGranted('restaurant-core', modules);
  const pos = isModuleGranted('restaurant-pos', modules);
  return [
    reports && "What were today's settled sales?",
    reports && 'How much was refunded today?',
    !owner && pos && 'How do I take an order on the POS?',
    !owner && pos && 'How do I split a bill at checkout?',
  ];
}

function pharmacyExamples(modules: readonly string[], owner: boolean) {
  const reports = owner && isModuleGranted('pharmacy-reports', modules);
  const counter = isModuleGranted('pharmacy-counter', modules);
  return [
    reports && "What were today's sales?",
    reports && 'Which stock is expiring soon?',
    reports && 'Which medicines are running low and need reordering?',
    !owner && counter && 'How do I check whether a medicine is in stock?',
    counter && 'How do I process a customer return?',
    owner && counter && !reports && 'How do I close the day at the counter?',
  ];
}

function examples(candidates: (string | false)[]) {
  const specific = candidates.filter((text): text is string => Boolean(text));
  return [...specific.slice(0, 4), ASK_WHAT_IS_POSSIBLE];
}

export function assistantEntry(
  entitlements: EntitlementView,
  user: Session['user'] | undefined,
  sessionStatus: 'loading' | 'authenticated' | 'unauthenticated'
): AssistantEntry {
  const neutral = { title: 'Ask Fathom', suggestions: [], canChat: false, limitedByRole: false };
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
  const modules = entitlements.enabledModules;
  const owner = user.role === 'ADMIN';

  if (vertical === 'AGENCY') {
    return {
      title: 'Your agency workspace',
      description: 'Ask about your workspace, or start with one of the examples below.',
      suggestions: examples(agencyExamples(modules)),
      canChat: true,
      limitedByRole: false,
    };
  }
  if (vertical === 'RESTAURANT') {
    const core = isModuleGranted('restaurant-core', modules);
    return {
      title: 'Your restaurant workspace',
      description: !core
        ? 'Ask how to use your workspace. Restaurant reports are not enabled for this workspace.'
        : owner
          ? 'Ask about Restaurant and Catering reports, such as settled sales and refunds. Operational changes are unavailable here.'
          : 'Ask how to use your workspace, such as taking an order or splitting a bill. Operational changes are unavailable here.',
      suggestions: examples(restaurantExamples(modules, owner)),
      canChat: true,
      limitedByRole: core && !owner,
    };
  }
  if (vertical === 'PHARMACY') {
    const reports = isModuleGranted('pharmacy-reports', modules);
    const counter = isModuleGranted('pharmacy-counter', modules);
    const focus = owner
      ? reports
        ? "Ask about today's sales, expiring or low stock, and other pharmacy reports."
        : 'Ask how to use your pharmacy workspace. Pharmacy reports are not enabled for this workspace.'
      : counter
        ? 'Ask how to handle counter tasks, such as checking stock or processing a return.'
        : 'Ask how to use your pharmacy workspace.';
    return {
      title: 'Your pharmacy workspace',
      description: `${focus} Patient and clinical actions are unavailable here.`,
      suggestions: examples(pharmacyExamples(modules, owner)),
      canChat: true,
      limitedByRole: reports && !owner,
    };
  }
  return { ...neutral, description: 'Workspace context is unavailable. Reload to try again.' };
}
