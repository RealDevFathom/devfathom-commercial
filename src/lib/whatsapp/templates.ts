import 'server-only';

import { generateText } from 'ai';
import { z } from 'zod';
import { can } from '@/lib/abac';
import type { Subject } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { routeAI } from '@/lib/ai/router';
import { getTierForFeature, type AITier } from '@/lib/ai/tiers';
import type { WhatsAppOptInPort } from '@/lib/ai/shared/wa-optin.types';

export const WHATSAPP_AI_LABEL = 'DevFathom AI';
export const WHATSAPP_TEMPLATE_VARIABLES = ['name', 'shop', 'offer'] as const;
export type WhatsAppTemplateKind = 'WIN_BACK' | 'REFILL' | 'OFFER';
export type WhatsAppTemplateState = 'DRAFT' | 'APPROVED';

export type WhatsAppTemplate = {
  id: string;
  organizationId: string;
  kind: WhatsAppTemplateKind;
  text: string;
  state: WhatsAppTemplateState;
  provider: string;
  model: string;
  tier: AITier;
  createdById: string;
  approvedById: string | null;
};

/** Persistence methods deliberately require orgId so adapters remain RLS-compatible. */
export interface WhatsAppTemplateStore {
  createDraft(
    input: Omit<WhatsAppTemplate, 'id' | 'state' | 'approvedById'>
  ): Promise<WhatsAppTemplate>;
  findById(organizationId: string, id: string): Promise<WhatsAppTemplate | null>;
  approve(organizationId: string, id: string, actorId: string): Promise<WhatsAppTemplate>;
}

export type WhatsAppTemplateAudit = {
  organizationId: string;
  actorId: string;
  action: 'AI_DRAFT' | 'APPROVE' | 'SEND';
  templateId: string;
  oldValue: unknown;
  newValue: unknown;
  ai: { provider: string; model: string; tier: AITier };
};

export interface WhatsAppTemplatePorts {
  store: WhatsAppTemplateStore;
  audit: (entry: WhatsAppTemplateAudit) => Promise<void>;
  /** Must read the named org's server-side configuration and secret presence. */
  hasConfiguredProviderSecret: (organizationId: string) => Promise<boolean>;
  register: (organizationId: string, template: WhatsAppTemplate) => Promise<void>;
  send: (input: {
    organizationId: string;
    phone: string;
    body: string;
    templateId: string;
  }) => Promise<void>;
  optIn: WhatsAppOptInPort;
}

export type WhatsAppTemplateContext = {
  organizationId: string;
  actor: Subject;
  db: AuthzDb;
};

const draftInput = z.object({ kind: z.enum(['WIN_BACK', 'REFILL', 'OFFER']) }).strict();
const valuesSchema = z
  .object({
    name: z.string().max(100),
    shop: z.string().min(1).max(100),
    offer: z.string().max(200),
  })
  .strict();
const VARIABLE = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

function assertTemplateText(raw: string): string {
  const text = z.string().trim().min(1).max(1000).parse(raw);
  for (const match of text.matchAll(VARIABLE)) {
    if (
      !WHATSAPP_TEMPLATE_VARIABLES.includes(
        match[1] as (typeof WHATSAPP_TEMPLATE_VARIABLES)[number]
      )
    )
      throw new Error('AI returned a non-whitelisted template variable.');
  }
  if (/{{|}}/.test(text.replace(VARIABLE, '')))
    throw new Error('AI returned malformed template variables.');
  return text;
}

async function authorize(context: WhatsAppTemplateContext): Promise<void> {
  if (
    !(await can(
      context.actor,
      'customers:manage',
      { type: 'WhatsAppTemplate', organizationId: context.organizationId },
      { db: context.db, source: 'SYSTEM' }
    ))
  )
    throw new Error('Forbidden');
}

export async function draftWhatsAppTemplate(
  context: WhatsAppTemplateContext,
  input: { kind: WhatsAppTemplateKind },
  ports: WhatsAppTemplatePorts
): Promise<WhatsAppTemplate> {
  await authorize(context);
  const choice = draftInput.parse(input);
  if (!(await ports.hasConfiguredProviderSecret(context.organizationId)))
    throw new Error('DevFathom AI is not configured for this organization.');

  const tier = getTierForFeature('whatsapp');
  if (tier !== 'standard') throw new Error('WhatsApp drafting requires the growth tier.');
  const generated = await routeAI({
    tier,
    feature: 'whatsapp',
    organizationId: context.organizationId,
    execute: async (selection) => {
      const result = await generateText({
        model: selection.model,
        providerOptions: selection.providerOptions,
        system:
          'Draft one concise WhatsApp marketing template. Use only {{name}}, {{shop}}, and {{offer}} variables. Never request or include personal, health, purchase, or other sensitive data. {{name}} means first name only. Include Reply STOP to opt out. The owner must approve this draft before registration or use. Return text only.',
        prompt: `Template type: ${choice.kind}.`,
        maxOutputTokens: 250,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15_000),
      });
      return {
        value: {
          text: assertTemplateText(result.text),
          provider: selection.provider,
          model: selection.modelId,
        },
        usage: result.usage,
      };
    },
  });
  const template = await ports.store.createDraft({
    organizationId: context.organizationId,
    kind: choice.kind,
    text: generated.text,
    provider: generated.provider,
    model: generated.model,
    tier,
    createdById: context.actor.id,
  });
  await ports.audit({
    organizationId: context.organizationId,
    actorId: context.actor.id,
    action: 'AI_DRAFT',
    templateId: template.id,
    oldValue: null,
    newValue: { state: template.state, kind: template.kind, text: template.text },
    ai: { provider: template.provider, model: template.model, tier: template.tier },
  });
  return template;
}

export async function approveWhatsAppTemplate(
  context: WhatsAppTemplateContext,
  id: string,
  ports: WhatsAppTemplatePorts
) {
  await authorize(context);
  const current = await ports.store.findById(context.organizationId, id);
  if (!current) throw new Error('Draft not found.');
  // Provider registration is an external side effect. Treat an approval retry as
  // a successful replay rather than registering and auditing the same template
  // twice (for example, after a client times out while receiving the response).
  if (current.state === 'APPROVED') return current;
  // Registration receives the owner's approved representation, never a draft.
  await ports.register(context.organizationId, {
    ...current,
    state: 'APPROVED',
    approvedById: context.actor.id,
  });
  const approved = await ports.store.approve(context.organizationId, id, context.actor.id);
  await ports.audit({
    organizationId: context.organizationId,
    actorId: context.actor.id,
    action: 'APPROVE',
    templateId: id,
    oldValue: { state: current.state },
    newValue: { state: approved.state, approvedById: context.actor.id },
    ai: { provider: current.provider, model: current.model, tier: current.tier },
  });
  return approved;
}

export async function sendWhatsAppTemplate(
  context: WhatsAppTemplateContext,
  input: {
    templateId: string;
    customerId: string;
    values: { name: string; shop: string; offer: string };
  },
  ports: WhatsAppTemplatePorts
): Promise<void> {
  await authorize(context);
  const values = valuesSchema.parse(input.values);
  const template = await ports.store.findById(context.organizationId, input.templateId);
  if (!template || template.state !== 'APPROVED') throw new Error('Approved template not found.');
  const recipient = await ports.optIn.findEligibleRecipient(
    context.organizationId,
    input.customerId
  );
  if (!recipient) throw new Error('Recipient is not opted in.');
  const firstName = recipient.firstName.trim().split(/\s+/)[0] ?? '';
  if (values.name.trim() !== firstName)
    throw new Error('Only the recipient first name may be used.');
  const rendered = template.text.replace(VARIABLE, (_, key: keyof typeof values) => values[key]);
  await ports.send({
    organizationId: context.organizationId,
    phone: recipient.phone,
    body: rendered,
    templateId: template.id,
  });
  await ports.audit({
    organizationId: context.organizationId,
    actorId: context.actor.id,
    action: 'SEND',
    templateId: template.id,
    oldValue: { state: template.state },
    newValue: { state: template.state, customerId: input.customerId },
    ai: { provider: template.provider, model: template.model, tier: template.tier },
  });
}
