'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Field, WorkspaceState, fieldClass } from './dispensing/field';
import { PrescriptionsConsole } from './dispensing/prescriptions-console';
import type { CustomerPortalSettings } from '@/lib/pharmacy/customer-portal-contract';
import { portalFetch } from '@/lib/pharmacy/customer-portal-client';

type QueueRequest = {
  id: string;
  kind: string;
  status: string;
  customerName: string;
  patientId: string;
  sourceSaleId: string | null;
  sourceFileRef: string | null;
};
type Workspace = {
  branches: { id: string; name: string }[];
  branchId?: string;
  settings: CustomerPortalSettings | null;
  requests: QueueRequest[];
  canConfigure: boolean;
};
const endpoint = '/api/pharmacy/customer-requests';

export function CustomerRequests() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [branchId, setBranchId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [capture, setCapture] = useState<QueueRequest | null>(null);
  const flight = useRef(false);
  // setState runs only in promise callbacks: the branch fetch subscribes to the
  // external queue API, and later reloads start from user events.
  const fetchWorkspace = useCallback(
    () =>
      portalFetch<Workspace>(
        `${endpoint}${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`
      ),
    [branchId]
  );
  const applyLoaded = useCallback((nextWorkspace: Workspace) => {
    setWorkspace(nextWorkspace);
    setError('');
    setLoading(false);
  }, []);
  const applyFailed = useCallback((e: unknown) => {
    setError((e as Error).message);
    setLoading(false);
  }, []);
  const load = useCallback(
    () => fetchWorkspace().then(applyLoaded, applyFailed),
    [fetchWorkspace, applyLoaded, applyFailed]
  );
  useEffect(() => {
    let active = true;
    fetchWorkspace().then(
      (nextWorkspace) => {
        if (active) applyLoaded(nextWorkspace);
      },
      (e: unknown) => {
        if (active) applyFailed(e);
      }
    );
    return () => {
      active = false;
    };
  }, [fetchWorkspace, applyLoaded, applyFailed]);

  async function submit(event: FormEvent<HTMLFormElement>, request?: QueueRequest) {
    event.preventDefault();
    if (flight.current || !workspace?.branchId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = request ? submitter?.value : 'settings';
    if (!action) return;
    if (
      action === 'DECLINE' &&
      !window.confirm('Decline this customer request? The customer will see that it was declined.')
    )
      return;
    flight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const common = { action, branchId: workspace.branchId, pin: String(data.get('pin')) };
      const command = request
        ? {
            ...common,
            requestId: request.id,
            ...(action === 'FULFIL' ? { saleId: String(data.get('saleId')) } : {}),
          }
        : {
            ...common,
            settings: {
              enabled: data.get('enabled') === 'on',
              otpTtlMinutes: Number(data.get('otpTtlMinutes')),
              otpMaxAttempts: Number(data.get('otpMaxAttempts')),
              sessionMinutes: Number(data.get('sessionMinutes')),
              loyaltyLabel: String(data.get('loyaltyLabel')),
              raastPayeeLabel: String(data.get('raastPayeeLabel')),
              raastId: String(data.get('raastId')),
              nonDrugOffersEnabled: data.get('nonDrugOffersEnabled') === 'on',
              deliveryFeeWaived: data.get('deliveryFeeWaived') === 'on',
            },
          };
      await portalFetch(endpoint, command);
      form.reset();
      setLoading(true);
      await load();
      setNotice(
        request
          ? 'Request updated. Dispensing controls still apply at the counter.'
          : 'Customer service settings verified and saved.'
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      const pinField = form.querySelector<HTMLInputElement>('[name=pin]');
      if (pinField) pinField.value = '';
      flight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy · customer service"
        heading="Customer requests"
        description="Review refill and Rx photo requests. Approvals require your own PIN; dispensing remains in the existing verified counter workflow."
        actions={
          <Link
            href="/pharmacy/prescriptions"
            className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
          >
            Prescription workspace
          </Link>
        }
      />
      {loading ? (
        <WorkspaceState title="Loading requests">
          Retrieving the assigned branch queue.
        </WorkspaceState>
      ) : null}
      {error ? (
        <WorkspaceState title="Customer service could not be updated" tone="danger">
          <p>{error}</p>
          <Button
            className="mt-3 min-h-11"
            variant="secondary"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Retry
          </Button>
        </WorkspaceState>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {workspace ? (
        <>
          <Field label="Assigned pharmacy branch">
            <select
              className={fieldClass}
              value={workspace.branchId ?? ''}
              disabled={busy}
              onChange={(e) => {
                setLoading(true);
                setBranchId(e.target.value);
                setCapture(null);
              }}
            >
              {workspace.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          {!workspace.requests.length ? (
            <WorkspaceState title="No customer requests">
              New customer requests will appear here after phone verification.
            </WorkspaceState>
          ) : null}
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {workspace.requests.map((request) => (
              <SectionCard
                key={request.id}
                title={`${request.kind === 'REFILL' ? 'Refill' : 'Rx photo'} · ${request.customerName}`}
                actions={
                  <StatusPill
                    status={request.status}
                    label={request.status.replaceAll('_', ' ').toLowerCase()}
                  />
                }
              >
                <p className="break-all text-xs text-text-muted">Request {request.id}</p>
                {request.sourceSaleId ? (
                  <p className="mt-2 break-all text-sm">Previous sale: {request.sourceSaleId}</p>
                ) : null}
                {request.sourceFileRef &&
                ['AWAITING_PHARMACIST', 'APPROVED'].includes(request.status) ? (
                  <Button
                    className="mt-3 min-h-11"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setCapture(request)}
                  >
                    Review photo and capture prescription
                  </Button>
                ) : null}
                {['AWAITING_PHARMACIST', 'APPROVED'].includes(request.status) ? (
                  <form
                    className="mt-4 grid gap-3"
                    onSubmit={(event) => void submit(event, request)}
                  >
                    {request.status === 'APPROVED' ? (
                      <>
                        <p className="text-sm text-text-muted">
                          Dispense at the counter with the recorded customer and Rx. Existing
                          pharmacist SIGN, consent, stock and payment checks apply.
                        </p>
                        <Field label="Completed dispensing sale ID">
                          <input
                            className={fieldClass}
                            name="saleId"
                            required
                            maxLength={128}
                            disabled={busy}
                          />
                        </Field>
                      </>
                    ) : (
                      <p className="text-sm text-text-muted">
                        Confirm that the request is suitable for the pharmacist dispensing workflow.
                        Approval alone does not release stock.
                      </p>
                    )}
                    <Field label="Your operator PIN">
                      <input
                        className={fieldClass}
                        name="pin"
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        pattern="[0-9]{4,8}"
                        maxLength={8}
                        required
                        disabled={busy}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      {request.status === 'AWAITING_PHARMACIST' ? (
                        <>
                          <Button
                            className="min-h-11"
                            type="submit"
                            name="action"
                            value="APPROVE"
                            disabled={busy}
                          >
                            Approve for dispensing review
                          </Button>
                          <Button
                            className="min-h-11"
                            variant="destructive"
                            type="submit"
                            name="action"
                            value="DECLINE"
                            disabled={busy}
                          >
                            Decline request
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="min-h-11"
                          type="submit"
                          name="action"
                          value="FULFIL"
                          disabled={busy}
                        >
                          Link completed sale
                        </Button>
                      )}
                    </div>
                  </form>
                ) : null}
              </SectionCard>
            ))}
          </div>
          {capture?.sourceFileRef ? (
            <SectionCard title={`Capture customer Rx · ${capture.customerName}`}>
              <p className="mb-4 text-sm text-text-muted">
                The original customer image is attached. Capture the authority and directions, then
                complete the pharmacist review at the counter.
              </p>
              <PrescriptionsConsole
                key={capture.id}
                embedded
                initialBranchId={workspace.branchId}
                initialPatientId={capture.patientId}
                initialSourceFileRef={capture.sourceFileRef}
              />
            </SectionCard>
          ) : null}
          {workspace.canConfigure && workspace.settings ? (
            <SectionCard title="Customer service settings">
              <form
                key={`${workspace.branchId}:${JSON.stringify(workspace.settings)}`}
                className="grid gap-4"
                onSubmit={(event) => void submit(event)}
              >
                <p className="text-sm text-text-muted">
                  Share{' '}
                  <Link className="underline" href="/pharmacy/customer">
                    this customer link
                  </Link>{' '}
                  from this tenant host by SMS, WhatsApp or QR. Verify the Raast destination against
                  the store account before saving. SMS delivery also requires the tenant-bound
                  sender configuration.
                </p>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={workspace.settings.enabled}
                    disabled={busy}
                  />
                  Enable customer sign-in
                </label>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="OTP lifetime (minutes)">
                    <input
                      className={fieldClass}
                      name="otpTtlMinutes"
                      type="number"
                      min={1}
                      max={30}
                      defaultValue={workspace.settings.otpTtlMinutes}
                      required
                      disabled={busy}
                    />
                  </Field>
                  <Field label="OTP attempt limit">
                    <input
                      className={fieldClass}
                      name="otpMaxAttempts"
                      type="number"
                      min={1}
                      max={10}
                      defaultValue={workspace.settings.otpMaxAttempts}
                      required
                      disabled={busy}
                    />
                  </Field>
                  <Field label="Session lifetime (minutes)">
                    <input
                      className={fieldClass}
                      name="sessionMinutes"
                      type="number"
                      min={5}
                      max={1440}
                      defaultValue={workspace.settings.sessionMinutes}
                      required
                      disabled={busy}
                    />
                  </Field>
                </div>
                <Field label="Loyalty label">
                  <input
                    className={fieldClass}
                    name="loyaltyLabel"
                    defaultValue={workspace.settings.loyaltyLabel}
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                </Field>
                <Field label="Verified Raast account title">
                  <input
                    className={fieldClass}
                    name="raastPayeeLabel"
                    defaultValue={workspace.settings.raastPayeeLabel}
                    maxLength={120}
                    disabled={busy}
                  />
                </Field>
                <Field label="Verified Raast ID or IBAN">
                  <input
                    className={fieldClass}
                    name="raastId"
                    defaultValue={workspace.settings.raastId}
                    maxLength={34}
                    disabled={busy}
                  />
                </Field>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    name="nonDrugOffersEnabled"
                    defaultChecked={workspace.settings.nonDrugOffersEnabled}
                    disabled={busy}
                  />
                  Show non-drug service offers
                </label>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    name="deliveryFeeWaived"
                    defaultChecked={workspace.settings.deliveryFeeWaived}
                    disabled={busy}
                  />
                  Offer a delivery fee waiver
                </label>
                <Field label="Your operator PIN to verify these settings">
                  <input
                    className={fieldClass}
                    name="pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="[0-9]{4,8}"
                    maxLength={8}
                    required
                    disabled={busy}
                  />
                </Field>
                <Button className="min-h-11 justify-self-start" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Verify and save settings'}
                </Button>
              </form>
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
