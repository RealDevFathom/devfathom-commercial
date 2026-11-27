'use client';

import { useState } from 'react';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import {
  SUPPLIER_ACCESS_HEADER,
  SUPPLIER_DOCUMENT_MAX_BYTES,
  SUPPLIER_DOCUMENT_MAX_MB,
  SUPPLIER_DOCUMENT_SIZE_MESSAGE,
  SUPPLIER_DOCUMENT_TOKEN_HEADER,
  SUPPLIER_DOCUMENT_TYPES,
  SUPPLIER_DOCUMENT_UPLOAD_URL,
} from '@/lib/pharmacy/supplier-document-contract';

export function SupplierPoActionForm({ token }: { token: string }) {
  const order = trpc.pharmacySupplierLinks.get.useQuery({ token }, { retry: false });
  const submit = trpc.pharmacySupplierLinks.submit.useMutation();
  const [uploading, setUploading] = useState(false);
  const [linkEnded, setLinkEnded] = useState(false);
  const [confirmRejection, setConfirmRejection] = useState(false);
  const [eta, setEta] = useState('');
  const [proposal, setProposal] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [message, setMessage] = useState('');

  if (order.isLoading)
    return (
      <SectionCard>
        <PageHeader heading="Loading purchase order…" description="Checking your link." />
      </SectionCard>
    );
  if (order.error || !order.data || linkEnded)
    return (
      <SectionCard>
        <PageHeader
          heading="This link is not valid"
          description="Ask the pharmacy for a new link."
        />
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
        onSuccess: () => setMessage('Response sent. The pharmacy will review it.'),
        onError: (error) => {
          if (error.data?.code === 'NOT_FOUND') setLinkEnded(true);
          else
            setMessage(
              error.data?.code === 'TOO_MANY_REQUESTS'
                ? 'Too many tries. Please try again later.'
                : 'Your response could not be saved. Check the details and try again.'
            );
        },
      }
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="Supplier response"
        heading={`Purchase order ${order.data.reference}`}
        description="Confirm the order or suggest a change. The pharmacy reviews your response before changing the order."
      />
      <p className="text-sm text-text-body">
        Buying branch: {order.data.buyerBranch.name}
        {order.data.buyerBranch.phone && ` · ${order.data.buyerBranch.phone}`}
      </p>
      <SectionCard title="Order lines">
        {order.data.lines.length === 0 && (
          <p className="text-sm text-text-muted">
            There are no items on this order. Contact the pharmacy for details.
          </p>
        )}
        <div className="space-y-3">
          {order.data.lines.map((line) => (
            <label
              key={line.id}
              className="grid gap-2 border-b border-border-subtle pb-3 sm:grid-cols-[1fr_9rem] sm:items-center"
            >
              <span className="text-sm">
                {line.medicine.productName} · {line.orderedPacks} packs ordered
                <br />
                Packs you can supply
              </span>
              <Input
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
                className="h-11 rounded-control"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            className="min-h-11"
            disabled={submit.isPending}
            onClick={() => send('ACKNOWLEDGEMENT', {})}
          >
            Confirm order
          </Button>
          <Button
            className="min-h-11"
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
            className="min-h-11"
            variant="destructive"
            disabled={submit.isPending}
            onClick={() => setConfirmRejection(true)}
          >
            Decline order
          </Button>
        </div>
        {confirmRejection && (
          <div
            className="mt-4 space-y-3"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setConfirmRejection(false);
            }}
          >
            <p>Tell the pharmacy you cannot supply this order?</p>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-11"
                variant="outline"
                onClick={() => setConfirmRejection(false)}
              >
                Cancel
              </Button>
              <Button
                className="min-h-11"
                variant="destructive"
                disabled={submit.isPending}
                onClick={() => {
                  setConfirmRejection(false);
                  send('REJECTION', {});
                }}
              >
                Confirm decline
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Delivery and suggested changes">
        <div className="grid gap-5">
          <label className="grid gap-2 text-sm font-medium">
            Estimated arrival
            <Input
              type="datetime-local"
              value={eta}
              onChange={(event) => setEta(event.target.value)}
              className="h-11 rounded-control"
            />
          </label>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={!eta || submit.isPending}
            onClick={() => send('ETA', { eta: new Date(eta).toISOString() })}
          >
            Send delivery date
          </Button>
          <label className="grid gap-2 text-sm font-medium">
            Proposed substitution
            <Textarea
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
              rows={3}
              className="rounded-control"
              placeholder="Clearly identify the proposed product and pack."
            />
          </label>
          <Button
            className="min-h-11"
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
      <SectionCard
        title="Supporting document"
        eyebrow={`PDF, PNG or JPEG · ${SUPPLIER_DOCUMENT_MAX_MB} MB maximum`}
      >
        <Input
          aria-label="Supporting document"
          type="file"
          accept={SUPPLIER_DOCUMENT_TYPES.join(',')}
          disabled={uploading}
          aria-busy={uploading}
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            input.value = '';
            if (file.size > SUPPLIER_DOCUMENT_MAX_BYTES) {
              setMessage(SUPPLIER_DOCUMENT_SIZE_MESSAGE);
              return;
            }
            setUploading(true);
            setMessage('Uploading document…');
            try {
              const form = new FormData();
              form.set('file', file);
              form.set('idempotencyKey', browserUuid());
              const response = await fetch(SUPPLIER_DOCUMENT_UPLOAD_URL, {
                method: 'POST',
                headers: {
                  [SUPPLIER_DOCUMENT_TOKEN_HEADER]: token,
                  [SUPPLIER_ACCESS_HEADER]: 'order-link',
                },
                body: form,
              });
              if (response.ok) setMessage('Document sent to the pharmacy.');
              else if (response.status === 404) setLinkEnded(true);
              else if (response.headers.get('content-type')?.startsWith('text/plain'))
                setMessage(await response.text());
              else setMessage('The document could not be saved. Try again shortly.');
            } catch {
              setMessage('The document could not be saved. Try again shortly.');
            } finally {
              setUploading(false);
            }
          }}
          className="h-auto min-h-11 rounded-control py-2 text-sm"
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
