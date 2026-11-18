import Link from 'next/link';
import { MigrationStagingForm } from './migration-staging-form';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StagedMedicineExport } from '@/components/pharmacy/staged-medicine-export';
import {
  STAGED_COLUMN_HEADINGS,
  STAGED_LIST_INTRO,
  STAGED_NOT_SUPPLIED,
  STAGED_STATUS_LABEL,
  formatStagedPrice,
  formatStagedQuantity,
  formatStagedQuantityReview,
  plainBatchStatus,
  plainExceptionLabel,
} from '@/components/pharmacy/staged-review-display';
import { SOURCE_REFERENCE_COLUMNS } from '@/lib/pharmacy/migration/staged-review';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyStagedReviewRouter } from '@/server/routers/pharmacy-staged-review';

const linkClass =
  'inline-flex min-h-11 items-center rounded-sm px-3 text-sm underline hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring';
const selectClass =
  'min-h-11 rounded-sm border border-border bg-surface-card px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring';

async function loadReview(
  text: (key: string) => string,
  context?: Awaited<ReturnType<typeof createTRPCContext>>
) {
  try {
    const ctx = context ?? (await createTRPCContext());
    const caller = pharmacyStagedReviewRouter.createCaller(ctx).pharmacyMedicine;
    const batchPage = Number(text('batchPage') || '1');
    const rowsInput = (selected: { branchId: string; sourceId: string; batchId: string }) => ({
      ...selected,
      query: text('query'),
      page: Number(text('page') || '1'),
      filter: (text('filter') || 'all') as 'all' | 'stock' | 'price' | 'collision',
    });
    const explicit = {
      branchId: text('branchId'),
      sourceId: text('sourceId'),
      batchId: text('batchId'),
    };
    // Independent loads run concurrently when the URL already names the selection;
    // otherwise only the dependent defaults are resolved sequentially.
    const canParallel = Boolean(explicit.branchId && explicit.sourceId && explicit.batchId);
    const branchesPromise = caller.stagedBranches();
    const [branches, batches, parallelResult, parallelDetail] = canParallel
      ? await Promise.all([
          branchesPromise,
          caller.stagedBatches({ branchId: explicit.branchId, page: batchPage }),
          caller.stagedRows(rowsInput(explicit)),
          text('rowId') ? caller.stagedDetail({ ...explicit, rowId: text('rowId') }) : null,
        ])
      : [await branchesPromise, null, null, null];
    const branchId = text('branchId') || branches[0]?.id || '';
    const loadedBatches =
      batches ?? (branchId ? await caller.stagedBatches({ branchId, page: batchPage }) : null);
    const firstBatch = loadedBatches?.batches[0];
    const selected = {
      branchId,
      sourceId: text('sourceId') || (!text('batchId') ? firstBatch?.sourceId : '') || '',
      batchId: text('batchId') || (!text('sourceId') ? firstBatch?.id : '') || '',
    };
    const result =
      parallelResult ??
      (selected.sourceId && selected.batchId ? await caller.stagedRows(rowsInput(selected)) : null);
    const detail =
      parallelDetail ??
      (text('rowId') ? await caller.stagedDetail({ ...selected, rowId: text('rowId') }) : null);
    return { branches, branchId, batchPage, batches: loadedBatches, selected, result, detail };
  } catch (error) {
    if (
      !(error instanceof TRPCError) ||
      !['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'BAD_REQUEST'].includes(error.code)
    )
      throw error;
    return { errorCode: error.code };
  }
}

export async function StagedMedicineCatalogue({
  searchParams,
  route = '/pharmacy/medicines',
  heading = 'Medicine catalogue',
  ctx,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  ctx?: Awaited<ReturnType<typeof createTRPCContext>>;
  route?: string;
  heading?: string;
}) {
  const params = await searchParams;
  const text = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const loaded = await loadReview(text, ctx);
  const href = (change: Record<string, string>) => {
    const next = new URLSearchParams('selected' in loaded ? loaded.selected : {});
    for (const key of ['branchId', 'sourceId', 'batchId', 'query', 'filter', 'page', 'batchPage'])
      if (text(key)) next.set(key, text(key));
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `${route}?${next.toString()}`;
  };
  const header = (
    <PageHeader
      eyebrow="Pharmacy / source review"
      heading={heading}
      description="Review preserved medicine names, source counts and prices before catalogue or stock approval."
    />
  );
  if ('errorCode' in loaded) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard
          title={
            loaded.errorCode === 'FORBIDDEN' || loaded.errorCode === 'UNAUTHORIZED'
              ? 'Review permission required'
              : 'Review selection unavailable'
          }
          titleLevel={2}
        >
          <p className="text-sm text-text-muted">
            An active workspace administrator with pharmacy access must select a valid branch,
            source and batch. No candidates have been changed.
          </p>
          <Link className={linkClass} href={route}>
            Reset selection
          </Link>
        </SectionCard>
      </div>
    );
  }
  const { branches, branchId, batchPage, batches, selected, result, detail } = loaded;
  return (
    <div className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Source references, separate from physical stock" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Staged means unverified source evidence. A draft catalogue entry needs validated identity
          and pack metadata. Verified means an explicit review accepted the facts. Sellable also
          requires stock and sale checks. This screen establishes no linked draft, verified medicine
          or sellable balance.
        </p>
        <p className="mt-3 text-sm text-text-muted">
          Batch, expiry and verified MRP gaps concern opening stock or price publication. They do
          not erase supplied names or quantities and do not prevent reading these candidates.
          Staging is workspace-wide; the chosen branch grants context, not ownership of source
          counts.
        </p>
      </SectionCard>
      {branchId && <MigrationStagingForm key={branchId} branchId={branchId} route={route} />}
      <SectionCard title="Source and branch" titleLevel={2}>
        <form action={route} className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-sm">
            Branch
            <select className={selectClass} name="branchId" defaultValue={branchId} required>
              <option value="">Choose a branch</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" className="min-h-11" disabled={!branches.length}>
            Show batches
          </Button>
        </form>
        {!branches.length && (
          <p className="mt-3 text-sm">
            No active branches. Ask a workspace administrator to review branch setup.
          </p>
        )}
        {batches && (
          <div className="mt-4 space-y-2">
            {!batches.batches.length && (
              <p>
                No batches on this page. Preserved imports must exist in this workspace to appear
                here.
              </p>
            )}
            {batches.batches.map((batch) => (
              <div
                key={batch.id}
                className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2"
              >
                <Link
                  className={`${linkClass} break-all`}
                  aria-current={selected.batchId === batch.id ? 'page' : undefined}
                  href={href({
                    sourceId: batch.sourceId,
                    batchId: batch.id,
                    page: '1',
                    query: '',
                    filter: '',
                  })}
                >
                  {batch.label} · {batch.source.fileName}
                </Link>
                <StatusPill status={batch.status} label={plainBatchStatus(batch.status)} />
                <span className="text-sm text-text-muted">{batch.rowCount} recorded rows</span>
              </div>
            ))}
            <nav aria-label="Batch pages" className="flex flex-wrap gap-2">
              {batchPage > 1 && (
                <Link className={linkClass} href={href({ batchPage: String(batchPage - 1) })}>
                  Previous batches
                </Link>
              )}
              {batchPage * 25 < batches.total && (
                <Link className={linkClass} href={href({ batchPage: String(batchPage + 1) })}>
                  More batches
                </Link>
              )}
            </nav>
          </div>
        )}
      </SectionCard>
      {result && (
        <SectionCard title="Candidates and source quantities" titleLevel={2}>
          <p className="mb-2 text-sm font-medium text-text-strong">{STAGED_LIST_INTRO}</p>
          <p className="mb-4 text-sm">
            {result.candidateCount.toLocaleString('en-US')} staged product candidates available for
            review. {result.total.toLocaleString('en-US')} match this search. Source quantities are
            references, not physical stock.
          </p>
          {result.batch && (
            <p className="mb-4 break-all font-mono text-xs text-text-muted">
              {result.batch.source.fileName} · SHA256 {result.batch.source.contentHash} ·{' '}
              {result.batch.profilerVersion}
            </p>
          )}
          <form action={route} className="mb-4 flex flex-wrap items-end gap-3">
            {Object.entries(selected).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
            <label className="grid gap-2 text-sm">
              Name, legacy code or source key
              <Input
                name="query"
                defaultValue={text('query')}
                maxLength={120}
                className="min-h-11"
              />
            </label>
            <label className="grid gap-2 text-sm">
              Review filter
              <select name="filter" defaultValue={text('filter') || 'all'} className={selectClass}>
                <option value="all">All candidates</option>
                <option value="stock">Open batch / expiry gaps</option>
                <option value="price">Open verified price gaps</option>
                <option value="collision">Name collisions</option>
              </select>
            </label>
            <Button type="submit" className="min-h-11">
              Search
            </Button>
            <StagedMedicineExport rows={result.rows} />
          </form>
          <h3 className="mb-2 font-semibold">All open exceptions in this batch</h3>
          <ul className="mb-4 space-y-1 text-sm text-text-muted">
            {result.exceptions.map((e) => (
              <li key={e.bucket}>
                {e.workflow}: {plainExceptionLabel(e.bucket)} — {e.count} open
              </li>
            ))}
          </ul>
          <div
            role="region"
            aria-label="Staged medicine catalogue"
            tabIndex={0}
            className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">
                Unverified source quantities. No saleable stock is created.
              </caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {STAGED_COLUMN_HEADINGS.map((label) => (
                    <th className="px-3 py-3 text-left" key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="px-3 py-3">
                      <Link className={linkClass} href={href({ rowId: row.id })}>
                        {row.productName || row.references.Name || 'Unnamed candidate'}
                      </Link>
                      <p className="text-xs text-text-muted">
                        Row {row.rowNumber}
                        {row.collision ? ' · Name collision — keep separate' : ''}
                        {row.controlled ? ' · Controlled medicine (legacy class NARCOTICS)' : ''}
                      </p>
                    </td>
                    {(['QTY', 'saleprice', 'purprice', 'UnitPrice', 'PackUnits'] as const).map(
                      (key) => (
                        <td key={key} className="px-3 py-3 text-right font-mono tabular-nums">
                          {key === 'QTY' || key === 'PackUnits'
                            ? formatStagedQuantity(row.references[key])
                            : formatStagedPrice(row.references[key])}
                        </td>
                      )
                    )}
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {formatStagedQuantityReview(row.quantityReview) ?? STAGED_NOT_SUPPLIED}
                    </td>
                    <td className="px-3 py-3">
                      <StatusPill status="pending" label={STAGED_STATUS_LABEL} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.rows.length && (
            <p className="py-4">No candidates match. Clear the search or choose another batch.</p>
          )}
          <nav className="mt-4 flex flex-wrap items-center gap-3" aria-label="Candidate pages">
            <span className="text-sm">Page {result.page}</span>
            {result.page > 1 && (
              <Link className={linkClass} href={href({ page: String(result.page - 1) })}>
                Previous
              </Link>
            )}
            {result.page * result.pageSize < result.total && (
              <Link className={linkClass} href={href({ page: String(result.page + 1) })}>
                Next
              </Link>
            )}
          </nav>
        </SectionCard>
      )}
      {detail && (
        <SectionCard title={detail.productName || 'Candidate detail'} titleLevel={2}>
          <StatusPill status="pending" label={STAGED_STATUS_LABEL} />
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            {Object.entries({
              'Original status': detail.status,
              Catalogue: detail.catalogueStatus,
              'Controlled medicine': detail.controlled
                ? 'Yes — set from legacy class NARCOTICS'
                : 'No — not in the NARCOTICS class',
              Draft: detail.draftStatus,
              Verified: 'Not established',
              'Sellable stock': 'Not established',
              Source: detail.sourceId,
              Batch: detail.batchId,
              Row: detail.rowNumber,
              'Source key': detail.sourceKey,
              'Source SHA256': detail.contentHash,
              'Source SHA256 recorded on row': detail.sourceHash,
              'Lineage check': detail.lineage,
              'Normalized name preview': detail.normalizedNamePreview,
              'Natural key preview — never applied': detail.naturalKeyPreview,
              'Quantity column counts': detail.quantityReview.choiceLabel,
              'Staged quantity — not stock': detail.quantityReview.label,
              'Stored staged quantity — not stock': detail.canonicalQuantity,
            }).map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-text-muted">{key}</dt>
                <dd className="break-all">{value ?? 'Not supplied'}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-6 font-semibold">Original source references</h3>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {SOURCE_REFERENCE_COLUMNS.map((key) => (
              <div key={key} className="min-w-0">
                <dt className="font-mono text-text-muted">{key}</dt>
                <dd className="break-all whitespace-pre-wrap">
                  {detail.references[key] ?? 'Not supplied as text'}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-text-muted">
            Name is the source product name. A classname of NARCOTICS imports the item as a
            controlled medicine; correct a wrong flag through the catalogue edit path. Other
            classname values, lowercase name and Category are unverified legacy groupings. aliasname
            is a legacy code, not a verified barcode. All price columns remain references; no MRP or
            cost conversion is applied.
          </p>
          <h3 className="mt-6 font-semibold">Retained review flags and exceptions</h3>
          <ul className="mt-3 space-y-1 break-words text-sm">
            {detail.flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
            {detail.exceptions.map((e, i) => (
              <li key={`${e.bucket}-${i}`}>
                {plainExceptionLabel(e.bucket)} ({e.bucket}) · {e.workflow} · {e.status} ·{' '}
                {e.severity}
              </li>
            ))}
          </ul>
          <Link className={`${linkClass} mt-4`} href={href({ rowId: '' })}>
            Close detail
          </Link>
        </SectionCard>
      )}
    </div>
  );
}
