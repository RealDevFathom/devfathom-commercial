import type { JurisdictionRuleSet } from '@/generated/prisma/client';
import {
  PlatformCommandForm,
  type CommandField,
} from '@/components/platform/platform-command-form';
import { PlatformPageHeading } from '@/components/platform/platform-ui';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { RULE_FIELDS, RULE_FIELD_LABELS } from '@/lib/platform/jurisdiction-rules';
import { ruleSetOptions } from '@/lib/pharmacy/regulatory-profile-form';

const effectiveDate = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const help: Record<(typeof RULE_FIELDS)[number], string> = {
  licenceCategories: 'values: an array of licence category names. Wildcards are not allowed.',
  permittedSchedules:
    'values: an array of schedule names (for example OTC, RX, CONTROLLED or G), without duplicates or wildcards.',
  prescriptionOnlyClasses: 'values: an array of class names. Wildcards are not allowed.',
  prescriptionRetentionDays:
    'values: a positive whole number of days or an object mapping class names to days (maximum 36525).',
  controlledRegisterFlags:
    'values: an object with optional recordEverySale (boolean) and emergencySupply: { maxUnits, repeatWindowHours, source: "JURISDICTION_RULE_SET" }.',
  pharmacistCoverageRule:
    'values: an object with optional dispenseGrantRequired (boolean) and presenceHours: { timeZone, windows: [{ days: [0–6], start: "HH:MM", end: "HH:MM" }] }. End may be "24:00" for a window running to midnight. Split overnight shifts into two windows, e.g. 20:00–24:00 plus 00:00–08:00.',
  recordRetentionByClass:
    'values: an object mapping PRESCRIPTION, CONTROLLED_REGISTER, FISCAL or AUDIT to positive whole days (maximum 36525).',
};

function draftFields(ruleSet: JurisdictionRuleSet): CommandField[] {
  return [
    { name: 'previousId', label: 'Previous version', type: 'hidden', defaultValue: ruleSet.id },
    ...RULE_FIELDS.map((name): CommandField => ({
      name,
      label: RULE_FIELD_LABELS[name],
      type: 'json',
      required: true,
      defaultValue: {
        ...(ruleSet[name] as Record<string, unknown>),
        provisional: true,
      },
      help: `${help[name]} Keep provisional: true until reviewed; set provisional: false only for a confirmed field. Optional toConfirm records outstanding review.`,
    })),
    {
      name: 'effectiveFrom',
      label: 'Effective from',
      type: 'datetime-local',
      required: true,
      help: 'Choose a future time after the previous version starts. This uses your browser’s local time.',
    },
    { name: 'reviewerName', label: 'Reviewer name', required: true, maxLength: 200 },
    {
      name: 'reviewerRole',
      label: 'Reviewer role',
      required: true,
      maxLength: 200,
      help: 'For example, the lawyer or pharmacist who reviewed these values.',
    },
    { name: 'evidenceRef', label: 'Evidence document reference (optional)', maxLength: 500 },
    {
      name: 'reason',
      label: 'Publication reason',
      type: 'textarea',
      required: true,
      minLength: 10,
      maxLength: 500,
    },
    {
      name: 'authenticationCode',
      label: 'Fresh MFA code',
      type: 'password',
      required: true,
      pattern: '[0-9]{6}',
      minLength: 6,
      maxLength: 6,
    },
  ];
}

export function JurisdictionRuleSets({ ruleSets }: { ruleSets: JurisdictionRuleSet[] }) {
  return (
    <div className="space-y-6">
      <PlatformPageHeading
        eyebrow="Governance / jurisdiction rules"
        title="Jurisdiction rule sets"
        description="Review published rules and draft a new effective-dated version after professional review."
      />
      <p className="text-sm text-text-muted">
        Published values cannot be edited. Drafts stay in this form until published; leaving the
        page discards them. Publication closes the previous version and records the reviewer and
        reason in the audit ledger. Branch owners must record a new regulatory profile to adopt new
        rules. Provisional enforced fields continue to block operation.
      </p>
      {!ruleSets.length ? (
        <SectionCard title="No rule sets published">
          <p className="text-sm text-text-muted">
            There is no existing jurisdiction to version. A platform jurisdiction must be
            provisioned before a successor can be drafted here.
          </p>
        </SectionCard>
      ) : (
        ruleSets.map((ruleSet) => (
          <SectionCard key={ruleSet.id} title={`${ruleSet.code} · version ${ruleSet.version}`}>
            <p className="mb-4 text-sm text-text-muted">
              Effective from{' '}
              <time dateTime={ruleSet.effectiveFrom.toISOString()}>
                {effectiveDate.format(ruleSet.effectiveFrom)} UTC
              </time>{' '}
              · until{' '}
              {ruleSet.effectiveTo ? (
                <time dateTime={ruleSet.effectiveTo.toISOString()}>
                  {effectiveDate.format(ruleSet.effectiveTo)} UTC
                </time>
              ) : (
                'superseded'
              )}
              {ruleSet.isPlaceholder ? ' · Emergency placeholder (read only)' : ''}
            </p>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {RULE_FIELDS.map((field) => (
                <div key={field} className="min-w-0">
                  <dt className="text-sm">{RULE_FIELD_LABELS[field]}</dt>
                  <dd className="mt-1">
                    <StatusPill
                      status={
                        ruleSetOptions(ruleSet[field]).provisional ? 'Provisional' : 'Confirmed'
                      }
                      tone={ruleSetOptions(ruleSet[field]).provisional ? 'warning' : 'success'}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <details className="mt-4">
              <summary className="cursor-pointer rounded-sm py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
                View all published fields and values
              </summary>
              <pre className="max-h-96 overflow-auto rounded-md bg-surface-sunken p-4 text-xs">
                {JSON.stringify(ruleSet, null, 2)}
              </pre>
            </details>
            {!ruleSet.isPlaceholder && ruleSet.effectiveTo === null ? (
              <details className="mt-4">
                <summary className="cursor-pointer rounded-sm py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
                  Draft version {ruleSet.version + 1}
                </summary>
                <PlatformCommandForm
                  action="jurisdiction.rules.publish"
                  fields={draftFields(ruleSet)}
                  submitLabel="Confirm and publish new version"
                  description="Review all seven fields. Every field starts provisional in this draft, including fields confirmed in the previous version."
                  confirm="Publish this immutable version and close the previous version at the chosen effective time? Existing branch profiles will keep their original rules."
                />
              </details>
            ) : null}
          </SectionCard>
        ))
      )}
    </div>
  );
}
