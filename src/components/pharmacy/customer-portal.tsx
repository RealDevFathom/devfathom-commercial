'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Field, WorkspaceState, fieldClass } from './dispensing/field';
import { fileError, imageBase64, isImageType } from '@/lib/pharmacy/prescription-image-input';
import type { CustomerPortalSummary } from '@/lib/pharmacy/customer-portal-contract';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';
import { buildCounterReceiptPreview } from '@/lib/pharmacy/counter-receipt-presentation';
import { printCounterBrowserReceipt } from '@/lib/pharmacy/counter-browser-print';

import { CustomerPortalClientError, portalFetch } from '@/lib/pharmacy/customer-portal-client';

const endpoint = '/api/pharmacy/customer';
type Bootstrap = {
  signedIn: false;
  pharmacyName: string;
  branches: { id: string; name: string }[];
  smsAvailable: boolean;
};
type State = Bootstrap | { signedIn: true; summary: CustomerPortalSummary };

export function CustomerPortal() {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [receipt, setReceipt] = useState<CounterReceipt | null>(null);
  const [receiptLocale, setReceiptLocale] = useState<'en' | 'ur'>('en');
  const requestKey = useRef<{ refill: string | null; photo: string | null }>({
    refill: null,
    photo: null,
  });
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await portalFetch<State>(endpoint));
      setError('');
    } catch (e) {
      if (e instanceof CustomerPortalClientError && e.status === 401) {
        setState(null);
        setReceipt(null);
      }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      if (challengeId) {
        await portalFetch(endpoint, {
          action: 'verify',
          challengeId,
          code: String(form.get('code')),
        });
        setChallengeId('');
        await load();
      } else {
        const response = await portalFetch<{ challengeId: string; message: string }>(endpoint, {
          action: 'start',
          branchId: String(form.get('branchId')),
          phone: String(form.get('phone')),
        });
        setChallengeId(response.challengeId);
        setNotice(response.message);
      }
    });
  }

  const summary = state?.signedIn ? state.summary : null;
  const money = (minor: number) => `${summary?.currency ?? ''} ${(minor / 100).toFixed(2)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Customer portal"
        heading={
          summary
            ? `My pharmacy · ${summary.branchName}`
            : state && !state.signedIn
              ? state.pharmacyName
              : 'My pharmacy'
        }
        description="Private receipts, refill requests, Rx photos, khata payments and rewards."
        actions={
          summary ? (
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await portalFetch(endpoint, { action: 'logout' });
                  setState(null);
                  setReceipt(null);
                  await load();
                })
              }
            >
              Sign out
            </Button>
          ) : undefined
        }
      />
      {loading ? (
        <WorkspaceState title="Loading customer service">
          Connecting to your pharmacy.
        </WorkspaceState>
      ) : null}
      {error ? (
        <div
          id="customer-portal-error"
          role="alert"
          className="rounded-lg border border-destructive p-4 text-destructive"
        >
          <p>{error}</p>
          <Button
            className="mt-3 min-h-11"
            variant="secondary"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Retry connection
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-text-body">
          {notice}
        </p>
      ) : null}
      {state && !state.signedIn && !loading ? (
        <SectionCard title="Verify your phone">
          {!state.branches.length || !state.smsAvailable ? (
            <p className="text-sm text-text-muted">
              Customer sign-in is unavailable. Contact the pharmacy for help with your receipts or
              requests.
            </p>
          ) : (
            <form onSubmit={signIn} className="grid max-w-lg gap-4">
              <p className="text-sm text-text-muted">
                Use the phone registered with your pharmacy. Your staff login does not grant access
                to customer records.
              </p>
              {challengeId ? (
                <Field label="Six-digit SMS code">
                  <input
                    className={fieldClass}
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'customer-portal-error' : undefined}
                    disabled={busy}
                  />
                </Field>
              ) : (
                <>
                  <Field label="Pharmacy branch">
                    <select className={fieldClass} name="branchId" required disabled={busy}>
                      {state.branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Registered phone number">
                    <input
                      className={fieldClass}
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      aria-describedby={error ? 'customer-portal-error' : undefined}
                      minLength={8}
                      maxLength={32}
                      required
                      disabled={busy}
                    />
                  </Field>
                </>
              )}
              <div className="flex flex-wrap gap-3">
                <Button className="min-h-11" type="submit" disabled={busy}>
                  {busy ? 'Please wait…' : challengeId ? 'Verify and sign in' : 'Send SMS code'}
                </Button>
                {challengeId ? (
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setChallengeId('');
                      setNotice('');
                      setError('');
                    }}
                  >
                    Request a new code
                  </Button>
                ) : null}
              </div>
            </form>
          )}
        </SectionCard>
      ) : null}
      {summary ? (
        <>
          <p className="text-sm text-text-muted">
            Signed in as {summary.customerName}. Requests are reviewed by a pharmacist before
            dispensing.
          </p>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SectionCard title="Receipts">
              {!summary.receipts.length ? (
                <p className="text-sm text-text-muted">
                  No completed purchases are linked to your customer account at this branch.
                </p>
              ) : (
                <ul className="space-y-3">
                  {summary.receipts.map((sale) => (
                    <li
                      key={sale.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3"
                    >
                      <span className="text-sm">
                        Receipt {sale.receiptNumber} · {sale.completedAt?.slice(0, 10)}
                      </span>
                      <Button
                        className="min-h-11"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            setReceipt(
                              await portalFetch<CounterReceipt>(
                                `${endpoint}?receipt=${encodeURIComponent(sale.id)}`
                              )
                            );
                          })
                        }
                      >
                        View receipt {sale.receiptNumber}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {receipt ? (
                <div className="mt-4 space-y-3">
                  <Field label="Receipt language">
                    <select
                      className={fieldClass}
                      value={receiptLocale}
                      onChange={(e) => setReceiptLocale(e.target.value as 'en' | 'ur')}
                    >
                      <option value="en">English</option>
                      <option value="ur">اردو</option>
                    </select>
                  </Field>
                  <pre
                    dir={receiptLocale === 'ur' ? 'rtl' : 'ltr'}
                    className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-4 text-xs"
                  >
                    {buildCounterReceiptPreview(receipt, receiptLocale, 80, true)}
                  </pre>
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    onClick={() => {
                      try {
                        printCounterBrowserReceipt(receipt, receiptLocale, 'A4', true);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Print or save receipt
                  </Button>
                </div>
              ) : null}
            </SectionCard>
            <SectionCard title="Request a refill">
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  void run(async () => {
                    requestKey.current.refill ??= crypto.randomUUID();
                    await portalFetch(endpoint, {
                      action: 'refill',
                      saleId: String(data.get('saleId')),
                      idempotencyKey: requestKey.current.refill,
                    });
                    requestKey.current.refill = null;
                    await load();
                    setNotice(
                      'Refill request received. A pharmacist will review your previous purchase.'
                    );
                  });
                }}
              >
                <p className="text-sm text-text-muted">
                  Select your previous receipt. Availability and clinical suitability must be
                  checked by the pharmacist.
                </p>
                <Field label="Previous receipt">
                  <select
                    className={fieldClass}
                    name="saleId"
                    required
                    disabled={busy || !summary.receipts.length}
                    onChange={() => {
                      requestKey.current.refill = null;
                    }}
                  >
                    {summary.receipts.map((sale) => (
                      <option key={sale.id} value={sale.id}>
                        Receipt {sale.receiptNumber} · {sale.completedAt?.slice(0, 10)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  className="min-h-11 justify-self-start"
                  disabled={busy || !summary.receipts.length}
                  type="submit"
                >
                  {busy ? 'Submitting…' : 'Request pharmacist review'}
                </Button>
              </form>
            </SectionCard>
            <SectionCard title="Order with an Rx photo">
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const file = new FormData(form).get('photo') as File | null;
                  void run(async () => {
                    const validation = fileError(file);
                    if (validation || !file || !isImageType(file.type))
                      throw new Error(validation || 'Choose an image.');
                    requestKey.current.photo ??= crypto.randomUUID();
                    await portalFetch(endpoint, {
                      action: 'photo',
                      contentType: file.type,
                      dataBase64: await imageBase64(file),
                      idempotencyKey: requestKey.current.photo,
                    });
                    requestKey.current.photo = null;
                    form.reset();
                    await load();
                    setNotice(
                      'Photo request received. A pharmacist must verify it before fulfilment.'
                    );
                  });
                }}
              >
                <p className="text-sm text-text-muted">
                  Upload your own prescription. A photo does not authorize dispensing.
                </p>
                <Field label="Rx photo" hint="JPEG, PNG or WebP, up to 5 MiB.">
                  <input
                    className={`${fieldClass} py-2`}
                    name="photo"
                    aria-describedby={error ? 'customer-portal-error' : undefined}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    required
                    disabled={busy}
                    onChange={() => {
                      requestKey.current.photo = null;
                    }}
                  />
                </Field>
                <Button className="min-h-11 justify-self-start" type="submit" disabled={busy}>
                  {busy ? 'Uploading…' : 'Send Rx for review'}
                </Button>
              </form>
            </SectionCard>
            <SectionCard title="Pay khata with Raast">
              {!summary.accounts.length ? (
                <p className="text-sm text-text-muted">
                  No khata account lists you as its payer at this branch.
                </p>
              ) : (
                <div className="space-y-4">
                  {summary.accounts.map((account) => (
                    <div key={account.id} className="rounded-md border border-border-subtle p-4">
                      <p className="font-medium">{account.displayName}</p>
                      <p className="mt-2 font-mono tabular-nums">
                        Balance: {money(account.balanceMinor)}
                      </p>
                      <p className="mt-2 break-all text-xs text-text-muted">
                        Payment reference: {account.id}
                      </p>
                    </div>
                  ))}
                  {summary.raast ? (
                    <div className="space-y-2 text-sm">
                      <p>
                        Open your bank app, choose Raast, and pay the amount you intend to settle.
                      </p>
                      <p>
                        Verified account title: <strong>{summary.raast.payee}</strong>
                      </p>
                      <p className="break-all">
                        Raast ID / IBAN: <strong>{summary.raast.id}</strong>
                      </p>
                      <p>
                        Check the account title in your bank app. Include your account reference and
                        contact the pharmacy after transferring. Your balance updates after the
                        pharmacy confirms receipt.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">
                      The pharmacy has not configured verified Raast details. Contact the store
                      before paying.
                    </p>
                  )}
                </div>
              )}
            </SectionCard>
            <SectionCard title={summary.loyaltyLabel}>
              <p className="font-mono text-xl tabular-nums">
                {summary.pointsBalance === null
                  ? 'Consent required'
                  : `${summary.pointsBalance} points`}
              </p>
              {summary.pointsBalance === null ? (
                <p className="mt-2 text-sm text-text-muted">
                  Ask the pharmacy to record your loyalty consent before viewing rewards.
                </p>
              ) : null}
              <h3 className="mt-4 font-semibold">Non-drug offers</h3>
              {summary.offers.length ? (
                <ul className="mt-2 space-y-2 text-sm">
                  {summary.offers.map((offer) => (
                    <li key={offer}>{offer}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-text-muted">No active offers.</p>
              )}
            </SectionCard>
            <SectionCard title="Your requests">
              {summary.requests.length ? (
                <ul className="space-y-3">
                  {summary.requests.map((request) => (
                    <li
                      key={request.id}
                      className="flex flex-wrap items-center justify-between gap-3"
                    >
                      <span className="text-sm">
                        {request.kind === 'REFILL' ? 'Refill' : 'Rx photo'} ·{' '}
                        {request.createdAt.slice(0, 10)}
                      </span>
                      <StatusPill
                        status={request.status}
                        label={request.status.replaceAll('_', ' ').toLowerCase()}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-muted">
                  No requests yet. Submit a refill or Rx photo for pharmacist review.
                </p>
              )}
            </SectionCard>
          </div>
        </>
      ) : null}
      <SectionCard title="Pharmacist verification">
        <p className="text-sm text-text-muted">
          For urgent care or clinical advice, contact the pharmacy directly. This portal does not
          advertise drugs or provide medical advice.
        </p>
      </SectionCard>
    </div>
  );
}
