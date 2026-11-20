/**
 * PH-POS / POS-09 — what the counter is allowed to say, and how loudly.
 *
 * Pure and database-free. The panel beside the cart must keep three kinds of
 * message visibly apart, because collapsing them is the failure the PRD calls
 * out by name: "'Are you sure?' is not an approval design".
 *
 *   SAFETY_BLOCK    the line cannot proceed as composed. A pharmacist decision
 *                   or a corrected line is required; acknowledging is not one
 *                   of the available outcomes.
 *   CLINICAL_ADVICE counselling and handling the operator should read and pass
 *                   on. Never blocks, never dressed up as a block.
 *   COMMERCIAL      margin, discount and near-expiry economics. Lowest rank so
 *                   a promotion notice can never crowd out a safety block.
 *
 * Alerts are deduplicated by a stable key and returned in severity order, so a
 * cart with four lines of the same controlled medicine raises ONE controlled
 * alert rather than four — POS-09 requires alerts to be deduplicated, and an
 * operator who scrolls past repeats is an operator who stops reading.
 */

import { duplicateSaltGroups, type DuplicateSaltGroup } from './duplicate-salt';
import type { BlockReason } from './inventory';
import { prescriptionIsCurrent } from './prescription-calendar';
import { PHARMACIST_CHECK_OFF_NOTE } from './pharmacist-check';

export const COUNTER_ALERT_SEVERITIES = ['SAFETY_BLOCK', 'CLINICAL_ADVICE', 'COMMERCIAL'] as const;
export type CounterAlertSeverity = (typeof COUNTER_ALERT_SEVERITIES)[number];

export type CounterAlert = {
  /** Stable identity used for deduplication and as the React key. */
  key: string;
  severity: CounterAlertSeverity;
  code: string;
  message: string;
  /** The cart line this alert came from, when it is line-specific. */
  saleLineRef: string | null;
  /** What the operator must do. Null when the alert is purely informational. */
  remedy: string | null;
  /**
   * #724: present only on alerts the operator may acknowledge (never on a
   * SAFETY_BLOCK). Acknowledging records an audit entry; it never gates sale.
   */
  acknowledgement?: {
    kind: 'DUPLICATE_ACTIVE_INGREDIENT';
    ingredientKey: string;
    medicines: DuplicateSaltGroup['medicines'];
  };
};

const SEVERITY_RANK: Record<CounterAlertSeverity, number> = {
  SAFETY_BLOCK: 0,
  CLINICAL_ADVICE: 1,
  COMMERCIAL: 2,
};

/** INV-03 hard blocks, phrased for a counter rather than for a ledger. */
const BLOCK_MESSAGES: Record<BlockReason, string> = {
  EXPIRED: 'Nearest batch is expired and cannot be dispensed.',
  RECALLED: 'Batch is under recall and is blocked from sale.',
  QUARANTINED: 'Stock is quarantined and is blocked from sale.',
  DAMAGED: 'Stock is marked damaged and is blocked from sale.',
  DESTROYED: 'Stock is recorded as destroyed and cannot be sold.',
  IN_TRANSIT: 'Stock is in transit to another branch and is not sellable here.',
  RETURNED_TO_SUPPLIER: 'Stock is dispatched back to the supplier and is not sellable.',
  UNRECEIVED: 'Lot has not been received yet and cannot be dispensed.',
  UNAUTHORIZED: 'Stock belongs to another branch or tenant and is not sellable here.',
  EMPTY: 'No sellable units remain in this batch.',
};

export type CounterAlertMedicine = {
  medicineId: string;
  displayName: string;
  rx: boolean;
  controlled: boolean;
  restricted: boolean;
  highAlert: boolean;
  lasa: boolean;
  coldChain: boolean;
  /**
   * #724: active salts from the ingredient graph (the substitute-finder data).
   * Optional so callers without ingredient data keep their behaviour.
   */
  activeIngredients?: readonly { ingredientId: string; name: string }[];
};

export type CounterAlertLine = {
  /** Cart line identity — the sale line id, or a local draft id before it exists. */
  ref: string;
  medicine: CounterAlertMedicine;
  /** Blocked lots FEFO refused for this line (INV-03). */
  blocked: readonly BlockReason[];
  /** A verified prescription covering this line, when one has been attached. */
  prescription: {
    id: string;
    verified: boolean;
    /** UTC-midnight calendar-date carriers; validUntil is inclusive. */
    validFrom: Date;
    validUntil: Date;
    remainingAuthorizedUnits: number;
  } | null;
  /**
   * True when a pharmacist-witnessed emergency no-prescription supply was
   * recorded for this line (a PharmacyEmergencyRxFollowUp exists). Only
   * controlled lines honour it; the follow-up stays open until a prescription
   * is captured.
   */
  emergencySupply?: boolean;
  requestedCanonicalUnits: number;
  /** Earliest safe expiry backing this line, for the near-expiry notice. */
  nearestSafeExpiry: Date | null;
  discountMinor: number;
};

export type CounterAlertContext = {
  at: Date;
  /** Organization calendar timezone; missing or invalid zones fall back to UTC. */
  timeZone?: string | null;
  /** Days before expiry at which the counter starts warning commercially. */
  nearExpiryDays?: number;
  /**
   * DEV-911: the owner switched the pharmacist check at each sale off. A prescription-only or
   * controlled line then carries a plain note instead of the prescription block; the server
   * makes the same decision from the stored setting. Absent means on.
   */
  pharmacistCheckOff?: boolean;
};

const DAY_MS = 86_400_000;

function push(alerts: CounterAlert[], alert: CounterAlert): void {
  alerts.push(alert);
}

/**
 * Every alert one cart line raises.
 *
 * A regulated medicine without a verified prescription blocks; the SAME
 * medicine with a verified, in-date, sufficient prescription raises nothing,
 * because an alert that fires whether or not the operator did the right thing
 * teaches the operator to dismiss it.
 */
function alertsForLine(line: CounterAlertLine, context: CounterAlertContext): CounterAlert[] {
  const alerts: CounterAlert[] = [];
  const { medicine } = line;
  const name = medicine.displayName;

  for (const reason of line.blocked) {
    push(alerts, {
      key: `block:${medicine.medicineId}:${reason}`,
      severity: 'SAFETY_BLOCK',
      code: `STOCK_${reason}`,
      message: `${name}: ${BLOCK_MESSAGES[reason]}`,
      saleLineRef: line.ref,
      remedy: 'Choose another batch, or capture the shortfall as unfulfilled demand.',
    });
  }

  const needsPrescription = medicine.rx || medicine.controlled || medicine.restricted;
  if (needsPrescription && context.pharmacistCheckOff === true) {
    push(alerts, {
      key: `pharmacist-check-off:${line.ref}`,
      severity: 'CLINICAL_ADVICE',
      code: 'PHARMACIST_CHECK_SWITCHED_OFF',
      message: `${name}: ${PHARMACIST_CHECK_OFF_NOTE}.`,
      saleLineRef: line.ref,
      remedy: null,
    });
  } else if (needsPrescription) {
    const prescription = line.prescription;
    if (!prescription && medicine.controlled && line.emergencySupply) {
      push(alerts, {
        key: `rx-emergency:${line.ref}`,
        severity: 'CLINICAL_ADVICE',
        code: 'CONTROLLED_EMERGENCY_SUPPLY',
        message: `${name} was supplied as an emergency without a prescription. The prescription follow-up stays open.`,
        saleLineRef: line.ref,
        remedy: "Capture the prescriber's prescription to close the emergency follow-up.",
      });
    } else if (!prescription) {
      push(alerts, {
        key: `rx-missing:${medicine.medicineId}`,
        severity: 'SAFETY_BLOCK',
        code: medicine.controlled ? 'CONTROLLED_WITHOUT_PRESCRIPTION' : 'RX_WITHOUT_PRESCRIPTION',
        message: `${name} requires a prescription before it can be dispensed.`,
        saleLineRef: line.ref,
        remedy: 'Attach a captured prescription and have a pharmacist verify it.',
      });
    } else {
      if (!prescription.verified) {
        push(alerts, {
          key: `rx-unverified:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_NOT_VERIFIED',
          message: `The prescription attached to ${name} has not been verified by a pharmacist.`,
          saleLineRef: line.ref,
          remedy: 'A pharmacist must verify this prescription; a cashier cannot self-approve it.',
        });
      }
      if (
        !prescriptionIsCurrent(
          prescription.validFrom,
          prescription.validUntil,
          context.at,
          context.timeZone
        )
      ) {
        push(alerts, {
          key: `rx-expired:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_EXPIRED',
          message: `The prescription attached to ${name} is outside its validity period.`,
          saleLineRef: line.ref,
          remedy: 'Capture a current prescription before dispensing.',
        });
      }
      if (prescription.remainingAuthorizedUnits < line.requestedCanonicalUnits) {
        push(alerts, {
          key: `rx-quantity:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_QUANTITY_EXCEEDED',
          message: `${name} exceeds the remaining authorized quantity (${prescription.remainingAuthorizedUnits} units).`,
          saleLineRef: line.ref,
          remedy: 'Reduce the quantity to the remaining authorization, or record a partial fill.',
        });
      }
    }
  }

  if (medicine.highAlert) {
    push(alerts, {
      key: `high-alert:${medicine.medicineId}`,
      severity: 'SAFETY_BLOCK',
      code: 'HIGH_ALERT_MEDICINE',
      message: `${name} is a high-alert medicine and needs an independent pharmacist check.`,
      saleLineRef: line.ref,
      remedy: 'A pharmacist must confirm the medicine, strength and quantity before release.',
    });
  }

  if (medicine.lasa) {
    push(alerts, {
      key: `lasa:${medicine.medicineId}`,
      severity: 'CLINICAL_ADVICE',
      code: 'LOOK_ALIKE_SOUND_ALIKE',
      message: `${name} is look-alike/sound-alike. Read the strength back before handing over.`,
      saleLineRef: line.ref,
      remedy: null,
    });
  }

  if (medicine.coldChain) {
    push(alerts, {
      key: `cold-chain:${medicine.medicineId}`,
      severity: 'CLINICAL_ADVICE',
      code: 'COLD_CHAIN_HANDLING',
      message: `${name} is cold-chain. Hand over in an insulated pack and state the storage range.`,
      saleLineRef: line.ref,
      remedy: null,
    });
  }

  if (line.discountMinor > 0 && (medicine.rx || medicine.restricted || medicine.controlled)) {
    push(alerts, {
      key: `regulated-discount:${medicine.medicineId}`,
      severity: 'COMMERCIAL',
      code: 'REGULATED_DISCOUNT_REFUSED',
      message: `Discounts are not applied to ${name} because it is a regulated item.`,
      saleLineRef: line.ref,
      remedy: 'Remove the discount to complete this line.',
    });
  }

  const nearExpiryDays = context.nearExpiryDays ?? 90;
  if (line.nearestSafeExpiry) {
    const remainingDays = Math.floor(
      (line.nearestSafeExpiry.getTime() - context.at.getTime()) / DAY_MS
    );
    if (remainingDays >= 0 && remainingDays <= nearExpiryDays) {
      push(alerts, {
        key: `near-expiry:${medicine.medicineId}`,
        severity: 'COMMERCIAL',
        code: 'NEAR_EXPIRY_BATCH',
        message: `${name} dispenses from a batch expiring in ${remainingDays} day(s).`,
        saleLineRef: line.ref,
        remedy: 'Tell the customer the expiry before completing the sale.',
      });
    }
  }

  return alerts;
}

/**
 * #724 Phase 1: two different medicines on one bill sharing an active salt.
 *
 * CLINICAL_ADVICE by design: the warning is read and acknowledged, never a
 * block, so `hasBlockingAlert` is unaffected. Points at the first line that
 * carries the salt.
 */
function duplicateSaltAlerts(lines: readonly CounterAlertLine[]): CounterAlert[] {
  return duplicateSaltGroups(
    lines.map((line) => ({
      ref: line.ref,
      medicineId: line.medicine.medicineId,
      displayName: line.medicine.displayName,
      activeIngredients: line.medicine.activeIngredients ?? [],
    }))
  ).map((group) => ({
    // A group always holds at least two medicines (duplicateSaltGroups filters).
    key: `duplicate-salt:${group.ingredientKey}`,
    severity: 'CLINICAL_ADVICE',
    code: 'DUPLICATE_ACTIVE_INGREDIENT',
    message: `${group.medicines.map((medicine) => medicine.displayName).join(', ')} ${group.medicines.length === 2 ? 'both' : 'all'} contain ${group.ingredientName}. Check the patient is not double-dosing.`,
    saleLineRef: group.medicines[0]?.ref ?? null,
    remedy: 'Confirm each is intended, then acknowledge. The sale is not blocked.',
    acknowledgement: {
      kind: 'DUPLICATE_ACTIVE_INGREDIENT',
      ingredientKey: group.ingredientKey,
      medicines: group.medicines,
    },
  }));
}

/**
 * Every alert the cart raises, deduplicated and ordered severity-first.
 *
 * Dedup keeps the FIRST occurrence, so the retained alert still points at a
 * real cart line the operator can jump to with the keyboard.
 */
export function counterAlertsFor(
  lines: readonly CounterAlertLine[],
  context: CounterAlertContext
): CounterAlert[] {
  const byKey = new Map<string, CounterAlert>();
  for (const line of lines) {
    for (const alert of alertsForLine(line, context)) {
      if (!byKey.has(alert.key)) byKey.set(alert.key, alert);
    }
  }
  for (const alert of duplicateSaltAlerts(lines)) {
    if (!byKey.has(alert.key)) byKey.set(alert.key, alert);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      left.key.localeCompare(right.key)
  );
}

/** A cart carrying an unresolved safety block may not be tendered. */
export function hasBlockingAlert(alerts: readonly CounterAlert[]): boolean {
  return alerts.some((alert) => alert.severity === 'SAFETY_BLOCK');
}
