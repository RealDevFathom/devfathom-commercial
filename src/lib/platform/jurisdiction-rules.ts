import { z } from 'zod';
import { ianaTimezone } from '@/lib/timezone';

export const RULE_FIELDS = [
  'licenceCategories',
  'permittedSchedules',
  'prescriptionOnlyClasses',
  'prescriptionRetentionDays',
  'controlledRegisterFlags',
  'pharmacistCoverageRule',
  'recordRetentionByClass',
] as const;

export const RULE_FIELD_LABELS: Record<(typeof RULE_FIELDS)[number], string> = {
  licenceCategories: 'Licence categories',
  permittedSchedules: 'Permitted schedules',
  prescriptionOnlyClasses: 'Prescription-only classes',
  prescriptionRetentionDays: 'Prescription retention days',
  controlledRegisterFlags: 'Controlled register flags',
  pharmacistCoverageRule: 'Pharmacist coverage rule',
  recordRetentionByClass: 'Record retention by class',
};

// These are storage contracts, not legal defaults. No wildcard may turn an
// ordinary jurisdiction into the separate emergency placeholder escape hatch.
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !value.includes('*'), 'Wildcards are not permitted.');
const names = z
  .array(name)
  .max(100)
  .refine((values) => new Set(values).size === values.length, 'Remove duplicate values.');
const days = z.number().int().positive().max(36525);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const rule = <T extends z.ZodType>(values: T) =>
  z
    .object({
      values,
      provisional: z.boolean(),
      toConfirm: z.string().trim().max(1000).optional(),
    })
    .strict();

export const jurisdictionRulesSchema = z
  .object({
    licenceCategories: rule(names),
    permittedSchedules: rule(names),
    prescriptionOnlyClasses: rule(names),
    prescriptionRetentionDays: rule(z.union([days, z.record(name, days)])),
    controlledRegisterFlags: rule(
      z
        .object({
          recordEverySale: z.boolean().optional(),
          emergencySupply: z
            .object({
              maxUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              repeatWindowHours: z.number().int().positive().max(2_400_000_000),
              source: z.literal('JURISDICTION_RULE_SET').optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
    ),
    pharmacistCoverageRule: rule(
      z
        .object({
          dispenseGrantRequired: z.boolean().optional(),
          presenceHours: z
            .object({
              timeZone: ianaTimezone.optional(),
              windows: z
                .array(
                  z
                    .object({
                      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
                      start: windowStart,
                      end: windowEnd,
                    })
                    .strict()
                    .refine(
                      (window) => window.start < window.end,
                      'End must follow start; split overnight shifts into two windows.'
                    )
                )
                .min(1)
                .max(100),
            })
            .strict()
            .optional(),
        })
        .strict()
    ),
    recordRetentionByClass: rule(
      z
        .object({
          PRESCRIPTION: days.optional(),
          CONTROLLED_REGISTER: days.optional(),
          FISCAL: days.optional(),
          AUDIT: days.optional(),
        })
        .strict()
    ),
  })
  .strict();

export const publishJurisdictionRulesSchema = jurisdictionRulesSchema.extend({
  previousId: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  effectiveFrom: z.iso.datetime().transform((value) => new Date(value)),
  reason: z.string().trim().min(10).max(500),
  reviewerName: z.string().trim().min(1).max(200),
  reviewerRole: z.string().trim().min(1).max(200),
  evidenceRef: z.string().trim().min(1).max(500).optional(),
  authenticationCode: z.string(),
});

export function allRulesConfirmed(rules: Record<(typeof RULE_FIELDS)[number], unknown>): boolean {
  return RULE_FIELDS.every((key) => {
    const field = rules[key];
    return (
      field !== null &&
      typeof field === 'object' &&
      'provisional' in field &&
      field.provisional === false
    );
  });
}
),
  authenticationCode: z.string(),
});

export function allRulesConfirmed(rules: Record<(typeof RULE_FIELDS)[number], unknown>): boolean {
  return RULE_FIELDS.every((key) => {
    const field = rules[key];
    return (
      field !== null &&
      typeof field === 'object' &&
      'provisional' in field &&
      field.provisional === false
    );
  });
}
