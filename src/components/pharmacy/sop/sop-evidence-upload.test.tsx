import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVIDENCE_ENDPOINT, SopEvidenceUpload } from './sop-evidence-upload';

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
        '{"error":"Start the occurrence before adding proof to it."}'
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Start the occurrence before adding proof to it.'
    );
    expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
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
