import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WHATSAPP_AI_LABEL,
  isOptedIn,
  isStopKeyword,
  WhatsAppConsentService,
  type WhatsAppAudit,
  type WhatsAppConsentEvent,
  type WhatsAppConsentStore,
} from './consent';

type EvalFixture = {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
};

function evalFixtures(name: string): EvalFixture[] {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `tests/fixtures/ai/wa-optin/${name}.json`), 'utf8')
  ) as EvalFixture[];
}

function fixture() {
  const consents: WhatsAppConsentEvent[] = [];
  const audits: WhatsAppAudit[] = [];
  const enabled = new Map<string, boolean>();
  const store: WhatsAppConsentStore = {
    latestConsent: vi.fn(
      async (organizationId, customerId) =>
        consents
          .filter(
            (row) =>
              row.organizationId === organizationId && row.customerId === customerId
          )
          .at(-1) ?? null
    ),
    appendConsent: vi.fn(async (event) => {
      consents.push(event);
    }),
    settings: vi.fn(async (organizationId) =>
      enabled.has(organizationId)
        ? { organizationId, ownerEnabled: enabled.get(organizationId)! }
        : null
    ),
    setOwnerEnabled: vi.fn(async (organizationId, value) => {
      enabled.set(organizationId, value);
    }),
    appendAudit: vi.fn(async (entry) => {
      audits.push(entry);
    }),
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

const owner = { id: 'owner-a', role: 'OWNER' };
const customerActor = { id: 'customer-1', type: 'CUSTOMER' as const };
const outbound = {
  organizationId: 'org-a',
  customerId: 'customer-1',
  to: '923001234567',
  body: 'Your prescription is ready.',
  actor: { id: 'pharmacist-1', type: 'USER' as const },
  trace: { model: 'pharmacy-model-1' },
};

beforeEach(() => vi.restoreAllMocks());

describe('WhatsApp consent happy path', () => {
  it('uses the required product label', () => {
    expect(WHATSAPP_AI_LABEL).toBe('DevFathom AI');
  });

  it('records opt-in, enables a configured org, sends, and audits every action', async () => {
    const f = fixture();

    await f.service.recordOwnerConsent({
      organizationId: 'org-a',
      customerId: 'customer-1',
      actor: owner,
      optedIn: true,
    });
    await f.service.setOwnerEnabled({ organizationId: 'org-a', actor: owner, enabled: true });
    await f.service.auditAI({
      organizationId: 'org-a',
      actor: { id: owner.id, type: 'USER' },
      action: 'AI_DRAFT',
      oldValue: null,
      newValue: { body: outbound.body },
      trace: outbound.trace,
    });
    await f.service.auditAI({
      organizationId: 'org-a',
      actor: { id: owner.id, type: 'USER' },
      action: 'AI_APPROVAL',
      oldValue: 'DRAFT',
      newValue: 'APPROVED',
      trace: outbound.trace,
    });

    await expect(f.service.send(outbound)).resolves.toEqual({ providerMessageId: 'wamid-1' });
    expect(f.permission).toHaveBeenCalledTimes(2);
    expect(f.permission).toHaveBeenNthCalledWith(1, owner, 'customers:manage');
    expect(f.permission).toHaveBeenNthCalledWith(2, owner, 'customers:manage');
    expect(f.adapter.isProviderConfigured).toHaveBeenCalledWith('org-a');
    expect(f.adapter.send).toHaveBeenCalledWith(expect.objectContaining(outbound));
    expect(f.audits.map(({ action }) => action)).toEqual([
      'OPT_IN',
      'OWNER_TOGGLE',
      'AI_DRAFT',
      'AI_APPROVAL',
      'AI_SEND',
    ]);
    expect(f.audits.at(-1)).toEqual({
      organizationId: 'org-a',
      actor: outbound.actor,
      action: 'AI_SEND',
      oldValue: null,
      newValue: { customerId: 'customer-1', providerMessageId: 'wamid-1' },
      occurredAt: f.now,
      model: 'pharmacy-model-1',
      tier: 'standard',
    });
  });
});

describe('tenant isolation', () => {
  it('never exposes org A consent to org B, even for the same customer id', async () => {
    const f = fixture();
    await f.service.recordConsent({
      organizationId: 'org-a',
      customerId: 'shared-customer',
      optedIn: true,
      source: 'CUSTOMER',
      actor: customerActor,
    });

    await expect(f.service.isOptedIn('org-a', 'shared-customer')).resolves.toBe(true);
    await expect(f.service.isOptedIn('org-b', 'shared-customer')).resolves.toBe(false);
    expect(f.store.latestConsent).toHaveBeenLastCalledWith('org-b', 'shared-customer');
  });

  it('fails closed when a broken store returns another tenant consent or settings row', async () => {
    const f = fixture();
    f.store.latestConsent = vi.fn(async () => ({
      organizationId: 'org-b',
      customerId: 'customer-1',
      optedIn: true,
      occurredAt: f.now,
      source: 'IMPORT',
      actor: customerActor,
    }));
    f.store.settings = vi.fn(async () => ({ organizationId: 'org-b', ownerEnabled: true }));

    await expect(isOptedIn(f.store, 'org-a', 'customer-1')).resolves.toBe(false);
    await expect(f.service.aiEnabled('org-a')).resolves.toBe(false);
    await expect(f.service.send(outbound)).rejects.toThrow('WHATSAPP_NOT_OPTED_IN');
    expect(f.adapter.send).not.toHaveBeenCalled();
  });

  it('keeps org enablement independent and passes org_id to every settings operation', async () => {
    const f = fixture();
    await f.service.setOwnerEnabled({ organizationId: 'org-a', actor: owner, enabled: true });

    await expect(f.service.aiEnabled('org-a')).resolves.toBe(true);
    await expect(f.service.aiEnabled('org-b')).resolves.toBe(false);
    expect(f.store.setOwnerEnabled).toHaveBeenCalledWith('org-a', true);
    expect(f.store.settings).toHaveBeenCalledWith('org-b');
    expect(f.adapter.isProviderConfigured).not.toHaveBeenCalledWith('org-b');
  });
});

describe('permission and configuration gates', () => {
  it('honors a central DENY over an apparent role ALLOW without writing state or audit', async () => {
    const f = fixture();
    f.permission.mockResolvedValue(false);

    await expect(
      f.service.recordOwnerConsent({
        organizationId: 'org-a',
        customerId: 'customer-1',
        actor: owner,
        optedIn: true,
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      f.service.setOwnerEnabled({ organizationId: 'org-a', actor: owner, enabled: true })
    ).rejects.toThrow('FORBIDDEN');

    expect(f.permission).toHaveBeenCalledWith(owner, 'customers:manage');
    expect(f.store.appendConsent).not.toHaveBeenCalled();
    expect(f.store.setOwnerEnabled).not.toHaveBeenCalled();
    expect(f.store.appendAudit).not.toHaveBeenCalled();
  });

  it('is AI-off by default for every org and does not consult the provider', async () => {
    const f = fixture();
    await expect(f.service.aiEnabled('org-a')).resolves.toBe(false);
    await expect(f.service.aiEnabled('org-b')).resolves.toBe(false);
    expect(f.adapter.isProviderConfigured).not.toHaveBeenCalled();
  });

  it('cannot be enabled until the server-side provider secret is configured', async () => {
    const f = fixture();
    f.adapter.isProviderConfigured.mockResolvedValue(false);

    await expect(
      f.service.setOwnerEnabled({ organizationId: 'org-a', actor: owner, enabled: true })
    ).rejects.toThrow('AI_PROVIDER_NOT_CONFIGURED');
    expect(f.adapter.isProviderConfigured).toHaveBeenCalledWith('org-a');
    expect(f.store.setOwnerEnabled).not.toHaveBeenCalled();
    expect(f.store.appendAudit).not.toHaveBeenCalled();
  });

  it('rechecks server provider configuration on every enabled read and send', async () => {
    const f = fixture();
    f.enabled.set('org-a', true);
    await f.service.recordConsent({
      organizationId: 'org-a',
      customerId: 'customer-1',
      optedIn: true,
      source: 'CUSTOMER',
      actor: customerActor,
    });
    f.adapter.isProviderConfigured.mockResolvedValue(false);

    await expect(f.service.aiEnabled('org-a')).resolves.toBe(false);
    await expect(f.service.send(outbound)).rejects.toThrow('WHATSAPP_AI_DISABLED');
    expect(f.adapter.send).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(1);
  });
});

describe('idempotency, opt-out, and audit records', () => {
  it('does not append duplicate consent or duplicate audit entries for retries', async () => {
    const f = fixture();
    const input = {
      organizationId: 'org-a',
      customerId: 'customer-1',
      optedIn: true,
      source: 'CUSTOMER' as const,
      actor: customerActor,
    };

    await f.service.recordConsent(input);
    await f.service.recordConsent(input);

    expect(f.consents).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ action: 'OPT_IN', oldValue: false, newValue: true });
  });

  it('records a first explicit opt-out but deduplicates a retried STOP webhook', async () => {
    const f = fixture();

    await expect(
      f.service.handleWebhookText({
        organizationId: 'org-a',
        customerId: 'customer-1',
        text: 'STOP',
      })
    ).resolves.toBe('OPTED_OUT');
    await f.service.handleWebhookText({
      organizationId: 'org-a',
      customerId: 'customer-1',
      text: ' stop ',
    });

    expect(f.consents).toHaveLength(1);
    expect(f.consents[0]).toMatchObject({ optedIn: false, source: 'WEBHOOK' });
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ action: 'OPT_OUT', oldValue: false, newValue: false });
  });

  it('DENY opt-out takes effect immediately and prevents a later send', async () => {
    const f = fixture();
    f.enabled.set('org-a', true);
    await f.service.recordConsent({
      organizationId: 'org-a',
      customerId: 'customer-1',
      optedIn: true,
      source: 'CUSTOMER',
      actor: customerActor,
    });
    await f.service.handleWebhookText({
      organizationId: 'org-a',
      customerId: 'customer-1',
      text: 'UNSUBSCRIBE',
    });

    await expect(f.service.send(outbound)).rejects.toThrow('WHATSAPP_NOT_OPTED_IN');
    expect(f.adapter.send).not.toHaveBeenCalled();
    expect(f.audits.map(({ action }) => action)).toEqual(['OPT_IN', 'OPT_OUT']);
  });

  it('audits AI actions with the supplied tier and immutable timestamp', async () => {
    const f = fixture();
    await f.service.auditAI({
      organizationId: 'org-a',
      actor: { id: 'pharmacist-1', type: 'USER' },
      action: 'AI_ACTION',
      oldValue: { status: 'PENDING' },
      newValue: { status: 'REVIEWED' },
      trace: { model: 'safety-model', tier: 'deep' },
    });

    expect(f.audits[0]).toEqual({
      organizationId: 'org-a',
      actor: { id: 'pharmacist-1', type: 'USER' },
      action: 'AI_ACTION',
      oldValue: { status: 'PENDING' },
      newValue: { status: 'REVIEWED' },
      occurredAt: f.now,
      model: 'safety-model',
      tier: 'deep',
    });
  });
});

describe('pharmacy WhatsApp opt-in eval fixtures', () => {
  it.each(evalFixtures('keyword-decisions'))('$name', ({ input, expected }) => {
    expect({ stopKeyword: isStopKeyword(String(input.text)) }).toEqual(expected);
  });

  it.each(evalFixtures('enablement-decisions'))('$name', async ({ input, expected }) => {
    const f = fixture();
    if (input.ownerEnabled === true) f.enabled.set(String(input.organizationId), true);
    f.adapter.isProviderConfigured.mockResolvedValue(input.providerConfigured === true);

    await expect(f.service.aiEnabled(String(input.organizationId))).resolves.toBe(
      expected.aiEnabled
    );
  });
});
