'use client';

import { useState } from 'react';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';

export function SupplierPoActionForm({ token }: { token: string }) {
  const order = trpc.pharmacySupplierLinks.get.useQuery({ token }, { retry: false });
  const submit = trpc.pharmacySupplierLinks.submit.useMutation();
  const upload = trpc.pharmacySupplierLinks.uploadDocument.useMutation();
  const [eta, setEta] = useState('');
  const [proposal, setProposal] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [message, setMessage] = useState('');

  if (order.isLoading)
    return (
      <SectionCard title="Loading purchase order…">
        <p className="text-sm text-text-muted">Checking this secure link.</p>
      </SectionCard>
    );
  if (order.error || !order.data)
    return (
      <SectionCard title="Link unavailable">
        <p role="alert" className="text-sm text-destructive">
          This link is invalid, expired, or revoked. Contact the pharmacy if you still need to
          respond.
        </p>
      </SectionCard>
    );

  const send = (
    kind: 'ACKNOWLEDGEMENT' | 'REJECTION' | 'PARTIAL_ACCEPTANCE' | 'ETA' | 'SUBSTITUTION_PROPOSAL',
    payload: Record<string, unknown>
  ) => {
    setMessage('');
    submit.mutate(
      { token, kind, payload, idempotencyKey: browserUuid() },
      {
        onSuccess: () =>
          setMessage('Response recorded as supplier evidence. The pharmacy will review it.'),
        onError: (error) => setMessage(error.message),
      }
    );
  };

  return (
    <>
      <header className="space-y-2">
        <p className="font-mono text-xs tracking-wider text-text-muted uppercase">
          Supplier response
        </p>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-text-strong">
          Purchase order {order.data.reference}
        </h1>
        <p className="text-sm text-text-muted">
          Your response is a proposal or evidence record. It does not change stock, pricing,
          receipts, or pharmacy approvals.
        </p>
      </header>
      <SectionCard title="Order lines" eyebrow="One purchase order only">
        <div className="space-y-3">
          {order.data.lines.map((line) => (
            <label
              key={line.id}
              className="grid gap-2 border-b border-border-subtle pb-3 sm:grid-cols-[1fr_9rem] sm:items-center"
            >
              <span className="text-sm">
                Line {line.lineNumber} · {line.orderedPacks} packs
              </span>
              <input
                aria-label={`Accepted packs for line ${line.lineNumber}`}
                type="number"
                min={0}
                max={line.orderedPacks}
                value={quantities[line.id] ?? line.orderedPacks}
                onChange={(event) =>
                  setQuantities((current) => ({
                    ...current,
                    [line.id]: Number(event.target.value),
                  }))
                }
                className="h-11 rounded-sm border border-border bg-background px-3"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button disabled={submit.isPending} onClick={() => send('ACKNOWLEDGEMENT', {})}>
            Acknowledge
          </Button>
          <Button
            variant="outline"
            disabled={submit.isPending}
            onClick={() =>
              send('PARTIAL_ACCEPTANCE', {
                quantities: Object.fromEntries(
                  order.data.lines.map((line) => [
                    line.id,
                    quantities[line.id] ?? line.orderedPacks,
                  ])
                ),
              })
            }
          >
            Accept quantities shown
          </Button>
          <Button
            variant="destructive"
            disabled={submit.isPending}
            onClick={() => send('REJECTION', {})}
          >
            Reject order
          </Button>
        </div>
      </SectionCard>
      <SectionCard title="Delivery and substitution proposals">
        <div className="grid gap-5">
          <label className="grid gap-2 text-sm font-medium">
            Estimated arrival
            <input
              type="datetime-local"
              value={eta}
              onChange={(event) => setEta(event.target.value)}
              className="h-11 rounded-sm border border-border bg-background px-3"
            />
          </label>
          <Button
            variant="outline"
            disabled={!eta || submit.isPending}
            onClick={() => send('ETA', { eta: new Date(eta).toISOString() })}
          >
            Send ETA
          </Button>
          <label className="grid gap-2 text-sm font-medium">
            Proposed substitution
            <textarea
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
              rows={3}
              className="rounded-sm border border-border bg-background p-3"
              placeholder="Clearly identify the proposed product and pack."
            />
          </label>
          <Button
            variant="outline"
            disabled={!proposal.trim() || submit.isPending}
            onClick={() =>
              send('SUBSTITUTION_PROPOSAL', { proposal: true, description: proposal.trim() })
            }
          >
            Send substitution proposal
          </Button>
        </div>
      </SectionCard>
      <SectionCard title="Supporting document" eyebrow="PDF, PNG or JPEG · 10 MB maximum">
        <input
          aria-label="Supporting document"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          disabled={upload.isPending}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            upload.mutate(
              {
                token,
                idempotencyKey: browserUuid(),
                fileName: file.name,
                declaredMimeType: file.type as 'application/pdf' | 'image/png' | 'image/jpeg',
                contentBase64: btoa(binary),
              },
              {
                onSuccess: () => setMessage('Document recorded as evidence.'),
                onError: (error) => setMessage(error.message),
              }
            );
          }}
          className="block w-full text-sm"
        />
      </SectionCard>
      {message ? (
        <p role="status" className="rounded-md border border-border bg-card p-4 text-sm">
          {message}
        </p>
      ) : null}
    </>
  );
}
