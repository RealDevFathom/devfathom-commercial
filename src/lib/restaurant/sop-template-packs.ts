import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * SOP-1 / WHA-224 — the nine starter checklist packs.
 *
 * A pack is a ready-to-run template: a name, a category, an ordered step list with
 * per-step evidence flags, plus the recurrence and default job role an operator
 * would almost certainly pick anyway. Installing a pack materialises the M7 shape
 * — template → version 1 → steps — and PUBLISHES version 1, because an unpublished
 * template schedules nothing and a starter pack that silently generates no work is
 * worse than no pack at all.
 *
 * The packs deliberately stop at "record the observation". Verification decisions,
 * escalation, scoring and reporting are other lanes' concerns; nothing here
 * depends on them.
 *
 * IDEMPOTENCY. There is no key column on `RestaurantSopTemplate` (M7 shape, not
 * changed here), so a pack is identified by its exact NAME within the
 * organization. Installing twice is a no-op; an operator who renames a pack owns
 * the rename, and a later install will add the original back rather than fight
 * them for the name.
 */

export type SopPackStep = {
  title: string;
  instructions?: string;
  requiresPhoto?: boolean;
  requiresNote?: boolean;
  requiresSignature?: boolean;
};

export type SopPack = {
  /** Stable identifier for callers selecting packs; NOT persisted (see above). */
  key: string;
  name: string;
  category: string;
  description: string;
  /** The job-role key this pack is normally assigned to (see DEFAULT_JOB_ROLES). */
  defaultJobRoleKey: string;
  /** Suggested recurrence for a branch assignment. */
  suggestedRecurrence: {
    frequency: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval: number;
    daysOfWeek: number[];
    monthDay: number | null;
    /** Branch-local minutes past midnight the checklist is due. */
    dueTimeMinutes: number;
    windowMinutes: number;
    graceMinutes: number;
  };
  steps: SopPackStep[];
};

const daily = (dueTimeMinutes: number, windowMinutes: number, graceMinutes: number) => ({
  frequency: 'DAILY' as const,
  interval: 1,
  daysOfWeek: [],
  monthDay: null,
  dueTimeMinutes,
  windowMinutes,
  graceMinutes,
});

const weekly = (
  daysOfWeek: number[],
  dueTimeMinutes: number,
  windowMinutes: number,
  graceMinutes: number
) => ({
  frequency: 'WEEKLY' as const,
  interval: 1,
  daysOfWeek,
  monthDay: null,
  dueTimeMinutes,
  windowMinutes,
  graceMinutes,
});

const monthly = (
  monthDay: number,
  dueTimeMinutes: number,
  windowMinutes: number,
  graceMinutes: number
) => ({
  frequency: 'MONTHLY' as const,
  interval: 1,
  daysOfWeek: [],
  monthDay,
  dueTimeMinutes,
  windowMinutes,
  graceMinutes,
});

/** The nine packs. Order is the order the admin console offers them in. */
export const SOP_TEMPLATE_PACKS: readonly SopPack[] = [
  {
    key: 'front-of-house-opening',
    name: 'Front of house — opening',
    category: 'Opening',
    description: 'Bring the dining room and service stations to opening standard.',
    defaultJobRoleKey: 'cashier',
    suggestedRecurrence: daily(7 * 60, 3 * 60, 15),
    steps: [
      {
        title: 'Unlock and disarm',
        instructions: 'Confirm the alarm log shows no overnight events.',
      },
      { title: 'Lights, music and climate on' },
      { title: 'Dining room swept and tables wiped', requiresPhoto: true },
      { title: 'Condiments and cutlery stations restocked' },
      { title: 'Menus checked for damage and current pricing' },
      { title: 'Guest bathrooms stocked and clean', requiresPhoto: true },
      { title: 'Note anything not ready for service', requiresNote: true },
    ],
  },
  {
    key: 'front-of-house-closing',
    name: 'Front of house — closing',
    category: 'Closing',
    description: 'Shut the dining room down and leave it ready for the opening crew.',
    defaultJobRoleKey: 'cashier',
    suggestedRecurrence: daily(23 * 60, 3 * 60, 15),
    steps: [
      { title: 'All guests departed and doors locked' },
      { title: 'Tables cleared, wiped and reset' },
      { title: 'Floors swept and mopped', requiresPhoto: true },
      { title: 'Condiment stations cleaned and covered' },
      { title: 'Bathrooms cleaned and restocked' },
      { title: 'Lights, music and non-essential equipment off' },
      { title: 'Alarm set and premises secured', requiresSignature: true },
    ],
  },
  {
    key: 'kitchen-opening-line-check',
    name: 'Kitchen — opening line check',
    category: 'Opening',
    description: 'Verify the line is stocked, clean and at temperature before first order.',
    defaultJobRoleKey: 'kitchen',
    suggestedRecurrence: daily(6 * 60 + 30, 3 * 60, 15),
    steps: [
      { title: 'Walk-in and freezer temperatures within range', requiresNote: true },
      { title: 'Prep list reviewed against today’s forecast' },
      { title: 'Line stocked and organised', requiresPhoto: true },
      { title: 'Hot holding equipment up to temperature', requiresNote: true },
      { title: 'Sauces and dressings dated and in date' },
      { title: 'Knives, boards and small wares clean and accounted for' },
      { title: 'Flag any 86’d items', requiresNote: true },
    ],
  },
  {
    key: 'kitchen-closing',
    name: 'Kitchen — closing',
    category: 'Closing',
    description: 'Break down, clean and store so the kitchen opens safely tomorrow.',
    defaultJobRoleKey: 'kitchen',
    suggestedRecurrence: daily(23 * 60 + 30, 3 * 60, 15),
    steps: [
      { title: 'All product wrapped, labelled and dated', requiresPhoto: true },
      { title: 'Hot line broken down and cleaned' },
      { title: 'Fryers filtered or topped up as scheduled' },
      { title: 'Grills, flat tops and salamanders scraped and cleaned', requiresPhoto: true },
      { title: 'Floors degreased and mats washed' },
      { title: 'Bins emptied and waste taken out' },
      { title: 'Gas and non-essential equipment off', requiresSignature: true },
    ],
  },
  {
    key: 'food-safety-temperature-log',
    name: 'Food safety — temperature log',
    category: 'Food safety',
    description: 'Twice-daily temperature record for cold and hot holding.',
    defaultJobRoleKey: 'kitchen',
    suggestedRecurrence: daily(11 * 60, 12 * 60, 30),
    steps: [
      { title: 'Walk-in fridge temperature', requiresNote: true },
      { title: 'Under-counter fridges temperature', requiresNote: true },
      { title: 'Freezer temperature', requiresNote: true },
      { title: 'Hot holding temperature', requiresNote: true },
      { title: 'Probe thermometer calibration checked' },
      { title: 'Corrective action taken for any reading out of range', requiresNote: true },
    ],
  },
  {
    key: 'cleaning-and-sanitation',
    name: 'Cleaning and sanitation — deep clean',
    category: 'Cleaning',
    description: 'The weekly deep clean beyond the daily open/close routines.',
    defaultJobRoleKey: 'kitchen',
    suggestedRecurrence: weekly([1], 9 * 60, 8 * 60, 60),
    steps: [
      { title: 'Extraction hood and filters cleaned', requiresPhoto: true },
      { title: 'Behind and under all line equipment' },
      { title: 'Walk-in shelving emptied, washed and dried', requiresPhoto: true },
      { title: 'Ice machine cleaned and sanitised' },
      { title: 'Drains flushed and treated' },
      { title: 'Sanitiser concentration verified', requiresNote: true },
    ],
  },
  {
    key: 'equipment-maintenance',
    name: 'Equipment maintenance check',
    category: 'Maintenance',
    description: 'Monthly preventative check on the equipment that stops service when it fails.',
    defaultJobRoleKey: 'manager',
    suggestedRecurrence: monthly(1, 10 * 60, 12 * 60, 120),
    steps: [
      { title: 'Refrigeration door seals inspected', requiresPhoto: true },
      { title: 'Fryer thermostat accuracy checked', requiresNote: true },
      { title: 'Dishwasher wash and rinse temperatures verified', requiresNote: true },
      { title: 'Espresso machine descaled and gaskets checked' },
      { title: 'Fire suppression and extinguisher service dates in date', requiresPhoto: true },
      { title: 'Faults logged with the maintenance contact', requiresNote: true },
    ],
  },
  {
    key: 'goods-receiving',
    name: 'Goods receiving and storage',
    category: 'Receiving',
    description: 'Check deliveries on arrival and store them correctly.',
    defaultJobRoleKey: 'kitchen',
    suggestedRecurrence: daily(8 * 60, 6 * 60, 30),
    steps: [
      { title: 'Delivery matched against the order', requiresNote: true },
      { title: 'Chilled and frozen items temperature-checked on arrival', requiresNote: true },
      { title: 'Packaging intact and no signs of pest or damage', requiresPhoto: true },
      { title: 'Use-by dates acceptable for intended use' },
      { title: 'Stock rotated front-to-back on storage' },
      { title: 'Shortages, substitutions or rejections recorded', requiresNote: true },
    ],
  },
  {
    key: 'health-and-hygiene',
    name: 'Team health and hygiene',
    category: 'Food safety',
    description: 'Daily personal-hygiene and fitness-to-work check for the on-site team.',
    defaultJobRoleKey: 'manager',
    suggestedRecurrence: daily(7 * 60 + 30, 4 * 60, 30),
    steps: [
      { title: 'Team fit to work — no reportable illness declared', requiresSignature: true },
      { title: 'Uniforms clean and hair restrained' },
      { title: 'Hand-wash stations stocked with soap and towels', requiresPhoto: true },
      { title: 'Cuts and wounds covered with a blue detectable dressing' },
      { title: 'Jewellery and nail policy observed' },
      { title: 'Record any exclusion from food handling', requiresNote: true },
    ],
  },
];

export function findSopPack(key: string): SopPack | undefined {
  return SOP_TEMPLATE_PACKS.find((pack) => pack.key === key);
}

export type InstallPackResult = {
  packKey: string;
  templateId: string;
  templateVersionId: string;
  /** False when the pack was already present and nothing was written. */
  created: boolean;
};

/**
 * Install one pack into the current organization. Creates the template, its
 * version 1 with the pack's steps, and publishes that version so assignments can
 * pin it immediately. Already-installed packs return `created: false` untouched.
 */
export async function installSopPack(
  db: ScopedDb,
  packKey: string,
  opts: { now?: Date } = {}
): Promise<InstallPackResult> {
  const pack = findSopPack(packKey);
  if (!pack) throw new Error(`Unknown SOP pack "${packKey}".`);

  return installSopPackDefinition(db, pack, opts);
}

/** Shared vertical seam: materialise a validated pack on the existing SOP engine. */
export async function installSopPackDefinition(
  db: ScopedDb,
  // Install reads only identity and steps; a vertical's pack need not carry the
  // restaurant `suggestedRecurrence` shape (pharmacy suggests no time of day).
  pack: Pick<SopPack, 'key' | 'name' | 'description' | 'category' | 'steps'>,
  opts: { now?: Date } = {}
): Promise<InstallPackResult> {
  const packKey = pack.key;

  const existing = await db.restaurantSopTemplate.findFirst({
    where: { name: pack.name },
    select: { id: true, versions: { select: { id: true }, orderBy: { versionNumber: 'asc' } } },
  });
  if (existing) {
    return {
      packKey,
      templateId: existing.id,
      templateVersionId: existing.versions[0]?.id ?? '',
      created: false,
    };
  }

  const template = await db.restaurantSopTemplate.create({
    data: {
      name: pack.name,
      description: pack.description,
      category: pack.category,
      isActive: true,
      versions: {
        create: {
          versionNumber: 1,
          status: 'PUBLISHED',
          publishedAt: opts.now ?? new Date(),
          steps: {
            create: pack.steps.map((step, index) => ({
              stepOrder: index + 1,
              title: step.title,
              instructions: step.instructions ?? null,
              requiresPhoto: step.requiresPhoto ?? false,
              requiresSignature: step.requiresSignature ?? false,
              requiresNote: step.requiresNote ?? false,
            })),
          },
        },
      },
    },
    select: { id: true, versions: { select: { id: true } } },
  });

  return {
    packKey,
    templateId: template.id,
    templateVersionId: template.versions[0]?.id ?? '',
    created: true,
  };
}

/** Install every pack. Idempotent; safe to re-run during onboarding. */
export async function installAllSopPacks(
  db: ScopedDb,
  opts: { now?: Date } = {}
): Promise<InstallPackResult[]> {
  const results: InstallPackResult[] = [];
  for (const pack of SOP_TEMPLATE_PACKS) {
    results.push(await installSopPack(db, pack.key, opts));
  }
  return results;
}
