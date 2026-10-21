'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { WorkspaceState } from './field';

const cell = 'px-2 py-1.5 align-top text-xs text-text-body';
const head =
  'px-2 py-1.5 text-left font-mono text-[0.65rem] tracking-wide text-text-muted uppercase';

export function ControlledRegisterConsole() {
  const page = useRef<HTMLDivElement>(null);
  const [printError, setPrintError] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [correctsEntryId, setCorrectsEntryId] = useState('');
  const [reason, setReason] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [balanceDelta, setBalanceDelta] = useState('0');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [pin, setPin] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const branches = trpc.pharmacySafety.branches.useQuery();
  const selected = branchId || branches.data?.[0]?.id || '';
  const register = trpc.pharmacySafety.controlledRegister.useQuery(
    { branchId: selected },
    { enabled: Boolean(selected) }
  );
  const pharmacists = trpc.pharmacySafety.controlledPharmacists.useQuery();
  const correct = trpc.pharmacySafety.recordCorrection.useMutation({
    onSuccess: async (result) => {
      if (result && 'blocked' in result) {
        setFormError(result.blocked);
        setPin('');
        return;
      }
      setReason('');
      setPin('');
      setFormError(null);
      await register.refetch();
    },
    onError: (error) => setFormError(error.message),
  });

  function printRegister() {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup || !page.current) {
      setPrintError(true);
      return;
    }
    popup.opener = null;
    popup.document.title = 'Controlled medicine register';
    const heading = popup.document.createElement('h1');
    heading.textContent = 'Controlled medicine register';
    const stamp = popup.document.createElement('p');
    stamp.textContent = `Printed ${new Date().toLocaleString()} · branch ${selected}`;
    const style = popup.document.createElement('style');
    style.textContent =
      '@page { size: landscape; margin: 12mm; } body { font: 11px sans-serif; color: #222; } table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #222; padding: 4px; text-align: left; vertical-align: top; } thead { display: table-header-group; } tr { break-inside: avoid; }';
    popup.document.head.append(style);
    popup.document.body.append(heading, stamp, page.current.cloneNode(true));
    popup.focus();
    popup.print();
    setPrintError(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          <Button
            type="button"
            variant="outline"
            className="h-9"
            disabled={!register.data?.entries.length}
            onClick={printRegister}
          >
            Print register
          </Button>
        }
        eyebrow="Pharmacy"
        heading="Controlled register"
        description="Append-only sales, purchases and corrections for this branch."
      />
      {printError ? (
        <p className="text-xs text-destructive" role="alert">
          Allow the print window, then try Print register again.
        </p>
      ) : null}
      <label className="block text-xs text-text-muted" htmlFor="register-branch">
        Branch
        <select
          id="register-branch"
          className="mt-1 h-9 w-full max-w-sm rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
          value={selected}
          onChange={(event) => setBranchId(event.target.value)}
        >
          {branches.data?.length ? null : <option value="">No branch</option>}
          {branches.data?.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </label>
      {branches.error ? (
        <p className="text-xs text-destructive" role="alert">
          {branches.error.message}
        </p>
      ) : null}
      {register.isLoading ? (
        <WorkspaceState title="Loading controlled register">Reading this branch.</WorkspaceState>
      ) : null}
      {register.error ? (
        <WorkspaceState title="Controlled register could not be loaded" tone="danger">
          {register.error.message}
        </WorkspaceState>
      ) : null}
      {register.data ? (
        <SectionCard title="Register" titleLevel={2}>
          {register.data.entries.length === 0 ? (
            <p className="text-xs text-text-muted">
              No rows yet. A sale or purchase of a controlled medicine adds the first one.
            </p>
          ) : (
            <div ref={page} className="overflow-x-auto">
              <table className="w-full min-w-[72rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {[
                      'S. No.',
                      'Date',
                      'Prescriber',
                      'Patient',
                      'Drug',
                      'Manufacturer',
                      'Qty',
                      'Batch',
                      'Qualified person',
                      'Balance',
                    ].map((label) => (
                      <th className={head} key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {register.data.entries.map((entry) => {
                    const drug =
                      entry.medicine?.productName ?? entry.line?.medicine.productName ?? '—';
                    const prescriber = entry.prescriber?.name ?? entry.prescriberName ?? '—';
                    const regNo =
                      entry.prescriber?.registrationNumber ?? entry.prescriberRegNo ?? '';
                    const open = entry.incidents.find((incident) => incident.status === 'OPEN');
                    return (
                      <tr className="border-b border-border-subtle" key={entry.id}>
                        <td className={`${cell} font-mono tabular-nums`}>{entry.serial}</td>
                        <td className={cell}>
                          {entry.createdAt.toLocaleString()}
                          <span className="mt-0.5 block text-text-muted">
                            {entry.entryKind === 'PURCHASE'
                              ? 'Purchase'
                              : entry.entryKind === 'CORRECTION'
                                ? `Correction of ${entry.correctsEntry?.serial ?? '—'}`
                                : entry.emergency
                                  ? 'Emergency sale'
                                  : 'Sale'}
                            {entry.refEntry ? ` · repeats ${entry.refEntry.serial}` : ''}
                          </span>
                        </td>
                        <td className={cell}>
                          {prescriber}
                          {regNo ? (
                            <span className="mt-0.5 block text-text-muted">{regNo}</span>
                          ) : null}
                        </td>
                        <td className={cell}>
                          {entry.patient?.displayName ?? entry.counterpartyName ?? '—'}
                          {entry.patientAddress ? (
                            <span className="mt-0.5 block text-text-muted">
                              {entry.patientAddress}
                            </span>
                          ) : null}
                        </td>
                        <td className={cell}>
                          {drug}
                          {entry.prescription?.sourceFileRef ? (
                            <span className="mt-0.5 block text-text-muted">
                              Rx {entry.prescription.sourceFileRef}
                              {entry.rxSerialWritten ? ' · serial written on Rx' : ''}
                            </span>
                          ) : null}
                          {entry.correctionReason ? (
                            <span className="mt-0.5 block text-text-muted">
                              {entry.correctionReason}
                            </span>
                          ) : null}
                        </td>
                        <td className={cell}>
                          {entry.manufacturer ?? entry.medicine?.manufacturer ?? '—'}
                        </td>
                        <td className={`${cell} text-right font-mono tabular-nums`}>
                          {entry.quantityCanonicalUnits}
                          {entry.balanceDelta ? (
                            <span className="mt-0.5 block text-text-muted">
                              {entry.balanceDelta > 0 ? '+' : ''}
                              {entry.balanceDelta}
                            </span>
                          ) : null}
                        </td>
                        <td className={`${cell} font-mono`}>{entry.batchNumber}</td>
                        <td className={`${cell} font-mono`}>
                          {entry.witnessedByUserId}
                          {entry.signatureRef ? (
                            <span className="mt-0.5 block text-text-muted">
                              {entry.signatureRef}
                            </span>
                          ) : null}
                          {open ? (
                            <span className="mt-0.5 block text-destructive">
                              Balance incident open
                            </span>
                          ) : null}
                        </td>
                        <td className={`${cell} text-right font-mono tabular-nums`}>
                          {entry.runningBalance}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {register.data.entries.length > 0 ? (
            <form
              className="mt-4 grid max-w-3xl gap-2 border-t border-border-subtle pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                setFormError(null);
                const quantityCanonicalUnits = Number(quantity);
                const delta = Number(balanceDelta);
                if (
                  !correctsEntryId ||
                  !Number.isInteger(quantityCanonicalUnits) ||
                  !Number.isInteger(delta)
                ) {
                  setFormError('Choose an entry and whole numbers for quantity and balance.');
                  return;
                }
                correct.mutate({
                  branchId: selected,
                  correctsEntryId,
                  correctionReason: reason.trim(),
                  quantityCanonicalUnits,
                  balanceDelta: delta,
                  staffProfileId,
                  pin,
                });
              }}
            >
              <p className="text-xs text-text-muted">
                Corrections are new rows. Earlier rows stay as they were written.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-text-muted" htmlFor="correct-entry">
                  Entry to correct
                  <select
                    id="correct-entry"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    value={correctsEntryId}
                    onChange={(event) => setCorrectsEntryId(event.target.value)}
                    required
                  >
                    <option value="">Select serial</option>
                    {register.data.entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.serial} · {entry.entryKind} · {entry.batchNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-text-muted" htmlFor="correct-pharmacist">
                  Qualified person
                  <select
                    id="correct-pharmacist"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    value={staffProfileId}
                    onChange={(event) => setStaffProfileId(event.target.value)}
                    required
                  >
                    <option value="">Select</option>
                    {pharmacists.data?.map((staff) => (
                      <option key={staff.id} value={staff.id}>
                        {staff.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-text-muted sm:col-span-2" htmlFor="correct-reason">
                  Reason
                  <input
                    id="correct-reason"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    minLength={3}
                  />
                </label>
                <label className="text-xs text-text-muted" htmlFor="correct-qty">
                  Quantity
                  <input
                    id="correct-qty"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    inputMode="numeric"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    required
                  />
                </label>
                <label className="text-xs text-text-muted" htmlFor="correct-delta">
                  Balance change
                  <input
                    id="correct-delta"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    inputMode="numeric"
                    value={balanceDelta}
                    onChange={(event) => setBalanceDelta(event.target.value)}
                    required
                  />
                </label>
                <label className="text-xs text-text-muted" htmlFor="correct-pin">
                  Pharmacist PIN
                  <input
                    id="correct-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    className="mt-1 h-9 w-full rounded-md border border-border-subtle bg-surface-raised px-2 text-sm text-text-strong"
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    required
                  />
                </label>
              </div>
              {formError ? (
                <p className="text-xs text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
              <Button
                type="submit"
                variant="outline"
                className="h-9 w-fit"
                disabled={correct.isPending}
              >
                {correct.isPending ? 'Saving…' : 'Add correction'}
              </Button>
            </form>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
