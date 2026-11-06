import { createTranslator } from 'next-intl';
import defaultMessages from '@/messages/en.json';

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
    expiresAt: Date;
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
  /** Display copy only; alert severity, code and authorization remain unchanged. */
  translate?: (key: string, values?: Record<string, string | number>) => string;
  /** Days before expiry at which the counter starts warning commercially. */
  nearExpiryDays?: number;
};

const englishText = createTranslator({ locale: 'en', messages: defaultMessages.CounterAlerts });
const defaultText = (key: string, values?: Record<string, string | number>) =>
  englishText(key as Parameters<typeof englishText>[0], values);
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
  const t = context.translate ?? defaultText;
  const alerts: CounterAlert[] = [];
  const { medicine } = line;
  const name = medicine.displayName;

  for (const reason of line.blocked) {
    push(alerts, {
      key: `block:${medicine.medicineId}:${reason}`,
      severity: 'SAFETY_BLOCK',
      code: `STOCK_${reason}`,
      message: t('value0Value1', { value0: name, value1: t(`stock.${reason}`) }),
      saleLineRef: line.ref,
      remedy: t('chooseAnotherBatchOrCaptureTheShortfallAsUnfulfilled'),
    });
  }

  const needsPrescription = medicine.rx || medicine.controlled || medicine.restricted;
  if (needsPrescription) {
    const prescription = line.prescription;
    if (!prescription && medicine.controlled && line.emergencySupply) {
      push(alerts, {
        key: `rx-emergency:${line.ref}`,
        severity: 'CLINICAL_ADVICE',
        code: 'CONTROLLED_EMERGENCY_SUPPLY',
        message: t('value0WasSuppliedAsAnEmergencyWithoutAPrescription', { value0: name }),
        saleLineRef: line.ref,
        remedy: t('captureThePrescriberSPrescriptionToCloseTheEmergency'),
      });
    } else if (!prescription) {
      push(alerts, {
        key: `rx-missing:${medicine.medicineId}`,
        severity: 'SAFETY_BLOCK',
        code: medicine.controlled ? 'CONTROLLED_WITHOUT_PRESCRIPTION' : 'RX_WITHOUT_PRESCRIPTION',
        message: t('value0RequiresAPrescriptionBeforeItCanBeDispensed', { value0: name }),
        saleLineRef: line.ref,
        remedy: t('attachACapturedPrescriptionAndHaveAPharmacistVerify'),
      });
    } else {
      if (!prescription.verified) {
        push(alerts, {
          key: `rx-unverified:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_NOT_VERIFIED',
          message: t('thePrescriptionAttachedToValue0HasNotBeenVerified', { value0: name }),
          saleLineRef: line.ref,
          remedy: t('aPharmacistMustVerifyThisPrescriptionACashierCannot'),
        });
      }
      if (prescription.expiresAt.getTime() <= context.at.getTime()) {
        push(alerts, {
          key: `rx-expired:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_EXPIRED',
          message: t('thePrescriptionAttachedToValue0IsOutsideItsValidity', { value0: name }),
          saleLineRef: line.ref,
          remedy: t('captureACurrentPrescriptionBeforeDispensing'),
        });
      }
      if (prescription.remainingAuthorizedUnits < line.requestedCanonicalUnits) {
        push(alerts, {
          key: `rx-quantity:${prescription.id}`,
          severity: 'SAFETY_BLOCK',
          code: 'PRESCRIPTION_QUANTITY_EXCEEDED',
          message: t('value0ExceedsTheRemainingAuthorizedQuantityValue1Units', {
            value0: name,
            value1: prescription.remainingAuthorizedUnits,
          }),
          saleLineRef: line.ref,
          remedy: t('reduceTheQuantityToTheRemainingAuthorizationOrRecord'),
        });
      }
    }
  }

  if (medicine.highAlert) {
    push(alerts, {
      key: `high-alert:${medicine.medicineId}`,
      severity: 'SAFETY_BLOCK',
      code: 'HIGH_ALERT_MEDICINE',
      message: t('value0IsAHighAlertMedicineAndNeedsAn', { value0: name }),
      saleLineRef: line.ref,
      remedy: t('aPharmacistMustConfirmTheMedicineStrengthAndQuantity'),
    });
  }

  if (medicine.lasa) {
    push(alerts, {
      key: `lasa:${medicine.medicineId}`,
      severity: 'CLINICAL_ADVICE',
      code: 'LOOK_ALIKE_SOUND_ALIKE',
      message: t('value0IsLookAlikeSoundAlikeReadTheStrength', { value0: name }),
      saleLineRef: line.ref,
      remedy: null,
    });
  }

  if (medicine.coldChain) {
    push(alerts, {
      key: `cold-chain:${medicine.medicineId}`,
      severity: 'CLINICAL_ADVICE',
      code: 'COLD_CHAIN_HANDLING',
      message: t('value0IsColdChainHandOverInAnInsulated', { value0: name }),
      saleLineRef: line.ref,
      remedy: null,
    });
  }

  if (line.discountMinor > 0 && (medicine.rx || medicine.restricted || medicine.controlled)) {
    push(alerts, {
      key: `regulated-discount:${medicine.medicineId}`,
      severity: 'COMMERCIAL',
      code: 'REGULATED_DISCOUNT_REFUSED',
      message: t('discountsAreNotAppliedToValue0BecauseItIs', { value0: name }),
      saleLineRef: line.ref,
      remedy: t('removeTheDiscountToCompleteThisLine'),
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
        message: t('value0DispensesFromABatchExpiringInValue1Day', {
          value0: name,
          value1: remainingDays,
        }),
        saleLineRef: line.ref,
        remedy: t('tellTheCustomerTheExpiryBeforeCompletingTheSale'),
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
function duplicateSaltAlerts(
  lines: readonly CounterAlertLine[],
  context: CounterAlertContext
): CounterAlert[] {
  const t = context.translate ?? defaultText;
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
    message: t('value0Value1ContainValue2CheckThePatientIsNot', {
      value0: group.medicines.map((medicine) => medicine.displayName).join(t('listSeparator')),
      value1: group.medicines.length === 2 ? t('both') : t('all'),
      value2: group.ingredientName,
    }),
    saleLineRef: group.medicines[0]?.ref ?? null,
    remedy: t('confirmEachIsIntendedThenAcknowledgeTheSaleIs'),
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
  for (const alert of duplicateSaltAlerts(lines, context)) {
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
