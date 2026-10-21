import type { GrowthWhatsAppStore, MessageTemplateRow } from '@/lib/growth/whatsapp/types';

export const TEMPLATE_KEYS = [
  'birthday_offer',
  'refill_reminder',
  'winback',
  'slow_day',
  'holiday',
  'review_request',
  'referral',
  'generic',
  'order_ready',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_VARIABLES = [
  'name',
  'business',
  'discount',
  'code',
  'expires',
  'product',
  'reviewUrl',
  'referralCode',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const DEFAULT_TEMPLATE_LANGUAGE = 'ur-en';

/** Pickup-ready notice for a pharmacy or a restaurant. Both bodies name STOP. */
export const ORDER_READY_BODIES = {
  en: '{{name}}, your order from {{business}} is ready for pickup. Reply STOP to opt out.',
  ur: '{{name}}، {{business}} سے آپ کا آرڈر لینے کے لیے تیار ہے۔ Reply STOP to opt out.',
} as const;

export type OrderReadyLanguage = keyof typeof ORDER_READY_BODIES;

/** Seed bodies. Every one names STOP so the renderer can send it. */
export const DEFAULT_TEMPLATES: Record<Exclude<TemplateKey, 'order_ready'>, string> = {
  birthday_offer:
    'Salaam {{name}}! {{discount}} off at {{business}} till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  refill_reminder:
    'Salaam {{name}}! Your {{product}} from {{business}} is due soon. Reply STOP to opt out.',
  winback:
    'Salaam {{name}}! We miss you at {{business}}. {{discount}} off till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  slow_day:
    'Salaam {{name}}! Today at {{business}}: {{discount}} off till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  holiday:
    'Salaam {{name}}! Holiday offer at {{business}}: {{discount}} off till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  review_request:
    'Salaam {{name}}! Please review {{business}}: {{reviewUrl}}. Reply STOP to opt out.',
  referral: 'Salaam {{name}}! Share code {{referralCode}} at {{business}}. Reply STOP to opt out.',
  generic: 'Salaam {{name}}! A note from {{business}}. Reply STOP to opt out.',
};

const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export class MissingStop extends Error {
  constructor() {
    super('Outbound WhatsApp body must include STOP.');
    this.name = 'MissingStop';
  }
}

export class MissingTemplateVariable extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing template variable ${variable}.`);
    this.name = 'MissingTemplateVariable';
    this.variable = variable;
  }
}

export type TemplatePurpose = 'marketing' | 'utility';

/** `refill_reminder` and `order_ready` are utility templates. The rest are marketing. */
export const TEMPLATE_PURPOSE: Record<TemplateKey, TemplatePurpose> = {
  birthday_offer: 'marketing',
  refill_reminder: 'utility',
  winback: 'marketing',
  slow_day: 'marketing',
  holiday: 'marketing',
  review_request: 'marketing',
  referral: 'marketing',
  generic: 'marketing',
  order_ready: 'utility',
};

/**
 * Drug categories a promotional campaign must not include. Pharmaceutical and
 * biological families are medicines; front-shop, device, and alternative are not.
 */
const DRUG_PRODUCT_CATEGORIES = new Set([
  'pharmaceutical',
  'biological',
  'drug',
  'medicine',
  'prescription',
  'rx',
  'controlled',
]);

export class DrugCategoryInPromo extends Error {
  readonly categories: readonly string[];

  constructor(categories: readonly string[]) {
    super('Promotional campaigns can only include non-drug product categories.');
    this.name = 'DrugCategoryInPromo';
    this.categories = categories;
  }
}

export function isDrugProductCategory(category: string): boolean {
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return DRUG_PRODUCT_CATEGORIES.has(normalized);
}

export function assertPromoProductCategories(categories: readonly string[]): void {
  const blocked = categories.filter(isDrugProductCategory);
  if (blocked.length > 0) throw new DrugCategoryInPromo(blocked);
}

/**
 * Marketing sends refuse a drug product category. A utility template such as
 * `refill_reminder` may name the medicine being refilled.
 */
export function assertCampaignProducts(input: {
  templateKey: string;
  productCategories: readonly string[];
}): void {
  if (!isTemplateKey(input.templateKey)) throw new UnknownTemplateVariable(input.templateKey);
  if (TEMPLATE_PURPOSE[input.templateKey] === 'utility') return;
  assertPromoProductCategories(input.productCategories);
}

export class UnknownTemplateVariable extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Unknown template variable ${variable}.`);
    this.name = 'UnknownTemplateVariable';
    this.variable = variable;
  }
}

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

function isTemplateVariable(value: string): value is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

export function assertBodyHasStop(body: string): void {
  if (!body.includes('STOP')) throw new MissingStop();
}

/** Save-time check: known placeholders only, and the opt-out line is present. */
export function validateTemplateBody(body: string): void {
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    if (!isTemplateVariable(name)) throw new UnknownTemplateVariable(name);
  }
  assertBodyHasStop(body);
}

/**
 * Replaces `{{var}}`. A missing or blank value throws so `{{code}}` is never
 * delivered. The rendered body must still contain STOP.
 */
export function renderTemplate(
  body: string,
  vars: Partial<Record<TemplateVariable, string>>
): string {
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    if (!isTemplateVariable(name)) throw new UnknownTemplateVariable(name);
    const value = vars[name];
    if (value == null || value.trim() === '') throw new MissingTemplateVariable(name);
  }
  const rendered = body.replace(TOKEN, (_, name: string) => vars[name as TemplateVariable] ?? '');
  assertBodyHasStop(rendered);
  return rendered;
}

export async function ensureDefaultTemplates(
  store: GrowthWhatsAppStore,
  organizationId: string
): Promise<MessageTemplateRow[]> {
  const existing = await store.templates(organizationId);
  const have = new Set(existing.map((row) => `${row.key}:${row.language}`));
  for (const key of TEMPLATE_KEYS) {
    if (key === 'order_ready') {
      for (const language of Object.keys(ORDER_READY_BODIES) as OrderReadyLanguage[]) {
        if (have.has(`${key}:${language}`)) continue;
        await store.saveTemplate({
          organizationId,
          key,
          language,
          body: ORDER_READY_BODIES[language],
        });
      }
      continue;
    }
    if (have.has(`${key}:${DEFAULT_TEMPLATE_LANGUAGE}`)) continue;
    await store.saveTemplate({
      organizationId,
      key,
      language: DEFAULT_TEMPLATE_LANGUAGE,
      body: DEFAULT_TEMPLATES[key],
    });
  }
  return store.templates(organizationId);
}

export async function saveTemplateBody(
  store: GrowthWhatsAppStore,
  input: { organizationId: string; key: string; language: string; body: string }
): Promise<MessageTemplateRow> {
  if (!isTemplateKey(input.key)) throw new UnknownTemplateVariable(input.key);
  validateTemplateBody(input.body);
  return store.saveTemplate(input);
}
