import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CameraEvidenceViewer, type CameraEvidenceItem } from './camera-evidence-viewer';

afterEach(cleanup);

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=';
const captured: CameraEvidenceItem = {
  id: 'synthetic-captured',
  subjectKind: 'SALE',
  status: 'CAPTURED',
  requestedAt: '2026-10-12T09:00:00.000Z',
  capturedAt: '2026-10-12T09:01:00.000Z',
  image: null,
};
const props = {
  cameraName: 'Synthetic camera',
  subjectLabels: { SALE: 'Sale evidence' },
  onClose: () => {},
};

describe('CameraEvidenceViewer', () => {
  it('describes a CAPTURED still without image bytes as unavailable without asserting storage fate', () => {
    render(<CameraEvidenceViewer {...props} state="ready" items={[captured]} />);

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Captured still is unavailable to view.')).toBeInTheDocument();
    expect(item).not.toHaveTextContent(
      /no longer in storage|deleted|retained|expired|purged|removed/i
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  describe('controls', () => {
    it.each([
      ['PURGED', 'Still removed under the camera retention period.'],
      ['FAILED', 'No still was captured.'],
      ['PENDING', 'Still pending capture.'],
    ] as const)('preserves the %s message', (status, message) => {
      render(<CameraEvidenceViewer {...props} state="ready" items={[{ ...captured, status }]} />);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('renders private synthetic image bytes with the existing accessible alt text', () => {
      render(<CameraEvidenceViewer {...props} state="ready" items={[{ ...captured, image }]} />);
      expect(screen.getByRole('img')).toHaveAttribute('src', image);
      expect(screen.getByRole('img')).toHaveAccessibleName(
        'Camera still for sale evidence, 2026-10-12 09:01 UTC'
      );
      expect(screen.queryByText('Captured still is unavailable to view.')).not.toBeInTheDocument();
    });

    it.each([
      ['loading', 'Requesting private viewer access…'],
      ['error', 'Evidence could not be loaded. Check your access and try again.'],
      [
        'access-lost',
        'Viewer access expired or was revoked. Stills were cleared from this screen. Open evidence again to request access.',
      ],
    ] as const)('clears ready items and images when rerendered as %s', (state, message) => {
      const items: CameraEvidenceItem[] = [
        { ...captured, image },
        { ...captured, id: 'synthetic-pending', status: 'PENDING', capturedAt: null },
      ];
      const callbacks = { onRefresh: vi.fn(), onCapturePending: vi.fn() };
      const { container, rerender } = render(
        <CameraEvidenceViewer {...props} {...callbacks} state="ready" items={items} />
      );
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByRole('img')).toHaveAttribute('src', image);
      expect(screen.getByRole('button', { name: 'Capture pending stills' })).toBeInTheDocument();

      rerender(<CameraEvidenceViewer {...props} {...callbacks} state={state} items={items} />);

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.queryByText('Sale evidence')).not.toBeInTheDocument();
      expect(container.innerHTML).not.toContain(image);
      expect(
        screen.queryByRole('button', { name: 'Capture pending stills' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close evidence' })).toBeInTheDocument();
      if (state === 'access-lost') {
        expect(screen.queryByRole('button', { name: 'Refresh evidence' })).not.toBeInTheDocument();
      }
    });

    it('preserves the ready empty message', () => {
      render(<CameraEvidenceViewer {...props} state="ready" items={[]} />);
      expect(screen.getByText('No evidence stills recorded for this camera.')).toBeInTheDocument();
      expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    });

    it('uses the real shared buttons and preserves callback and busy guards', () => {
      const callbacks = { onRefresh: vi.fn(), onCapturePending: vi.fn(), onClose: vi.fn() };
      const items: CameraEvidenceItem[] = [{ ...captured, status: 'PENDING', capturedAt: null }];
      const { rerender } = render(
        <CameraEvidenceViewer {...props} {...callbacks} state="ready" items={items} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
      fireEvent.click(screen.getByRole('button', { name: 'Capture pending stills' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close evidence' }));
      expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
      expect(callbacks.onCapturePending).toHaveBeenCalledTimes(1);
      expect(callbacks.onClose).toHaveBeenCalledTimes(1);

      rerender(
        <CameraEvidenceViewer
          {...props}
          {...callbacks}
          state="ready"
          items={items}
          refreshing
          capturing
        />
      );
      const refresh = screen.getByRole('button', { name: 'Refreshing evidence…' });
      const capture = screen.getByRole('button', { name: 'Capturing…' });
      expect(refresh).toBeDisabled();
      expect(capture).toBeDisabled();
      fireEvent.click(refresh);
      fireEvent.click(capture);
      expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
      expect(callbacks.onCapturePending).toHaveBeenCalledTimes(1);
    });
  });
});
