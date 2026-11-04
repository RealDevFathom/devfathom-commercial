'use client';

import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { startCameraLiveSession, type CameraLiveGrant } from '@/lib/cameras/live-session';

export type CameraLivePlayerProps = {
  cameraId: string;
  name: string;
  issue: (previousGrantId?: string) => Promise<CameraLiveGrant>;
  /** Same-origin authorized stream URL for a grant. Never a gateway or device URL. */
  streamUrl: (cameraId: string, grantId: string) => string;
  /** Called once with the last grant when the view stops or unmounts. */
  onRelease?: (grantId: string) => void;
};

/**
 * Shared live HLS player for restaurant and pharmacy cameras: one selected view,
 * short-lived grants renewed by `startCameraLiveSession`, native HLS first and
 * pinned hls.js otherwise. It fails closed on denial, timeout or codec errors.
 */
export function CameraLivePlayer({
  cameraId,
  name,
  issue,
  streamUrl,
  onRelease,
}: CameraLivePlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const issueRef = useRef(issue);
  const urlRef = useRef(streamUrl);
  const releaseRef = useRef(onRelease);
  useEffect(() => {
    issueRef.current = issue;
    urlRef.current = streamUrl;
    releaseRef.current = onRelease;
  }, [issue, streamUrl, onRelease]);
  const [status, setStatus] = useState('Authorizing live view…');

  useEffect(() => {
    const media = video.current!;
    let disposed = false;
    let revision = 0;
    let hls: Hls | undefined;
    let loadingTimer: ReturnType<typeof setTimeout>;
    // The current grant and the one it renewed (which lapses within 15 s).
    // Both are revoked when the view ends, so neither URL outlives the view.
    let held: string[] = [];
    let ended = false;
    const release = () => {
      ended = true;
      const grants = held;
      held = [];
      for (const grantId of grants) releaseRef.current?.(grantId);
    };
    const session: { current?: ReturnType<typeof startCameraLiveSession> } = {};
    const clearMedia = () => {
      revision++;
      clearTimeout(loadingTimer);
      hls?.destroy();
      hls = undefined;
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
    const stop = (message: string) => {
      session.current?.stop();
      clearMedia();
      release();
      if (!disposed) setStatus(message);
    };
    const playing = () => {
      clearTimeout(loadingTimer);
      setStatus('Live view playing');
    };
    const waiting = () => {
      setStatus('Loading live video…');
      clearTimeout(loadingTimer);
      loadingTimer = setTimeout(
        () => stop('Video timed out. Close and reopen live view to try again.'),
        20_000
      );
    };
    const mediaError = () =>
      stop(
        media.error?.code === 3 || media.error?.code === 4
          ? 'This stream or codec is unsupported. Ask the gateway owner to check the video format.'
          : 'Video unavailable or access ended. Close and reopen live view to request access.'
      );
    media.addEventListener('playing', playing);
    media.addEventListener('waiting', waiting);
    media.addEventListener('error', mediaError);

    session.current = startCameraLiveSession({
      issue: async (previous) => {
        const grant = await issueRef.current(previous);
        // Closed while the request was in flight: the session discards this
        // grant, so revoke it here rather than leave it live until expiry.
        if (ended && grant?.grantId) releaseRef.current?.(grant.grantId);
        return grant;
      },
      onStop: stop,
      onGrant: (grant) => {
        clearMedia();
        held = [held.at(-1), grant.grantId].filter((id): id is string => Boolean(id));
        const current = revision;
        waiting();
        const url = urlRef.current(cameraId, grant.grantId);
        const play = () => {
          void media.play().catch(() => {
            if (!disposed && current === revision) {
              clearTimeout(loadingTimer);
              setStatus('Press Play to start live video.');
            }
          });
        };
        if (media.canPlayType('application/vnd.apple.mpegurl')) {
          media.src = url;
          play();
          return;
        }
        // Camera-only lazy bundle. No CDN script or gateway credentials reach the client.
        void import('hls.js')
          .then(({ default: HlsPlayer }) => {
            if (disposed || current !== revision) return;
            if (!HlsPlayer.isSupported()) {
              stop(
                'This browser cannot play HLS video. Use a supported browser with native HLS or MediaSource support.'
              );
              return;
            }
            const policy = {
              default: {
                maxTimeToFirstByteMs: 10_000,
                maxLoadTimeMs: 10_000,
                timeoutRetry: null,
                errorRetry: null,
              },
            };
            hls = new HlsPlayer({
              enableWorker: false,
              lowLatencyMode: false,
              manifestLoadPolicy: policy,
              playlistLoadPolicy: policy,
              fragLoadPolicy: policy,
            });
            hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
              // Denied media must stop immediately, including nonfatal network events.
              if (data.fatal || data.response?.code === 401 || data.response?.code === 403)
                stop(
                  data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR
                    ? 'This stream or codec is unsupported. Ask the gateway owner to check the video format.'
                    : 'Video unavailable or access ended. Close and reopen live view to request access.'
                );
            });
            hls.on(HlsPlayer.Events.MANIFEST_PARSED, play);
            hls.loadSource(url);
            hls.attachMedia(media);
          })
          .catch(() => {
            if (!disposed && current === revision)
              stop('Video player could not load. Close and reopen live view to try again.');
          });
      },
    });
    return () => {
      disposed = true;
      session.current?.stop();
      media.removeEventListener('playing', playing);
      media.removeEventListener('waiting', waiting);
      media.removeEventListener('error', mediaError);
      clearMedia();
      release();
    };
  }, [cameraId]);

  return (
    <div className="w-full space-y-2">
      <video
        ref={video}
        className="aspect-video w-full"
        controls
        autoPlay
        muted
        playsInline
        aria-label={`${name} playback panel`}
      />
      <p role="status" className="text-sm text-text-muted">
        {status}
      </p>
    </div>
  );
}
