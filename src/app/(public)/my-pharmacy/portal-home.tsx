'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';

type PortalRequest = {
  id: string;
  kind: 'REFILL' | 'RX_ORDER' | 'KHATA_PAYMENT';
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'CANCELLED';
  note: string | null;
  amountMinor: number | null;
  decisionNote: string | null;
  createdAt: string;
  refillSale: { receiptNumber: string } | null;
};

export type PortalHomeData = {
  customer: { displayName: string };
  branchName: string;
  currency: string;
  loyaltyPoints: number;
  receipts: Array<{
    saleId: string;
    receiptNumber: string;
    completedAt: string | null;
    totalMinor: number;
  }>;
  khataAccounts: Array<{ id: string; displayName: string; balanceMinor: number }>;
  raast: { destination: string; qrImageDataUrl: string | null } | null;
  offers: Array<{ id: string; title: string; body: string }>;
  requests: PortalRequest[];
};

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error' }
  | { kind: 'ready'; home: PortalHomeData };

const KIND_LABELS: Record<PortalRequest['kind'], string> = {
  REFILL: 'Refill request',
  RX_ORDER: 'Prescription order',
  KHATA_PAYMENT: 'Khata payment',
};

const STATUS_LABELS: Record<PortalRequest['status'], string> = {
  PENDING: 'Waiting for the pharmacy',
  VERIFIED: 'Confirmed',
  REJECTED: 'Not accepted',
  CANCELLED: 'Cancelled',
};

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-PK', { style: 'currency', currency }).format(minor / 100);
}

function day(value: string | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeZone: 'Asia/Karachi' }).format(
    new Date(value)
  );
}

function majorToMinor(value: string): number | null {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('The photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function post(action: 'request' | 'cancel' | 'sign-out', body: unknown) {
  const response = await fetch(`/api/pharmacy/portal/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!response.ok || !result.ok)
    throw new Error(result.message ?? 'This request could not be completed.');
}

export function PortalHome() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [rxNote, setRxNote] = useState('');
  const [paymentAccount, setPaymentAccount] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentRef, setPaymentRef] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/pharmacy/portal/me', { cache: 'no-store' });
      if (response.status === 401 || response.status === 404) {
        setState({ kind: 'signed-out' });
        return;
      }
      const result = (await response.json()) as { ok: boolean; home?: PortalHomeData };
      setState(result.ok && result.home ? { kind: 'ready', home: result.home } : { kind: 'error' });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    // Initial load of the signed-in customer's own records.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(work: () => Promise<void>, success: string) {
    setPending(true);
    setNotice(null);
    try {
      await work();
      setNotice({ tone: 'success', text: success });
      await load();
    } catch (cause) {
      setNotice({
        tone: 'danger',
        text: cause instanceof Error ? cause.message : 'This request could not be completed.',
      });
    } finally {
      setPending(false);
    }
  }

  if (state.kind === 'loading')
    return (
      <SectionCard>
        <p role="status" className="text-sm text-text-muted">
          Loading your pharmacy account…
        </p>
      </SectionCard>
    );
  if (state.kind === 'signed-out')
    return (
      <SectionCard title="Sign in to your pharmacy">
        <p className="text-sm leading-6 text-text-muted">
          Open the link your pharmacy sent you on WhatsApp or SMS, or scan the QR code at the
          counter, then sign in with the code we send to your phone.
        </p>
      </SectionCard>
    );
  if (state.kind === 'error')
    return (
      <SectionCard title="Something went wrong">
        <p role="alert" className="mb-4 text-sm text-text-muted">
          Your account could not be loaded. Your records are safe.
        </p>
        <Button size="touch" onClick={() => void load()}>
          Try again
        </Button>
      </SectionCard>
    );

  const { home } = state;
  const submitPhoto = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!photo) return;
    void run(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(photo.type))
        throw new Error('Choose a PNG, JPEG or WebP photo.');
      if (photo.size > 5 * 1024 * 1024) throw new Error('The photo must be 5 MB or smaller.');
      await post('request', {
        kind: 'RX_ORDER',
        contentType: photo.type,
        dataBase64: await readFile(photo),
        ...(rxNote.trim() ? { note: rxNote.trim() } : {}),
      });
      setPhoto(null);
      setRxNote('');
    }, 'Prescription sent. A pharmacist will check it before your order is prepared.');
  };
  const submitPayment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accountId = paymentAccount || home.khataAccounts[0]?.id;
    const amountMinor = majorToMinor(paymentAmount);
    void run(async () => {
      if (!accountId) throw new Error('Choose a khata account.');
      if (!amountMinor) throw new Error('Enter the amount you paid.');
      if (!/^\d{4,6}$/.test(paymentRef))
        throw new Error('Enter the last 4–6 digits of the Raast transaction ID.');
      await post('request', {
        kind: 'KHATA_PAYMENT',
        familyAccountId: accountId,
        amountMinor,
        payerReference: paymentRef,
      });
      setPaymentAmount('');
      setPaymentRef('');
    }, 'Payment sent for confirmation. Your balance updates once the pharmacy confirms it.');
  };

  const inputClass =
    'min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.16em] text-text-muted uppercase">
            {home.branchName}
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-text-strong">
            Hello, {home.customer.displayName}
          </h1>
        </div>
        <Button
          variant="outline"
          size="touch"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await post('sign-out', {});
            }, 'Signed out.')
          }
        >
          Sign out
        </Button>
      </header>

      {notice ? (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={notice.tone === 'danger' ? 'text-sm text-destructive' : 'text-sm text-success'}
        >
          {notice.text}
        </p>
      ) : null}

      <SectionCard>
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat label="Loyalty points" value={home.loyaltyPoints.toLocaleString('en-PK')} />
          <Stat
            label="Khata balance"
            value={money(
              home.khataAccounts.reduce((sum, account) => sum + account.balanceMinor, 0),
              home.currency
            )}
          />
        </div>
      </SectionCard>

      <SectionCard eyebrow="Order" title="Order with a prescription photo">
        <form className="space-y-4" onSubmit={submitPhoto}>
          <p className="text-sm text-text-muted">
            A pharmacist checks every prescription before your order is prepared.
          </p>
          <div className="space-y-2">
            <label htmlFor="rx-photo" className="block text-sm font-semibold text-text-strong">
              Prescription photo
            </label>
            <input
              id="rx-photo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              capture="environment"
              disabled={pending}
              onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-text-body"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="rx-note" className="block text-sm font-semibold text-text-strong">
              Note for the pharmacist (optional)
            </label>
            <textarea
              id="rx-note"
              value={rxNote}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setRxNote(event.target.value)}
              className={`${inputClass} min-h-20 py-2`}
            />
          </div>
          <Button type="submit" size="touch" disabled={pending || !photo}>
            Send prescription
          </Button>
        </form>
      </SectionCard>

      <SectionCard eyebrow="Receipts" title="Your receipts">
        {home.receipts.length ? (
          <ul className="divide-y divide-border-subtle">
            {home.receipts.map((receipt) => (
              <li key={receipt.saleId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-text-strong">{receipt.receiptNumber}</p>
                  <p className="text-xs text-text-muted">{day(receipt.completedAt)}</p>
                </div>
                <span className="font-mono text-sm tabular-nums text-text-strong">
                  {money(receipt.totalMinor, home.currency)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () => post('request', { kind: 'REFILL', saleId: receipt.saleId }),
                      'Refill requested. The pharmacy will confirm before preparing it.'
                    )
                  }
                >
                  Request refill
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Your receipts appear here after a purchase.</p>
        )}
      </SectionCard>

      <SectionCard eyebrow="Khata" title="Pay your khata with Raast">
        {!home.khataAccounts.length ? (
          <p className="text-sm text-text-muted">You have no khata account with this pharmacy.</p>
        ) : (
          <div className="space-y-4">
            <ul className="divide-y divide-border-subtle">
              {home.khataAccounts.map((account) => (
                <li key={account.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm text-text-body">{account.displayName}</span>
                  <span className="font-mono text-sm tabular-nums text-text-strong">
                    {money(account.balanceMinor, home.currency)}
                  </span>
                </li>
              ))}
            </ul>
            {home.raast ? (
              <form className="space-y-4" onSubmit={submitPayment}>
                <div className="rounded-md border border-border-subtle bg-surface-sunken p-4">
                  <p className="text-sm text-text-muted">Send the payment by Raast to</p>
                  {home.raast.destination ? (
                    <p className="mt-1 font-mono text-sm break-all text-text-strong">
                      {home.raast.destination}
                    </p>
                  ) : null}
                  {home.raast.qrImageDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={home.raast.qrImageDataUrl}
                      alt="Raast payment QR code"
                      className="mt-3 size-40 rounded-sm bg-surface-raised"
                    />
                  ) : null}
                </div>
                {home.khataAccounts.length > 1 ? (
                  <div className="space-y-2">
                    <label
                      htmlFor="khata-account"
                      className="block text-sm font-semibold text-text-strong"
                    >
                      Account
                    </label>
                    <select
                      id="khata-account"
                      value={paymentAccount || home.khataAccounts[0]?.id}
                      onChange={(event) => setPaymentAccount(event.target.value)}
                      className={inputClass}
                    >
                      {home.khataAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      htmlFor="khata-amount"
                      className="block text-sm font-semibold text-text-strong"
                    >
                      Amount paid ({home.currency})
                    </label>
                    <input
                      id="khata-amount"
                      inputMode="decimal"
                      value={paymentAmount}
                      disabled={pending}
                      onChange={(event) => setPaymentAmount(event.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-2">
                    <label
                      htmlFor="khata-ref"
                      className="block text-sm font-semibold text-text-strong"
                    >
                      Last 4–6 digits of the transaction ID
                    </label>
                    <input
                      id="khata-ref"
                      inputMode="numeric"
                      value={paymentRef}
                      disabled={pending}
                      onChange={(event) =>
                        setPaymentRef(event.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      className={inputClass}
                    />
                  </div>
                </div>
                <Button type="submit" size="touch" disabled={pending}>
                  I have paid
                </Button>
              </form>
            ) : (
              <p className="text-sm text-text-muted">
                This pharmacy does not accept Raast payments in the app yet. Pay at the counter.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Requests" title="Your requests">
        {home.requests.length ? (
          <ul className="divide-y divide-border-subtle">
            {home.requests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-text-strong">
                    {KIND_LABELS[request.kind]}
                    {request.refillSale ? ` · ${request.refillSale.receiptNumber}` : ''}
                    {request.amountMinor != null
                      ? ` · ${money(request.amountMinor, home.currency)}`
                      : ''}
                  </p>
                  <p className="text-xs text-text-muted">{day(request.createdAt)}</p>
                  {request.decisionNote ? (
                    <p className="text-xs text-text-muted">{request.decisionNote}</p>
                  ) : null}
                </div>
                <StatusPill
                  status={request.status.toLowerCase()}
                  tone={request.status === 'VERIFIED' ? 'success' : undefined}
                  label={STATUS_LABELS[request.status]}
                />
                {request.status === 'PENDING' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => post('cancel', { requestId: request.id }),
                        'Request cancelled.'
                      )
                    }
                  >
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Requests you send appear here.</p>
        )}
      </SectionCard>

      {home.offers.length ? (
        <SectionCard eyebrow="Offers" title="Offers for you">
          <ul className="space-y-3">
            {home.offers.map((offer) => (
              <li key={offer.id} className="rounded-md border border-border-subtle p-4">
                <p className="text-sm font-semibold text-text-strong">{offer.title}</p>
                <p className="mt-1 text-sm text-text-body">{offer.body}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
