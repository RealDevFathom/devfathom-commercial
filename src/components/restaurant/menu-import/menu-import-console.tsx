'use client';

import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { inferRouterOutputs } from '@trpc/server';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

/**
 * WHA-210 / WHA-200 v2 — the OCR menu-import review console.
 *
 * The server lane (WHA-194) deliberately stops at `commit`, and `commit` refuses
 * while any line is still PENDING. This screen is the human gate that clause
 * assumes: every extracted line is shown next to whatever the reviewer decided,
 * and the Import action stays disabled until the server says `readyToCommit`.
 *
 * EXTRACTED TEXT IS UNTRUSTED. It came out of a file nobody in the building
 * authored, through an OCR/vision adapter. It is rendered as text and nothing
 * else — no `dangerouslySetInnerHTML`, no prompt, no HTML sink — and a line
 * carrying SUSPECTED_INJECTION keeps that chip visible in every state.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ImportDetail = RouterOutputs['restaurantMenuImport']['get'];
type ImportSummary = RouterOutputs['restaurantMenuImport']['summary'];
type ImportLine = ImportDetail['pages'][number]['lines'][number];

/** Serialized `listMenuImports` row — dates cross the server boundary as ISO strings. */
export type MenuImportRow = {
  id: string;
  status: string;
  adapter: string;
  adapterVersion: string | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  pageCount: number;
  failureReason: string | null;
  sourceDeletedAt: string | null;
  createdById: string;
  createdAt: string;
  committedAt: string | null;
  committedMenuId: string | null;
  committedPriceListVersionId: string | null;
  lineCount: number;
};

/** Merge targets for `EXISTING_PRODUCT_MATCH`, read on the server with the page. */
export type MergeCandidate = {
  id: string;
  name: string;
  variants: Array<{ id: string; name: string }>;
};

export type MenuImportSnapshot = {
  imports: MenuImportRow[];
  mergeCandidates: MergeCandidate[];
};

export type MenuImportConsoleProps = {
  snapshot: MenuImportSnapshot | null;
  canImport: boolean;
  loadError?: boolean;
};

type UiError = { message?: string; data?: { code?: string } | null };

/** The in-progress correction for exactly one line. */
type LineEditor = {
  lineId: string;
  categoryName: string;
  productName: string;
  description: string;
  priceAmount: string;
  currency: string;
  note: string;
  mergeProductId: string;
  mergeVariantId: string;
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Flag presentation. SUSPECTED_INJECTION is the only danger tone: the others
 * describe a legibility problem, that one describes an attempt to steer whoever
 * or whatever reads the line next.
 */
const FLAG_META: Record<string, { label: string; tone: StatusTone }> = {
  SUSPECTED_INJECTION: { label: 'Suspected injection', tone: 'danger' },
  LOW_CONFIDENCE: { label: 'Low confidence', tone: 'warning' },
  MISSING_PRICE: { label: 'Missing price', tone: 'warning' },
  MISSING_CURRENCY: { label: 'Missing currency', tone: 'warning' },
  AMBIGUOUS_AMOUNT: { label: 'Ambiguous amount', tone: 'warning' },
  DUPLICATE_IN_IMPORT: { label: 'Duplicate in import', tone: 'info' },
  EXISTING_PRODUCT_MATCH: { label: 'Existing product match', tone: 'info' },
};

const REVIEW_TONE: Record<string, StatusTone> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  MERGED: 'info',
};

const IMPORT_TONE: Record<string, StatusTone> = {
  PENDING_EXTRACTION: 'warning',
  EXTRACTING: 'info',
  AWAITING_REVIEW: 'warning',
  EXTRACTION_FAILED: 'danger',
  COMMITTED: 'success',
  DISCARDED: 'neutral',
};

function humanStatus(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase();
}

function isDenied(error: unknown): boolean {
  const value = error as UiError | null;
  return value?.data?.code === 'FORBIDDEN' || value?.data?.code === 'UNAUTHORIZED';
}

function errorMessage(error: unknown, fallback: string): string {
  const value = error as UiError | null;
  return value?.message || fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Base64 without `FileReader`, so the encode is awaited rather than raced with
 * a callback. Chunked because `String.fromCharCode(...bytes)` blows the call
 * stack on a multi-megabyte upload.
 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * The hint sits outside the `<label>` on purpose. Several hints echo the
 * extracted value, and a wrapping label would fold that untrusted text into the
 * control's accessible name — so the name stays the field, and the hint stays
 * adjacent visible text.
 */
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className={labelClass}>{label}</span>
        {children}
      </label>
      {hint ? <span className="block text-xs text-text-muted">{hint}</span> : null}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

/** Untrusted extracted text. Plain string children only — never an HTML sink. */
function Extracted({ value, fallback = '—' }: { value: string | null; fallback?: string }) {
  if (!value) return <span className="text-text-faint">{fallback}</span>;
  return <span className="break-words text-text-strong">{value}</span>;
}

type ExtractedVariant = {
  name: string;
  amount: string | null;
  currency: string | null;
};

/** Keep malformed adapter JSON visible to the server validator, but out of the UI. */
function extractedVariants(value: unknown): ExtractedVariant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((variant) => {
    if (!variant || typeof variant !== 'object') return [];
    const record = variant as Record<string, unknown>;
    const price =
      record.price && typeof record.price === 'object'
        ? (record.price as Record<string, unknown>)
        : null;
    if (typeof record.name !== 'string') return [];
    return [
      {
        name: record.name,
        amount: typeof price?.amount === 'string' ? price.amount : null,
        currency: typeof price?.currency === 'string' ? price.currency : null,
      },
    ];
  });
}

function VariantReviewList({ variants }: { variants: ExtractedVariant[] }) {
  if (variants.length === 0) return null;
  return (
    <div className="mt-2 border-l-2 border-border-default pl-2">
      <span className="block font-mono text-[0.625rem] font-semibold uppercase tracking-wide text-text-muted">
        Variant prices to approve
      </span>
      <ul className="mt-1 space-y-0.5">
        {variants.map((variant, index) => (
          <li key={`${variant.name}-${index}`} className="text-xs text-text-strong">
            <span>{variant.name}</span>
            <span className="ml-2 tabular-nums text-text-muted">
              {variant.amount
                ? `${variant.amount} ${variant.currency ?? ''}`.trim()
                : '(no price)'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FlagChips({ flags }: { flags: string[] }) {
  if (flags.length === 0) {
    return <span className="font-mono text-[0.625rem] tracking-wide text-text-faint">NONE</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => {
        const meta = FLAG_META[flag];
        return (
          <StatusPill
            key={flag}
            status={meta?.label ?? flag}
            tone={meta?.tone ?? 'neutral'}
            title={flag}
          />
        );
      })}
    </span>
  );
}

function editorFor(line: ImportLine): LineEditor {
  return {
    lineId: line.id,
    categoryName: line.reviewedCategoryName ?? '',
    productName: line.reviewedProductName ?? '',
    description: line.reviewedDescription ?? '',
    priceAmount: line.reviewedPriceAmount ?? '',
    currency: line.reviewedCurrency ?? '',
    note: line.reviewNote ?? '',
    mergeProductId: line.mergeProductId ?? '',
    mergeVariantId: line.mergeVariantId ?? '',
  };
}

/** Blank means "no override" — send `null` so the server clears any earlier edit. */
function override(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function RestaurantMenuImportConsole({
  snapshot,
  canImport,
  loadError = false,
}: MenuImportConsoleProps) {
  const router = useRouter();
  const entitlements = useEntitlements();
  const menuModule = entitlements.modules.find((module) => module.key === 'restaurant-menu');
  const moduleEnabled =
    menuModule?.enabled ?? entitlements.enabledModules.includes('restaurant-menu');

  const imports = useMemo(() => snapshot?.imports ?? [], [snapshot]);
  const mergeCandidates = snapshot?.mergeCandidates ?? [];

  const [selectedImportId, setSelectedImportId] = useState(
    () => imports.find((row) => row.status === 'AWAITING_REVIEW')?.id ?? imports[0]?.id ?? ''
  );
  const [editor, setEditor] = useState<LineEditor | null>(null);
  const [menuName, setMenuName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [isEncoding, setIsEncoding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const active = moduleEnabled && canImport && !loadError;

  const limitsQuery = trpc.restaurantMenuImport.uploadLimits.useQuery(undefined, {
    enabled: active,
  });
  const detailQuery = trpc.restaurantMenuImport.get.useQuery(
    { importId: selectedImportId },
    { enabled: active && selectedImportId !== '' }
  );
  const summaryQuery = trpc.restaurantMenuImport.summary.useQuery(
    { importId: selectedImportId },
    { enabled: active && selectedImportId !== '' }
  );

  function refreshImport() {
    void detailQuery.refetch();
    void summaryQuery.refetch();
  }

  const uploadMutation = trpc.restaurantMenuImport.upload.useMutation({
    onSuccess: (result) => {
      setUploadError('');
      setSelectedImportId(result.importId);
      setStatusMessage(
        result.deduplicated
          ? 'That file was already uploaded; resumed the existing import.'
          : `Uploaded ${result.pageCount} page(s). Extraction is queued.`
      );
      router.refresh();
    },
    onError: (error) => setUploadError(errorMessage(error, 'The upload could not be accepted.')),
  });

  const reviewMutation = trpc.restaurantMenuImport.reviewLine.useMutation({
    onSuccess: (line) => {
      setMutationError('');
      setEditor(null);
      setStatusMessage(`Line recorded as ${humanStatus(line.reviewStatus)}.`);
      refreshImport();
    },
    onError: (error) => setMutationError(errorMessage(error, 'The decision was not recorded.')),
  });

  const commitMutation = trpc.restaurantMenuImport.commit.useMutation({
    onSuccess: (result) => {
      setMutationError('');
      setStatusMessage(
        result.alreadyCommitted
          ? 'This import was already committed; nothing was created.'
          : `Imported ${result.createdProductIds.length} new product(s) and ${result.mergedProductIds.length} merge(s) into a draft menu.`
      );
      refreshImport();
      router.refresh();
    },
    onError: (error) => setMutationError(errorMessage(error, 'The import could not be committed.')),
  });

  const discardMutation = trpc.restaurantMenuImport.discard.useMutation({
    onSuccess: () => {
      setMutationError('');
      setConfirmDiscard(false);
      setStatusMessage('Import discarded and the uploaded file deleted.');
      refreshImport();
      router.refresh();
    },
    onError: (error) => setMutationError(errorMessage(error, 'The import could not be discarded.')),
  });

  const busy =
    isEncoding ||
    uploadMutation.isPending ||
    reviewMutation.isPending ||
    commitMutation.isPending ||
    discardMutation.isPending;

  const detail = detailQuery.data;
  const summary: ImportSummary | undefined = summaryQuery.data;
  const openForReview = detail?.status === 'AWAITING_REVIEW';
  const readyToCommit = summary?.readyToCommit ?? false;

  async function submitFile(file: File | undefined) {
    if (!file || busy || !limitsQuery.data?.available || limitsQuery.error) return;
    const limits = limitsQuery.data;
    setUploadError('');
    // Honour the server's limits before spending the user's bandwidth. The
    // server re-checks both, and decides the type from the bytes, not this hint.
    if (limits && file.size > limits.maxBytes) {
      setUploadError(
        `${file.name} is ${formatBytes(file.size)}. The maximum upload size is ${formatBytes(limits.maxBytes)}.`
      );
      return;
    }
    // `allowedMimeTypes` is a literal union on the wire; the browser's reported
    // type is an arbitrary string, so compare as strings.
    const allowed: readonly string[] = limits?.allowedMimeTypes ?? [];
    if (limits && file.type && !allowed.includes(file.type)) {
      setUploadError(
        `${file.name} looks like ${file.type}. Upload one of: ${limits.allowedMimeTypes.join(', ')}.`
      );
      return;
    }
    setIsEncoding(true);
    try {
      const content = await fileToBase64(file);
      uploadMutation.mutate({
        fileName: file.name,
        content,
        declaredMimeType: file.type || null,
      });
    } catch {
      setUploadError('The file could not be read from this device.');
    } finally {
      setIsEncoding(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void submitFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void submitFile(event.dataTransfer.files?.[0]);
  }

  function decide(line: ImportLine, decision: 'ACCEPTED' | 'REJECTED' | 'MERGED') {
    const draft = editor?.lineId === line.id ? editor : editorFor(line);
    if (decision === 'MERGED' && !draft.mergeProductId) {
      setMutationError('Choose the existing product to merge this line into.');
      return;
    }
    setMutationError('');
    reviewMutation.mutate({
      lineId: line.id,
      decision,
      categoryName: override(draft.categoryName),
      productName: override(draft.productName),
      description: override(draft.description),
      priceAmount: override(draft.priceAmount),
      currency: override(draft.currency),
      note: override(draft.note),
      mergeProductId: decision === 'MERGED' ? draft.mergeProductId : null,
      mergeVariantId: decision === 'MERGED' ? override(draft.mergeVariantId) : null,
    });
  }

  const header = (
    <PageHeader
      eyebrow="Restaurant operations"
      heading="Menu import"
      description="Upload a menu, review every extracted line, then import the confirmed rows as a draft menu and draft prices."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {busy ? <StatusPill status="Working" tone="info" /> : null}
          <StatusPill
            status={canImport ? 'Operational' : 'No access'}
            tone={canImport ? 'success' : 'neutral'}
          />
        </div>
      }
    />
  );

  if (!moduleEnabled) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Menu and Costing module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Menu import is unavailable for this organization. Enable Menu and Costing to upload a
              menu and open the review queue.
            </p>
          </div>
        </SectionCard>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Menu imports could not be loaded">
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-destructive">
              No menu data changed. The current list of imports is unavailable.
            </p>
            <Button type="button" variant="outline" onClick={() => router.refresh()}>
              Try again
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  if (!canImport) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Menu import access unavailable">
          <div className="space-y-3">
            <StatusPill status="Permission denied" tone="danger" />
            <p role="alert" className="max-w-2xl text-sm leading-relaxed text-text-muted">
              You do not have the <span className="font-mono text-xs">menu:import</span> capability.
              Importing a menu creates products, categories and draft prices in bulk, so it is
              granted separately from ordinary menu editing. Ask an administrator to grant it.
            </p>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      {header}

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>

      <SectionCard
        eyebrow="Step 1"
        title="Upload a menu"
        titleLevel={2}
        actions={
          limitsQuery.data ? (
            <span className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Max {formatBytes(limitsQuery.data.maxBytes)}
            </span>
          ) : null
        }
      >
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          data-dragging={isDragging ? 'true' : undefined}
          className={`rounded-md border border-dashed px-5 py-8 text-center transition-colors ${
            isDragging ? 'border-ring bg-accent-quiet' : 'border-border-default'
          }`}
        >
          <p className="text-sm font-medium text-text-strong">Drop a menu file here</p>
          <p className="mt-1 text-sm text-text-muted">
            {limitsQuery.data
              ? `Accepted: ${limitsQuery.data.allowedMimeTypes.join(', ')}.`
              : 'Loading the accepted file types…'}
          </p>
          {limitsQuery.data?.explanation ? (
            <p role="status" className="mt-3 text-sm text-text-muted">
              {limitsQuery.data.explanation}
            </p>
          ) : null}
          <div className="mt-4 flex justify-center">
            <Field label="Menu file">
              <input
                ref={fileInputRef}
                type="file"
                accept={limitsQuery.data?.allowedMimeTypes.join(',')}
                onChange={onFileChange}
                disabled={busy || !limitsQuery.data?.available || Boolean(limitsQuery.error)}
                className="block w-full text-sm text-text-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-surface-raised file:px-4 file:text-sm file:font-medium file:text-text-strong hover:file:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </Field>
          </div>
          {isEncoding || uploadMutation.isPending ? (
            <p role="status" className="mt-3 text-sm text-text-muted">
              {isEncoding ? 'Reading the file…' : 'Uploading…'}
            </p>
          ) : null}
        </div>
        {uploadError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {uploadError}
          </p>
        ) : null}
        {limitsQuery.error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {isDenied(limitsQuery.error)
              ? 'Upload limits are unavailable because the import capability was denied.'
              : errorMessage(limitsQuery.error, 'The upload limits could not be read.')}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard eyebrow="Step 2" title="Imports">
        {imports.length === 0 ? (
          <EmptyState
            title="No menu imports yet"
            detail="Upload a menu above. Extraction runs in the background and the review queue opens when it finishes."
          />
        ) : (
          <div role="region" aria-label="Menu imports" tabIndex={0} className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.map((row) => (
                  <TableRow key={row.id} data-selected={row.id === selectedImportId}>
                    <TableCell className="max-w-[18rem]">
                      <span className="block truncate text-text-strong" title={row.fileName}>
                        {row.fileName}
                      </span>
                      <span className="font-mono text-[0.625rem] tracking-wide text-text-faint">
                        {row.adapter}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        status={humanStatus(row.status)}
                        tone={IMPORT_TONE[row.status] ?? 'neutral'}
                      />
                      {row.failureReason ? (
                        <span className="mt-1 block text-xs text-destructive">
                          {row.failureReason}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.pageCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.lineCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(row.byteSize)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant={row.id === selectedImportId ? 'secondary' : 'outline'}
                        size="sm"
                        aria-pressed={row.id === selectedImportId}
                        onClick={() => {
                          setSelectedImportId(row.id);
                          setEditor(null);
                          setConfirmDiscard(false);
                          setMutationError('');
                        }}
                      >
                        {row.id === selectedImportId ? 'Selected' : 'Open'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {selectedImportId === '' ? null : detailQuery.isLoading ? (
        <SectionCard eyebrow="Step 3" title="Review queue">
          <div role="status" aria-label="Loading the review queue" className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </SectionCard>
      ) : detailQuery.error ? (
        <SectionCard eyebrow="Step 3" title="Review queue">
          <div className="space-y-3" role="alert">
            <StatusPill
              status={isDenied(detailQuery.error) ? 'Permission denied' : 'Read failed'}
              tone="danger"
            />
            <p className="text-sm text-text-muted">
              {isDenied(detailQuery.error)
                ? 'Your role does not grant the menu:import capability for this import.'
                : errorMessage(detailQuery.error, 'The review queue could not be read.')}
            </p>
            {!isDenied(detailQuery.error) ? (
              <Button type="button" variant="outline" size="sm" onClick={refreshImport}>
                Retry
              </Button>
            ) : null}
          </div>
        </SectionCard>
      ) : !detail ? null : (
        <>
          <SectionCard
            eyebrow="Step 3"
            title="Review queue"
            actions={
              <StatusPill
                status={humanStatus(detail.status)}
                tone={IMPORT_TONE[detail.status] ?? 'neutral'}
              />
            }
          >
            {summary ? (
              <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {(
                  [
                    ['Pending', summary.PENDING],
                    ['Accepted', summary.ACCEPTED],
                    ['Rejected', summary.REJECTED],
                    ['Merged', summary.MERGED],
                    ['Flagged', summary.flagged],
                  ] as const
                ).map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-border-subtle bg-surface-sunken px-4 py-3"
                  >
                    <dt className={labelClass}>{label}</dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums text-text-strong">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {!openForReview ? (
              <div
                role="status"
                className="mb-4 rounded-md border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted"
              >
                This import is {humanStatus(detail.status)}. The queue is read-only — decisions can
                only be recorded while an import is awaiting review.
              </div>
            ) : null}

            {mutationError ? (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {mutationError}
              </p>
            ) : null}

            {detail.pages.length === 0 ? (
              <EmptyState
                title="Nothing extracted yet"
                detail="Extraction has not produced any pages for this upload. The queue opens as soon as it completes."
              />
            ) : (
              <div className="space-y-6">
                {detail.pages.map((page) => (
                  <section key={page.id} aria-label={`Page ${page.pageNumber}`} className="min-w-0">
                    <div className="mb-2 space-y-1">
                      <h4 className="font-display text-sm font-semibold text-text-strong">
                        Page {page.pageNumber}
                      </h4>
                      {/*
                       * Adapter legibility notes are full sentences, so they are
                       * a note and not a StatusPill — §6 reserves pill geometry
                       * for statuses and compact controls.
                       */}
                      {page.warnings.length > 0 ? (
                        <ul className="space-y-0.5">
                          {page.warnings.map((warning) => (
                            <li key={warning} className="text-xs text-warning">
                              {warning}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    {page.lines.length === 0 ? (
                      <EmptyState
                        title="No lines on this page"
                        detail="The adapter found no menu lines here. Nothing will be imported from it."
                      />
                    ) : (
                      <div
                        role="region"
                        aria-label={`Page ${page.pageNumber} review lines`}
                        tabIndex={0}
                        className="overflow-x-auto"
                      >
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Extracted</TableHead>
                              <TableHead>Reviewer correction</TableHead>
                              <TableHead>Flags</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Decision</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {page.lines.map((line, index) => {
                              const variants = extractedVariants(line.extractedVariants);
                              const corrected =
                                line.reviewedProductName ??
                                line.reviewedCategoryName ??
                                line.reviewedPriceAmount ??
                                line.reviewNote;
                              // Three identically-labelled buttons per row are
                              // ambiguous to a screen reader, so each decision
                              // names its line. The name is extracted text and
                              // stays text — an accessible name is not a sink.
                              const lineLabel =
                                line.extractedProductName ??
                                `unnamed line ${index + 1} on page ${page.pageNumber}`;
                              return (
                                <TableRow key={line.id}>
                                  <TableCell className="max-w-[22rem] align-top">
                                    <span className="block font-medium">
                                      <Extracted
                                        value={line.extractedProductName}
                                        fallback="(no product name)"
                                      />
                                    </span>
                                    <span className="mt-0.5 block text-xs text-text-muted">
                                      <Extracted
                                        value={line.extractedCategoryName}
                                        fallback="(uncategorised)"
                                      />
                                    </span>
                                    <span className="mt-0.5 block text-xs tabular-nums text-text-muted">
                                      <Extracted
                                        value={
                                          line.extractedPriceAmount
                                            ? `${line.extractedPriceAmount} ${line.extractedCurrency ?? ''}`.trim()
                                            : line.extractedPriceRaw
                                        }
                                        fallback="(no price)"
                                      />
                                    </span>
                                    <VariantReviewList variants={variants} />
                                  </TableCell>
                                  <TableCell className="max-w-[18rem] align-top">
                                    {corrected ? (
                                      <>
                                        <span className="block font-medium text-text-strong">
                                          {line.reviewedProductName ?? '—'}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-text-muted">
                                          {line.reviewedCategoryName ?? '—'}
                                        </span>
                                        <span className="mt-0.5 block text-xs tabular-nums text-text-muted">
                                          {line.reviewedPriceAmount
                                            ? `${line.reviewedPriceAmount} ${line.reviewedCurrency ?? ''}`.trim()
                                            : '—'}
                                        </span>
                                        {line.reviewNote ? (
                                          <span className="mt-0.5 block text-xs text-text-muted italic">
                                            {line.reviewNote}
                                          </span>
                                        ) : null}
                                      </>
                                    ) : (
                                      <span className="text-text-faint">No correction</span>
                                    )}
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <FlagChips flags={line.flags} />
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <StatusPill
                                      status={humanStatus(line.reviewStatus)}
                                      tone={REVIEW_TONE[line.reviewStatus] ?? 'neutral'}
                                    />
                                  </TableCell>
                                  <TableCell className="align-top text-right">
                                    <div className="flex flex-wrap justify-end gap-2">
                                      <Button
                                        type="button"
                                        size="sm"
                                        aria-label={`Accept ${lineLabel}`}
                                        disabled={!openForReview || busy}
                                        onClick={() =>
                                          variants.length > 0
                                            ? setEditor(editorFor(line))
                                            : decide(line, 'ACCEPTED')
                                        }
                                      >
                                        {variants.length > 0 ? 'Review variants' : 'Accept'}
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label={`Edit ${lineLabel}`}
                                        aria-expanded={editor?.lineId === line.id}
                                        disabled={!openForReview || busy}
                                        onClick={() =>
                                          setEditor((current) =>
                                            current?.lineId === line.id ? null : editorFor(line)
                                          )
                                        }
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="destructive"
                                        aria-label={`Reject ${lineLabel}`}
                                        disabled={!openForReview || busy}
                                        onClick={() => decide(line, 'REJECTED')}
                                      >
                                        Reject
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {editor && page.lines.some((line) => line.id === editor.lineId) ? (
                      <LineEditorPanel
                        editor={editor}
                        line={page.lines.find((line) => line.id === editor.lineId)!}
                        mergeCandidates={mergeCandidates}
                        busy={busy}
                        onChange={setEditor}
                        onCancel={() => setEditor(null)}
                        onAccept={(line) => decide(line, 'ACCEPTED')}
                        onMerge={(line) => decide(line, 'MERGED')}
                      />
                    ) : null}
                  </section>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard eyebrow="Step 4" title="Import the reviewed menu">
            <div className="space-y-4">
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                Importing creates a <strong>draft</strong> menu and a <strong>draft</strong> price
                list version. Nothing is published to a branch until someone activates it.
              </p>

              <div className="grid gap-4 sm:max-w-md">
                <Field label="Menu name" hint="Optional. Defaults to the uploaded file name.">
                  <Input
                    value={menuName}
                    onChange={(event) => setMenuName(event.target.value)}
                    placeholder={detail.fileName}
                    disabled={busy || !openForReview}
                  />
                </Field>
              </div>

              <div
                role="status"
                className="rounded-md border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted"
              >
                {readyToCommit
                  ? 'Every line has a decision. This import is ready.'
                  : summary
                    ? `${summary.PENDING} line(s) still need a decision, and at least one line must be accepted or merged, before this menu can be imported.`
                    : 'Reading review progress…'}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={!readyToCommit || !openForReview || busy}
                  onClick={() => {
                    setMutationError('');
                    commitMutation.mutate({
                      importId: detail.id,
                      menuName: menuName.trim() === '' ? undefined : menuName.trim(),
                    });
                  }}
                >
                  {commitMutation.isPending ? 'Importing…' : 'Import reviewed menu'}
                </Button>

                {confirmDiscard ? (
                  <>
                    <span role="alert" className="text-sm text-destructive">
                      Discard this import and delete the uploaded file?
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => discardMutation.mutate({ importId: detail.id })}
                    >
                      Confirm discard
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmDiscard(false)}
                    >
                      Keep import
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || detail.status === 'DISCARDED'}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    Discard import
                  </Button>
                )}
              </div>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

function LineEditorPanel({
  editor,
  line,
  mergeCandidates,
  busy,
  onChange,
  onCancel,
  onAccept,
  onMerge,
}: {
  editor: LineEditor;
  line: ImportLine;
  mergeCandidates: MergeCandidate[];
  busy: boolean;
  onChange: (editor: LineEditor) => void;
  onCancel: () => void;
  onAccept: (line: ImportLine) => void;
  onMerge: (line: ImportLine) => void;
}) {
  const selectedProduct = mergeCandidates.find(
    (candidate) => candidate.id === editor.mergeProductId
  );

  function set<K extends keyof LineEditor>(key: K, value: LineEditor[K]) {
    onChange({ ...editor, [key]: value });
  }

  return (
    <div className="mt-4 rounded-md border border-border-default bg-surface-sunken p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="font-display text-sm font-semibold text-text-strong">
            Correcting: <Extracted value={line.extractedProductName} fallback="(no product name)" />
          </h5>
          <p className="mt-1 text-xs text-text-muted">
            Leave a field blank to keep the extracted value. Blanking a field you previously edited
            clears that correction.
          </p>
        </div>
        <FlagChips flags={line.flags} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Product name" hint={line.extractedProductName ?? 'Nothing was extracted.'}>
          <Input
            value={editor.productName}
            onChange={(event) => set('productName', event.target.value)}
            disabled={busy}
            maxLength={200}
          />
        </Field>
        <Field label="Category" hint={line.extractedCategoryName ?? 'Nothing was extracted.'}>
          <Input
            value={editor.categoryName}
            onChange={(event) => set('categoryName', event.target.value)}
            disabled={busy}
            maxLength={200}
          />
        </Field>
        <Field label="Price" hint={line.extractedPriceRaw ?? 'Nothing was extracted.'}>
          <Input
            value={editor.priceAmount}
            onChange={(event) => set('priceAmount', event.target.value)}
            inputMode="decimal"
            disabled={busy}
          />
        </Field>
        <Field label="Currency" hint="Three-letter code, e.g. PKR.">
          <Input
            value={editor.currency}
            onChange={(event) => set('currency', event.target.value.toUpperCase())}
            maxLength={3}
            disabled={busy}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Description" hint={line.extractedDescription ?? 'Nothing was extracted.'}>
            <Textarea
              value={editor.description}
              onChange={(event) => set('description', event.target.value)}
              rows={2}
              disabled={busy}
              maxLength={2000}
            />
          </Field>
        </div>
        {extractedVariants(line.extractedVariants).length > 0 ? (
          <div className="md:col-span-2 rounded-md border border-border-default bg-surface-raised p-3">
            <p className="text-sm font-medium text-text-strong">
              Confirm every extracted variant price
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Accepting this line imports all of the variant prices shown below.
            </p>
            <VariantReviewList variants={extractedVariants(line.extractedVariants)} />
          </div>
        ) : null}
        <div className="md:col-span-2">
          <Field label="Review note" hint="Recorded with the decision. Not imported.">
            <Input
              value={editor.note}
              onChange={(event) => set('note', event.target.value)}
              disabled={busy}
              maxLength={1000}
            />
          </Field>
        </div>
        <Field
          label="Merge into existing product"
          hint="Required for a merge; ignored when accepting as new."
        >
          <select
            className={selectClass}
            value={editor.mergeProductId}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...editor, mergeProductId: event.target.value, mergeVariantId: '' })
            }
          >
            <option value="">Import as a new product</option>
            {mergeCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Merge into variant" hint="Optional. Only when a product is selected.">
          <select
            className={selectClass}
            value={editor.mergeVariantId}
            disabled={busy || !selectedProduct}
            onChange={(event) => set('mergeVariantId', event.target.value)}
          >
            <option value="">No specific variant</option>
            {selectedProduct?.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => onAccept(line)}>
          {extractedVariants(line.extractedVariants).length > 0
            ? 'Accept line and variants'
            : 'Accept with edits'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || !editor.mergeProductId}
          onClick={() => onMerge(line)}
        >
          Merge into selected product
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
