import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceCapture } from './evidence-capture';

class UploadRequest {
  static latest: UploadRequest | null = null;
  readonly upload = new EventTarget();
  readonly events = new EventTarget();
  status = 0;
  responseURL = '';
  method = '';
  url = '';

  constructor() {
    UploadRequest.latest = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.events.addEventListener(type, listener);
  }

  send() {}

  progress(loaded: number, total: number) {
    this.upload.dispatchEvent(
      new ProgressEvent('progress', { lengthComputable: true, loaded, total })
    );
  }

  fail() {
    this.events.dispatchEvent(new Event('error'));
  }
}

const props = {
  branchId: 'branch-internal',
  businessDate: '2026-08-29',
  occurrenceId: 'occurrence-internal',
  occurrenceStepId: 'step-internal',
  purpose: 'photo' as const,
  staff: [{ id: 'staff-internal', displayName: 'Mina Khan' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  UploadRequest.latest = null;
});

describe('EvidenceCapture', () => {
  it('uses session attribution and preserves mobile camera/file capture', () => {
    const { container } = render(<EvidenceCapture {...props} />);

    expect(screen.getByText('Uploaded as your signed-in staff profile.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uploading staff')).not.toBeInTheDocument();
    const file = screen.getByLabelText('Take or choose photo');
    expect(file).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(file).toHaveAttribute('capture', 'environment');
    expect(container).not.toHaveTextContent('staff-internal');
    expect(screen.getByText(/Photo proof required/)).toBeInTheDocument();
  });

  it('shows determinate upload progress and a generic network failure', () => {
    vi.stubGlobal('XMLHttpRequest', UploadRequest);
    vi.spyOn(HTMLFormElement.prototype, 'reportValidity').mockReturnValue(true);
    render(<EvidenceCapture {...props} />);

    const proof = new File(['proof'], 'proof.jpg', { type: 'image/jpeg' });
    const fileInput = screen.getByLabelText('Take or choose photo');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [proof],
    });
    const NativeFormData = FormData;
    vi.stubGlobal(
      'FormData',
      class extends NativeFormData {
        constructor(form?: HTMLFormElement) {
          super(form);
          this.set('file', proof);
        }
      }
    );
    fireEvent.submit(screen.getByRole('button', { name: 'Upload photo proof' }).closest('form')!);

    expect(UploadRequest.latest?.method).toBe('POST');
    expect(UploadRequest.latest?.url).toBe('http://localhost:3000/api/restaurant/sop/evidence');
    act(() => UploadRequest.latest?.progress(1, 2));
    expect(screen.getByRole('button', { name: 'Uploading 50%' })).toBeDisabled();
    expect(screen.getByRole('progressbar', { name: 'Photo proof upload progress' })).toHaveValue(
      50
    );

    act(() => UploadRequest.latest?.fail());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Proof could not be uploaded. Check your connection and try again.'
    );
  });

  it('keeps signature capture available without a caller-selected staff directory', () => {
    render(<EvidenceCapture {...props} purpose="signature" staff={[]} />);

    expect(screen.getByLabelText('Choose signature image')).not.toHaveAttribute('capture');
    expect(screen.getByRole('button', { name: 'Upload signature proof' })).toBeEnabled();
  });
});
