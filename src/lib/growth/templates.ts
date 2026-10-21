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
 * Promotional campaigns may name only these product families. Anything else,
 * including an empty list, is refused. Utility templates do not use this list.
 */
const PROMO_PRODUCT_CATEGORIES = new Set(['front_shop', 'device', 'alternative']);

export class DrugCategoryInPromo extends Error {
  readonly categories: readonly string[];

  constructor(categories: readonly string[]) {
    super('Promotional campaigns can only include non-drug product categories.');
    this.name = 'DrugCategoryInPromo';
    this.categories = categories;
  }
}

export function normalizeProductCategory(category: string): string {
  return category
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function isDrugProductCategory(category: string): boolean {
  return !PROMO_PRODUCT_CATEGORIES.has(normalizeProductCategory(category));
}

export function assertPromoProductCategories(categories: readonly string[]): void {
  if (categories.length === 0) throw new DrugCategoryInPromo([]);
  const blocked = categories.filter(isDrugProductCategory);
  if (blocked.length > 0) throw new DrugCategoryInPromo(blocked);
}

/**
 * Marketing sends allow only front-shop, device, and alternative families.
 * A utility template such as `refill_reminder` or `order_ready` may name a medicine.
 * An unknown template key and an empty marketing list both fail closed.
 */
export function assertCampaignProducts(input: {
  templateKey: string;
  productCategories: readonly string[];
}): void {
  if (!isTemplateKey(input.templateKey)) throw new UnknownTemplateVariable(input.templateKey);
  if (TEMPLATE_PURPOSE[input.templateKey] === 'utility') return;
  assertPromoProductCategories(input.productCategories);
}

type MedicineFamilyDb = {
  medicine: {
    findMany(args: {
      where: { organizationId: string; id: { in: string[] } };
      select: { productFamily: true };
    }): Promise<Array<{ productFamily: string }>>;
  };
};

/** Families stored on this organization's medicines. A missing id fails closed. */
export async function productFamiliesFromMedicines(
  db: MedicineFamilyDb,
  organizationId: string,
  medicineIds: readonly string[]
): Promise<string[]> {
  const ids = [...new Set(medicineIds)];
  if (ids.length === 0) return [];
  const rows = await db.medicine.findMany({
    where: { organizationId, id: { in: ids } },
    select: { productFamily: true },
  });
  if (rows.length !== ids.length) throw new DrugCategoryInPromo(['UNKNOWN']);
  return rows.map((row) => row.productFamily);
}

/** Marketing `{{product}}` may name only these stored families. */
const ALLOWLISTED_PRODUCT_FAMILIES = new Set(['FRONT_SHOP', 'DEVICE']);

const PRODUCT_TOKEN = /\{\{\s*product\s*\}\}/;

export class ProductNotAllowlisted extends Error {
  constructor() {
    super('The product variable must come from a front-shop or device medicine.');
    this.name = 'ProductNotAllowlisted';
  }
}

export class ProhibitedDrugInCopy extends Error {
  constructor() {
    super('Marketing copy names a prescription, controlled, or restricted medicine.');
    this.name = 'ProhibitedDrugInCopy';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word match. Names shorter than 3 characters are ignored. */
export function bodyNamesProhibitedDrug(body: string, names: readonly string[]): boolean {
  const text = body.normalize('NFKC');
  for (const raw of names) {
    const name = raw.normalize('NFKC').trim();
    if (name.length < 3) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(text)) return true;
  }
  return false;
}

type MedicineReader = MedicineFamilyDb;

function readMedicines(db: MedicineReader, args: object): Promise<unknown> {
  return (db.medicine.findMany as (query: object) => Promise<unknown>)(args);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Replaces `{{product}}` from this organization's front-shop and device rows.
 * A caller-supplied product string is not accepted. Lookup failure fails closed.
 */
export async function fillAllowlistedProduct(
  db: MedicineReader,
  organizationId: string,
  body: string,
  medicineIds: readonly string[]
): Promise<string> {
  if (!PRODUCT_TOKEN.test(body)) return body;
  const ids = [...new Set(medicineIds)];
  let rows: unknown;
  try {
    rows = await readMedicines(db, {
      where: {
        organizationId,
        id: { in: ids },
        productFamily: { in: ['FRONT_SHOP', 'DEVICE'] },
      },
      select: { productName: true, productFamily: true },
    });
  } catch {
    throw new ProductNotAllowlisted();
  }
  if (!Array.isArray(rows)) throw new ProductNotAllowlisted();
  const names = [
    ...new Set(
      rows
        .map((row) => {
          const value = asRecord(row);
          const family = typeof value?.productFamily === 'string' ? value.productFamily : '';
          const productName =
            typeof value?.productName === 'string' ? value.productName.trim() : '';
          return ALLOWLISTED_PRODUCT_FAMILIES.has(family) ? productName : '';
        })
        .filter((name) => name.length > 0)
    ),
  ];
  if (names.length === 0) throw new ProductNotAllowlisted();
  return body.replace(/\{\{\s*product\s*\}\}/g, names.join(', '));
}

function prohibitedNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) throw new ProhibitedDrugInCopy();
  const names: string[] = [];
  for (const row of rows) {
    const value = asRecord(row);
    if (!value) continue;
    if (typeof value.productName === 'string') names.push(value.productName);
    if (typeof value.brandName === 'string') names.push(value.brandName);
    if (Array.isArray(value.aliases)) {
      for (const alias of value.aliases) {
        const record = asRecord(alias);
        if (typeof record?.value === 'string') names.push(record.value);
      }
    }
    if (Array.isArray(value.strengths)) {
      for (const strength of value.strengths) {
        const ingredient = asRecord(asRecord(strength)?.ingredient);
        if (typeof ingredient?.name === 'string') names.push(ingredient.name);
      }
    }
  }
  return names;
}

/**
 * Refuses marketing text that names one of this organization's prescription,
 * controlled, or restricted medicines. A lookup error fails closed.
 */
export async function assertMarketingCopyAllowed(
  db: MedicineReader,
  organizationId: string,
  body: string
): Promise<void> {
  let rows: unknown;
  try {
    rows = await readMedicines(db, {
      where: {
        organizationId,
        OR: [{ rx: true }, { controlled: true }, { restricted: true }],
      },
      select: {
        productName: true,
        brandName: true,
        aliases: { select: { value: true } },
        strengths: { select: { ingredient: { select: { name: true } } } },
      },
    });
  } catch (error) {
    if (error instanceof ProhibitedDrugInCopy) throw error;
    throw new ProhibitedDrugInCopy();
  }
  if (bodyNamesProhibitedDrug(body, prohibitedNames(rows))) throw new ProhibitedDrugInCopy();
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
