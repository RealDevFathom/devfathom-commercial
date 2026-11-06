import { beforeEach, describe, expect, it } from 'vitest';
import {
  assistantAvailabilityMessage,
  isAssistantAvailable,
  useAssistant,
} from './assistant-store';

const settings = (askFathomEnabled: boolean, organizationId = 'org-a') => ({
  organizationId,
  askFathomEnabled,
  available: askFathomEnabled,
  unavailableReason: askFathomEnabled ? null : ('COMPANY_DISABLED' as const),
});
const unconfigured = (organizationId = 'org-a') => ({
  organizationId,
  askFathomEnabled: true,
  available: false,
  unavailableReason: 'AI_NOT_CONFIGURED' as const,
});

beforeEach(() => useAssistant.setState(useAssistant.getInitialState()));

describe('organization-bound Ask Fathom presentation state', () => {
  it('fails closed for unknown availability through both programmatic entry points', () => {
    useAssistant.getState().setOrganization('org-a');
    useAssistant.getState().setOpen(true);
    expect(useAssistant.getState().open).toBe(false);
    useAssistant.getState().toggle();
    expect(useAssistant.getState().hasOpened).toBe(false);
  });

  it('opens only for confirmed matching organization and retains history on ordinary close', () => {
    useAssistant.getState().setOrganization('org-a');
    useAssistant.getState().confirmSettings(settings(true, 'org-b'), 1);
    expect(isAssistantAvailable(useAssistant.getState(), 'org-a')).toBe(false);
    useAssistant.getState().confirmSettings(settings(true), 2);
    expect(isAssistantAvailable(useAssistant.getState(), 'org-b')).toBe(false);
    useAssistant.getState().toggle();
    expect(useAssistant.getState()).toMatchObject({ open: true, hasOpened: true });
    useAssistant.getState().setOpen(false);
    expect(useAssistant.getState()).toMatchObject({ open: false, hasOpened: true });
  });

  it('closes and clears mount history on disable, rejects an older response, then re-enables fresh', () => {
    const store = useAssistant.getState();
    store.setOrganization('org-a');
    store.confirmSettings(settings(true), 10);
    store.setOpen(true);
    const epoch = useAssistant.getState().panelEpoch;
    store.confirmSettings(settings(false), 20);
    store.confirmSettings(settings(true), 10);
    store.confirmSettings(settings(true), 20);
    store.setOpen(true);
    store.toggle();
    expect(useAssistant.getState()).toMatchObject({
      open: false,
      hasOpened: false,
      askFathomEnabled: false,
    });
    expect(useAssistant.getState().panelEpoch).toBeGreaterThan(epoch);
    store.confirmSettings(settings(true), 30);
    expect(useAssistant.getState()).toMatchObject({ open: false, hasOpened: false });
    store.toggle();
    expect(useAssistant.getState().open).toBe(true);
  });

  it('clears prior organization state and ignores late responses after changing organization', () => {
    const store = useAssistant.getState();
    store.setOrganization('org-a');
    store.confirmSettings(settings(true), 10);
    store.setOpen(true);
    store.setOrganization('org-b');
    store.confirmSettings(settings(true), 30);
    store.toggle();
    expect(useAssistant.getState()).toMatchObject({
      organizationId: 'org-b',
      open: false,
      hasOpened: false,
      askFathomEnabled: null,
    });
    store.setOrganization(null);
    store.confirmSettings(settings(true, 'org-b'), 40);
    store.setOpen(true);
    expect(useAssistant.getState().open).toBe(false);
  });

  it('fails closed after a query error without allowing older success to reopen chat', () => {
    const store = useAssistant.getState();
    store.setOrganization('org-a');
    store.confirmSettings(settings(true), 10);
    store.setOpen(true);
    store.markUnavailable('org-b', 50);
    expect(useAssistant.getState().open).toBe(true);
    store.markUnavailable('org-a', 20);
    store.confirmSettings(settings(true), 10);
    expect(useAssistant.getState()).toMatchObject({
      open: false,
      hasOpened: false,
      askFathomEnabled: null,
    });
  });

  it('stays closed with an explanation while the company switch is on but no AI provider is configured', () => {
    const store = useAssistant.getState();
    store.setOrganization('org-a');
    store.confirmSettings(settings(true), 10);
    store.setOpen(true);
    const epoch = useAssistant.getState().panelEpoch;
    store.confirmSettings(unconfigured(), 20);
    expect(useAssistant.getState()).toMatchObject({
      open: false,
      hasOpened: false,
      askFathomEnabled: true,
      unavailableReason: 'AI_NOT_CONFIGURED',
    });
    expect(useAssistant.getState().panelEpoch).toBeGreaterThan(epoch);
    expect(isAssistantAvailable(useAssistant.getState(), 'org-a')).toBe(false);
    store.toggle();
    store.setOpen(true);
    expect(useAssistant.getState().open).toBe(false);
    expect(assistantAvailabilityMessage(useAssistant.getState(), 'org-a')).toBe(
      "Ask Fathom isn't set up yet, contact support."
    );
    // The company switch explanation wins when both apply.
    store.confirmSettings(settings(false), 30);
    expect(assistantAvailabilityMessage(useAssistant.getState(), 'org-a')).toBe(
      'Ask Fathom chat is off for this organization.'
    );
    store.confirmSettings(settings(true), 40);
    store.setOpen(true);
    expect(useAssistant.getState().open).toBe(true);
  });
});
