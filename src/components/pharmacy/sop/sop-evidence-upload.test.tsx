import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVIDENCE_ENDPOINT, SopEvidenceUpload } from './sop-evidence-upload';
import { PHARMACY_SOP_CHANGED_MESSAGE } from '@/lib/pharmacy/sop-shared';

type Listener = (event?: unknown) => void;

/** A controllable stand-in for the browser upload request. */
class FakeRequest {
  static sent: FakeRequest[] = [];
  method = '';
  url = '';
  status = 0;
  responseText = '';
  body: FormData | null = null;
  headers: Record<string, string> = {};
  private listeners: Record<string, Listener[]> = {};
  upload = { addEventListener: vi.fn() };
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(body: FormData) {
    this.body = body;
    FakeRequest.sent.push(this);
  }
  fire(type: 'load' | 'error' | 'abort', status = 0, body = '') {
    this.status = status;
    this.responseText = body;
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

const CHANGED = PHARMACY_SOP_CHANGED_MESSAGE;
const photo = () => new File(['fridge display'], 'fridge.jpg', { type: 'image/jpeg' });

function renderUpload(props: Partial<React.ComponentProps<typeof SopEvidenceUpload>> = {}) {
  const onUploaded = vi.fn();
  const recount = vi.fn(async () => 0);
  render(
    <SopEvidenceUpload
      pharmacyBranchId="branch-1"
      occurrenceId="occ-1"
      occurrenceStepId="step-1"
      stepTitle="Record fridge temperature"
      purpose="photo"
      evidenceCount={0}
      recount={recount}
      onUploaded={onUploaded}
      {...props}
    />
  );
  return { onUploaded, recount };
}

function choose(file: File, label = 'Photo for Record fridge temperature') {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
}

beforeEach(() => {
  FakeRequest.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('procedure proof upload', () => {
  it('sends the branch, occurrence, step, purpose and file, and never a staff id', () => {
    renderUpload();
    choose(photo());
    expect(FakeRequest.sent).toHaveLength(1);
    const [request] = FakeRequest.sent;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(EVIDENCE_ENDPOINT);
    const body = request.body!;
    expect(body.get('pharmacyBranchId')).toBe('branch-1');
    expect(body.get('occurrenceId')).toBe('occ-1');
    expect(body.get('occurrenceStepId')).toBe('step-1');
    expect(body.get('evidencePurpose')).toBe('photo');
    expect(body.get('file')).toBeInstanceOf(File);
    expect([...body.keys()].some((key) => /staff|uploader|user/i.test(key))).toBe(false);
  });

  it('retries an interrupted upload with the same file and succeeds exactly once', async () => {
    const { onUploaded, recount } = renderUpload();
    const file = photo();
    choose(file);
    act(() => FakeRequest.sent[0].fire('error'));
    expect(screen.getByRole('alert')).toHaveTextContent('The upload was interrupted');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    });
    // The step was re-read first; the photo had not arrived, so it was sent again.
    expect(recount).toHaveBeenCalledTimes(1);
    expect(FakeRequest.sent).toHaveLength(2);
    expect(FakeRequest.sent[1].body!.get('file')).toBe(file);

    act(() => FakeRequest.sent[1].fire('load', 201, '{"created":true}'));
    expect(screen.getByText('Photo saved.')).toBeVisible();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
    expect(FakeRequest.sent).toHaveLength(2);
  });

  it('does not send again when the interrupted upload had in fact arrived', async () => {
    const { onUploaded } = renderUpload({ recount: vi.fn(async () => 1) });
    choose(photo());
    act(() => FakeRequest.sent[0].fire('abort'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    });
    expect(FakeRequest.sent).toHaveLength(1);
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Photo saved.')).toBeVisible();
  });

  it('shows the server reason and offers no retry for a refused image', () => {
    renderUpload();
    choose(photo());
    act(() =>
      FakeRequest.sent[0].fire(
        'load',
        409,
        '{"error":"This exact image is already on the step but was not captured in the pharmacy workspace."}'
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This exact image is already on the step');
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
  });

  it('hands a procedure that moved on to onConflict with the server words, and shows nothing inline', () => {
    const onConflict = vi.fn();
    const { onUploaded } = renderUpload({ onConflict });
    choose(photo());
    act(() =>
      FakeRequest.sent[0].fire('load', 409, JSON.stringify({ error: CHANGED, conflict: true }))
    );
    expect(onConflict).toHaveBeenCalledExactlyOnceWith(CHANGED);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
    // The file input is ready for a new choice once the procedure is re-read.
    expect(screen.getByLabelText('Photo for Record fridge temperature')).toBeEnabled();
  });

  it('uses the fixed plain words when a moved-on refusal carries none', () => {
    const onConflict = vi.fn();
    renderUpload({ onConflict });
    choose(photo());
    act(() => FakeRequest.sent[0].fire('load', 409, '{"conflict":true}'));
    expect(onConflict).toHaveBeenCalledExactlyOnceWith(CHANGED);
  });

  it('keeps a failed save inline with a retry, never treating it as a moved-on procedure', () => {
    const onConflict = vi.fn();
    renderUpload({ onConflict });
    choose(photo());
    act(() =>
      FakeRequest.sent[0].fire('load', 503, '{"error":"Proof was not saved. Retry in a moment."}')
    );
    expect(onConflict).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Proof was not saved. Retry in a moment.');
    expect(screen.getByRole('button', { name: 'Retry upload' })).toBeVisible();
  });

  it('without onConflict, shows a moved-on refusal inline', () => {
    renderUpload();
    choose(photo());
    act(() =>
      FakeRequest.sent[0].fire('load', 409, JSON.stringify({ error: CHANGED, conflict: true }))
    );
    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED);
  });

  it('rejects a file that is not an image before uploading', () => {
    renderUpload();
    choose(new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    expect(FakeRequest.sent).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a JPEG, PNG or WebP image');
  });

  it('uploads signature proof with the signature purpose', () => {
    renderUpload({ purpose: 'signature' });
    choose(photo(), 'Signature for Record fridge temperature');
    expect(FakeRequest.sent[0].body!.get('evidencePurpose')).toBe('signature');
  });
});
