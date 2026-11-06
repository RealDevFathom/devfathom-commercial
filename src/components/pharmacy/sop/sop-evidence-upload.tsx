'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { PHARMACY_SOP_CHANGED_MESSAGE } from '@/lib/pharmacy/sop-shared';

import type { EvidencePurpose } from './sop-model';

export const EVIDENCE_ENDPOINT = '/api/pharmacy/sop/evidence';
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LABEL = `${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`;

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  /** `interrupted`: the connection dropped, so the server may already hold the photo. */
  | { kind: 'failed'; message: string; interrupted: boolean; retryable: boolean }
  | { kind: 'checking' }
  | { kind: 'done' };

export type SopEvidenceUploadProps = {
  pharmacyBranchId: string;
  occurrenceId: string;
  occurrenceStepId: string;
  stepTitle: string;
  purpose: EvidencePurpose;
  /** Proof of this purpose already on the step, as the last read of the procedure showed. */
  evidenceCount: number;
  /** Re-read the procedure and return how much proof of this purpose the step now holds. */
  recount: () => Promise<number>;
  /** Called once the proof is known to be stored. */
  onUploaded: () => void;
  /**
   * Whether the step needs this proof. False when adding new proof to a done
   * step after a send-back, so the label never says "required".
   */
  required?: boolean;
  /**
   * The procedure moved on since this screen read it (the server answers 409
   * with `conflict: true`): the runner shows the words and re-reads it. A
   * retry could never succeed, so none is offered here. Without it the words
   * are shown inline.
   */
  onConflict?: (message: string) => void;
};

function responseBody(request: XMLHttpRequest): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(request.responseText);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null; // Not JSON — the caller falls back to the generic message.
  }
}

function serverMessage(request: XMLHttpRequest) {
  const body = responseBody(request);
  if (!body) return null;
  const text = typeof body.error === 'string' ? body.error : body.message;
  if (typeof text === 'string' && text.length > 0 && text.length <= 300) return text;
  return null;
}

/**
 * Photo or signature proof for one step. The chosen file is kept until the
 * server confirms it, so a failed or interrupted upload is retried with the
 * same bytes without choosing the file again. Two guards keep a retry from
 * adding a second copy: before re-sending after a dropped connection the step
 * is re-read, and if the proof arrived after all nothing is sent; and the
 * server resolves identical bytes on the same step to the one evidence row.
 *
 * No staff or uploader id is ever sent — the server derives the person.
 */
export function SopEvidenceUpload({
  pharmacyBranchId,
  occurrenceId,
  occurrenceStepId,
  stepTitle,
  purpose,
  evidenceCount,
  recount,
  onUploaded,
  required = true,
  onConflict,
}: SopEvidenceUploadProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<{ file: File; baseline: number } | null>(null);
  const inFlight = useRef<XMLHttpRequest | null>(null);
  const mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(next: Phase) {
    if (mounted.current) setPhase(next);
  }

  function finish() {
    pending.current = null;
    if (inputRef.current) inputRef.current.value = '';
    update({ kind: 'done' });
    onUploaded();
  }

  function send() {
    const attempt = pending.current;
    if (!attempt || inFlight.current) return;
    const body = new FormData();
    body.set('pharmacyBranchId', pharmacyBranchId);
    body.set('occurrenceId', occurrenceId);
    body.set('occurrenceStepId', occurrenceStepId);
    body.set('evidencePurpose', purpose);
    body.set('file', attempt.file);

    const request = new XMLHttpRequest();
    inFlight.current = request;
    update({ kind: 'uploading', progress: 0 });
    request.open('POST', EVIDENCE_ENDPOINT);
    request.upload?.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        update({ kind: 'uploading', progress: Math.round((event.loaded / event.total) * 100) });
      }
    });
    const interrupted = () => {
      inFlight.current = null;
      update({
        kind: 'failed',
        interrupted: true,
        retryable: true,
        message: 'The upload was interrupted. Check your connection, then retry.',
      });
    };
    request.addEventListener('load', () => {
      inFlight.current = null;
      if (request.status >= 200 && request.status < 300) {
        finish();
        return;
      }
      if (request.status === 409 && responseBody(request)?.conflict === true && onConflict) {
        // The chosen file is dropped: it can only go on the procedure as it is now.
        pending.current = null;
        if (inputRef.current) inputRef.current.value = '';
        update({ kind: 'idle' });
        onConflict(serverMessage(request) ?? PHARMACY_SOP_CHANGED_MESSAGE);
        return;
      }
      const retryable = request.status >= 500 || request.status === 0 || request.status === 429;
      update({
        kind: 'failed',
        interrupted: request.status === 0,
        retryable,
        message:
          serverMessage(request) ??
          (retryable
            ? 'The upload could not be saved just now. Retry in a moment.'
            : 'This image could not be accepted. Choose a different one.'),
      });
    });
    request.addEventListener('error', interrupted);
    request.addEventListener('abort', interrupted);
    request.addEventListener('timeout', interrupted);
    request.send(body);
  }

  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || inFlight.current) return;
    if (!ACCEPTED.includes(file.type) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      pending.current = null;
      update({
        kind: 'failed',
        interrupted: false,
        retryable: false,
        message: `Choose a JPEG, PNG or WebP image no larger than ${MAX_LABEL}.`,
      });
      return;
    }
    pending.current = { file, baseline: evidenceCount };
    send();
  }

  async function retry() {
    const attempt = pending.current;
    if (!attempt || inFlight.current || phase.kind === 'checking') return;
    if (phase.kind === 'failed' && phase.interrupted) {
      update({ kind: 'checking' });
      try {
        const now = await recount();
        if (now > attempt.baseline) {
          finish();
          return;
        }
      } catch {
        // Could not re-read; the server still resolves identical bytes to one row.
      }
    }
    send();
  }

  const busy = phase.kind === 'uploading' || phase.kind === 'checking';
  const noun = purpose === 'photo' ? 'photo' : 'signature';

  return (
    <div className="grid gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4">
      <div>
        <p className="text-sm font-medium text-text-strong">
          {purpose === 'photo' ? 'Photo' : 'Signature'}
          {evidenceCount > 0 ? ' · added' : required ? ' · required' : ' · optional'}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {purpose === 'photo'
            ? 'Take a photo of what you checked.'
            : 'Sign on paper and take a photo of your signature.'}{' '}
          JPEG, PNG or WebP, up to {MAX_LABEL}. It is kept with this procedure and cannot be edited
          later.
        </p>
      </div>
      <label className="grid gap-1.5 text-sm font-medium text-text-strong" htmlFor={`${id}-file`}>
        <span>{evidenceCount > 0 ? `Add another ${noun}` : `Take or choose a ${noun} image`}</span>
        <input
          ref={inputRef}
          id={`${id}-file`}
          aria-label={`${purpose === 'photo' ? 'Photo' : 'Signature'} for ${stepTitle}`}
          type="file"
          accept={ACCEPTED.join(',')}
          capture={purpose === 'photo' ? 'environment' : undefined}
          disabled={busy}
          onChange={choose}
          className="min-h-11 w-full cursor-pointer rounded-sm border border-border-default bg-surface-raised px-3 py-2 text-sm text-text-strong outline-none file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>
      {phase.kind === 'uploading' ? (
        <Progress value={phase.progress} aria-label={`Uploading ${noun} for ${stepTitle}`}>
          <span className="font-mono text-xs text-text-muted tabular-nums">
            Uploading {phase.progress}%
          </span>
        </Progress>
      ) : null}
      <div aria-live="polite" aria-atomic="true" className="text-sm">
        {phase.kind === 'checking' ? (
          <p className="text-text-muted">Checking whether the {noun} arrived…</p>
        ) : null}
        {phase.kind === 'done' ? (
          <p className="text-success">{purpose === 'photo' ? 'Photo' : 'Signature'} saved.</p>
        ) : null}
      </div>
      {phase.kind === 'failed' ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="min-w-0 text-sm text-destructive">{phase.message}</p>
          {phase.retryable ? (
            <Button type="button" variant="outline" size="touch" onClick={() => void retry()}>
              Retry upload
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
