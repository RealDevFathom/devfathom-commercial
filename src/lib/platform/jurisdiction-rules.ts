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
// Same contract as the pharmacist-presence gate (src/lib/pharmacy/regulatory.ts):
// a window may end at 24:00, the exclusive end of the local day.
const startTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const endTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const minutes = (value: string) => {
  const [hours, mins] = value.split(':').map(Number);
  return hours! * 60 + mins!;
};

type RuleFieldShape = { values?: unknown; provisional?: unknown; toConfirm?: unknown };

function hasValues(values: unknown): boolean {
  if (Array.isArray(values)) return values.length > 0;
  if (values !== null && typeof values === 'object') return Object.keys(values).length > 0;
  return typeof values === 'number';
}

/**
 * DEV-99 confirmation contract. A field counts as confirmed only when it is
 * explicitly `provisional: false`, records no outstanding review (`toConfirm`)
 * and carries reviewed content. Empty sections can never be confirmed: a
 * genuinely "not applicable" rule needs its own approved representation.
 */
export function ruleFieldConfirmed(field: unknown): boolean {
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return false;
  const { values, provisional, toConfirm } = field as RuleFieldShape;
  return (
    provisional === false &&
    (toConfirm === undefined || (typeof toConfirm === 'string' && toConfirm.trim() === '')) &&
    hasValues(values)
  );
}

// Keep the concrete field schema for inference without comparing its fluent methods.
const rule = <T extends z.core.$ZodType>(values: T) =>
  z
    .object({
      values,
      provisional: z.boolean(),
      toConfirm: z.string().trim().max(1000).optional(),
    })
    .strict()
    .superRefine((field, context) => {
      if (field.provisional !== false) return;
      if (field.toConfirm) {
        context.addIssue({
          code: 'custom',
          path: ['toConfirm'],
          message: 'A confirmed field cannot record outstanding review. Keep it provisional.',
        });
      }
      if (!hasValues((field as RuleFieldShape).values)) {
        context.addIssue({
          code: 'custom',
          path: ['values'],
          message: 'A confirmed field needs reviewed values. Keep an empty field provisional.',
        });
      }
    });

export const jurisdictionRulesSchema = z
  .object({
    licenceCategories: rule(names),
    // Schedule names are the published names branch profiles record (see
    // regulatoryProfileInput in src/lib/pharmacy/regulatory-profile-form.ts).
    permittedSchedules: rule(
      z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(60)
            .refine((value) => !value.includes('*'), 'Wildcards are not permitted.')
        )
        .max(40)
        .refine((values) => new Set(values).size === values.length, 'Remove duplicate schedules.')
    ),
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
                      start: startTime,
                      end: endTime,
                    })
                    .strict()
                    .refine(
                      (window) => minutes(window.start) < minutes(window.end),
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
  // Branch profiles are dated by day and bind the rule set in force at that
  // day's UTC midnight (saveRegulatoryProfile), so a publication starts at a
  // UTC midnight too. A mid-day start could not be adopted by a profile dated
  // that day, which would silently keep the predecessor.
  effectiveFrom: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .refine(
      (value) => value.getTime() % 86_400_000 === 0,
      'Choose a date; a new version starts at the beginning of that day (UTC).'
    ),
  reason: z.string().trim().min(10).max(500),
  reviewerName: z.string().trim().min(1).max(200),
  reviewerRole: z.string().trim().min(1).max(200),
  evidenceRef: z.string().trim().min(1).max(500).optional(),
  authenticationCode: z.string(),
});

export function allRulesConfirmed(rules: Record<(typeof RULE_FIELDS)[number], unknown>): boolean {
  return RULE_FIELDS.every((key) => ruleFieldConfirmed(rules[key]));
}
