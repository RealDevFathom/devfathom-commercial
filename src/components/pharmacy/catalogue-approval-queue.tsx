'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/status-pill';

const editLabels: Record<string, string> = {
  productName: 'Product name',
  brandName: 'Brand',
  manufacturer: 'Manufacturer',
  retailPriceMinor: 'Retail price',
  retailCategory: 'Retail category',
  marketingAuthorizationHolder: 'Marketing authorization holder',
  drapRegistrationNumber: 'Registration number',
  drapRegistrationStatus: 'Registration status',
  rx: 'Prescription required',
  otc: 'Over the counter',
  restricted: 'Restricted',
  controlled: 'Controlled',
  highAlert: 'High alert',
  lasa: 'Look alike / sound alike',
  coldChain: 'Cold chain',
  code: 'Barcode',
  type: 'Type',
  level: 'Pack type',
  unitsPerParent: 'Individual units per pack',
  effectiveFrom: 'Effective from',
  batchReference: 'Batch reference',
  printedMrpMinor: 'Printed MRP',
  roundingIncrementMinor: 'Rounding increment',
  mrpMinor: 'MRP',
  sellingPriceMinor: 'Selling price',
  value: 'Alias',
  name: 'Ingredient',
  fileName: 'File',
  uploadedAt: 'Uploaded',
  medicines: 'Medicines to create',
  reorderBranch: 'Reorder levels set at',
};
/** Catalogue prices are stored in paisa; the person approving reads them in rupees. */
const RUPEE_FIELDS = new Set([
  'retailPriceMinor',
  'printedMrpMinor',
  'roundingIncrementMinor',
  'mrpMinor',
  'sellingPriceMinor',
]);
/** Checked on the server only; a file hash or branch id means nothing to the person approving. */
const HIDDEN_FIELDS = new Set(['sourceSha256', 'reorderBranchId']);
const operationLabels: Record<string, string> = {
  UPDATE_MEDICINE: 'Product details',
  setPackPrice: 'Set pack price',
  createIngredient: 'Add ingredient',
  createPackLevel: 'Add pack',
  revisePackLevel: 'Revise pack',
  recordPrintedMrp: 'Record printed MRP',
  addBarcode: 'Add barcode',
  setPackBarcode: 'Attach pack barcode',
  addAlias: 'Add alias',
  createStagedMedicines: 'Create medicines from an imported file',
};

function displayChange(field: string, value: unknown): string {
  // A pack price without a selling price sells at the MRP.
  if (value === null && field === 'reorderBranch') return 'Not set from this file';
  if (value === null) return field === 'sellingPriceMinor' ? 'Sell at MRP' : 'Clear value';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (RUPEE_FIELDS.has(field) && typeof value === 'number' && Number.isSafeInteger(value))
    return `Rs ${formatMinor(value)}`;
  if ((field === 'effectiveFrom' || field === 'uploadedAt') && typeof value === 'string') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()))
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        date
      );
  }
  return typeof value === 'object' ? (JSON.stringify(value) ?? '—') : String(value);
}

function decisionMessage(result?: { status: string; staleEdits?: number }): string {
  if (!result) return '';
  if (result.status !== 'APPROVED') return 'Edit rejected.';
  const stale = result.staleEdits ?? 0;
  if (!stale) return 'Edit approved.';
  return stale === 1
    ? 'Edit approved. 1 other pending edit on this item is now out of date and must be rejected and resubmitted.'
    : `Edit approved. ${stale} other pending edits on this item are now out of date and must be rejected and resubmitted.`;
}

/** How the signed-in member may approve one pending edit (DEV-976). */
type ApprovalMode = 'DIRECT' | 'PIN' | 'OTHER_REVIEWER' | 'CHECKING';

const MAX_NAMED_REVIEWERS = 5;

/** "Ask Ayesha Khan or Bilal Ahmed to approve this." — names only, from the server. */
export function askReviewers(names: readonly string[]): string {
  if (!names.length)
    return 'Nobody else can approve it yet. Give another member the catalogue review permission, then ask them to approve this.';
  const shown = names.slice(0, MAX_NAMED_REVIEWERS);
  const rest = names.length - shown.length;
  const list = new Intl.ListFormat('en', { type: 'disjunction' }).format(
    rest ? [...shown, rest === 1 ? '1 other reviewer' : `${rest} other reviewers`] : shown
  );
  return `Ask ${list} to approve this.`;
}

export function CatalogueApprovalQueue() {
  const [pin, setPin] = useState('');
  const [query, setQuery] = useState('');
  const [medicineId, setMedicineId] = useState('');
  const [productName, setProductName] = useState('');
  const [decisionNotice, setDecisionNotice] = useState('');
  const search = trpc.pharmacyMedicine.search.useQuery(
    { query: query || ' ', limit: 25 },
    { enabled: query.trim().length > 1, retry: false }
  );
  const utils = trpc.useUtils();
  const queue = trpc.pharmacyMedicine.catalogueEdits.useQuery(undefined, {
    retry: false,
  });
  // DEV-19: show only the controls the server will accept for this member.
  const access = trpc.pharmacyMedicine.catalogueQueueAccess.useQuery(undefined, {
    retry: false,
  });
  const canEdit = access.data?.canEdit === true;
  const canDecide = access.data?.canDecide === true;
  const ownerPinApproval = access.data?.ownerPinApproval === true;
  // DEV-976: whether this member may approve their own edits, and who else can, decided on the
  // server by the same rule as the approval itself.
  const selfApproval = trpc.pharmacyMedicine.catalogueSelfApproval.useQuery(undefined, {
    enabled: canDecide,
    retry: false,
  });
  const approvalMode = (ownEdit: boolean | undefined): ApprovalMode => {
    if (!ownEdit) return ownerPinApproval ? 'PIN' : 'DIRECT';
    if (!selfApproval.data) return 'CHECKING';
    return selfApproval.data.canSelfApprove ? 'PIN' : 'OTHER_REVIEWER';
  };
  const pinEdits = (queue.data ?? []).filter(
    (edit) => !edit.stale && approvalMode(edit.ownEdit) === 'PIN'
  );
  const showPin = canDecide && pinEdits.length > 0;
  const pinReason = pinEdits.some((edit) => edit.ownEdit)
    ? 'Nobody else can review, so you approve with your own PIN.'
    : 'Nobody holds the catalogue review permission, so you approve as the owner with your own PIN.';
  const decide = trpc.pharmacyMedicine.decideCatalogueEdit.useMutation({
    onSuccess: async (result) => {
      setPin('');
      setDecisionNotice(decisionMessage(result));
      await utils.pharmacyMedicine.catalogueEdits.invalidate();
    },
    onError: () => {
      setPin('');
      setDecisionNotice('');
      // A refused approval may mean the item changed; refresh so stale edits show.
      void utils.pharmacyMedicine.catalogueEdits.invalidate();
      // DEV-976: or that who can review changed since the screen loaded.
      void utils.pharmacyMedicine.catalogueSelfApproval.invalidate();
    },
  });
  const propose = trpc.pharmacyMedicine.proposeCatalogueEdit.useMutation({
    onSuccess: async () => {
      setProductName('');
      await utils.pharmacyMedicine.catalogueEdits.invalidate();
    },
  });
  return (
    <SectionCard title="Catalogue edits awaiting approval" titleLevel={2}>
      <p className="mb-4 text-sm text-text-muted">
        Edits stay pending until a catalogue reviewer approves them. A solo owner may approve by
        entering their own fresh PIN. Every approval is audited.
      </p>
      {canEdit && !canDecide ? (
        <p role="note" className="mb-4 text-sm">
          {access.data?.isOwner
            ? 'Another member holds the catalogue review permission, so they approve or reject these edits. To decide them yourself, give your own role that permission.'
            : 'You can submit edits, but approving or rejecting them needs the catalogue review permission. Ask the owner to give you the Pharmacist role or that permission.'}
        </p>
      ) : null}
      {canEdit ? (
        <form
          className="mb-6 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            propose.mutate({ medicineId, changes: { productName } });
          }}
        >
          <label className="block max-w-sm space-y-2 text-sm">
            <span>Find catalogue item to edit</span>
            <Input
              className="min-h-11"
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
                setMedicineId('');
              }}
            />
          </label>
          {search.isFetching ? <p role="status">Finding items…</p> : null}
          {search.error ? (
            <p role="alert" className="text-destructive">
              {search.error.message}
            </p>
          ) : null}
          {search.data?.length === 0 ? <p>No matching catalogue items.</p> : null}
          {search.data?.length ? (
            <label className="block max-w-sm space-y-2 text-sm">
              <span>Catalogue item</span>
              <select
                className="min-h-11 w-full rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-ring"
                required
                value={medicineId}
                onChange={(event) => setMedicineId(event.target.value)}
              >
                <option value="">Choose an item</option>
                {search.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.productName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block max-w-sm space-y-2 text-sm">
            <span>Proposed product name</span>
            <Input
              className="min-h-11"
              required
              maxLength={300}
              value={productName}
              onChange={(event) => setProductName(event.target.value)}
            />
          </label>
          <Button
            size="touch"
            disabled={!medicineId || !productName.trim() || propose.isPending}
            type="submit"
          >
            {propose.isPending ? 'Submitting…' : 'Submit edit for review'}
          </Button>
          {propose.error ? (
            <p role="alert" className="text-destructive">
              {propose.error.message}
            </p>
          ) : null}
          {propose.isSuccess ? (
            <p role="status">
              Edit submitted for review. The published item changes after approval.
            </p>
          ) : null}
        </form>
      ) : null}
      {showPin ? (
        <div className="mb-4 max-w-sm space-y-2 text-sm">
          <label className="block space-y-2">
            <span>Solo owner PIN (for self-approval)</span>
            <Input
              className="min-h-11"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={64}
              aria-describedby="catalogue-approval-pin-reason"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          <p id="catalogue-approval-pin-reason" className="text-text-muted">
            {pinReason}
          </p>
        </div>
      ) : null}
      {queue.isPending ? <p role="status">Loading catalogue edits…</p> : null}
      {queue.error ? (
        <p role="alert" className="text-destructive">
          {queue.error.message}
        </p>
      ) : null}
      {decide.error ? (
        <p role="alert" className="mb-4 text-destructive">
          <PinAwareMessage message={decide.error.message} />
        </p>
      ) : null}
      {decisionNotice && !decide.error ? (
        <p role="status" className="mb-4 text-sm">
          {decisionNotice}
        </p>
      ) : null}
      {!queue.isPending && !queue.error && queue.data?.length === 0 ? (
        <p className="text-sm text-text-muted">No catalogue edits are awaiting review.</p>
      ) : null}
      <div className="space-y-4">
        {queue.data?.map((edit) => {
          const mode = approvalMode(edit.ownEdit);
          return (
            <article key={edit.id} className="min-w-0 rounded-md border border-border p-4">
              <h3 className="mb-2 break-words font-semibold">{edit.medicine.productName}</h3>
              <p className="mb-2 text-sm text-text-muted">
                {operationLabels[edit.operation] ?? 'Catalogue edit'}
              </p>
              {edit.stale ? (
                <>
                  <StatusPill status="blocked" label="Out of date" />
                  <p className="my-2 text-sm">
                    This item changed after the edit was submitted, so it can no longer be approved.
                    Reject it and submit a new edit.
                  </p>
                </>
              ) : (
                <StatusPill status="pending" label="Pending review" />
              )}
              <p className="mb-2 break-words text-sm text-text-muted">
                Submitted by {edit.editor.name}
              </p>
              <dl className="my-4 grid gap-2 text-sm">
                {edit.targets.map((target, index) => (
                  <div key={`${target.label}-${index}`} className="flex min-w-0 flex-wrap gap-2">
                    <dt className="font-semibold">{target.label}</dt>
                    <dd className="break-words">{target.value}</dd>
                  </div>
                ))}
                {Object.entries(
                  (edit.operation === 'UPDATE_MEDICINE'
                    ? edit.changes
                    : (edit.changes as { json: unknown }).json) as Record<string, unknown>
                )
                  .filter(
                    ([field]) =>
                      field !== 'id' && !field.endsWith('Id') && !HIDDEN_FIELDS.has(field)
                  )
                  .map(([field, value]) => (
                    <div key={field} className="flex min-w-0 flex-wrap gap-2">
                      <dt className="font-semibold">{editLabels[field] ?? field}</dt>
                      <dd className="break-all">{displayChange(field, value)}</dd>
                    </div>
                  ))}
              </dl>
              {canDecide && mode === 'OTHER_REVIEWER' ? (
                <p role="note" className="mb-4 text-sm">
                  You submitted this edit, so another reviewer must approve it.{' '}
                  {askReviewers(selfApproval.data?.reviewers ?? [])}
                </p>
              ) : null}
              {canDecide && mode === 'CHECKING' ? (
                selfApproval.error ? (
                  <p role="alert" className="mb-4 text-sm text-destructive">
                    {selfApproval.error.message}
                  </p>
                ) : (
                  <p className="mb-4 text-sm text-text-muted">
                    Checking who can approve this edit…
                  </p>
                )
              ) : null}
              {canDecide ? (
                <div className="flex flex-wrap gap-2">
                  {mode === 'DIRECT' || mode === 'PIN' ? (
                    <Button
                      size="touch"
                      disabled={decide.isPending || edit.stale || (mode === 'PIN' && !pin)}
                      onClick={() =>
                        decide.mutate({
                          editId: edit.id,
                          decision: 'APPROVE',
                          soloPin: mode === 'PIN' ? pin || undefined : undefined,
                        })
                      }
                    >
                      {decide.isPending ? 'Saving…' : 'Approve edit'}
                    </Button>
                  ) : null}
                  <Button
                    size="touch"
                    variant="destructive"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ editId: edit.id, decision: 'REJECT' })}
                  >
                    Reject edit
                  </Button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </SectionCard>
  );
}
