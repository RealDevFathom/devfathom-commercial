import { create } from 'zustand';
import type {
  AskFathomAvailability,
  AskFathomUnavailableReason,
} from '@/lib/ai/ask-fathom-settings';

type AssistantState = {
  organizationId: string | null;
  askFathomEnabled: boolean | null;
  /** Server-reported reason the confirmed settings cannot answer, e.g. no AI provider configured. */
  unavailableReason: AskFathomUnavailableReason | null;
  settingsUpdatedAt: number;
  settingsFailed: boolean;
  open: boolean;
  hasOpened: boolean;
  panelEpoch: number;
  setOrganization: (organizationId: string | null) => void;
  confirmSettings: (settings: AskFathomAvailability, updatedAt: number) => void;
  markUnavailable: (organizationId: string, updatedAt: number) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export function isAssistantAvailable(
  state: Pick<AssistantState, 'organizationId' | 'askFathomEnabled' | 'unavailableReason'>,
  organizationId: string | null | undefined
) {
  return Boolean(
    organizationId &&
    state.organizationId === organizationId &&
    state.askFathomEnabled === true &&
    state.unavailableReason === null
  );
}

export function assistantAvailabilityMessage(
  state: Pick<
    AssistantState,
    'organizationId' | 'askFathomEnabled' | 'unavailableReason' | 'settingsFailed'
  >,
  organizationId: string | null | undefined
) {
  if (state.organizationId === organizationId && state.settingsFailed) {
    return 'Ask Fathom chat availability could not be confirmed. Reload to try again.';
  }
  const confirmed = Boolean(organizationId && state.organizationId === organizationId);
  if (confirmed && state.askFathomEnabled === false) {
    return 'Ask Fathom chat is off for this organization.';
  }
  if (confirmed && state.unavailableReason === 'AI_NOT_CONFIGURED') {
    return 'Ask Fathom is unavailable because no AI provider is configured for this environment.';
  }
  return 'Ask Fathom chat availability is being checked. Try again shortly.';
}

// Ephemeral presentation state only. The server authorizes every chat turn.
export const useAssistant = create<AssistantState>((set) => ({
  organizationId: null,
  askFathomEnabled: null,
  unavailableReason: null,
  settingsUpdatedAt: 0,
  settingsFailed: false,
  open: false,
  hasOpened: false,
  panelEpoch: 0,
  setOrganization: (organizationId) =>
    set((state) =>
      state.organizationId === organizationId
        ? state
        : {
            organizationId,
            askFathomEnabled: null,
            unavailableReason: null,
            settingsUpdatedAt: 0,
            settingsFailed: false,
            open: false,
            hasOpened: false,
            panelEpoch: state.panelEpoch + 1,
          }
    ),
  confirmSettings: (settings, updatedAt) =>
    set((state) => {
      if (
        settings.organizationId !== state.organizationId ||
        updatedAt <= state.settingsUpdatedAt
      ) {
        return state;
      }
      const unavailableReason = settings.available
        ? null
        : (settings.unavailableReason ?? 'AI_NOT_CONFIGURED');
      return {
        askFathomEnabled: settings.askFathomEnabled,
        unavailableReason,
        settingsFailed: false,
        settingsUpdatedAt: updatedAt,
        ...(unavailableReason !== null && {
          open: false,
          hasOpened: false,
          panelEpoch:
            state.panelEpoch + (isAssistantAvailable(state, state.organizationId) ? 1 : 0),
        }),
      };
    }),
  markUnavailable: (organizationId, updatedAt) =>
    set((state) =>
      state.organizationId !== organizationId || updatedAt < state.settingsUpdatedAt
        ? state
        : {
            askFathomEnabled: null,
            unavailableReason: null,
            settingsFailed: true,
            settingsUpdatedAt: updatedAt,
            open: false,
            hasOpened: false,
            panelEpoch:
              state.panelEpoch + (isAssistantAvailable(state, state.organizationId) ? 1 : 0),
          }
    ),
  setOpen: (open) =>
    set((state) => {
      const allowed = open && isAssistantAvailable(state, state.organizationId);
      return { open: allowed, hasOpened: state.hasOpened || allowed };
    }),
  toggle: () =>
    set((state) => {
      const open = !state.open && isAssistantAvailable(state, state.organizationId);
      return { open, hasOpened: state.hasOpened || open };
    }),
}));
