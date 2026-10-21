import { create } from 'zustand';

type AskFathomSettings = {
  organizationId: string;
  askFathomEnabled: boolean;
};

type AssistantState = {
  organizationId: string | null;
  askFathomEnabled: boolean | null;
  settingsUpdatedAt: number;
  settingsFailed: boolean;
  open: boolean;
  hasOpened: boolean;
  panelEpoch: number;
  setOrganization: (organizationId: string | null) => void;
  confirmSettings: (settings: AskFathomSettings, updatedAt: number) => void;
  markUnavailable: (organizationId: string, updatedAt: number) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export function isAssistantAvailable(
  state: Pick<AssistantState, 'organizationId' | 'askFathomEnabled'>,
  organizationId: string | null | undefined
) {
  return Boolean(
    organizationId && state.organizationId === organizationId && state.askFathomEnabled === true
  );
}

export function assistantAvailabilityMessage(
  state: Pick<AssistantState, 'organizationId' | 'askFathomEnabled' | 'settingsFailed'>,
  organizationId: string | null | undefined
) {
  if (state.organizationId === organizationId && state.settingsFailed) {
    return 'Ask Fathom chat availability could not be confirmed. Reload to try again.';
  }
  return organizationId &&
    state.organizationId === organizationId &&
    state.askFathomEnabled === false
    ? 'Ask Fathom chat is off for this organization.'
    : 'Ask Fathom chat availability is being checked. Try again shortly.';
}

// Ephemeral presentation state only. The server authorizes every chat turn.
export const useAssistant = create<AssistantState>((set) => ({
  organizationId: null,
  askFathomEnabled: null,
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
      return {
        askFathomEnabled: settings.askFathomEnabled,
        settingsFailed: false,
        settingsUpdatedAt: updatedAt,
        ...(!settings.askFathomEnabled && {
          open: false,
          hasOpened: false,
          panelEpoch: state.panelEpoch + (state.askFathomEnabled === true ? 1 : 0),
        }),
      };
    }),
  markUnavailable: (organizationId, updatedAt) =>
    set((state) =>
      state.organizationId !== organizationId || updatedAt < state.settingsUpdatedAt
        ? state
        : {
            askFathomEnabled: null,
            settingsFailed: true,
            settingsUpdatedAt: updatedAt,
            open: false,
            hasOpened: false,
            panelEpoch: state.panelEpoch + (state.askFathomEnabled === true ? 1 : 0),
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
