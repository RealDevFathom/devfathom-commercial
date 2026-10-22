import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStopKeyword,
  WhatsAppConsentService,
  type WhatsAppAudit,
  type WhatsAppConsentEvent,
  type WhatsAppConsentStore,
} from './consent';

function fixture() {
  const consents: WhatsAppConsentEvent[] = [];
  const audits: WhatsAppAudit[] = [];
  const enabled = new Map<string, boolean>();
  const store: WhatsAppConsentStore = {
    latestConsent: vi.fn(async (org, customer) =>
      consents.filter((row) => row.organizationId === org && row.customerId === customer).at(-1) ?? null),
    appendConsent: vi.fn(async (event) => { consents.push(event); }),
    settings: vi.fn(async (org) => enabled.has(org) ? { organizationId: org, ownerEnabled: enabled.get(org)! } : null),
    setOwnerEnabled: vi.fn(async (org, value) => { enabled.set(org, value); }),
    appendAudit: vi.fn(async (entry) => { audits.push(entry); }),
  };
  const adapter = {
    isProviderConfigured: vi.fn(async () => true),
    send: vi.fn(async () => ({ providerMessageId: 'wamid-1' })),
  };
  const permission = vi.fn(async () => true);
  const now = new Date('2026-10-22T10:00:00.000Z');
  const service = new WhatsAppConsentService(store, adapter, permission, () => now);
  return { service, store, adapter, permission, consents, audits, enabled, now };
}

beforeEach(() => vi.restoreAllMocks());

describe('WhatsAppConsentService', () => {
  it('records tenant-scoped consent provenance and exposes latest opt-in', async () => {
    const f = fixture();
    await f.service.recordConsent({ organizationId: 'org-a', customerId: 'customer-a', optedIn: true, source: 'CUSTOMER', actor: { id: 'customer-a', type: 'CUSTOMER' } });
    expect(await f.service.isOptedIn('org-a', 'customer-a')).toBe(true);
    expect(await f.service.isOptedIn('org-b', 'customer-a')).toBe(false);
    expect(f.consents[0]).toMatchObject({ occurredAt: f.now, source: 'CUSTOMER', optedIn: true });
    expect(f.audits[0]).toMatchObject({ organizationId: 'org-a', action: 'OPT_IN', oldValue: false, newValue: true });
  });

  it.each(['STOP', ' stop all ', 'Unsubscribe', 'OPT   OUT'])('opts out immediately for webhook keyword %j', async (text) => {
    const f = fixture();
    await f.service.recordConsent({ organizationId: 'org-a', customerId: 'customer-a', optedIn: true, source: 'OWNER', actor: { id: 'owner', type: 'USER' } });
    expect(isStopKeyword(text)).toBe(true);
    expect(await f.service.handleWebhookText({ organizationId: 'org-a', customerId: 'customer-a', text })).toBe('OPTED_OUT');
    expect(await f.service.isOptedIn('org-a', 'customer-a')).toBe(false);
    expect(f.consents.at(-1)).toMatchObject({ source: 'WEBHOOK', actor: { id: 'customer-a', type: 'CUSTOMER' } });
  });

  it('requires central permission and provider configuration before owner enable', async () => {
    const denied = fixture();
    denied.permission.mockResolvedValue(false);
    await expect(denied.service.setOwnerEnabled({ organizationId: 'org-a', actor: { id: 'owner', role: 'OWNER' }, enabled: true })).rejects.toThrow('FORBIDDEN');
    expect(denied.store.setOwnerEnabled).not.toHaveBeenCalled();

    const missing = fixture();
    missing.adapter.isProviderConfigured.mockResolvedValue(false);
    await expect(missing.service.setOwnerEnabled({ organizationId: 'org-a', actor: { id: 'owner', role: 'OWNER' }, enabled: true })).rejects.toThrow('AI_PROVIDER_NOT_CONFIGURED');
    expect(missing.store.setOwnerEnabled).not.toHaveBeenCalled();
  });

  it('is off by default and audits the authorized owner toggle', async () => {
    const f = fixture();
    expect(await f.service.aiEnabled('org-a')).toBe(false);
    await f.service.setOwnerEnabled({ organizationId: 'org-a', actor: { id: 'owner', role: 'OWNER' }, enabled: true });
    expect(f.permission).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner' }), 'customers:manage');
    expect(await f.service.aiEnabled('org-a')).toBe(true);
    expect(f.audits[0]).toMatchObject({ action: 'OWNER_TOGGLE', oldValue: false, newValue: true, actor: { id: 'owner' } });
  });

  it('checks consent on every send and audits model plus standard WhatsApp tier', async () => {
    const f = fixture();
    f.enabled.set('org-a', true);
    const message = { organizationId: 'org-a', customerId: 'customer-a', to: '15551234567', body: 'Hello', actor: { id: 'owner', type: 'USER' as const }, trace: { model: 'model-1' } };
    await expect(f.service.send(message)).rejects.toThrow('WHATSAPP_NOT_OPTED_IN');
    expect(f.adapter.send).not.toHaveBeenCalled();
    await f.service.recordConsent({ organizationId: 'org-a', customerId: 'customer-a', optedIn: true, source: 'CUSTOMER', actor: { id: 'customer-a', type: 'CUSTOMER' } });
    await expect(f.service.send(message)).resolves.toEqual({ providerMessageId: 'wamid-1' });
    expect(f.audits.at(-1)).toMatchObject({ action: 'AI_SEND', model: 'model-1', tier: 'standard', organizationId: 'org-a' });
  });
});
