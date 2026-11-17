import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { SupplierLicenceStatus } from '@/lib/pharmacy/purchasing';
import {
  SUPPLIER_CHECKS_DISABLED_LABEL,
  SUPPLIER_COMPLIANCE_WARNING,
  type SupplierComplianceOperation,
} from '@/lib/pharmacy/supplier-compliance';
import { PurchasingActionForm } from '../../_components/action-form';
import { Field, SubmitButton } from '../../_components/form-controls';
import { dateTime, type Notice } from '../../_lib/console';
import type {
  SupplierCompliancePolicyHistory,
  SupplierCompliancePolicyRead,
  SupplierComplianceSkips,
} from '../_lib/supplier-compliance';

/**
 * DEV-753 — the owner switch for supplier compliance checks, on the register it
 * governs. The policy status is shown apart from any supplier's evidence status:
 * "Checks disabled" describes what the software does, never what a supplier holds.
 */

export const LICENCE_STATUS_LABEL: Record<SupplierLicenceStatus, string> = {
  VALID: 'Valid verified licence on file',
  NONE: 'No licence on file',
  UNVERIFIED: 'Licence on file is not verified',
  EXPIRED: 'Licence on file has expired',
  SUPERSEDED: 'Licence on file has been superseded',
};

const OPERATION_LABEL: Record<SupplierComplianceOperation, string> = {
  PURCHASE_ORDER_CREATE: 'Purchase order raised',
  PURCHASE_ORDER_APPROVE: 'Purchase order approved',
  PURCHASE_ORDER_SEND: 'Purchase order sent',
  GOODS_RECEIPT_CREATE: 'Goods receipt drafted',
  GOODS_RECEIPT_POST: 'Goods receipt posted',
  CENTRAL_PURCHASE_ORDER_CREATE: 'Central purchase order raised',
};

function setBy(read: SupplierCompliancePolicyRead, timeZone?: string | null): string {
  const { policy } = read;
  if (!policy.updatedAt) return '';
  return ` Changed ${dateTime(policy.updatedAt, timeZone)}${
    policy.updatedByName ? ` by ${policy.updatedByName}` : ''
  } (policy version ${policy.version}).`;
}

export function SupplierCompliancePanel({
  read,
  history,
  notice,
  onSetPolicy,
  timeZone,
}: {
  /** `null` when the policy could not be read; the server enforces in that case. */
  read: SupplierCompliancePolicyRead | null;
  history: SupplierCompliancePolicyHistory | null;
  notice: Notice | null;
  onSetPolicy: (form: FormData) => Promise<string>;
  timeZone?: string | null;
}) {
  if (!read) {
    return (
      <SectionCard eyebrow="Pharmacy policy" title="Supplier compliance checks" titleLevel={2}>
        <p className="text-sm text-text-body">
          The supplier compliance setting could not be shown here. Orders and receipts follow the
          setting stored on the server, and if the server cannot read it the supplier checks stay
          on.
        </p>
      </SectionCard>
    );
  }

  const on = read.policy.checksEnabled;
  // Staff only need the panel when something differs from the default.
  if (on && !read.canManage) return null;

  return (
    <SectionCard
      eyebrow="Pharmacy policy"
      title="Supplier compliance checks"
      titleLevel={2}
      actions={
        on ? (
          <StatusPill status="On" tone="success" label="Checks on" />
        ) : (
          <StatusPill status="Off" tone="warning" label={SUPPLIER_CHECKS_DISABLED_LABEL} />
        )
      }
    >
      {on ? (
        <p className="text-sm text-text-body">
          A supplier must be authorized and hold a verified, unexpired licence before you can raise,
          approve or send a purchase order, or draft or post a goods receipt from it.
          {read.policy.source === 'FAIL_CLOSED'
            ? ' The stored setting could not be read, so the checks are enforced.'
            : setBy(read, timeZone)}
        </p>
      ) : (
        <div className="space-y-2 text-sm text-text-body">
          <p className="text-text-body">
            Supplier licence and trade-authorization checks are off. Orders and receipts are not
            refused because a licence or authorization is missing, and suppliers are shown as
            &ldquo;Not checked&rdquo;.{setBy(read, timeZone)}
          </p>
          <p className="text-text-muted">
            This includes suppliers of controlled medicines. The controlled-drug safeguards
            themselves are unchanged: the pharmacist witness PIN at goods-in, the controlled
            register and the counter&rsquo;s controlled-medicine checks still apply, as do approvals
            and PINs, batch, expiry and stock checks, invoice and accounting records and branch
            access. Licences on file are kept unchanged. The pharmacy remains responsible for its
            legal sourcing obligations.
          </p>
          {!read.canManage ? (
            <p className="text-text-muted">
              Only the pharmacy owner or an administrator with pharmacy settings access can change
              this setting.
            </p>
          ) : null}
        </div>
      )}

      {read.canManage && read.policy.source !== 'FAIL_CLOSED' ? (
        on ? (
          // Collapsed by default so the register and the selected supplier stay above the
          // fold; opened again when the server sends the operator back to this form.
          <details className="mt-3" open={notice?.field === 'acknowledged'}>
            <summary className="flex min-h-11 cursor-pointer items-center rounded-[var(--radius-sm)] text-sm font-medium text-text-strong underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2">
              Turn supplier checks off…
            </summary>
            <PurchasingActionForm
              operation={{ resource: 'supplier-compliance-policy', action: 'turn-off' }}
              action={onSetPolicy}
              className="mt-4 space-y-4"
            >
              <input name="checksEnabled" type="hidden" value="false" />
              <input name="expectedVersion" type="hidden" value={read.policy.version} />
              <input name="warningVersion" type="hidden" value={read.warningVersion} />
              <div
                className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/10 p-4"
                role="note"
                aria-labelledby="supplier-compliance-warning-title"
              >
                <p
                  className="text-sm font-semibold text-text-strong"
                  id="supplier-compliance-warning-title"
                >
                  {SUPPLIER_COMPLIANCE_WARNING.title}
                </p>
                <div className="mt-2 space-y-2 text-sm text-text-body">
                  {SUPPLIER_COMPLIANCE_WARNING.paragraphs.map((paragraph) => (
                    <p className="text-text-body" key={paragraph}>
                      {paragraph}
                    </p>
                  ))}
                </div>
              </div>
              <Field label="Acknowledgement" name="acknowledged" notice={notice}>
                {(control) => (
                  <label className="flex min-h-11 items-start gap-2 text-sm text-text-body">
                    <input
                      aria-describedby={control['aria-describedby']}
                      aria-invalid={control['aria-invalid']}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      id={control.id}
                      name="acknowledged"
                      required
                      type="checkbox"
                    />
                    {SUPPLIER_COMPLIANCE_WARNING.acknowledgement}
                  </label>
                )}
              </Field>
              <SubmitButton variant="destructive">Turn supplier checks off</SubmitButton>
            </PurchasingActionForm>
          </details>
        ) : (
          <PurchasingActionForm
            operation={{ resource: 'supplier-compliance-policy', action: 'turn-on' }}
            action={onSetPolicy}
            className="mt-4 space-y-3"
          >
            <input name="checksEnabled" type="hidden" value="true" />
            <input name="expectedVersion" type="hidden" value={read.policy.version} />
            <p className="text-sm text-text-muted">
              Turning the checks back on applies to every later order and receipt, including drafts
              not yet sent or posted. Records made while they were off keep that history.
            </p>
            <SubmitButton>Turn supplier checks back on</SubmitButton>
          </PurchasingActionForm>
        )
      ) : null}

      {read.canManage && history && history.length > 0 ? (
        <details className="mt-4 border-t border-border-subtle pt-3">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-[var(--radius-sm)] text-sm font-medium text-text-strong underline-offset-4 hover:underline focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2">
            Change history ({history.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {history.slice(0, 5).map((change) => (
              <li className="text-sm text-text-body" key={change.id}>
                <span className="font-medium text-text-strong">
                  {change.newValue ? 'Turned on' : 'Turned off'}
                </span>{' '}
                · {dateTime(change.changedAt, timeZone)} · {change.actorName ?? 'Unknown user'}
                {change.policyVersion ? ` · version ${change.policyVersion}` : ''}
                {!change.newValue && change.acknowledgement ? ' · warning acknowledged' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </SectionCard>
  );
}

/**
 * The supplier's standing under the current policy, for the detail panel. With the
 * checks off it says nothing was verified and names what the evidence on file shows.
 */
export function SupplierPolicyStanding({
  checked,
  orderable,
  reason,
  licenceStatus,
}: {
  checked: boolean;
  orderable: boolean;
  reason: 'NOT_AUTHORIZED' | 'NO_VALID_LICENCE' | null;
  licenceStatus: SupplierLicenceStatus;
}) {
  if (!checked) {
    return (
      <p className="text-sm text-text-body">
        Supplier checks are off, so orders, sends and receipts are not refused for a missing licence
        or authorization, controlled medicines included. This supplier has not been checked.{' '}
        {`${LICENCE_STATUS_LABEL[licenceStatus]}.`} Authorization and licences can still be recorded
        as evidence.
      </p>
    );
  }
  return (
    <p className="text-sm text-text-body">
      {orderable
        ? 'This supplier can be ordered from and received from right now.'
        : reason === 'NOT_AUTHORIZED'
          ? 'Trade with this supplier is not authorized. Orders, sends and receipts are refused until it is.'
          : 'No unexpired, verified and current licence is on file, so orders, sends and receipts are refused. Authorization alone is not enough.'}
    </p>
  );
}

/** Writes that went ahead for this supplier while the checks were off. Evidence only. */
export function SupplierComplianceSkipList({
  skips,
  timeZone,
}: {
  skips: SupplierComplianceSkips | null;
  timeZone?: string | null;
}) {
  if (!skips || skips.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border-subtle pt-4">
      <h3 className="eyebrow">Recorded without supplier checks</h3>
      <ul className="mt-2 space-y-2">
        {skips.slice(0, 5).map((skip) => (
          <li className="text-sm text-text-body" key={skip.id}>
            <span className="font-medium text-text-strong">
              {OPERATION_LABEL[skip.operation] ?? skip.operation}
            </span>
            {skip.reference ? ` ${skip.reference}` : ''} · {dateTime(skip.recordedAt, timeZone)} ·{' '}
            {skip.actorName ?? 'Unknown user'} · policy version {skip.policyVersion} ·{' '}
            {skip.supplierAuthorized ? 'authorized' : 'not authorized'},{' '}
            {LICENCE_STATUS_LABEL[skip.licenceStatus as SupplierLicenceStatus]?.toLowerCase() ??
              skip.licenceStatus}
          </li>
        ))}
      </ul>
    </div>
  );
}
