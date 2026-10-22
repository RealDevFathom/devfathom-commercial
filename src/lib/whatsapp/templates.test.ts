import { beforeEach, describe, expect, it, vi } from 'vitest';
import happyPath from '../../../tests/fixtures/ai/wa-templates/happy-path.json';
import rejectedSensitiveVariable from '../../../tests/fixtures/ai/wa-templates/rejected-sensitive-variable.json';
import safeVariables from '../../../tests/fixtures/ai/wa-templates/safe-variables.json';

const mocks = vi.hoisted(() => ({ can: vi.fn(), generateText: vi.fn(), routeAI: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.routeAI }));

import {
  approveWhatsAppTemplate,
  draftWhatsAppTemplate,
  sendWhatsAppTemplate,
  WHATSAPP_AI_LABEL,
  type WhatsAppTemplate,
  type WhatsAppTemplateAudit,
  type WhatsAppTemplateContext,
  type WhatsAppTemplatePorts,
} from './templates';

const context = {
  organizationId: 'org-1',
  actor: { id: 'owner-1', role: 'ADMIN', status: 'ACTIVE' },
  db: {} as WhatsAppTemplateContext['db'],
};

function fixture() {
  const rows: WhatsAppTemplate[] = [];
  const audits: WhatsAppTemplateAudit[] = [];
  const register = vi.fn();
  const send = vi.fn();
  const ports: WhatsAppTemplatePorts = {
    store: {
      async createDraft(input) {
        const row = {
          ...input,
          id: `t-${rows.length + 1}`,
          state: 'DRAFT',
          approvedById: null,
        } as const;
        rows.push(row);
        return row;
      },
      async findById(organizationId, id) {
        return rows.find((row) => row.organizationId === organizationId && row.id === id) ?? null;
      },
      async approve(organizationId, id, actorId) {
        const index = rows.findIndex(
          (row) => row.organizationId === organizationId && row.id === id
        );
        if (index < 0) throw new Error('missing');
        rows[index] = { ...rows[index], state: 'APPROVED', approvedById: actorId };
        return rows[index];
      },
    },
    audit: async (entry) => void audits.push(entry),
    hasConfiguredProviderSecret: vi.fn(async (organizationId) => organizationId === 'org-1'),
    register,
    send,
    optIn: {
      async findEligibleRecipient(organizationId, customerId) {
        return organizationId === 'org-1' && customerId === 'customer-1'
          ? { customerId, firstName: 'Ayesha Khan', phone: '+15550001111' }
          : null;
      },
    },
  };
  return { ports, rows, audits, register, send };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.generateText.mockResolvedValue({
    text: 'Hi {{name}}, visit {{shop}} for {{offer}}. Reply STOP to opt out.',
    usage: { inputTokens: 5, outputTokens: 10 },
  });
  mocks.routeAI.mockImplementation(async (options) =>
    options
      .execute({ provider: 'anthropic', modelId: 'claude-sonnet-4-6', model: {} })
      .then((result: { value: unknown }) => result.value)
  );
});

describe('AI-drafted WhatsApp templates', () => {
  it('uses the standard growth tier, remains unapproved, and audits model provenance', async () => {
    const { ports, audits, register, send } = fixture();
    const template = await draftWhatsAppTemplate(context, { kind: 'WIN_BACK' }, ports);

    expect(WHATSAPP_AI_LABEL).toBe('DevFathom AI');
    expect(template).toMatchObject({
      state: 'DRAFT',
      tier: 'standard',
      model: 'claude-sonnet-4-6',
    });
    expect(mocks.routeAI).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'standard', feature: 'whatsapp', organizationId: 'org-1' })
    );
    expect(register).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: 'owner-1',
        organizationId: 'org-1',
        action: 'AI_DRAFT',
        oldValue: null,
        ai: { provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'standard' },
      }),
    ]);
  });

  it('is off until the org-scoped provider secret is configured', async () => {
    const { ports } = fixture();
    vi.mocked(ports.hasConfiguredProviderSecret).mockResolvedValue(false);
    await expect(draftWhatsAppTemplate(context, { kind: 'REFILL' }, ports)).rejects.toThrow(
      'not configured'
    );
    expect(mocks.routeAI).not.toHaveBeenCalled();
  });

  it('rejects non-whitelisted AI variables', async () => {
    const { ports, rows } = fixture();
    mocks.generateText.mockResolvedValue({
      text: rejectedSensitiveVariable.modelOutput,
      usage: {},
    });
    await expect(draftWhatsAppTemplate(context, { kind: 'OFFER' }, ports)).rejects.toThrow(
      'non-whitelisted'
    );
    expect(rows).toHaveLength(0);
  });

  it('keeps the eval fixture variable allowlist synchronized with the product contract', () => {
    expect(safeVariables.allowedVariables).toEqual(['name', 'shop', 'offer']);
  });

  it('registers only on owner approval and records the state transition', async () => {
    const { ports, audits, register } = fixture();
    const draft = await draftWhatsAppTemplate(context, { kind: 'REFILL' }, ports);
    const approved = await approveWhatsAppTemplate(context, draft.id, ports);
    expect(register).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ id: draft.id, state: 'APPROVED', approvedById: 'owner-1' })
    );
    expect(approved).toMatchObject({ state: 'APPROVED', approvedById: 'owner-1' });
    expect(audits[1]).toMatchObject({
      action: 'APPROVE',
      oldValue: { state: 'DRAFT' },
      newValue: { state: 'APPROVED', approvedById: 'owner-1' },
    });
  });

  it('replays approval idempotently without duplicate registration or audit entries', async () => {
    const { ports, audits, register } = fixture();
    const draft = await draftWhatsAppTemplate(context, { kind: 'REFILL' }, ports);

    const first = await approveWhatsAppTemplate(context, draft.id, ports);
    const replay = await approveWhatsAppTemplate(context, draft.id, ports);

    expect(replay).toEqual(first);
    expect(register).toHaveBeenCalledTimes(1);
    expect(audits.filter((entry) => entry.action === 'APPROVE')).toHaveLength(1);
  });

  it('sends only approved templates to opted-in recipients using first name only', async () => {
    const { ports, audits, send } = fixture();
    mocks.generateText.mockResolvedValue({ text: happyPath.modelOutput, usage: {} });
    const draft = await draftWhatsAppTemplate(context, { kind: 'OFFER' }, ports);
    await expect(
      sendWhatsAppTemplate(
        context,
        {
          templateId: draft.id,
          customerId: 'customer-1',
          values: happyPath.values,
        },
        ports
      )
    ).rejects.toThrow('Approved');
    await approveWhatsAppTemplate(context, draft.id, ports);
    await sendWhatsAppTemplate(
      context,
      {
        templateId: draft.id,
        customerId: 'customer-1',
        values: happyPath.values,
      },
      ports
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        phone: '+15550001111',
        body: happyPath.expectedRendered,
      })
    );
    expect(audits.at(-1)).toMatchObject({
      action: 'SEND',
      actorId: 'owner-1',
      newValue: { state: 'APPROVED', customerId: 'customer-1' },
    });
    await expect(
      sendWhatsAppTemplate(
        context,
        {
          templateId: draft.id,
          customerId: 'customer-1',
          values: { name: 'Ayesha Khan', shop: 'Corner Shop', offer: '10% off' },
        },
        ports
      )
    ).rejects.toThrow('first name');
  });

  it('uses central can(), honors denial, and cannot read another tenant template', async () => {
    const { ports, rows } = fixture();
    mocks.can.mockResolvedValue(false);
    await expect(draftWhatsAppTemplate(context, { kind: 'WIN_BACK' }, ports)).rejects.toThrow(
      'Forbidden'
    );
    expect(mocks.can).toHaveBeenCalledWith(
      context.actor,
      'customers:manage',
      expect.objectContaining({ organizationId: 'org-1' }),
      expect.objectContaining({ db: context.db })
    );
    mocks.can.mockResolvedValue(true);
    rows.push({
      id: 'foreign',
      organizationId: 'org-2',
      kind: 'OFFER',
      text: 'Hi',
      state: 'DRAFT',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tier: 'standard',
      createdById: 'x',
      approvedById: null,
    });
    await expect(approveWhatsAppTemplate(context, 'foreign', ports)).rejects.toThrow('not found');
    expect(register).not.toHaveBeenCalled();
  });

  it('uses the context organization for the provider-secret check', async () => {
    const { ports } = fixture();
    const foreignContext = { ...context, organizationId: 'org-2' };

    await expect(
      draftWhatsAppTemplate(foreignContext, { kind: 'OFFER' }, ports)
    ).rejects.toThrow('not configured');
    expect(ports.hasConfiguredProviderSecret).toHaveBeenCalledWith('org-2');
    expect(mocks.routeAI).not.toHaveBeenCalled();
  });
});
