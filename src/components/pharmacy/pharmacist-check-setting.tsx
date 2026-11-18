'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  PHARMACIST_CHECK_DISCLAIMER,
  type PharmacistCheckPolicyView,
} from '@/lib/pharmacy/pharmacist-check';
import { trpc } from '@/lib/trpc';

type Notice = { tone: 'status' | 'alert'; text: string };

export type PharmacistCheckHistoryEntry = {
  id: string;
  newValue: boolean;
  changedAt: Date | string;
  actorName: string | null;
  acknowledgement: string | null;
};

function when(value: Date | string, timeZone?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/**
 * DEV-911 — the owner's switch for the pharmacist check and prescription record at each sale.
 * The server decides who may change it and enforces the result at every sale; this console
 * only shows the state and collects the owner's PIN and disclaimer.
 */
export function PharmacistCheckSetting({
  policy,
  canManage,
  disclaimerVersion,
  history,
  timeZone,
}: {
  policy: PharmacistCheckPolicyView;
  canManage: boolean;
  disclaimerVersion: string;
  history: readonly PharmacistCheckHistoryEntry[];
  timeZone?: string | null;
}) {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const on = policy.enabled;
  const save = trpc.pharmacyPharmacistCheck.setPolicy.useMutation({
    onSuccess: (result) => {
      setPin('');
      setAccepted(false);
      setNotice({
        tone: 'status',
        text: result.policy.enabled
          ? 'The pharmacist check is on again for every sale.'
          : 'The pharmacist check is off. Prescription-only and controlled medicines now sell without a pharmacist step.',
      });
      router.refresh();
    },
    onError: (error) => setNotice({ tone: 'alert', text: error.message }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || save.isPending) return;
    setNotice(null);
    if (!pin) {
      setNotice({ tone: 'alert', text: 'Enter your own PIN to confirm.' });
      return;
    }
    if (on && !accepted) {
      setNotice({ tone: 'alert', text: 'Tick the disclaimer before turning the check off.' });
      return;
    }
    save.mutate({
      enabled: !on,
      expectedVersion: policy.version,
      pin,
      ...(on ? { disclaimer: { accepted, version: disclaimerVersion } } : {}),
    });
  }

  const changed = policy.updatedAt
    ? ` Changed ${when(policy.updatedAt, timeZone)}${policy.updatedByName ? ` by ${policy.updatedByName}` : ''}.`
    : '';

  return (
    <div className="space-y-6">
      <SectionCard
        eyebrow="Owner setting"
        title="Pharmacist check and prescription record at each sale"
        titleLevel={2}
        actions={
          on ? (
            <StatusPill status="on" tone="success" label="On" />
          ) : (
            <StatusPill status="off" tone="warning" label="Switched off by the owner" />
          )
        }
      >
        <div className="space-y-4">
          {on ? (
            <p className="max-w-prose text-sm text-text-body">
              A prescription-only or controlled medicine is sold only after a pharmacist has checked
              it and a prescription has been recorded. Controlled medicines also need an independent
              pharmacist PIN and get a controlled register entry.
              {policy.source === 'FAIL_CLOSED'
                ? ' The stored setting could not be read, so the check stays on.'
                : changed}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="max-w-prose text-sm text-text-body">
                Prescription-only and controlled medicines are sold like any other item: no
                pharmacist signature, no prescription record and no refusal for a cashier. Every
                controlled sale still gets its controlled register entry, marked as written with the
                pharmacist check switched off by the owner.{changed}
              </p>
              <p className="max-w-prose text-sm text-text-muted">
                Refunds, discounts, expired stock, stock, tax and money checks are unchanged.
              </p>
            </div>
          )}

          {!canManage ? (
            <p className="text-sm text-text-muted">
              Only the pharmacy owner can change this setting.
            </p>
          ) : policy.source === 'FAIL_CLOSED' ? null : (
            <form className="space-y-4" onSubmit={submit} noValidate>
              {on ? (
                <div
                  className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/10 p-4"
                  role="note"
                  aria-labelledby="pharmacist-check-disclaimer-title"
                >
                  <p
                    className="text-sm font-semibold text-text-strong"
                    id="pharmacist-check-disclaimer-title"
                  >
                    {PHARMACIST_CHECK_DISCLAIMER.title}
                  </p>
                  <p className="mt-2 max-w-prose text-sm text-text-body">
                    {PHARMACIST_CHECK_DISCLAIMER.text}
                  </p>
                  <label className="mt-3 flex min-h-11 items-start gap-2 text-sm text-text-body">
                    <input
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      type="checkbox"
                      name="accepted"
                      checked={accepted}
                      onChange={(event) => setAccepted(event.target.checked)}
                      aria-invalid={notice?.tone === 'alert' && !accepted ? true : undefined}
                    />
                    {PHARMACIST_CHECK_DISCLAIMER.acknowledgement}
                  </label>
                </div>
              ) : (
                <p className="max-w-prose text-sm text-text-muted">
                  Turning the check back on applies straight away to every line, payment and sale
                  completion. Sales made while it was off keep that record.
                </p>
              )}
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="pharmacist-check-pin">Your PIN</Label>
                <Input
                  id="pharmacist-check-pin"
                  className="min-h-11"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  aria-invalid={notice?.tone === 'alert' && !pin ? true : undefined}
                />
              </div>
              <Button
                className="min-h-11"
                type="submit"
                variant={on ? 'destructive' : 'default'}
                disabled={save.isPending}
              >
                {save.isPending
                  ? 'Saving…'
                  : on
                    ? 'Turn the pharmacist check off'
                    : 'Turn the pharmacist check back on'}
              </Button>
            </form>
          )}

          {notice ? (
            <p
              role={notice.tone}
              className={
                notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'
              }
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      </SectionCard>

      {canManage ? (
        <SectionCard eyebrow="Audit" title="Change history" titleLevel={2}>
          {history.length === 0 ? (
            <p className="text-sm text-text-muted">
              Never changed. The pharmacist check has been on since this pharmacy started.
            </p>
          ) : (
            <ul className="space-y-3">
              {history.map((change) => (
                <li className="text-sm text-text-body" key={change.id}>
                  <span className="font-medium text-text-strong">
                    {change.newValue ? 'Turned on' : 'Turned off'}
                  </span>{' '}
                  · {when(change.changedAt, timeZone)} · {change.actorName ?? 'Unknown user'}
                  {!change.newValue && change.acknowledgement ? (
                    <span className="mt-1 block text-text-muted">
                      Disclaimer accepted: {change.acknowledgement}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
