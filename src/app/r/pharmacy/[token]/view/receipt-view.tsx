'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import type { HostedReceipt } from '@/lib/pharmacy/whatsapp/hosted-receipt';

type Receipt = Pick<
  HostedReceipt,
  | 'branch'
  | 'receiptNumber'
  | 'total'
  | 'paymentMethod'
  | 'issuedAt'
  | 'expiresAt'
  | 'fbrInvoiceNumber'
  | 'fbrQrUrl'
>;
type State =
  | { kind: 'loading' }
  | { kind: 'verify' }
  | { kind: 'receipt'; receipt: Receipt }
  | { kind: 'unavailable'; error: string };

async function readReceipt(endpoint: string, signal?: AbortSignal): Promise<State> {
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  const body = await response.json();
  if (response.status === 401 && body.otpRequired) return { kind: 'verify' };
  if (!response.ok) throw new Error(body.error || 'Receipt service unavailable.');
  return { kind: 'receipt', receipt: body as Receipt };
}

export function HostedReceiptView({ token }: { token: string }) {
  const endpoint = `/r/pharmacy/${encodeURIComponent(token)}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    readReceipt(endpoint, controller.signal)
      .then(setState)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: 'unavailable',
            error: cause instanceof Error ? cause.message : 'Receipt service unavailable.',
          });
      });
    return () => controller.abort();
  }, [endpoint]);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Verification could not be completed.');
      setState(await readReceipt(endpoint));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification could not be completed.');
    } finally {
      setPending(false);
    }
  }

  const receipt = state.kind === 'receipt' ? state.receipt : null;
  const qrUrl = receipt?.fbrQrUrl?.startsWith('https://') ? receipt.fbrQrUrl : null;

  return (
    <main className="min-h-dvh bg-surface-page px-4 py-10 text-text-body sm:px-8">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Your receipt"
          description="Secure access to your pharmacy receipt."
        />
        {state.kind === 'loading' ? (
          <SectionCard role="status" aria-live="polite">
            Loading your receipt…
          </SectionCard>
        ) : state.kind === 'unavailable' ? (
          <SectionCard title="Receipt unavailable" role="alert">
            <p>{state.error}</p>
            <p className="mt-3 text-sm text-text-muted">
              Ask the pharmacy for a current receipt link.
            </p>
          </SectionCard>
        ) : state.kind === 'verify' ? (
          <SectionCard title="Verify your receipt">
            <p className="mb-5 text-sm text-text-muted">
              Enter the six-digit code sent to your WhatsApp number. If it has expired, ask the
              pharmacy for a new receipt link and code.
            </p>
            <form onSubmit={verify} className="space-y-4">
              <label htmlFor="receipt-code" className="block text-sm font-semibold">
                Six-digit code
              </label>
              <Input
                id="receipt-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'receipt-error' : undefined}
                className="min-h-11 font-mono"
              />
              {error ? (
                <p id="receipt-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                size="lg"
                className="min-h-11 w-full"
                disabled={pending || code.length !== 6}
              >
                {pending ? 'Verifying…' : 'View receipt'}
              </Button>
            </form>
          </SectionCard>
        ) : receipt ? (
          <SectionCard title={receipt.branch}>
            <dl className="space-y-4">
              {[
                ['Receipt number', receipt.receiptNumber],
                ['Total', receipt.total],
                ['Payment method', receipt.paymentMethod],
                ['Issued', new Date(receipt.issuedAt).toLocaleString()],
                ['Link expires', new Date(receipt.expiresAt).toLocaleString()],
                ...(receipt.fbrInvoiceNumber ? [['FBR invoice', receipt.fbrInvoiceNumber]] : []),
              ].map(([label, value]) => (
                <div key={label} className="space-y-1 break-words">
                  <dt className="font-mono text-xs text-text-muted uppercase">{label}</dt>
                  <dd className="font-medium text-text-strong tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {qrUrl ? (
              <a
                href={qrUrl}
                rel="noreferrer"
                className="mt-5 inline-block text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                View FBR verification
              </a>
            ) : null}
          </SectionCard>
        ) : null}
      </div>
    </main>
  );
}
