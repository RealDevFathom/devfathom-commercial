'use client';

/**
 * PLAT-02 — the branch regulatory profile form and its effective-dated history.
 *
 * The three things this surface is careful about:
 *
 * - **No raw identifiers.** The branch and the province are pickers over this
 *   organization's own records and the published jurisdictions; nothing asks
 *   the operator to type an id (UX rules 1 and 16).
 * - **Errors land on fields.** The server publishes a rejection as
 *   `data.validation[field]`, and every one of those field names is a name in
 *   this form, so the message appears under the input, the input is marked
 *   `aria-invalid`, and the first bad field is focused (UX rule 11).
 * - **The province is the branch's.** A profile only puts its own branch in
 *   force, so the province is locked to the branch's province; when that
 *   province has no published rules the form says so instead of offering
 *   another province's rules (#977).
 * - **Nothing is a dead end.** A province whose rules are still provisional
 *   still lets the profile be recorded, and says plainly that the branch cannot
 *   operate until those rules are confirmed — rather than offering an empty
 *   licence-category select with no explanation (UX rule 12).
 *
 * The record itself is append-only: saving writes the next effective-dated
 * version and closes the previous one, which is why the history is listed
 * beside the form rather than hidden behind it.
 */
import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import {
  FISCAL_STATUSES,
  PROVISIONAL_LICENCE_CATEGORY,
  provinceName,
  regulatoryVersionStatusLabel,
  rulesNotPublishedMessage,
  sameProvince,
} from '@/lib/pharmacy/regulatory-profile-form';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { AppRouter } from '@/server/routers/_app';

type Regulatory = inferRouterOutputs<AppRouter>['pharmacyOnboarding']['regulatory'];
type Jurisdiction = Regulatory['jurisdictions'][number];
type Version = Regulatory['versions'][number];

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const controlClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm text-text-body focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const day = (value: Date | string) => dayFormat.format(new Date(value));
const isoDay = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

/** A labelled field that shows its own error, or its own hint when there is none. */
function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function PharmacyRegulatoryProfileForm({ initial }: { initial: Regulatory }) {
  const [data, setData] = useState<Regulatory>(initial);
  const [branchId, setBranchId] = useState<string>(initial.selectedBranchId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [evidenceRef, setEvidenceRef] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const utils = trpc.useUtils();
  const refresh = (nextBranchId = branchId) => {
    void utils.pharmacyOnboarding.regulatory
      .fetch({ branchId: nextBranchId || undefined })
      .then(setData)
      .catch(() => setErrors({ form: 'That branch could not be loaded. Try again.' }));
  };

  const save = trpc.pharmacyOnboarding.saveRegulatoryProfile.useMutation({
    onSuccess: (result) => {
      setErrors({});
      setSaved(
        `Version ${result.version} saved. ${
          result.readiness.items.find((item) => item.key === 'PREMISES_AND_LICENCES')?.state ===
          'DONE'
            ? 'Premises and licences is now marked done on your setup steps.'
            : 'Premises and licences is still outstanding — the reason is on your setup steps.'
        }`
      );
      refresh();
    },
    onError: (error) => {
      const validation = (error.data?.validation ?? null) as Record<
        string,
        string[] | undefined
      > | null;
      const next: Record<string, string> = {};
      for (const [field, messages] of Object.entries(validation ?? {})) {
        if (messages?.[0]) next[field] = messages[0];
      }
      if (Object.keys(next).length === 0) next.form = error.message;
      setErrors(next);
      setSaved(null);
      // Focus the first field the server complained about, so the operator does
      // not have to hunt for it on a long form.
      const first = Object.keys(next)[0];
      if (first && first !== 'form') {
        formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      }
    },
  });

  const selectBranch = (nextBranchId: string) => {
    setBranchId(nextBranchId);
    setErrors({});
    setSaved(null);
    refresh(nextBranchId);
  };

  const branch = data.branches.find((candidate) => candidate.id === branchId);
  const jurisdiction: Jurisdiction | undefined = branch
    ? data.jurisdictions.find((candidate) =>
        sameProvince(candidate.provinceCode, branch.provinceCode)
      )
    : undefined;
  const provinceCode = jurisdiction?.provinceCode ?? branch?.provinceCode ?? '';
  const rulesMissing = Boolean(branch) && !jurisdiction;
  const categories = jurisdiction?.licenceCategories ?? [];
  const schedules = jurisdiction?.permittedSchedules ?? [];
  const current = data.versions.find((version) => version.effective);
  const inForce = data.versions.find((version) => version.inForce);

  async function uploadEvidence(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/upload', { method: 'POST', body });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        setUploadError(detail?.error ?? 'That file could not be uploaded. Try a PDF or an image.');
        return;
      }
      const uploaded = (await response.json()) as { url: string };
      setEvidenceRef(uploaded.url);
      setErrors((previous) => {
        const next = { ...previous };
        delete next.licenceEvidenceFileRef;
        return next;
      });
    } catch {
      setUploadError('That file could not be uploaded. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const number = (name: string) => Number(form.get(name) ?? Number.NaN);
    save.mutate({
      branchId,
      effectiveFrom: text('effectiveFrom'),
      provinceCode: text('provinceCode'),
      premisesAddressLine: text('premisesAddressLine'),
      premisesCity: text('premisesCity'),
      premisesPhone: text('premisesPhone'),
      premisesStorageDescription: text('premisesStorageDescription'),
      licenceCategory: text('licenceCategory'),
      licenceNumber: text('licenceNumber'),
      licenceValidFrom: text('licenceValidFrom'),
      licenceValidTo: text('licenceValidTo'),
      licenceEvidenceFileRef: evidenceRef,
      permittedSchedules: form.getAll('permittedSchedules').map(String),
      qualifiedPersonRegistration: text('qualifiedPersonRegistration'),
      qualifiedPersonValidFrom: text('qualifiedPersonValidFrom'),
      qualifiedPersonValidTo: text('qualifiedPersonValidTo'),
      qualifiedPersonCoverageRosterRef: text('qualifiedPersonCoverageRosterRef'),
      ntn: text('ntn'),
      strn: text('strn'),
      fiscalStatus: text('fiscalStatus') as (typeof FISCAL_STATUSES)[number]['value'],
      retentionPrescriptionYears: number('retentionPrescriptionYears'),
      retentionInvoiceYears: number('retentionInvoiceYears'),
      retentionControlledRegisterYears: number('retentionControlledRegisterYears'),
    });
  }

  if (data.branches.length === 0) {
    return (
      <SectionCard title="No pharmacy branch yet" titleLevel={2}>
        <p className="text-sm text-text-body">
          A regulatory profile belongs to a branch, and this workspace has none. Your DevFathom
          account manager creates the first branch with the workspace — ask them to add it, and this
          page will be ready to fill in.
        </p>
        <Link
          className="mt-3 inline-flex min-h-9 items-center text-sm font-medium text-primary underline underline-offset-4 hover:text-accent-brand"
          href="/pharmacy"
        >
          Back to your setup steps
        </Link>
      </SectionCard>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <SectionCard
        eyebrow="PLAT-02"
        title="Branch"
        titleLevel={2}
        actions={
          inForce ? (
            <StatusPill status="In force" tone="success" />
          ) : current ? (
            <StatusPill status="Not in force" tone="warning" />
          ) : (
            <StatusPill status="No profile" tone="warning" />
          )
        }
      >
        <Field
          htmlFor="branch-select"
          hint="Only branches in this workspace appear here."
          label="Which branch is this profile for?"
        >
          <select
            className={controlClass}
            id="branch-select"
            onChange={(event) => selectBranch(event.target.value)}
            value={branchId}
          >
            {data.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name} — {branch.city}
              </option>
            ))}
          </select>
        </Field>
        {inForce?.premisesCompletionDue ? (
          <p
            className="mt-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-text-body"
            role="status"
          >
            Finish this profile: the version in force is a platform placeholder that does not record
            your premises address and city. It still counts toward activation for now — record a
            version with your real licence and premises below to complete it.
          </p>
        ) : null}
        {inForce ? (
          <p className="mt-4 text-sm text-text-muted">
            Version {inForce.version} is in force from {day(inForce.effectiveFrom)}: licence{' '}
            {inForce.licenceNumber} ({inForce.licenceCategory}) valid to{' '}
            {day(inForce.licenceValidTo)}, qualified person {inForce.qualifiedPersonRegistration}{' '}
            covered to {day(inForce.qualifiedPersonValidTo)}.
          </p>
        ) : current ? (
          <p className="mt-4 text-sm text-text-muted">
            Version {current.version} is not in force.
            {current.licenceExpired
              ? ` Licence ${current.licenceNumber} expired on ${day(current.licenceValidTo)}.`
              : null}
            {current.qualifiedPersonCoverageExpired
              ? ` Qualified-person cover expired on ${day(current.qualifiedPersonValidTo)}.`
              : null}{' '}
            Dispensing and activation are refused until a valid version is recorded.
          </p>
        ) : (
          <p className="mt-4 text-sm text-text-muted">
            This branch has no regulatory profile in force. Until it does, dispensing and activation
            are refused — not warned about.
          </p>
        )}
      </SectionCard>

      <SectionCard
        eyebrow="Effective-dated"
        title={inForce ? 'Record the next version' : 'Record the first version'}
        titleLevel={2}
      >
        <p className="mb-4 text-sm text-text-muted">
          A regulatory profile is never edited. Saving records a new version from the date you
          choose and closes the one before it, so the record of what was true on any past day
          survives.
        </p>
        {errors.form ? (
          <p
            className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {errors.form}
          </p>
        ) : null}
        {saved ? (
          <p
            className="mb-4 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success"
            role="status"
          >
            {saved}
          </p>
        ) : null}
        {rulesMissing ? (
          <p
            className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-text-body"
            role="status"
          >
            {rulesNotPublishedMessage(provinceCode)} Your DevFathom account manager can tell you
            when they are.
          </p>
        ) : null}
        <form className="space-y-6" noValidate onSubmit={submit} ref={formRef}>
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-display text-base font-semibold text-text-strong">
              Jurisdiction and premises
            </legend>
            <Field
              error={errors.effectiveFrom}
              htmlFor="effectiveFrom"
              hint="The day this version starts applying."
              label="Effective from"
            >
              <Input
                aria-describedby={errors.effectiveFrom ? 'effectiveFrom-error' : undefined}
                aria-invalid={errors.effectiveFrom ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={isoDay(new Date())}
                id="effectiveFrom"
                name="effectiveFrom"
                required
                type="date"
              />
            </Field>
            <Field
              error={errors.provinceCode}
              htmlFor="provinceCode"
              hint={
                rulesMissing
                  ? rulesNotPublishedMessage(provinceCode)
                  : jurisdiction?.provisional
                    ? 'These rules are still provisional, so this branch cannot operate on them yet.'
                    : 'Set by the branch — a profile always names the province its branch operates in.'
              }
              label="Province"
            >
              <select
                aria-describedby={errors.provinceCode ? 'provinceCode-error' : undefined}
                aria-invalid={errors.provinceCode ? true : undefined}
                className={controlClass}
                id="provinceCode"
                name="provinceCode"
              >
                <option value={provinceCode}>
                  {provinceName(provinceCode)}
                  {rulesMissing
                    ? ' (rules not published yet)'
                    : jurisdiction?.provisional
                      ? ' (rules provisional)'
                      : ''}
                </option>
              </select>
            </Field>
            <Field
              error={errors.premisesAddressLine}
              htmlFor="premisesAddressLine"
              label="Premises address"
            >
              <Input
                aria-describedby={
                  errors.premisesAddressLine ? 'premisesAddressLine-error' : undefined
                }
                aria-invalid={errors.premisesAddressLine ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={
                  data.branches.find((branch) => branch.id === branchId)?.addressLine ?? ''
                }
                id="premisesAddressLine"
                name="premisesAddressLine"
                required
              />
            </Field>
            <Field error={errors.premisesCity} htmlFor="premisesCity" label="Premises city">
              <Input
                aria-describedby={errors.premisesCity ? 'premisesCity-error' : undefined}
                aria-invalid={errors.premisesCity ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={data.branches.find((branch) => branch.id === branchId)?.city ?? ''}
                id="premisesCity"
                name="premisesCity"
                required
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                error={errors.premisesPhone}
                htmlFor="premisesPhone"
                hint="Printed on customer receipts when provided."
                label="Pharmacy phone (optional)"
              >
                <Input
                  aria-describedby={errors.premisesPhone ? 'premisesPhone-error' : undefined}
                  aria-invalid={errors.premisesPhone ? true : undefined}
                  className="mt-1 min-h-11"
                  id="premisesPhone"
                  maxLength={60}
                  name="premisesPhone"
                  type="tel"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                error={errors.premisesStorageDescription}
                htmlFor="premisesStorageDescription"
                hint="Cold chain, controlled-drug cabinet, general shelving — what an inspector would want described."
                label="Medicine storage at these premises"
              >
                <Textarea
                  aria-describedby={
                    errors.premisesStorageDescription
                      ? 'premisesStorageDescription-error'
                      : undefined
                  }
                  aria-invalid={errors.premisesStorageDescription ? true : undefined}
                  className="mt-1"
                  id="premisesStorageDescription"
                  name="premisesStorageDescription"
                  required
                  rows={3}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-display text-base font-semibold text-text-strong">
              Licence
            </legend>
            <Field
              error={errors.licenceCategory}
              htmlFor="licenceCategory"
              hint={
                categories.length === 0
                  ? 'This province has not published its licence categories yet, so the profile records a provisional one.'
                  : undefined
              }
              label="Licence category"
            >
              <select
                aria-describedby={errors.licenceCategory ? 'licenceCategory-error' : undefined}
                aria-invalid={errors.licenceCategory ? true : undefined}
                className={controlClass}
                id="licenceCategory"
                name="licenceCategory"
              >
                {categories.length === 0 ? (
                  <option value={PROVISIONAL_LICENCE_CATEGORY}>
                    Provisional — awaiting published categories
                  </option>
                ) : (
                  categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))
                )}
              </select>
            </Field>
            <Field error={errors.licenceNumber} htmlFor="licenceNumber" label="Licence number">
              <Input
                aria-describedby={errors.licenceNumber ? 'licenceNumber-error' : undefined}
                aria-invalid={errors.licenceNumber ? true : undefined}
                className="mt-1 min-h-11"
                id="licenceNumber"
                name="licenceNumber"
                required
              />
            </Field>
            <Field
              error={errors.licenceValidFrom}
              htmlFor="licenceValidFrom"
              label="Licence valid from"
            >
              <Input
                aria-describedby={errors.licenceValidFrom ? 'licenceValidFrom-error' : undefined}
                aria-invalid={errors.licenceValidFrom ? true : undefined}
                className="mt-1 min-h-11"
                id="licenceValidFrom"
                name="licenceValidFrom"
                required
                type="date"
              />
            </Field>
            <Field error={errors.licenceValidTo} htmlFor="licenceValidTo" label="Licence valid to">
              <Input
                aria-describedby={errors.licenceValidTo ? 'licenceValidTo-error' : undefined}
                aria-invalid={errors.licenceValidTo ? true : undefined}
                className="mt-1 min-h-11"
                id="licenceValidTo"
                name="licenceValidTo"
                required
                type="date"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                error={errors.licenceEvidenceFileRef ?? uploadError ?? undefined}
                htmlFor="licenceEvidence"
                hint="A PDF or photograph of the licence. Stored against this workspace only."
                label="Licence evidence"
              >
                <input
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  className={cn(controlClass, 'py-2 file:mr-3 file:text-sm')}
                  disabled={uploading}
                  id="licenceEvidence"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadEvidence(file);
                  }}
                  type="file"
                />
                <input name="licenceEvidenceFileRef" type="hidden" value={evidenceRef} />
                <p aria-live="polite" className="mt-1 text-xs text-text-muted">
                  {uploading
                    ? 'Uploading…'
                    : evidenceRef
                      ? 'Licence evidence attached.'
                      : 'No evidence attached yet.'}
                </p>
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                error={errors.permittedSchedules}
                htmlFor="permittedSchedules"
                hint={
                  schedules.length === 0
                    ? 'This province has not published its medicine schedules yet, so none can be permitted on this version.'
                    : 'Tick every schedule this branch is permitted to hold.'
                }
                label="Permitted schedules"
              >
                {schedules.length === 0 ? (
                  <p className="mt-1 text-sm text-text-muted">
                    Nothing to choose yet — this version records no permitted schedules.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-3" id="permittedSchedules">
                    {schedules.map((schedule) => (
                      <label
                        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 text-sm"
                        key={schedule}
                      >
                        <input name="permittedSchedules" type="checkbox" value={schedule} />
                        {schedule}
                      </label>
                    ))}
                  </div>
                )}
              </Field>
            </div>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-display text-base font-semibold text-text-strong">
              Qualified person
            </legend>
            <Field
              error={errors.qualifiedPersonRegistration}
              htmlFor="qualifiedPersonRegistration"
              label="Registration number"
            >
              <Input
                aria-describedby={
                  errors.qualifiedPersonRegistration
                    ? 'qualifiedPersonRegistration-error'
                    : undefined
                }
                aria-invalid={errors.qualifiedPersonRegistration ? true : undefined}
                className="mt-1 min-h-11"
                id="qualifiedPersonRegistration"
                name="qualifiedPersonRegistration"
                required
              />
            </Field>
            <Field
              error={errors.qualifiedPersonCoverageRosterRef}
              htmlFor="qualifiedPersonCoverageRosterRef"
              hint="Where the roster showing their hours at this branch is kept."
              label="Coverage roster"
            >
              <Input
                aria-describedby={
                  errors.qualifiedPersonCoverageRosterRef
                    ? 'qualifiedPersonCoverageRosterRef-error'
                    : undefined
                }
                aria-invalid={errors.qualifiedPersonCoverageRosterRef ? true : undefined}
                className="mt-1 min-h-11"
                id="qualifiedPersonCoverageRosterRef"
                name="qualifiedPersonCoverageRosterRef"
                required
              />
            </Field>
            <Field
              error={errors.qualifiedPersonValidFrom}
              htmlFor="qualifiedPersonValidFrom"
              label="Registered from"
            >
              <Input
                aria-describedby={
                  errors.qualifiedPersonValidFrom ? 'qualifiedPersonValidFrom-error' : undefined
                }
                aria-invalid={errors.qualifiedPersonValidFrom ? true : undefined}
                className="mt-1 min-h-11"
                id="qualifiedPersonValidFrom"
                name="qualifiedPersonValidFrom"
                required
                type="date"
              />
            </Field>
            <Field
              error={errors.qualifiedPersonValidTo}
              htmlFor="qualifiedPersonValidTo"
              label="Registered to"
            >
              <Input
                aria-describedby={
                  errors.qualifiedPersonValidTo ? 'qualifiedPersonValidTo-error' : undefined
                }
                aria-invalid={errors.qualifiedPersonValidTo ? true : undefined}
                className="mt-1 min-h-11"
                id="qualifiedPersonValidTo"
                name="qualifiedPersonValidTo"
                required
                type="date"
              />
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-display text-base font-semibold text-text-strong">
              Tax and retention
            </legend>
            <Field error={errors.ntn} htmlFor="ntn" hint="Optional." label="NTN">
              <Input className="mt-1 min-h-11" id="ntn" name="ntn" />
            </Field>
            <Field error={errors.strn} htmlFor="strn" hint="Optional." label="STRN">
              <Input className="mt-1 min-h-11" id="strn" name="strn" />
            </Field>
            <Field error={errors.fiscalStatus} htmlFor="fiscalStatus" label="Fiscal status">
              <select
                aria-describedby={errors.fiscalStatus ? 'fiscalStatus-error' : undefined}
                aria-invalid={errors.fiscalStatus ? true : undefined}
                className={controlClass}
                id="fiscalStatus"
                name="fiscalStatus"
              >
                {FISCAL_STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              error={errors.retentionPrescriptionYears}
              htmlFor="retentionPrescriptionYears"
              label="Keep prescriptions (years)"
            >
              <Input
                aria-describedby={
                  errors.retentionPrescriptionYears ? 'retentionPrescriptionYears-error' : undefined
                }
                aria-invalid={errors.retentionPrescriptionYears ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={5}
                id="retentionPrescriptionYears"
                max={30}
                min={1}
                name="retentionPrescriptionYears"
                required
                type="number"
              />
            </Field>
            <Field
              error={errors.retentionInvoiceYears}
              htmlFor="retentionInvoiceYears"
              label="Keep invoices (years)"
            >
              <Input
                aria-describedby={
                  errors.retentionInvoiceYears ? 'retentionInvoiceYears-error' : undefined
                }
                aria-invalid={errors.retentionInvoiceYears ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={6}
                id="retentionInvoiceYears"
                max={30}
                min={1}
                name="retentionInvoiceYears"
                required
                type="number"
              />
            </Field>
            <Field
              error={errors.retentionControlledRegisterYears}
              htmlFor="retentionControlledRegisterYears"
              label="Keep controlled-drug register (years)"
            >
              <Input
                aria-describedby={
                  errors.retentionControlledRegisterYears
                    ? 'retentionControlledRegisterYears-error'
                    : undefined
                }
                aria-invalid={errors.retentionControlledRegisterYears ? true : undefined}
                className="mt-1 min-h-11"
                defaultValue={10}
                id="retentionControlledRegisterYears"
                max={30}
                min={1}
                name="retentionControlledRegisterYears"
                required
                type="number"
              />
            </Field>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            {/* Not disabled when `rulesMissing`: that reads the rules in force today,
                while the server checks the date this version takes effect, so a
                province whose rules start later can still be recorded for that date. */}
            <Button disabled={save.isPending || uploading} type="submit">
              {save.isPending ? 'Saving…' : 'Save this version'}
            </Button>
            <Link
              className="text-sm font-medium text-primary underline underline-offset-4 hover:text-accent-brand"
              href="/pharmacy"
            >
              Back to your setup steps
            </Link>
          </div>
        </form>
      </SectionCard>

      <VersionHistory versions={data.versions} />
    </div>
  );
}

function VersionHistory({ versions }: { versions: readonly Version[] }) {
  const now = new Date();
  return (
    <SectionCard title="Effective-dated versions" titleLevel={2}>
      {versions.length === 0 ? (
        <p className="text-sm text-text-muted">
          No versions yet. The first one you save appears here, and every later one is added beside
          it rather than replacing it.
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                {['Version', 'From', 'To', 'Province', 'Licence', 'Qualified person', ''].map(
                  (heading, index) => (
                    <th
                      className="py-2 pr-4 font-mono text-[0.6875rem] font-semibold tracking-wide text-text-muted uppercase"
                      key={heading || `status-${index}`}
                      scope="col"
                    >
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr className="border-b border-border-subtle last:border-b-0" key={version.id}>
                  <td className="py-2 pr-4 tabular-nums">{version.version}</td>
                  <td className="py-2 pr-4">{day(version.effectiveFrom)}</td>
                  <td className="py-2 pr-4">
                    {version.effectiveTo ? day(version.effectiveTo) : 'Open-ended'}
                  </td>
                  <td className="py-2 pr-4">{version.provinceName}</td>
                  <td className="py-2 pr-4">
                    {version.licenceNumber}
                    <span className="block text-xs text-text-muted">
                      {version.licenceCategory} · to {day(version.licenceValidTo)}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {version.qualifiedPersonRegistration}
                    <span className="block text-xs text-text-muted">
                      to {day(version.qualifiedPersonValidTo)}
                    </span>
                  </td>
                  <td className="py-2">
                    <StatusPill
                      status={regulatoryVersionStatusLabel(version, now)}
                      tone={version.inForce ? 'success' : version.effective ? 'warning' : 'neutral'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
