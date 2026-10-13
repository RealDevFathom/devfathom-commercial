/**
 * COMP-01 / PROP-01 — the hospitality onboarding checklist.
 *
 * Mirrors `src/lib/pharmacy/onboarding-checklist.ts` in shape and in the one rule
 * that matters: **a stored claim is never the verdict.** Readiness is recomputed
 * from the property record and the organization's roles on every read, so seed
 * data, a bulk import or a hand-written row cannot move a step to done. The
 * difference from pharmacy is that every hospitality step happens to be
 * evidence-backed, so there is no attestation path at all — nothing here accepts
 * an operator's word for anything.
 *
 * Every item blocks activation. `assertActivationReady` calls
 * {@link evaluateHotelReadiness} for a HOSPITALITY organization and refuses to
 * activate while any item is pending, which is the "no go-live while blocking
 * items pending" rule of PROP-01's acceptance criterion.
 *
 * The types repeat the pharmacy checklist's row shape rather than importing it.
 * Two verticals sharing a *rendering* contract is intended; two verticals sharing
 * a module is not, because a hospitality change would then have to be safe for a
 * regulated pharmacy surface.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

export type HotelOnboardingItemKey =
  | 'MODE_CHOSEN'
  | 'PROPERTY_FACTS'
  | 'TAX_PROFILE'
  | 'BUSINESS_DATE_AND_AUDIT'
  | 'ROLES_ASSIGNED'
  | 'ROOM_TYPES';

export type HotelOnboardingStep = {
  key: HotelOnboardingItemKey;
  /** 1-based position in the walk an operator follows. */
  step: number;
  label: string;
  /** Every hospitality step blocks go-live; kept explicit so a later optional
   * step does not have to be discovered by reading the resolver. */
  blocking: boolean;
  /** How the step is answered, and where. Never "OK". */
  todo: string;
  done: string;
  href: string | null;
  linkLabel: string | null;
};

export const HOTEL_ONBOARDING_STEPS: readonly HotelOnboardingStep[] = [
  {
    key: 'MODE_CHOSEN',
    step: 1,
    label: 'Property mode',
    blocking: true,
    todo: 'Create the property and choose how it operates — hotel, hostel, apartments, resort or venue.',
    done: 'The property records how it operates.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'PROPERTY_FACTS',
    step: 2,
    label: 'Property facts',
    blocking: true,
    todo: 'Record the property name, address, city, timezone and its check-in and check-out times.',
    done: 'Name, address, timezone and the guest-facing times are recorded.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'TAX_PROFILE',
    step: 3,
    label: 'Tax profile',
    blocking: true,
    todo: 'Attach the tax profile every folio charge will be taxed from. No property goes live untaxed.',
    done: 'A tax profile is attached to this property.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'BUSINESS_DATE_AND_AUDIT',
    step: 4,
    label: 'Business date and audit time',
    blocking: true,
    todo: 'Set the time the night audit runs and the rule that rolls the business date.',
    done: 'The audit time and the business-date rule are set.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'ROLES_ASSIGNED',
    step: 5,
    label: 'Roles assigned',
    blocking: true,
    todo: 'The hospitality role templates are missing. They are created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
    done: 'The hospitality role templates are in place.',
    href: '/organization',
    linkLabel: 'Open organization',
  },
  {
    key: 'ROOM_TYPES',
    step: 6,
    // PROP-02 ships in H1-03. The step is listed now — an operator has to see
    // the whole walk — and its resolver reports pending until that lane can
    // answer it. It carries no link, because UX rule 12 forbids linking into a
    // surface that does not exist in this build.
    label: 'At least one room type',
    blocking: true,
    todo: 'Room types are not yet available in this build. Your DevFathom delivery team enables them; this step stays outstanding until then.',
    done: 'At least one sellable room type exists.',
    href: null,
    linkLabel: null,
  },
];

export type HotelOnboardingEvidence = Record<HotelOnboardingItemKey, boolean>;

export type HotelChecklistItemState = 'DONE' | 'NEEDS_YOU';

export type HotelChecklistItem = HotelOnboardingStep & {
  state: HotelChecklistItemState;
  /** One line: how it was satisfied, or exactly what to do next. */
  why: string;
  /** True when leaving this row unresolved refuses activation. */
  blocksActivation: boolean;
};

export type HotelOnboardingChecklist = {
  organizationId: string;
  items: readonly HotelChecklistItem[];
  doneCount: number;
  totalCount: number;
  /** Rows that refuse activation while they stand, in walk order. */
  blocking: readonly HotelChecklistItem[];
  ready: boolean;
};

/**
 * Turn evidence into the checklist. Pure, so the go-live rule is testable
 * without a database and so no caller can reach `ready` by another route.
 */
export function evaluateHotelOnboarding(
  organizationId: string,
  evidence: HotelOnboardingEvidence
): HotelOnboardingChecklist {
  const items = HOTEL_ONBOARDING_STEPS.map((step): HotelChecklistItem => {
    const done = evidence[step.key];
    return {
      ...step,
      state: done ? 'DONE' : 'NEEDS_YOU',
      why: done ? step.done : step.todo,
      blocksActivation: step.blocking && !done,
    };
  });
  const blocking = items.filter((item) => item.blocksActivation);
  return {
    organizationId,
    items,
    doneCount: items.filter((item) => item.state === 'DONE').length,
    totalCount: items.length,
    blocking,
    ready: blocking.length === 0,
  };
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Does this JSON policy column hold a decision, rather than the `{}` default? */
function policyRecorded(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

/**
 * The property facts and the roles this organization actually holds, read as the
 * tenant. Exported separately from the queries so the evidence rules can be
 * exercised without a database.
 */
export function hotelEvidence(
  property: {
    mode: string | null;
    name: string | null;
    addressLine: string | null;
    city: string | null;
    timezone: string | null;
    checkInTime: string | null;
    checkOutTime: string | null;
    auditTime: string | null;
    taxProfileId: string | null;
    businessDatePolicy: unknown;
  } | null,
  seededRoleKeyCount: number,
  requiredRoleKeyCount: number,
  roomTypeCount: number | null
): HotelOnboardingEvidence {
  return {
    MODE_CHOSEN: nonEmpty(property?.mode),
    PROPERTY_FACTS: Boolean(
      property &&
      nonEmpty(property.name) &&
      nonEmpty(property.addressLine) &&
      nonEmpty(property.city) &&
      nonEmpty(property.timezone) &&
      nonEmpty(property.checkInTime) &&
      nonEmpty(property.checkOutTime)
    ),
    TAX_PROFILE: nonEmpty(property?.taxProfileId),
    BUSINESS_DATE_AND_AUDIT: Boolean(
      property && nonEmpty(property.auditTime) && policyRecorded(property.businessDatePolicy)
    ),
    ROLES_ASSIGNED: requiredRoleKeyCount > 0 && seededRoleKeyCount >= requiredRoleKeyCount,
    // H1-03 owns room types. Until it ships there is nothing to count, and
    // `null` reports pending rather than being quietly read as satisfied.
    ROOM_TYPES: roomTypeCount !== null && roomTypeCount > 0,
  };
}

/**
 * Run the evidence queries for one organization and evaluate every step.
 *
 * Both queries carry an explicit `organizationId` predicate; forced row-level
 * security is the second wall and never the only one. The property read picks
 * the organization's first active property — PROP-04 multi-property arrives with
 * its own selector, and until then a hospitality organization holds exactly the
 * one property provisioning created.
 */
export async function evaluateHotelReadiness(
  db: PrismaClient,
  organizationId: string
): Promise<HotelOnboardingChecklist> {
  const requiredRoleKeys = roleTemplatesForVertical('HOSPITALITY').map((template) => template.key);

  const [property, seededRoleKeys] = await Promise.all([
    db.hotelProperty.findFirst({
      where: { organizationId, active: true },
      orderBy: { createdAt: 'asc' },
      select: {
        mode: true,
        name: true,
        addressLine: true,
        city: true,
        timezone: true,
        checkInTime: true,
        checkOutTime: true,
        auditTime: true,
        taxProfileId: true,
        businessDatePolicy: true,
      },
    }),
    db.organizationRole.count({ where: { organizationId, key: { in: requiredRoleKeys } } }),
  ]);

  return evaluateHotelOnboarding(
    organizationId,
    hotelEvidence(property, seededRoleKeys, requiredRoleKeys.length, null)
  );
}

/**
 * The activation status sentence, built from the same rows the checklist shows.
 * Names how many steps block and which, because the panel renders those rows
 * beneath it (UX rule 13).
 */
export function hotelActivationSummary(checklist: HotelOnboardingChecklist): string {
  if (checklist.ready) {
    return 'Every readiness step is done. This property can be activated.';
  }
  const names = checklist.blocking.map((item) => item.label);
  const count = names.length;
  const listed =
    names.length > 3
      ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      : names.join(', ');
  return `Activation is refused until ${count === 1 ? 'this step is' : `these ${count} steps are`} done: ${listed}.`;
}
