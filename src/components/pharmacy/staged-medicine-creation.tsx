'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  requestStagedMedicineCreation,
  runStagedMedicineCreationStep,
} from './staged-medicine-creation-actions';

export type StagedCreationState = {
  request: { id: string; status: string } | null;
  canRequest: boolean;
  candidates: number;
  done: number;
  remaining: number;
  unnamed: number;
};

const count = (value: number) => value.toLocaleString('en-US');

/**
 * DEV-912: turn a staged file's rows into catalogue medicines. One request for the whole file is
 * approved in the catalogue review queue; then the medicines are created in short steps.
 */
export function StagedMedicineCreation({
  batchId,
  initial,
}: {
  batchId: string;
  initial: StagedCreationState;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<'request' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = state.request?.status ?? null;
  const finished = status === 'APPROVED' && state.remaining === 0;

  async function ask() {
    setBusy('request');
    setError(null);
    const result = await requestStagedMedicineCreation(batchId);
    if ('error' in result) setError(result.error ?? null);
    else setState(result.data);
    setBusy(null);
  }

  async function create() {
    setBusy('create');
    setError(null);
    // Each step creates one chunk; stop on the first refusal and keep what was created.
    for (;;) {
      const result = await runStagedMedicineCreationStep(batchId);
      if ('error' in result) {
        setError(result.error ?? null);
        break;
      }
      const step = result.data;
      setState((current) => ({ ...current, done: step.done, remaining: step.remaining }));
      if (step.remaining === 0 || step.created === 0) break;
    }
    setBusy(null);
  }

  return (
    <SectionCard title="Create catalogue medicines from this file" titleLevel={3}>
      <div className="space-y-3 text-sm">
        <p className="text-text-muted">
          Each named row becomes one medicine with its MRP, purchase price and units per pack. A
          value the file does not have is stored as not recorded and does not stop the medicine
          being sold. A row in the NARCOTICS class becomes a controlled medicine.
        </p>
        <p>
          {count(state.candidates)} medicines in this file · {count(state.done)} created ·{' '}
          {count(state.remaining)} still to create
          {state.unnamed ? ` · ${count(state.unnamed)} rows have no name and are skipped` : ''}
        </p>
        {status === 'PENDING' && (
          <>
            <StatusPill status="pending" label="Waiting for approval" />
            <p className="text-text-muted">
              A different reviewer approves this request in Catalogue review. When nobody else can
              review, the owner approves it with their own PIN.
            </p>
          </>
        )}
        {status === 'REJECTED' && <StatusPill status="rejected" label="Request rejected" />}
        {finished && <StatusPill status="done" label="All medicines created" />}
        {status === 'APPROVED' && !finished && (
          <StatusPill status="approved" label="Approved — ready to create" />
        )}
        <div aria-live="polite" className="min-h-5">
          {busy === 'create' && (
            <p>
              Creating medicines… {count(state.done)} of {count(state.candidates)} done.
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(status === null || status === 'REJECTED') && state.canRequest && (
            <Button size="touch" disabled={busy !== null || state.candidates === 0} onClick={ask}>
              {busy === 'request'
                ? 'Sending…'
                : `Ask to create ${count(state.candidates)} medicines`}
            </Button>
          )}
          {status === 'APPROVED' && !finished && (
            <Button size="touch" disabled={busy !== null} onClick={create}>
              {busy === 'create' ? 'Creating…' : 'Create medicines'}
            </Button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
