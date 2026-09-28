'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { WorkspaceState } from './field';

export function ControlledRegisterConsole() {
  const page = useRef<HTMLDivElement>(null);
  const [printError, setPrintError] = useState(false);
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
    stamp.textContent = `Printed ${new Date().toLocaleString()} · quantities and lot balances in canonical units`;
    const style = popup.document.createElement('style');
    style.textContent =
      '@page { size: landscape; margin: 12mm; } body { font: 11px sans-serif; } table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid; padding: 5px; text-align: left; } thead { display: table-header-group; } tr { break-inside: avoid; }';
    popup.document.head.append(style);
    popup.document.body.append(heading, stamp, page.current.cloneNode(true));
    popup.focus();
    popup.print();
    setPrintError(false);
  }
  const register = trpc.pharmacySafety.controlledRegister.useQuery();
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            type="button"
            className="h-11"
            disabled={register.isFetching || !!register.error || !register.data?.entries.length}
            onClick={printRegister}
          >
            Print register
          </Button>
        }
        eyebrow="Pharmacy · RX-05"
        heading="Controlled register"
        description="An append-only, dual-control view reconciled against the stock ledger."
      />
      {printError ? (
        <p role="alert">Allow the print window, then try Print register again.</p>
      ) : null}
      {register.isLoading ? (
        <WorkspaceState title="Loading controlled register">
          Reconciling register entries and incidents.
        </WorkspaceState>
      ) : null}
      {register.error ? (
        <WorkspaceState title="Controlled register could not be loaded" tone="danger">
          {register.error.message}
        </WorkspaceState>
      ) : null}
      {register.data ? (
        <SectionCard title="Register entries" titleLevel={2}>
          {register.data.entries.length === 0 ? (
            <WorkspaceState title="No controlled entries">
              Entries appear after a controlled or restricted medicine is dispensed under dual
              control.
            </WorkspaceState>
          ) : (
            <div ref={page} className="overflow-x-auto">
              <table className="w-full min-w-[68rem] text-left text-sm">
                <thead className="font-mono text-[0.65rem] tracking-wide text-text-muted uppercase">
                  <tr>
                    <th className="pb-3">Branch / medicine</th>
                    <th className="pb-3">Serial</th>
                    <th className="pb-3">Prescription</th>
                    <th className="pb-3">Patient</th>
                    <th className="pb-3">Prescriber</th>
                    <th className="pb-3">Batch</th>
                    <th className="pb-3 text-right">Quantity</th>
                    <th className="pb-3 text-right">Balance</th>
                    <th className="pb-3">Dual control</th>
                    <th className="pb-3">Reconciliation</th>
                  </tr>
                </thead>
                <tbody>
                  {register.data.entries.map((entry) => {
                    const open = entry.incidents.find((incident) => incident.status === 'OPEN');
                    return (
                      <tr key={entry.id} className="border-t border-border-subtle">
                        <td className="py-4">
                          {entry.branchId} · {entry.line.medicine.productName}
                        </td>
                        <td className="py-4 font-mono tabular-nums">{entry.serial}</td>
                        <td className="py-4">
                          Captured {entry.prescription.capturedAt.toLocaleDateString()}
                        </td>
                        <td className="py-4 font-medium text-text-strong">
                          {entry.patient.displayName}
                        </td>
                        <td className="py-4">{entry.prescriber.name}</td>
                        <td className="py-4 font-mono">{entry.batchNumber}</td>
                        <td className="py-4 text-right font-mono tabular-nums">
                          {entry.quantityCanonicalUnits}
                        </td>
                        <td className="py-4 text-right font-mono font-semibold tabular-nums">
                          {entry.runningBalance}
                        </td>
                        <td className="py-4">
                          <StatusPill
                            status={
                              entry.recordedByUserId !== entry.witnessedByUserId
                                ? 'dual signed'
                                : 'blocked'
                            }
                          />
                        </td>
                        <td className="py-4">
                          {open ? (
                            <div>
                              <StatusPill status="discrepancy" tone="danger" />
                              <span className="mt-1 block text-xs text-destructive">
                                Expected {open.expectedBalance}; ledger {open.actualBalance}.
                                Incident open.
                              </span>
                            </div>
                          ) : (
                            <StatusPill status="reconciled" tone="success" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
