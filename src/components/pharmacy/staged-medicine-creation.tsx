'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  readNotCreatedStagedRows,
  requestStagedMedicineCreation,
  runStagedMedicineCreationStep,
} from './staged-medicine-creation-actions';
import type { NotCreatedRow } from './staged-not-created';

export type StagedCreationState = {
  request: { id: string; status: string } | null;
  canRequest: boolean;
  candidates: number;
  done: number;
  /** Rows the database refused: recorded on the row with a reason, nothing created (DEV-1002). */
  notCreated: number;
  remaining: number;
  unnamed: number;
  matchedEarlier: number;
  barcodesNotAttached: number;
  suppliersNotMatched: number;
  reorderLevelsNotApplied: number;
  /** Rows whose old code or generic name was left off because it cannot be searched. */
  aliasesNotAdded: number;
};

/** DEV-1002: where the review lists rows, and the first rows that could not be created. */
export type StagedCreationReview = {
  sourceId: string;
  /** The review page with this file selected, e.g. `/pharmacy/medicines?branchId=…`. */
  path: string;
  notCreated: { total: number; rows: NotCreatedRow[] };
};

const linkClass =
  'inline-flex min-h-11 items-center rounded-sm text-sm underline hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring';

/** The review page with one more parameter set, the row choice and paging cleared. */
function reviewHref(path: string, key: string, value: string) {
  const [route, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  for (const stale of ['rowId', 'page', 'filter', 'query']) params.delete(stale);
  params.set(key, value);
  return `${route}?${params.toString()}`;
}

const count = (value: number) => value.toLocaleString('en-US');

/**
 * DEV-912: turn a staged file's rows into catalogue medicines. One request for the whole file is
 * approved in the catalogue review queue; then the medicines are created in short steps.
 */
export function StagedMedicineCreation({
  batchId,
  branchId,
  initial,
  review,
}: {
  batchId: string;
  /** The branch the file's reorder levels are set at, when the requester may set them there. */
  branchId?: string;
  initial: StagedCreationState;
  /** Present on the staged review page, where the rows that were not created can be listed. */
  review?: StagedCreationReview;
}) {
  const [state, setState] = useState(initial);
  const [notCreatedRows, setNotCreatedRows] = useState(review?.notCreated ?? null);
  const [busy, setBusy] = useState<'request' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = state.request?.status ?? null;
  const finished = status === 'APPROVED' && state.remaining === 0;

  async function ask() {
    setBusy('request');
    setError(null);
    const result = await requestStagedMedicineCreation(batchId, branchId);
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
      setState((current) => ({
        ...current,
        done: step.done,
        notCreated: step.notCreated,
        remaining: step.remaining,
        matchedEarlier: step.matchedEarlier,
        barcodesNotAttached: step.barcodesNotAttached,
        suppliersNotMatched: step.suppliersNotMatched,
        reorderLevelsNotApplied: step.reorderLevelsNotApplied,
        aliasesNotAdded: step.aliasesNotAdded,
      }));
      // DEV-1002: list the rows this step could not create, through the review's own read.
      if (step.refused > 0 && review && branchId) {
        const listed = await readNotCreatedStagedRows({
          branchId,
          sourceId: review.sourceId,
          batchId,
        });
        if ('data' in listed && listed.data) setNotCreatedRows(listed.data);
      }
      if (step.remaining === 0 || step.created + step.matched + step.refused === 0) break;
    }
    setBusy(null);
  }

  return (
    <SectionCard title="Create catalogue medicines from this file" titleLevel={3}>
      <div className="space-y-3 text-sm">
        <p className="text-text-muted">
          Each named row becomes one medicine with its MRP, purchase price and units per pack. A
          value the file does not have is stored as not recorded and does not stop the medicine
          being sold. A row in the NARCOTICS class becomes a controlled medicine. A supplier is
          linked only when it is already one of your suppliers, and a reorder level becomes the
          safety stock of the branch chosen above when you may set stock levels there.
        </p>
        <p>
          {count(state.candidates)} medicines in this file · {count(state.done)} created ·{' '}
          {state.notCreated ? `${count(state.notCreated)} could not be created · ` : ''}
          {count(state.remaining)} still to create
          {state.unnamed ? ` · ${count(state.unnamed)} rows have no name and are skipped` : ''}
        </p>
        {state.notCreated > 0 && (
          <div className="space-y-2">
            <p>
              {count(state.notCreated)} rows could not be created, and the other medicines were
              created without them. Correct those rows in the file and upload it again: medicines
              already created are matched, never made twice.
            </p>
            {review && notCreatedRows && notCreatedRows.rows.length > 0 && (
              <>
                <ul aria-label="Rows that could not be created" className="space-y-1">
                  {notCreatedRows.rows.map((row) => (
                    <li key={row.rowId}>
                      <Link
                        className={linkClass}
                        href={reviewHref(review.path, 'rowId', row.rowId)}
                      >
                        Row {count(row.rowNumber)}: {row.productName || 'Unnamed row'}
                      </Link>
                      <span className="block text-text-muted">{row.reason}</span>
                    </li>
                  ))}
                </ul>
                {notCreatedRows.total > notCreatedRows.rows.length && (
                  <Link
                    className={linkClass}
                    href={reviewHref(review.path, 'filter', 'not-created')}
                  >
                    Show all {count(notCreatedRows.total)} rows that could not be created
                  </Link>
                )}
              </>
            )}
          </div>
        )}
        {state.aliasesNotAdded > 0 && (
          <p>
            {count(state.aliasesNotAdded)} rows have an old code or generic name that was not added:
            the catalogue cannot search its characters. Open a row to see which.
          </p>
        )}
        {state.matchedEarlier > 0 && (
          <p>
            {count(state.matchedEarlier)} rows name a medicine an earlier file already created, so
            no second copy was made.
          </p>
        )}
        {state.barcodesNotAttached > 0 && (
          <p>
            {count(state.barcodesNotAttached)} barcodes were not added: they already belong to
            another pack, or the medicine already existed. Open a row to see which barcode.
          </p>
        )}
        {state.suppliersNotMatched > 0 && (
          <p>
            {count(state.suppliersNotMatched)} rows name a supplier that is not one of your
            suppliers, so no supplier was linked or created. Open a row to see the name.
          </p>
        )}
        {state.reorderLevelsNotApplied > 0 && (
          <p>
            {count(state.reorderLevelsNotApplied)} reorder levels were not set. Open a row to see
            why, and set them in Stock.
          </p>
        )}
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
        {finished &&
          (state.notCreated ? (
            <StatusPill
              status="warning"
              label={`Finished: ${count(state.notCreated)} rows not created`}
            />
          ) : (
            <StatusPill status="done" label="All medicines created" />
          ))}
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
