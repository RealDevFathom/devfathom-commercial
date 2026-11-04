import 'server-only';

import { Prisma, type PharmacySopRecordType } from '@/generated/prisma/client';
import { withOrganizationDefaults, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  installSopPackDefinition,
  type InstallPackResult,
  type SopPack,
  type SopPackStep,
} from '@/lib/restaurant/sop-template-packs';
import type { PharmacySopRoleKey } from './sop-adapter';

/**
 * DEV-751 — the pharmacy procedure library on the shared SOP engine.
 *
 * Each pack is an ordinary `SopPack` (so the shared installer materialises it
 * unchanged) plus pharmacy metadata the engine does not model: which pharmacy
 * role owns it, who may verify it, what starts it, a suggested schedule, and
 * which steps must point at an existing pharmacy record.
 *
 * Wording stays operational. The checklists record what staff did against the
 * branch's own records; they give no clinical or dosing advice and they do not
 * claim that completing them satisfies any regulation.
 *
 * A procedure is an instruction to the person it is assigned to, plus the
 * proof they send back ("Once closed, send a photo of the locked premises").
 * It never performs, blocks, gates or changes opening, closing, selling,
 * dispensing, receiving or any other pharmacy workflow, exactly as in
 * restaurants. A step's photo, note, signature or linked record gates only
 * that procedure's own submission. Step wording is phrased as follow-up
 * ("after…", "once…", "confirm…", "note…", "send…"), never as the operation.
 *
 * Template names are the install identity and stay fixed. An organization that
 * installed an earlier wording keeps it (install is idempotent by name); the
 * router maps installed steps to pack metadata by title, then by position, and
 * every step keeps its position and linked-record type.
 *
 * Install creates templates only. It never creates an assignment, a schedule or
 * a role holding; a manager does that per branch after enabling SOPs there.
 */

/** What starts a pack: a shift boundary, a repeating interval, an event, or a named person. */
export type PharmacySopTrigger = 'SHIFT' | 'INTERVAL' | 'EVENT' | 'ASSIGNED';

/**
 * Suggested schedule in the engine's assignment shape. INTERVAL packs repeat
 * every `interval` minutes from `dueTimeMinutes` to `intervalEndTimeMinutes` on
 * `daysOfWeek`. ONCE packs (events and named-person work) run once, on demand.
 */
export type PharmacySopRecurrence = {
  frequency: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';
  interval: number;
  daysOfWeek: number[];
  monthDay: number | null;
  /** Branch-local minutes past midnight. */
  dueTimeMinutes: number;
  /** INTERVAL only: the last branch-local minute an interval may start. */
  intervalEndTimeMinutes: number | null;
  windowMinutes: number;
  graceMinutes: number;
};

export type PharmacySopPackMeta = {
  /** The pharmacy role that owes the work (for ASSIGNED packs, the usual candidates). */
  roleKey: PharmacySopRoleKey;
  /** ROLE: an unclaimed pool for holders of `roleKey`. PERSON: one named person. */
  assigneeTarget: 'ROLE' | 'PERSON';
  /** Roles allowed to verify a submitted occurrence (always independently). */
  verifierRoleKeys: readonly PharmacySopRoleKey[];
  trigger: PharmacySopTrigger;
  suggestedRecurrence: PharmacySopRecurrence;
};

export type PharmacySopPackStep = SopPackStep & {
  /** The step is complete only when it links an existing record of this type. */
  requiredRecordType?: PharmacySopRecordType;
};

/** A shared `SopPack` (assignable to it) whose steps carry pharmacy record requirements. */
export type PharmacySopPack = Omit<SopPack, 'steps'> & {
  steps: PharmacySopPackStep[];
  pharmacy: PharmacySopPackMeta;
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const OPENING_MINUTES = 8 * 60;
const CLOSING_MINUTES = 20 * 60;
/** Verifiers allowed for most packs. Controlled counts narrow this to the qualified person. */
const STANDARD_VERIFIERS: readonly PharmacySopRoleKey[] = [
  'pharmacy-qualified-person',
  'pharmacy-manager',
];

const daily = (dueTimeMinutes: number, windowMinutes: number, graceMinutes: number) => ({
  frequency: 'DAILY' as const,
  interval: 1,
  daysOfWeek: [] as number[],
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

/** On-demand work: one occurrence, created when the event happens or the person is named. */
const once = (dueTimeMinutes: number, windowMinutes: number) => ({
  frequency: 'ONCE' as const,
  interval: 1,
  daysOfWeek: [] as number[],
  monthDay: null,
  dueTimeMinutes,
  windowMinutes,
  graceMinutes: 0,
});

/** Training attestation: due at 15:00, a day to do it, a day's grace before it is missed. */
const attestation = { ...once(15 * 60, 24 * 60), graceMinutes: 24 * 60 };

const withoutInterval = <T extends Omit<PharmacySopRecurrence, 'intervalEndTimeMinutes'>>(
  rule: T
): PharmacySopRecurrence => ({ ...rule, intervalEndTimeMinutes: null });

export class PharmacySopRecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PharmacySopRecurrenceError';
  }
}

/**
 * The temperature round: a reading every `everyMinutes` between opening and
 * closing on the given days. Defaults to every four hours, 08:00–20:00, daily.
 * Each reading gets the whole interval as its window so rounds never overlap.
 */
export function temperatureLogRecurrence(
  options: {
    openingMinutes?: number;
    closingMinutes?: number;
    everyMinutes?: number;
    daysOfWeek?: readonly number[];
  } = {}
): PharmacySopRecurrence {
  const opening = options.openingMinutes ?? OPENING_MINUTES;
  const closing = options.closingMinutes ?? CLOSING_MINUTES;
  const every = options.everyMinutes ?? 4 * 60;
  const days = [...new Set(options.daysOfWeek ?? ALL_DAYS)].sort((a, b) => a - b);
  const minuteOfDay = (value: number) => Number.isInteger(value) && value >= 0 && value <= 1439;
  if (!minuteOfDay(opening) || !minuteOfDay(closing) || closing <= opening) {
    throw new PharmacySopRecurrenceError('Closing time must be later than opening time.');
  }
  if (!Number.isInteger(every) || every < 15 || every > closing - opening) {
    throw new PharmacySopRecurrenceError(
      'The reading interval must be at least 15 minutes and fit between opening and closing.'
    );
  }
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new PharmacySopRecurrenceError('Choose at least one weekday (0=Sunday … 6=Saturday).');
  }
  return {
    frequency: 'INTERVAL',
    interval: every,
    daysOfWeek: days,
    monthDay: null,
    dueTimeMinutes: opening,
    intervalEndTimeMinutes: closing,
    windowMinutes: every,
    graceMinutes: Math.min(30, every),
  };
}

type PackDefinition = Omit<PharmacySopPack, 'defaultJobRoleKey' | 'suggestedRecurrence'> & {
  /** The engine-facing recurrence; INTERVAL packs fall back to their opening time here. */
  engineRecurrence: SopPack['suggestedRecurrence'];
};

function pack(definition: PackDefinition): PharmacySopPack {
  const { engineRecurrence, ...rest } = definition;
  return {
    ...rest,
    defaultJobRoleKey: definition.pharmacy.roleKey,
    suggestedRecurrence: engineRecurrence,
  };
}

const temperatureRound = temperatureLogRecurrence();

/** The nine pharmacy packs. Names are the install identity and must stay stable. */
export const PHARMACY_SOP_PACKS: readonly PharmacySopPack[] = [
  pack({
    key: 'opening',
    name: 'Pharmacy — opening',
    category: 'Opening',
    description:
      'After the branch opens: confirm who is in charge and send proof that storage was checked.',
    engineRecurrence: daily(OPENING_MINUTES, 2 * 60, 30),
    pharmacy: {
      roleKey: 'pharmacy-qualified-person',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'SHIFT',
      suggestedRecurrence: withoutInterval(daily(OPENING_MINUTES, 2 * 60, 30)),
    },
    steps: [
      {
        title: 'Once the counter is open, sign to confirm you are the person in charge today',
        requiresSignature: true,
      },
      {
        title: 'Once the counter is open, confirm the opening temperatures were recorded',
        instructions: 'Link the reading already recorded in the temperature log for this branch.',
        requiredRecordType: 'TEMPERATURE_LOG',
      },
      { title: 'Note the controlled register balance you took over', requiresNote: true },
      { title: 'After opening, confirm the premises, security and counter look right' },
      { title: 'Note anything that was not right at opening, or confirm none', requiresNote: true },
    ],
  }),
  pack({
    key: 'closing',
    name: 'Pharmacy — closing',
    category: 'Closing',
    description:
      'After the day close: send proof that records were checked and stock was put away securely.',
    engineRecurrence: daily(CLOSING_MINUTES, 2 * 60, 30),
    pharmacy: {
      roleKey: 'pharmacy-qualified-person',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'SHIFT',
      suggestedRecurrence: withoutInterval(daily(CLOSING_MINUTES, 2 * 60, 30)),
    },
    steps: [
      {
        title: 'After the day close, note the controlled register and till balances you checked',
        requiresNote: true,
      },
      { title: 'Confirm prescriptions and controlled medicines were put away securely' },
      {
        title: 'After closing, confirm the last refrigerator temperature was recorded',
        instructions: 'Link the reading already recorded in the temperature log for this branch.',
        requiredRecordType: 'TEMPERATURE_LOG',
      },
      {
        title: 'Once closed, send a photo of the locked premises',
        requiresPhoto: true,
      },
    ],
  }),
  pack({
    key: 'temperature-log',
    name: 'Pharmacy — temperature log',
    category: 'Storage',
    description: 'Regular storage temperature readings through the opening hours.',
    engineRecurrence: daily(OPENING_MINUTES, temperatureRound.windowMinutes, 30),
    pharmacy: {
      roleKey: 'pharmacy-assistant',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'INTERVAL',
      suggestedRecurrence: temperatureRound,
    },
    steps: [
      {
        title: 'Confirm the refrigerator temperature was recorded',
        instructions: 'Link the reading from the temperature log.',
        requiredRecordType: 'TEMPERATURE_LOG',
      },
      {
        title: 'Confirm the ambient storage temperature was recorded',
        instructions: 'Link the reading from the temperature log.',
        requiredRecordType: 'TEMPERATURE_LOG',
      },
      {
        title: 'Record any excursion and the corrective action taken, or confirm none',
        instructions:
          'If a reading is out of range, say what you did and who you told. Follow your branch procedure for affected stock.',
        requiresNote: true,
      },
    ],
  }),
  pack({
    key: 'controlled-counts',
    name: 'Pharmacy — controlled counts',
    category: 'Controlled medicines',
    description:
      'Weekly count of controlled medicines, with the result noted against the register.',
    engineRecurrence: weekly([1], 10 * 60, 8 * 60, 60),
    pharmacy: {
      roleKey: 'pharmacy-qualified-person',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: ['pharmacy-qualified-person'],
      trigger: 'SHIFT',
      suggestedRecurrence: withoutInterval(weekly([1], 10 * 60, 8 * 60, 60)),
    },
    steps: [
      { title: 'Count the controlled medicines on hand and note the totals', requiresNote: true },
      {
        title: 'Compare your count with the register running balance',
        instructions: 'Link the register entry whose running balance you checked.',
        requiresNote: true,
        requiredRecordType: 'CONTROLLED_REGISTER_ENTRY',
      },
      { title: 'Note any difference and who you told, or confirm none', requiresNote: true },
      { title: 'Sign the count', requiresSignature: true },
    ],
  }),
  pack({
    key: 'expiry-pull',
    name: 'Pharmacy — expiry pull',
    category: 'Inventory',
    description: 'Weekly check for expired or damaged stock, with a note of what was set aside.',
    engineRecurrence: weekly([1], 11 * 60, 8 * 60, 60),
    pharmacy: {
      roleKey: 'pharmacy-assistant',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'SHIFT',
      suggestedRecurrence: withoutInterval(weekly([1], 11 * 60, 8 * 60, 60)),
    },
    steps: [
      { title: 'Look over stock nearing expiry' },
      {
        title: 'Note expired or damaged stock you set aside',
        instructions: 'Link the batch you set aside.',
        requiresNote: true,
        requiredRecordType: 'MANUFACTURING_BATCH',
      },
      { title: 'Note what happens to it next (disposal or supplier return)', requiresNote: true },
    ],
  }),
  pack({
    key: 'receiving',
    name: 'Pharmacy — receiving',
    category: 'Receiving',
    description: 'After a delivery is received, confirm it matched its goods receipt.',
    engineRecurrence: once(12 * 60, 24 * 60),
    pharmacy: {
      roleKey: 'pharmacy-assistant',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'EVENT',
      suggestedRecurrence: withoutInterval(once(12 * 60, 24 * 60)),
    },
    steps: [
      {
        title: 'Confirm the delivery matched its goods receipt',
        requiredRecordType: 'GOODS_RECEIPT',
      },
      { title: 'Confirm batch numbers, expiry dates and supplier warranty evidence were checked' },
      { title: 'Note how cold-chain items arrived', requiresNote: true },
      { title: 'Note any shortages, damage or rejections, or confirm none', requiresNote: true },
    ],
  }),
  pack({
    key: 'hygiene',
    name: 'Pharmacy — hygiene',
    category: 'Hygiene',
    description: 'Daily cleanliness check of the counter and dispensing area.',
    engineRecurrence: daily(8 * 60 + 30, 3 * 60, 30),
    pharmacy: {
      roleKey: 'pharmacy-assistant',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'SHIFT',
      suggestedRecurrence: withoutInterval(daily(8 * 60 + 30, 3 * 60, 30)),
    },
    steps: [
      { title: 'Inspect counter and dispensing area cleanliness' },
      { title: 'Confirm hand-hygiene supplies are stocked' },
      { title: 'Record cleaning completion and exceptions', requiresNote: true },
    ],
  }),
  pack({
    key: 'incident-capa',
    name: 'Pharmacy — incident and CAPA',
    category: 'Quality',
    description: 'Record an incident, its cause and the corrective and preventive actions.',
    engineRecurrence: once(14 * 60, 7 * 24 * 60),
    pharmacy: {
      roleKey: 'pharmacy-manager',
      assigneeTarget: 'ROLE',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'EVENT',
      suggestedRecurrence: withoutInterval(once(14 * 60, 7 * 24 * 60)),
    },
    steps: [
      { title: 'Describe the incident and immediate containment', requiresNote: true },
      { title: 'Record the root cause', requiresNote: true },
      { title: 'Record the corrective and preventive actions', requiresNote: true },
      { title: 'Name who will check the actions worked, and when', requiresNote: true },
    ],
  }),
  pack({
    key: 'training-attestation',
    name: 'Pharmacy — training attestation',
    category: 'Training',
    description: 'A named person confirms they have read an assigned procedure.',
    // A manager schedules this one through the schedule form, so it must fit
    // the router's bounds (window and grace each at most a day): a day to do
    // it on time, and a further day before it counts as missed.
    engineRecurrence: attestation,
    pharmacy: {
      roleKey: 'pharmacy-assistant',
      assigneeTarget: 'PERSON',
      verifierRoleKeys: STANDARD_VERIFIERS,
      trigger: 'ASSIGNED',
      suggestedRecurrence: withoutInterval(attestation),
    },
    steps: [
      { title: 'Read the assigned policy or procedure' },
      { title: 'Note any questions for your manager, or confirm none', requiresNote: true },
      { title: 'Attest completion with your signature', requiresSignature: true },
    ],
  }),
];

export function findPharmacySopPack(key: string): PharmacySopPack | undefined {
  return PHARMACY_SOP_PACKS.find((candidate) => candidate.key === key);
}

/** The pack an installed template came from, by its install identity (exact name). */
export function pharmacySopPackForTemplateName(name: string): PharmacySopPack | undefined {
  return PHARMACY_SOP_PACKS.find((candidate) => candidate.name === name);
}

export class PharmacySopLibraryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PharmacySopLibraryScopeError';
  }
}

/**
 * Install every pharmacy pack into one organization. Idempotent (a pack
 * already present by name is left untouched) and serialized per organization:
 * the shared installer is find-then-create, so two concurrent installs take a
 * transaction advisory lock and the second sees the first's templates.
 *
 * The organization is `opts.organizationId` when given, else the transaction's
 * `app.current_organization_id`; neither (a platform context with no explicit
 * organization) throws before any read or write, and an explicit id that
 * disagrees with a non-empty tenant setting throws too. The lock key always
 * names that organization. The shared installer scopes its reads and its
 * inserts by RLS and the column default, so unless the transaction is already
 * plain tenant scope for that organization, the install runs inside
 * `withOrganizationDefaults` — a platform-admin read would otherwise see every
 * tenant's templates.
 */
export async function installPharmacySopLibrary(
  db: ScopedDb,
  opts: { now?: Date; organizationId?: string } = {}
): Promise<InstallPackResult[]> {
  const transaction = db.$transaction.bind(db) as unknown as <T>(
    work: (tx: ScopedDb) => Promise<T>
  ) => Promise<T>;
  return transaction(async (tx) => {
    const [setting] = await tx.$queryRaw<
      { organizationId: string | null; platformAdmin: string | null }[]
    >(
      Prisma.sql`SELECT NULLIF(current_setting('app.current_organization_id', true), '') AS "organizationId", current_setting('app.is_platform_admin', true) AS "platformAdmin"`
    );
    const current = setting?.organizationId?.trim() || null;
    const requested = opts.organizationId?.trim() || null;
    if (requested && current && requested !== current) {
      throw new PharmacySopLibraryScopeError(
        'The organization to install into does not match the current tenant.'
      );
    }
    const organizationId = requested ?? current;
    if (!organizationId) {
      throw new PharmacySopLibraryScopeError(
        'Choose the organization to install the pharmacy procedure library into.'
      );
    }

    const install = async (scoped: ScopedDb) => {
      await scoped.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-sop-library:${organizationId}`}, 0))`
      );
      const results: InstallPackResult[] = [];
      for (const definition of PHARMACY_SOP_PACKS) {
        results.push(await installSopPackDefinition(scoped, definition, { now: opts.now }));
      }
      return results;
    };
    const tenantScoped = current === organizationId && setting?.platformAdmin !== 'true';
    return tenantScoped ? install(tx) : withOrganizationDefaults(tx, organizationId, install);
  });
}
