import type { ReactNode } from 'react';

import { CAMERA_PRESET_LABELS, type CameraPreset } from '@/lib/cameras/camera-preset';

/**
 * CAM-3 camera tile shared by the restaurant camera console and the pharmacy
 * cold-chain section: picture, preset, optional overlay, then the surface's
 * own status line and controls.
 */
export function CameraTile({
  name,
  preset,
  media,
  overlay,
  children,
}: {
  name: string;
  preset: CameraPreset | null;
  media: ReactNode;
  overlay?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="rounded-md border border-border-subtle bg-surface-sunken p-4">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-sm bg-foreground/10 text-sm text-text-muted">
        {media}
        {overlay}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-text-strong">{name}</h3>
        {preset && (
          <span className="rounded-sm border border-border-subtle px-1.5 text-xs text-text-muted">
            {CAMERA_PRESET_LABELS[preset]}
          </span>
        )}
      </div>
      {children}
    </article>
  );
}
