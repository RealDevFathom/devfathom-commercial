'use client';

import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { WorkspaceState } from './field';

export function ControlledRegisterConsole() {
  const register = trpc.pharmacySafety.controlledRegister.useQuery();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy · RX-05"
        heading="Controlled register"
        description="An append-only, dual-control view reconciled against the stock ledger."
      />
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[68rem] text-left text-sm">
                <thead className="font-mono text-[0.65rem] tracking-wide text-text-muted uppercase">
                  <tr>
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
