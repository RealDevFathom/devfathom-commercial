'use client';

import { forwardRef } from 'react';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';
import { formatReceiptDate } from '@/lib/pharmacy/counter-receipt';

export type CounterRxPanelProps = {
  controlled?: {
    prescriptionLineId: string;
    staffProfileId: string;
    pin: string;
    pharmacists: ReadonlyArray<{ id: string; name: string }>;
    loading: boolean;
    error: boolean;
    onChange: (field: 'prescriptionLineId' | 'staffProfileId' | 'pin', value: string) => void;
  };
  alerts: readonly CounterAlert[];
  patient: CounterPatientPanel | null;
  candidates: ReadonlyArray<{ patientId: string; displayName: string; phone: string | null }>;
  query: string;
  state: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  error?: string | null;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onSelectPatient: (patientId: string) => void;
  onClearPatient: () => void;
  onCapturePrescription?: (context: { patientId: string }) => void;
};

/**
 * POS-09 — the prescription and patient panel that sits beside the cart.
 *
 * Three rules the requirement states outright, implemented here rather than
 * assumed:
 *
 * 1. NO NAVIGATION AWAY. The panel is part of the counter layout; attaching a
 *    patient never leaves the bill.
 * 2. SAFETY BLOCKS LOOK DIFFERENT. A block gets the destructive surface, an
 *    alert role, and a stated remedy. Advice and commercial notices get quieter
 *    surfaces and `status`, so a promotion notice cannot be mistaken for a
 *    clinical stop — and no alert offers "acknowledge" as a way past a block.
 * 3. KEYBOARD-ADDRESSABLE AND DEDUPLICATED. Alerts arrive already deduplicated
 *    from `counterAlertsFor`; each one is a list item inside a labelled region
 *    the console can focus with a single chord.
 */
export const CounterRxPanel = forwardRef<HTMLDivElement, CounterRxPanelProps>(
  function CounterRxPanel(
    {
      controlled,
      alerts,
      patient,
      candidates,
      query,
      state,
      error,
      disabled = false,
      onQueryChange,
      onSearch,
      onSelectPatient,
      onClearPatient,
      onCapturePrescription,
    },
    ref
  ) {
    const blocks = alerts.filter((alert) => alert.severity === 'SAFETY_BLOCK');
    const advice = alerts.filter((alert) => alert.severity === 'CLINICAL_ADVICE');
    const commercial = alerts.filter((alert) => alert.severity === 'COMMERCIAL');

    return (
      <div ref={ref} tabIndex={-1} className="space-y-5 focus-visible:outline-none">
        {controlled ? (
          <section
            aria-label="Controlled medicine authorization"
            className="space-y-3 rounded-md border border-border-subtle p-3"
          >
            <h4 className="font-semibold text-text-strong">Controlled medicine authorization</h4>
            <p className="text-sm text-text-body">
              Attach a patient with ID on file, select the prescription, and ask an independent
              pharmacist to enter their PIN. Online only.
            </p>
            <Label htmlFor="controlled-prescription">Prescription line</Label>
            <select
              id="controlled-prescription"
              className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={disabled || !patient}
              value={controlled.prescriptionLineId}
              onChange={(event) => controlled.onChange('prescriptionLineId', event.target.value)}
            >
              <option value="">Select prescription</option>
              {patient?.prescriptions
                .filter((rx) => rx.inDate)
                .flatMap((rx) =>
                  rx.lines.map((line) => (
                    <option key={line.prescriptionLineId} value={line.prescriptionLineId}>
                      {line.medicineName} · {rx.prescriberName} · {line.remainingAuthorizedUnits}{' '}
                      units
                    </option>
                  ))
                )}
            </select>
            <Label htmlFor="controlled-pharmacist">Approving pharmacist</Label>
            <select
              id="controlled-pharmacist"
              className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={disabled || controlled.loading || controlled.error}
              value={controlled.staffProfileId}
              onChange={(event) => controlled.onChange('staffProfileId', event.target.value)}
            >
              <option value="">Select pharmacist</option>
              {controlled.pharmacists.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
            {controlled.loading ? (
              <p role="status">Loading pharmacists…</p>
            ) : controlled.error ? (
              <p role="alert">Pharmacists could not be loaded. Retry by refreshing the counter.</p>
            ) : controlled.pharmacists.length === 0 ? (
              <p role="status">
                No independent pharmacist with an active staff PIN is available. Ask your
                administrator to configure one.
              </p>
            ) : null}
            <Label htmlFor="controlled-pin">Pharmacist PIN</Label>
            <Input
              id="controlled-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              className="h-11"
              disabled={disabled || !controlled.staffProfileId}
              value={controlled.pin}
              onChange={(event) => controlled.onChange('pin', event.target.value)}
            />
            <p className="text-xs text-text-muted">
              PIN is cleared after each attempt. Five incorrect attempts lock the credential for 15
              minutes.
            </p>
          </section>
        ) : null}
        <section aria-label="Safety blocks" className="space-y-2">
          <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            Safety blocks
          </h4>
          {blocks.length === 0 ? (
            <p className="text-sm text-text-muted">
              No safety block on this bill. Lines may still carry advice below.
            </p>
          ) : (
            <ul className="space-y-2">
              {blocks.map((alert) => (
                <li
                  key={alert.key}
                  role="alert"
                  className="rounded-md border-l-4 border-destructive border-y border-r border-y-destructive/30 border-r-destructive/30 bg-destructive/10 p-3"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-strong">
                    <StatusPill status="blocked" tone="danger" label="Blocked" />
                    {alert.message}
                  </p>
                  {alert.remedy ? (
                    <p className="mt-1 text-sm text-text-body">{alert.remedy}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {advice.length > 0 ? (
          <section aria-label="Clinical advice" className="space-y-2">
            <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Counselling
            </h4>
            <ul className="space-y-2">
              {advice.map((alert) => (
                <li
                  key={alert.key}
                  role="status"
                  className="rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm text-text-body"
                >
                  <StatusPill status="advice" tone="info" label="Advice" />
                  <span className="ml-2">{alert.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {commercial.length > 0 ? (
          <section aria-label="Commercial notices" className="space-y-2">
            <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Commercial
            </h4>
            <ul className="space-y-2">
              {commercial.map((alert) => (
                <li
                  key={alert.key}
                  role="status"
                  className="rounded-md border border-dashed border-border-subtle p-3 text-sm text-text-muted"
                >
                  <StatusPill status="commercial" tone="neutral" label="Commercial" />
                  <span className="ml-2">{alert.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="Patient and prescriptions" className="space-y-3">
          <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            Patient
          </h4>

          {state === 'denied' ? (
            <p className="text-sm text-text-muted" role="status">
              Prescriptions are not enabled for this workspace. Commercial lines can still be sold;
              a prescription-only line will stay blocked.
            </p>
          ) : patient ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-strong">{patient.displayName}</p>
                  <p className="font-mono text-xs text-text-muted">
                    {patient.phone ?? '—'} · {patient.cnic ?? '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {patient.dispensingConsent ? (
                    <StatusPill status="consent" tone="success" label="Dispensing consent" />
                  ) : (
                    <StatusPill status="no-consent" tone="warning" label="No consent on file" />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled}
                    onClick={onClearPatient}
                  >
                    Detach
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {onCapturePrescription ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled || state === 'loading' || state === 'error'}
                    onClick={() => onCapturePrescription({ patientId: patient.patientId })}
                  >
                    Capture prescription
                  </Button>
                ) : disabled || state === 'loading' || state === 'error' ? (
                  <Button type="button" variant="outline" className="h-11" disabled>
                    Capture prescription
                  </Button>
                ) : (
                  <Link
                    className={buttonVariants({ variant: 'outline', className: 'h-11' })}
                    href={`/pharmacy/prescriptions#patientId=${encodeURIComponent(patient.patientId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    prefetch={false}
                  >
                    Capture prescription
                    <span className="sr-only"> for {patient.displayName} (opens in a new tab)</span>
                  </Link>
                )}
                <p className="text-xs text-text-muted">
                  {onCapturePrescription
                    ? `Capture evidence for ${patient.displayName}.`
                    : `Opens capture for ${patient.displayName} in a new tab. This bill stays open.`}{' '}
                  Capture does not replace pharmacist review or dispensing consent.
                </p>
              </div>

              {patient.prescriptions.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No prescription is on file for this patient.
                </p>
              ) : (
                <ul className="space-y-3">
                  {patient.prescriptions.map((prescription) => (
                    <li
                      key={prescription.prescriptionId}
                      className="rounded-md border border-border-subtle p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-text-strong">{prescription.prescriberName}</p>
                        {prescription.inDate ? (
                          <StatusPill status="valid" tone="success" label="In date" />
                        ) : (
                          <StatusPill status="expired" tone="danger" label="Outside validity" />
                        )}
                      </div>
                      <p className="font-mono text-xs text-text-muted">
                        {formatReceiptDate(prescription.validFrom)} →{' '}
                        {formatReceiptDate(prescription.validUntil)} · repeats{' '}
                        {prescription.authorizedRepeats} · {prescription.custodyState.toLowerCase()}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {prescription.lines.map((line) => (
                          <li
                            key={line.prescriptionLineId}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                          >
                            <span className="text-text-strong">{line.medicineName}</span>
                            <span className="font-mono tabular-nums text-text-muted">
                              {line.remainingAuthorizedUnits} of {line.authorizedCanonicalUnits}{' '}
                              units left
                            </span>
                            {line.verified ? (
                              <StatusPill
                                status="verified"
                                tone="success"
                                label="Pharmacist signed"
                              />
                            ) : (
                              <StatusPill
                                status="unverified"
                                tone="warning"
                                label={
                                  line.latestDecision
                                    ? `Awaiting sign · ${line.latestDecision.toLowerCase()}`
                                    : 'Awaiting pharmacist'
                                }
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                Select a patient to capture their prescription.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="counter-patient-search">Find patient</Label>
                <div className="flex gap-2">
                  <Input
                    id="counter-patient-search"
                    value={query}
                    autoComplete="off"
                    disabled={disabled}
                    placeholder="Name or phone"
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      onSearch();
                    }}
                    className="h-11"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled || query.trim().length < 2}
                    onClick={onSearch}
                  >
                    Search
                  </Button>
                </div>
              </div>

              {state === 'loading' ? (
                <p className="text-sm text-text-muted" role="status">
                  Searching patients…
                </p>
              ) : null}
              {state === 'error' ? (
                <p className="text-sm text-destructive" role="alert">
                  {error ?? 'Patient search failed.'}
                </p>
              ) : null}
              {state === 'ready' && candidates.length === 0 ? (
                <p className="text-sm text-text-muted">No patient matches that search.</p>
              ) : null}

              {candidates.map((candidate) => (
                <Button
                  key={candidate.patientId}
                  type="button"
                  variant="outline"
                  className="h-11 w-full justify-between"
                  disabled={disabled}
                  onClick={() => onSelectPatient(candidate.patientId)}
                >
                  <span className="truncate">{candidate.displayName}</span>
                  <span className="font-mono text-xs">{candidate.phone ?? ''}</span>
                </Button>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }
);
