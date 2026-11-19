'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  RX_SOLO_SHIFT_DISCLAIMER,
  type RxDeclaredSoloSignOff,
  type RxSoloShiftBranchView,
} from '@/lib/pharmacy/rx-solo-shift';
import { trpc } from '@/lib/trpc';

type Notice = { tone: 'status' | 'alert'; text: string };

export type RxSoloShiftHistoryEntry = {
  id: string;
  branchId: string;
  enabled: boolean;
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
 * DEV-960 — the owner's per-branch switch "One pharmacist per shift", the declared solo sign-offs
 * it allowed, and its change history. The server decides who may change it and enforces it at
 * every signature; this console only shows the state and collects the owner's PIN and statement.
 */
export function RxSoloShiftSetting({
  branches,
  disclaimerVersion,
  signOffs,
  history,
  timeZone,
}: {
  branches: readonly RxSoloShiftBranchView[];
  disclaimerVersion: string;
  signOffs: readonly RxDeclaredSoloSignOff[];
  history: readonly RxSoloShiftHistoryEntry[];
  timeZone?: string | null;
}) {
  const branchName = new Map(branches.map((branch) => [branch.branchId, branch.branchName]));
  return (
    <div className="space-y-6">
      {branches.length === 0 ? (
        <SectionCard eyebrow="Owner setting" title="No active branches" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Add a branch under Settings, Branches. Each branch then gets its own switch here.
          </p>
        </SectionCard>
      ) : (
        branches.map((branch) => (
          <BranchSwitch
            key={branch.branchId}
            branch={branch}
            disclaimerVersion={disclaimerVersion}
            timeZone={timeZone}
          />
        ))
      )}

      <SectionCard eyebrow="Audit" title="Declared solo sign-offs" titleLevel={2}>
        <p className="mb-4 max-w-prose text-sm text-text-muted">
          Each prescription check a pharmacist signed alone by declaring they were the only
          pharmacist on duty, with the other pharmacists who were on the staff list at that moment.
        </p>
        {signOffs.length === 0 ? (
          <p className="text-sm text-text-muted">
            No declared solo sign-offs yet. They appear here as soon as a pharmacist signs one at a
            branch where “One pharmacist per shift” is on.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border font-mono text-xs uppercase text-text-muted">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Signed
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Pharmacist
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Sale and line
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Others on the staff list
                  </th>
                </tr>
              </thead>
              <tbody>
                {signOffs.map((row) => (
                  <tr
                    key={row.auditId}
                    className="border-b border-border align-top last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">{when(row.signedAt, timeZone)}</td>
                    <td className="px-4 py-3">{row.signerName ?? 'Unknown user'}</td>
                    <td className="px-4 py-3">
                      {row.branchName ??
                        (row.branchId ? branchName.get(row.branchId) : null) ??
                        'Unknown branch'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="block">
                        {row.receiptNumber !== null
                          ? `Receipt ${row.receiptNumber}`
                          : row.saleId
                            ? `Sale ${row.saleId.slice(-8)}`
                            : 'Unknown sale'}
                      </span>
                      <span className="block text-text-muted">
                        {row.productName ?? 'Unknown line'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.otherSigners.length === 0
                        ? 'Nobody else'
                        : row.otherSigners
                            .map((signer) => signer.name ?? 'Unnamed member')
                            .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Audit" title="Change history" titleLevel={2}>
        {history.length === 0 ? (
          <p className="text-sm text-text-muted">
            Never changed. “One pharmacist per shift” has been off at every branch.
          </p>
        ) : (
          <ul className="space-y-3">
            {history.map((change) => (
              <li className="text-sm text-text-body" key={change.id}>
                <span className="font-medium text-text-strong">
                  {change.enabled ? 'Turned on' : 'Turned off'}
                </span>{' '}
                · {branchName.get(change.branchId) ?? 'Branch'} · {when(change.changedAt, timeZone)}{' '}
                · {change.actorName ?? 'Unknown user'}
                {change.enabled && change.acknowledgement ? (
                  <span className="mt-1 block text-text-muted">
                    Statement accepted: {change.acknowledgement}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function BranchSwitch({
  branch,
  disclaimerVersion,
  timeZone,
}: {
  branch: RxSoloShiftBranchView;
  disclaimerVersion: string;
  timeZone?: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const on = branch.enabled;
  const save = trpc.pharmacyRxSoloShift.setPolicy.useMutation({
    onSuccess: (result) => {
      setPin('');
      setAccepted(false);
      setNotice({
        tone: 'status',
        text: result.enabled
          ? `“One pharmacist per shift” is on at ${branch.branchName}.`
          : `“One pharmacist per shift” is off at ${branch.branchName}. Lines are signed by the staff-list rule again.`,
      });
      router.refresh();
    },
    onError: (error) => setNotice({ tone: 'alert', text: error.message }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    setNotice(null);
    if (!pin) {
      setNotice({ tone: 'alert', text: 'Enter your own PIN to confirm.' });
      return;
    }
    if (!on && !accepted) {
      setNotice({ tone: 'alert', text: 'Tick the statement before turning this on.' });
      return;
    }
    save.mutate({
      branchId: branch.branchId,
      enabled: !on,
      expectedVersion: branch.version,
      pin,
      ...(on ? {} : { disclaimer: { accepted, version: disclaimerVersion } }),
    });
  }

  const changed = branch.updatedAt
    ? ` Changed ${when(branch.updatedAt, timeZone)}${branch.updatedByName ? ` by ${branch.updatedByName}` : ''}.`
    : '';

  return (
    <SectionCard
      eyebrow={`Branch · ${branch.branchCode}`}
      title={branch.branchName}
      titleLevel={2}
      actions={
        on ? (
          <StatusPill status="on" tone="warning" label="On" />
        ) : (
          <StatusPill status="off" tone="neutral" label="Off" />
        )
      }
    >
      <div className="space-y-4">
        {on ? (
          <p className="max-w-prose text-sm text-text-body">
            The pharmacist who rang up a prescription line here may sign its check alone, with their
            own PIN, by declaring they are the only pharmacist on duty now. Each such sign-off is
            listed below. Controlled medicines still need an independent pharmacist.{changed}
          </p>
        ) : (
          <p className="max-w-prose text-sm text-text-body">
            A pharmacist signs their own prescription line only when nobody else on this branch’s
            staff list could sign it.
            {branch.source === 'FAIL_CLOSED'
              ? ' The stored setting could not be read, so it stays off.'
              : changed}
          </p>
        )}

        {branch.source === 'FAIL_CLOSED' ? null : (
          <form className="space-y-4" onSubmit={submit} noValidate>
            {on ? (
              <p className="max-w-prose text-sm text-text-muted">
                Turning it off applies straight away to the next signature. Sign-offs already
                declared stay on the list.
              </p>
            ) : (
              <div
                className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/10 p-4"
                role="note"
                aria-labelledby={`${id}-statement-title`}
              >
                <p className="text-sm font-semibold text-text-strong" id={`${id}-statement-title`}>
                  {RX_SOLO_SHIFT_DISCLAIMER.title}
                </p>
                <p className="mt-2 max-w-prose text-sm text-text-body">
                  {RX_SOLO_SHIFT_DISCLAIMER.text}
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
                  {RX_SOLO_SHIFT_DISCLAIMER.acknowledgement}
                </label>
              </div>
            )}
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor={`${id}-pin`}>Your PIN</Label>
              <Input
                id={`${id}-pin`}
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
              variant={on ? 'default' : 'destructive'}
              disabled={save.isPending}
              aria-busy={save.isPending}
            >
              {save.isPending
                ? 'Saving…'
                : on
                  ? 'Turn “One pharmacist per shift” off'
                  : 'Turn “One pharmacist per shift” on'}
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
            <PinAwareMessage message={notice.text} />
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
