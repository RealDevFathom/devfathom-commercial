import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { PurchasingActionForm } from '../_components/action-form';
import { PurchasingOutcomeScope, PurchasingOutcomes } from '../_components/action-outcomes';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import type { SupplierSummary } from '@/lib/pharmacy/purchasing-console';
import {
  AccessState,
  EmptyState,
  LoadFailure,
  NoticeBanner,
  PurchasingHeader,
  PurchasingTabs,
} from '../_components/console-chrome';
import {
  Derived,
  Field,
  LicenceBadge,
  SelectField,
  SubmitButton,
  TextField,
} from '../_components/form-controls';
import {
  purchasingOutcome,
  PurchasingValidationError,
  dateField,
  dateInputValue,
  destination,
  field,
  money,
  moneyFieldMinor,
  noticeFrom,
  NO_ACTOR,
  optionalField,
  optionalIntegerField,
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  dateOnly,
  type SearchQuery,
} from '../_lib/console';

export const metadata: Metadata = { title: 'Suppliers · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/suppliers`;
const HEADING = 'Suppliers';
const DESCRIPTION =
  'Licensed distributors, their licence evidence, terms and credit. A supplier is orderable only while it is authorized and holds an unexpired verified licence.';

/**
 * PUR-01 — the supplier register.
 *
 * Master-detail, side by side on anything wider than a tablet (UX rule 2): the
 * detail of the supplier you clicked is never below the fold, because a
 * licence that has to be scrolled to is a licence nobody checks. Selection is a
 * link, so it survives a reload and a back button, and the selected row stays a
 * control with `aria-current` rather than becoming inert text (UX rule 3).
 */
export default async function PharmacySuppliersPage({
  searchParams,
}: {
  searchParams: Promise<SearchQuery>;
}) {
  const query = await searchParams;
  const notice = noticeFrom(query);
  const ctx = await tenantContext();
  if (!ctx)
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={false} />;
  const moduleEnabled = hasModule(ctx.entitlements, 'pharmacy-procurement');
  if (!moduleEnabled || !ctx.session?.user) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }
  // #979: suppliers, requisitions and orders are procurement work, closed to a
  // counter-only role exactly as Goods-in is.
  if (!(await actorCanProcure(ctx.db, ctx.session.user.id))) {
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
  }
  // PR J (#979): authorizing a supplier needs the approver capability as well,
  // as approving a purchase order does. Offer the control only to the people the
  // server will let through: Manager, Owner, and the solo owner.
  const canAuthorize = await can(
    subjectFromSession(ctx.session.user),
    'pharmacy:procurement-approve',
    undefined,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta?.ip ?? null }
  );

  const caller = await purchasingCaller();
  if (!caller) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }

  let suppliers: SupplierSummary[] | null = null;
  let loadError = false;
  try {
    suppliers = await caller.suppliers({ includeInactive: param(query, 'inactive') === '1' });
  } catch {
    loadError = true;
  }

  // UX rule 5: no `suppliers[0]` fallback. "Nothing chosen yet" is its own
  // state with its own words, and it has to be reachable.
  const requested = param(query, 'supplier');
  const selected = suppliers?.find((supplier) => supplier.id === requested) ?? null;

  async function createSupplier(form: FormData) {
    'use server';
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      const supplier = await outcome.write(actionCaller.createSupplier)({
        name: field(form, 'name'),
        legalName: optionalField(form, 'legalName'),
        serviceArea: optionalField(form, 'serviceArea'),
        contactName: optionalField(form, 'contactName'),
        contactPhone: optionalField(form, 'contactPhone'),
        paymentTermsDays: optionalIntegerField(form, 'paymentTermsDays', 'Payment terms', 0),
        creditLimitMinor: form.get('creditLimit')
          ? moneyFieldMinor(form, 'creditLimit', 'Credit limit')
          : 0,
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: `${supplier.name} added. Record a verified licence before ordering from it.`,
          kind: 'success',
        },
        { supplier: supplier.id }
      );
    } catch (error) {
      next = destination(ROUTE, {
        ...outcome.failure(error, 'Could not add the supplier.'),
        kind: 'error',
      });
    }
    return next;
  }

  async function recordLicence(form: FormData) {
    'use server';
    const supplierId = field(form, 'supplierId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.recordSupplierLicence)({
        supplierId,
        licenceType: field(form, 'licenceType'),
        licenceNumber: field(form, 'licenceNumber'),
        issuingAuthority: field(form, 'issuingAuthority'),
        issuedAt: dateField(form, 'issuedAt', 'Issued on'),
        expiresAt: dateField(form, 'expiresAt', 'Expires on'),
        evidenceUri: optionalField(form, 'evidenceUri'),
        verified: form.get('verified') === 'on',
        supersedesId: optionalField(form, 'supersedesId'),
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        { message: 'Licence filed. Earlier filings are kept as evidence.', kind: 'success' },
        { supplier: supplierId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not file the licence.'), kind: 'error' },
        { supplier: supplierId }
      );
    }
    return next;
  }

  async function verifyLicence(form: FormData) {
    'use server';
    const supplierId = field(form, 'supplierId');
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.verifySupplierLicence)({
        licenceId: field(form, 'licenceId'),
      });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: 'Licence verified. The unverified filing is kept as evidence.',
          kind: 'success',
        },
        { supplier: supplierId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not verify the licence.'), kind: 'error' },
        { supplier: supplierId }
      );
    }
    return next;
  }

  async function setAuthorization(form: FormData) {
    'use server';
    const supplierId = field(form, 'supplierId');
    const authorized = field(form, 'authorized') === 'true';
    const outcome = purchasingOutcome();
    let next: string;
    try {
      const actionCaller = await purchasingCaller();
      if (!actionCaller) throw new PurchasingValidationError(NO_ACTOR);
      await outcome.write(actionCaller.setSupplierAuthorization)({ supplierId, authorized });
      revalidatePath(ROUTE);
      next = destination(
        ROUTE,
        {
          message: authorized
            ? 'Supplier authorized. It can be ordered from while its licence is valid.'
            : 'Authorization withdrawn. New orders and receipts will be refused.',
          kind: 'success',
        },
        { supplier: supplierId }
      );
    } catch (error) {
      next = destination(
        ROUTE,
        { ...outcome.failure(error, 'Could not change authorization.'), kind: 'error' },
        { supplier: supplierId }
      );
    }
    return next;
  }

  return (
    <PurchasingOutcomeScope>
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={ROUTE} />
      <NoticeBanner notice={notice} />
      <PurchasingOutcomes />

      {loadError || !suppliers ? (
        <LoadFailure
          detail="The supplier register could not be read. This read failure does not confirm or undo earlier changes. Check their outcomes before retrying."
          retryHref={ROUTE}
        />
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,9fr)] xl:items-start">
          <SectionCard
            eyebrow="PUR-01"
            title={`Register (${suppliers.length})`}
            titleLevel={2}
            actions={
              <a
                className="min-h-11 rounded-[var(--radius-sm)] px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                href={param(query, 'inactive') === '1' ? ROUTE : `${ROUTE}?inactive=1`}
              >
                {param(query, 'inactive') === '1' ? 'Hide inactive' : 'Show inactive'}
              </a>
            }
          >
            {suppliers.length === 0 ? (
              <EmptyState
                title="No suppliers yet"
                detail="Add the distributor you buy from. A supplier needs a verified, unexpired licence on file before a purchase order can be raised against it, so record that next."
              />
            ) : (
              <ul className="space-y-2">
                {suppliers.map((supplier) => {
                  const current = supplier.id === selected?.id;
                  return (
                    <li key={supplier.id}>
                      {/* UX rule 4: the whole row is the target, not a small
                          "View" button at the end of it. */}
                      <a
                        aria-current={current ? 'true' : undefined}
                        className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 ${
                          current
                            ? 'border-primary bg-primary/5'
                            : 'border-border-subtle hover:bg-muted'
                        }`}
                        href={`${ROUTE}?supplier=${encodeURIComponent(supplier.id)}${
                          param(query, 'inactive') === '1' ? '&inactive=1' : ''
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text-strong">
                            {supplier.name}
                          </span>
                          <span className="block truncate text-xs text-text-muted">
                            {supplier.serviceArea ?? 'No service area recorded'} ·{' '}
                            {supplier.paymentTermsDays === 0
                              ? 'Cash on delivery'
                              : `Net ${supplier.paymentTermsDays} days`}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {!supplier.active ? (
                            <StatusPill status="Inactive" tone="neutral" />
                          ) : null}
                          <LicenceBadge supplier={supplier} />
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <div className="min-w-0 space-y-6">
            {selected ? (
              <SupplierDetail
                canAuthorize={canAuthorize}
                currentUserId={ctx.session.user.id}
                notice={notice}
                onRecordLicence={recordLicence}
                onSetAuthorization={setAuthorization}
                onVerifyLicence={verifyLicence}
                supplier={selected}
              />
            ) : (
              <SectionCard title="No supplier selected" titleLevel={2}>
                <EmptyState
                  title="Pick a supplier to see its licences"
                  detail={
                    suppliers.length === 0
                      ? 'Add a supplier first — its licence evidence, terms and trade authorization all live on its detail panel.'
                      : 'Choose a row on the left. Its licence evidence, terms, credit limit and authorization control open here, beside the list.'
                  }
                />
              </SectionCard>
            )}

            <SectionCard eyebrow="PUR-01" title="Add a supplier" titleLevel={2}>
              <PurchasingActionForm
                operation={{ resource: 'supplier:new', action: 'create' }}
                action={createSupplier}
                className="grid gap-4 sm:grid-cols-2"
              >
                <TextField
                  label="Trading name"
                  name="name"
                  notice={notice}
                  required
                  hint="What your team calls this distributor."
                />
                <TextField label="Registered legal name" name="legalName" notice={notice} />
                <TextField
                  label="Service area"
                  name="serviceArea"
                  notice={notice}
                  hint="Districts or cities it delivers to."
                />
                <TextField label="Contact name" name="contactName" notice={notice} />
                <TextField label="Contact phone" name="contactPhone" notice={notice} />
                <TextField
                  inputMode="numeric"
                  label="Payment terms (days)"
                  min={0}
                  name="paymentTermsDays"
                  notice={notice}
                  type="number"
                  hint="0 is cash on delivery."
                />
                <TextField
                  label="Credit limit (PKR)"
                  name="creditLimit"
                  notice={notice}
                  inputMode="decimal"
                  hint="Leave blank for no credit."
                />
                <div className="flex items-end sm:col-span-2">
                  <SubmitButton>Add supplier</SubmitButton>
                </div>
              </PurchasingActionForm>
              <p className="mt-3 text-sm text-text-muted">
                A new supplier starts unauthorized and unlicensed, so it cannot be ordered from
                until both are recorded. That is the PUR-01 gate, not a missing step.
              </p>
            </SectionCard>
          </div>
        </div>
      )}
    </PurchasingOutcomeScope>
  );
}

function SupplierDetail({
  supplier,
  notice,
  canAuthorize,
  currentUserId,
  onRecordLicence,
  onSetAuthorization,
  onVerifyLicence,
}: {
  supplier: SupplierSummary;
  notice: ReturnType<typeof noticeFrom>;
  canAuthorize: boolean;
  currentUserId: string;
  onRecordLicence: (form: FormData) => Promise<string>;
  onSetAuthorization: (form: FormData) => Promise<string>;
  onVerifyLicence: (form: FormData) => Promise<string>;
}) {
  const supersedable = supplier.licences.filter((licence) => !licence.superseded);
  return (
    <>
      <SectionCard
        eyebrow="PUR-01"
        title={supplier.name}
        titleLevel={2}
        actions={<LicenceBadge supplier={supplier} />}
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <Detail label="Legal name" value={supplier.legalName ?? '—'} />
          <Detail label="Service area" value={supplier.serviceArea ?? '—'} />
          <Detail label="Contact" value={supplier.contactName ?? '—'} />
          <Detail label="Phone" value={supplier.contactPhone ?? '—'} />
          <Detail
            label="Payment terms"
            value={
              supplier.paymentTermsDays === 0
                ? 'Cash on delivery'
                : `Net ${supplier.paymentTermsDays} days`
            }
          />
          <Detail label="Credit limit" value={money(supplier.creditLimitMinor)} />
        </dl>

        <div className="mt-5 rounded-[var(--radius-sm)] border border-border-subtle p-4">
          <p className="text-sm text-text-body">
            {supplier.eligibility.orderable
              ? 'This supplier can be ordered from and received from right now.'
              : supplier.eligibility.reason === 'NOT_AUTHORIZED'
                ? 'Trade with this supplier is not authorized. Orders, sends and receipts are refused until it is.'
                : 'No unexpired verified licence is on file, so orders, sends and receipts are refused. Authorization alone is not enough.'}
          </p>
          {/* UX rule 15: the control is one action and it is never greyed out
              while the operator is clearly acting on it. */}
          {!canAuthorize ? (
            <p className="mt-3 text-sm text-text-muted">
              Authorizing a supplier, or withdrawing it, needs the purchase-order approval
              permission, which a Manager or the Owner holds. Ask one of them to decide.
            </p>
          ) : (
            <PurchasingActionForm
              operation={{
                resource: `supplier:${supplier.id}`,
                action: supplier.authorized ? 'withdraw' : 'authorize',
              }}
              action={onSetAuthorization}
              className="mt-3"
            >
              <input name="supplierId" type="hidden" value={supplier.id} />
              <input
                name="authorized"
                type="hidden"
                value={supplier.authorized ? 'false' : 'true'}
              />
              <SubmitButton variant={supplier.authorized ? 'destructive' : 'primary'}>
                {supplier.authorized ? 'Withdraw authorization' : 'Authorize this supplier'}
              </SubmitButton>
            </PurchasingActionForm>
          )}
        </div>
      </SectionCard>

      <SectionCard
        eyebrow="PUR-01"
        title={`Licence evidence (${supplier.licences.length})`}
        titleLevel={2}
      >
        {supplier.licences.length === 0 ? (
          <EmptyState
            title="No licence on file"
            detail="File the drug sale licence or distribution licence below. It must be verified and unexpired before this supplier can be ordered from."
          />
        ) : (
          <ul className="space-y-2">
            {supplier.licences.map((licence) => (
              <li
                className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={licence.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-strong">
                    {licence.licenceType} · {licence.licenceNumber}
                  </span>
                  <span className="flex items-center gap-2">
                    {licence.superseded ? <StatusPill status="Superseded" tone="neutral" /> : null}
                    <StatusPill
                      status={licence.verified ? 'Verified' : 'Unverified'}
                      tone={licence.verified ? 'success' : 'warning'}
                    />
                    <StatusPill
                      status={licence.daysToExpiry < 0 ? 'Expired' : 'Valid'}
                      tone={
                        licence.daysToExpiry < 0
                          ? 'danger'
                          : licence.daysToExpiry <= 30
                            ? 'warning'
                            : 'success'
                      }
                      label={
                        licence.daysToExpiry < 0
                          ? `Expired ${Math.abs(licence.daysToExpiry)}d ago`
                          : `${licence.daysToExpiry}d left`
                      }
                    />
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  {licence.issuingAuthority} · issued {dateOnly(licence.issuedAt)} · expires{' '}
                  {dateOnly(licence.expiresAt)}
                </p>
                {licence.evidenceUri ? (
                  <p className="mt-1 truncate font-mono text-xs text-text-muted">
                    Evidence: {licence.evidenceUri}
                  </p>
                ) : null}
                {/* PUR-01: verification is a second person's act. The server
                    refuses the filer; this only says so before they try. */}
                {!licence.verified && !licence.superseded ? (
                  licence.recordedByUserId === currentUserId ? (
                    <p className="mt-2 text-xs text-text-muted">
                      You filed this licence. A colleague with purchasing access verifies it.
                    </p>
                  ) : (
                    <PurchasingActionForm
                      operation={{ resource: `licence:${licence.id}`, action: 'verify' }}
                      action={onVerifyLicence}
                      className="mt-2"
                    >
                      <input name="supplierId" type="hidden" value={supplier.id} />
                      <input name="licenceId" type="hidden" value={licence.id} />
                      <SubmitButton variant="secondary">Verify licence</SubmitButton>
                    </PurchasingActionForm>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <PurchasingActionForm
          operation={{ resource: `supplier:${supplier.id}`, action: 'record-licence' }}
          action={onRecordLicence}
          className="mt-5 grid gap-4 sm:grid-cols-2"
        >
          <input name="supplierId" type="hidden" value={supplier.id} />
          <TextField label="Licence type" name="licenceType" notice={notice} required />
          <TextField label="Licence number" name="licenceNumber" notice={notice} required />
          <TextField
            className="sm:col-span-2"
            label="Issuing authority"
            name="issuingAuthority"
            notice={notice}
            required
          />
          <TextField
            defaultValue={dateInputValue(new Date())}
            label="Issued on"
            name="issuedAt"
            notice={notice}
            required
            type="date"
          />
          <TextField
            label="Expires on"
            name="expiresAt"
            notice={notice}
            required
            type="date"
            hint="Must be after the issue date."
          />
          <TextField
            className="sm:col-span-2"
            label="Evidence location"
            name="evidenceUri"
            notice={notice}
            hint="Where the scanned licence is filed. Evidence of the licence, not the licence itself."
          />
          <SelectField
            className="sm:col-span-2"
            defaultValue=""
            emptyHint="Nothing to supersede yet — this will be the first filing."
            hint="A correction supersedes the earlier filing; both are kept."
            label="Supersedes an earlier filing"
            name="supersedesId"
            notice={notice}
            options={supersedable.map((licence) => ({
              value: licence.id,
              label: `${licence.licenceType} ${licence.licenceNumber} (expires ${dateOnly(licence.expiresAt)})`,
            }))}
            placeholder="No — this is a new licence"
          />
          <Field label="Verification" name="verified" notice={notice}>
            {(control) => (
              <label className="flex min-h-11 items-center gap-2 text-sm text-text-body">
                <input
                  aria-describedby={control['aria-describedby']}
                  className="size-4"
                  id={control.id}
                  name="verified"
                  type="checkbox"
                />
                I have checked this licence against the issuing authority
              </label>
            )}
          </Field>
          <p className="text-xs text-text-muted sm:col-span-2">
            Whoever files a licence cannot also verify it: a colleague verifies it from the list
            above. Only the sole owner of a one-person workspace may tick this box.
          </p>
          <div className="flex items-end">
            <SubmitButton>File licence</SubmitButton>
          </div>
          <Derived
            label="Gate"
            value="Only a verified, unexpired licence makes a supplier orderable."
          />
        </PurchasingActionForm>
      </SectionCard>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="truncate text-sm text-text-strong">{value}</dd>
    </div>
  );
}
