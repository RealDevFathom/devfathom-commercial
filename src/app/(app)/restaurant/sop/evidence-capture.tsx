'use client';

import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';

type StaffOption = { id: string; displayName: string };

type EvidenceCaptureProps = {
  branchId: string;
  businessDate: string;
  occurrenceId: string;
  occurrenceStepId: string;
  purpose: 'photo' | 'signature';
  staff: StaffOption[];
};

type UploadState =
  { kind: 'idle' } | { kind: 'uploading'; progress: number } | { kind: 'error'; message: string };

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIZE_LABEL = `${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`;

export function EvidenceCapture({
  branchId,
  businessDate,
  occurrenceId,
  occurrenceStepId,
  purpose,
}: EvidenceCaptureProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const label = purpose === 'photo' ? 'Photo proof' : 'Signature proof';
  const uploading = state.kind === 'uploading';

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;

    const file = new FormData(form).get('file');
    if (
      !(file instanceof File) ||
      !ACCEPTED_TYPES.has(file.type) ||
      file.size > MAX_ATTACHMENT_BYTES
    ) {
      setState({
        kind: 'error',
        message: `Choose a JPEG, PNG, or WebP image no larger than ${MAX_SIZE_LABEL}.`,
      });
      return;
    }

    setState({ kind: 'uploading', progress: 0 });
    const request = new XMLHttpRequest();
    request.open('POST', form.action);
    request.upload.addEventListener('progress', (progress) => {
      if (progress.lengthComputable) {
        setState({
          kind: 'uploading',
          progress: Math.round((progress.loaded / progress.total) * 100),
        });
      }
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 400) {
        window.location.assign(request.responseURL || window.location.href);
        return;
      }
      setState({ kind: 'error', message: 'Proof could not be uploaded. Try again.' });
    });
    request.addEventListener('error', () => {
      setState({
        kind: 'error',
        message: 'Proof could not be uploaded. Check your connection and try again.',
      });
    });
    request.send(new FormData(form));
  }

  return (
    <form
      action="/api/restaurant/sop/evidence"
      className="mt-3 grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4 sm:grid-cols-2"
      encType="multipart/form-data"
      method="post"
      onSubmit={submit}
      ref={formRef}
    >
      <input name="branchId" type="hidden" value={branchId} />
      <input name="businessDate" type="hidden" value={businessDate} />
      <input name="occurrenceId" type="hidden" value={occurrenceId} />
      <input name="occurrenceStepId" type="hidden" value={occurrenceStepId} />
      <input name="evidencePurpose" type="hidden" value={purpose} />
      <div className="sm:col-span-2">
        <p className="font-medium text-text-strong">{label} required</p>
        <p className="mt-1 text-xs text-text-muted">
          JPEG, PNG, or WebP · {MAX_SIZE_LABEL} maximum. Evidence is retained as an append-only
          record.
        </p>
      </div>
      <p className="text-sm text-text-muted">Uploaded as your signed-in staff profile.</p>
      <label className="text-sm text-text-body" htmlFor={`${id}-file`}>
        {purpose === 'photo' ? 'Take or choose photo' : 'Choose signature image'}
        <Input
          accept="image/jpeg,image/png,image/webp"
          capture={purpose === 'photo' ? 'environment' : undefined}
          className="mt-1 min-h-11 cursor-pointer bg-surface-raised py-2 file:mr-3"
          disabled={uploading}
          id={`${id}-file`}
          name="file"
          required
          type="file"
        />
      </label>
      <Button className="min-h-11 sm:col-span-2" disabled={uploading} type="submit">
        {uploading ? `Uploading ${state.progress}%` : `Upload ${label.toLowerCase()}`}
      </Button>
      {uploading ? (
        <progress
          aria-label={`${label} upload progress`}
          className="h-2 w-full accent-primary sm:col-span-2"
          max="100"
          value={state.progress}
        />
      ) : null}
      {state.kind === 'error' ? (
        <p className="text-sm text-destructive sm:col-span-2" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
