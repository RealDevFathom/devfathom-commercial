import type { Prisma } from '@/generated/prisma/client';

/**
 * Stable control-plane command names shared with the planned revert workflow.
 * Revert is deliberately only an interface here: it must eventually append a
 * replacement version too, never make an old regulatory snapshot mutable.
 */
export const PHARMACY_RULE_SET_COMMANDS = {
  confirm: 'pharmacy.ruleset.confirm',
  revert: 'pharmacy.ruleset.revert',
} as const;

export type ConfirmRuleSetInput = {
  code: string;
  effectiveFrom: string;
  reason: string;
  licenceCategories: Prisma.JsonValue;
  permittedSchedules: Prisma.JsonValue;
  prescriptionOnlyClasses: Prisma.JsonValue;
  prescriptionRetentionDays: Prisma.JsonValue;
  controlledRegisterFlags: Prisma.JsonValue;
  pharmacistCoverageRule: Prisma.JsonValue;
  recordRetentionByClass: Prisma.JsonValue;
};

export type RevertRuleSetInput = ConfirmRuleSetInput & {
  /** The immutable version whose values a future revert command will copy. */
  sourceVersion: number;
};
