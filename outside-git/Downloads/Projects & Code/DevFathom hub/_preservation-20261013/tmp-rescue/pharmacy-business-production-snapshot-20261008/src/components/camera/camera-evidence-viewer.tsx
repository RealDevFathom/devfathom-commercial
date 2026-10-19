'use client';

import { Button } from '@/components/ui/button';

/** One private still as returned by a vertical's grant-checked evidence read. */
export type CameraEvidenceItem = {
  id: string;
  subjectKind: string;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'PURGED';
  requestedAt: string | Date;
  capturedAt: string | Date | null;
  failureReason?: string | null;
  /** A private data: URL; never a storage key or public URL. */
  image: string | null;
};

export type CameraEvidenceViewerState = 'loading' | 'ready' | 'error' | 'access-lost';

const STATUS: Record<CameraEvidenceItem['status'], string> = {
  PENDING: 'Still pending capture.',
  CAPTURED: 'Still no longer in storage.',
  FAILED: 'No still was captured.',
  PURGED: 'Still removed under the camera retention period.',
};

function when(value: string | Date | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * Neutral private evidence list. The caller owns the viewer grant and the read;
 * this view never keeps stills of its own, so withholding `items` clears them.
 */
export function CameraEvidenceViewer({
  cameraName,
  state,
  items,
  subjectLabels,
  refreshing = false,
  capturing = false,
  onRefresh,
  onCapturePending,
  onClose,
}: {
  cameraName: string;
  state: CameraEvidenceViewerState;
  items: readonly CameraEvidenceItem[];
  subjectLabels: Record<string, string>;
  refreshing?: boolean;
  capturing?: boolean;
  onRefresh?: () => void;
  onCapturePending?: () => void;
  onClose: () => void;
}) {
  const visible = state === 'ready' ? items : [];
  const pending = visible.some((item) => item.status === 'PENDING');
  return (
    <section
      aria-label={`Private evidence for ${cameraName}`}
      className="space-y-3 rounded-md border border-border-subtle p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-strong">Private evidence stills</p>
        <div className="flex flex-wrap gap-2">
          {onRefresh && state !== 'access-lost' ? (
            <Button type="button" variant="secondary" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? 'Refreshing evidence…' : 'Refresh evidence'}
            </Button>
          ) : null}
          {onCapturePending && state === 'ready' && pending ? (
            <Button
              type="button"
              variant="secondary"
              disabled={capturing}
              onClick={onCapturePending}
            >
              {capturing ? 'Capturing…' : 'Capture pending stills'}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            Close evidence
          </Button>
        </div>
      </div>
      {state === 'loading' ? (
        <p role="status" className="text-sm text-text-muted">
          Requesting private viewer access…
        </p>
      ) : state === 'access-lost' ? (
        <p role="alert" className="text-sm text-text-muted">
          Viewer access expired or was revoked. Stills were cleared from this screen. Open evidence
          again to request access.
        </p>
      ) : state === 'error' ? (
        <p role="alert" className="text-sm text-text-muted">
          Evidence could not be loaded. Check your access and try again.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-text-muted">No evidence stills recorded for this camera.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {visible.map((item) => {
            const label = subjectLabels[item.subjectKind] ?? 'Evidence';
            return (
              <li key={item.id} className="space-y-1">
                <p className="text-sm text-text-strong">{label}</p>
                {item.image ? (
                  // A private data: URL from the grant-checked read; nothing to optimise.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.image}
                    alt={`Camera still for ${label.toLowerCase()}, ${when(item.capturedAt)}`}
                    className="w-full rounded border border-border-subtle"
                  />
                ) : (
                  <p className="text-sm text-text-muted">{STATUS[item.status]}</p>
                )}
                <p className="text-xs text-text-muted">
                  {item.capturedAt
                    ? `Captured ${when(item.capturedAt)}`
                    : `Requested ${when(item.requestedAt)}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
