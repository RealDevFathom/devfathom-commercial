'use client';

/**
 * Playback UI for an audio (voice) message attachment.
 *
 * Custom-styled play/pause + a faux-waveform scrubber + elapsed / total time,
 * backed by a hidden <audio> element. Total time prefers the stored `duration`
 * (ms) — recorded WebM blobs often report `Infinity`/`NaN` duration until fully
 * seeked, so we both fall back to the stored value AND nudge the element to
 * resolve its real duration (needed for reliable seeking).
 *
 * The scrubber is an ARIA slider: focusable, arrow-key seekable, and click/drag
 * seekable via the pointer.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';

import type { ChatAttachment } from '@/lib/chat/contract';
import { cn } from '@/lib/utils';

const BAR_COUNT = 40;
const SEEK_STEP_SEC = 5;

/** seconds → `m:ss`. */
function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Deterministic pseudo-random bar heights seeded from the attachment URL, so
// each clip gets a stable, distinct-looking waveform without storing real
// samples. The URL is identical between the optimistic and persisted message
// (only the id changes), so the waveform doesn't reshuffle on reconciliation.
function waveformBars(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    bars.push(0.3 + ((h % 1000) / 1000) * 0.7); // 0.3 .. 1.0 of track height
  }
  return bars;
}

export function VoiceMessage({ attachment }: { attachment: ChatAttachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // True while we nudge an Infinity-duration WebM to resolve its real length.
  const nudgingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [audioDur, setAudioDur] = useState(0);

  const storedSec = attachment.duration != null ? attachment.duration / 1000 : 0;
  const totalSec = storedSec > 0 ? storedSec : audioDur;
  const fraction = totalSec > 0 ? Math.min(currentSec / totalSec, 1) : 0;

  const bars = useMemo(() => waveformBars(attachment.url, BAR_COUNT), [attachment.url]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  const seekToFraction = useCallback(
    (f: number) => {
      const clamped = Math.max(0, Math.min(1, f));
      const target = clamped * totalSec;
      const a = audioRef.current;
      if (a && Number.isFinite(a.duration) && a.duration > 0) {
        a.currentTime = Math.min(target, a.duration);
      }
      setCurrentSec(target);
    },
    [totalSec]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) seekToFraction((e.clientX - rect.left) / rect.width);
      el.focus();
    },
    [seekToFraction]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggle();
        return;
      }
      if (totalSec <= 0) return;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = currentSec + SEEK_STEP_SEC;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = currentSec - SEEK_STEP_SEC;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = totalSec;
          break;
        default:
          return;
      }
      e.preventDefault();
      seekToFraction(next / totalSec);
    },
    [currentSec, totalSec, seekToFraction, toggle]
  );

  return (
    <div className="flex w-[20rem] max-w-full items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        className="hidden"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentSec(0);
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (!Number.isFinite(a.duration) || a.duration === 0) {
            nudgingRef.current = true;
            try {
              a.currentTime = 1e7; // force the element to discover its real length
            } catch {
              /* ignore */
            }
          } else {
            setAudioDur(a.duration);
          }
        }}
        onDurationChange={(e) => {
          const a = e.currentTarget;
          if (Number.isFinite(a.duration) && a.duration > 0) setAudioDur(a.duration);
        }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (nudgingRef.current) {
            if (Number.isFinite(a.duration) && a.duration > 0) {
              nudgingRef.current = false;
              setAudioDur(a.duration);
              try {
                a.currentTime = 0;
              } catch {
                /* ignore */
              }
              setCurrentSec(0);
            }
            return;
          }
          setCurrentSec(a.currentTime);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause voice message' : 'Play voice message'}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#bc8850] text-white transition-colors hover:bg-[#bc8850]/90"
      >
        {isPlaying ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek voice message"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalSec)}
          aria-valuenow={Math.round(currentSec)}
          aria-valuetext={`${formatClock(currentSec)} of ${formatClock(totalSec)}`}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          className="flex h-7 cursor-pointer items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-[#bc8850]/40"
        >
          {bars.map((bh, i) => {
            const played = (i + 0.5) / bars.length <= fraction;
            return (
              <span
                key={i}
                className={cn(
                  'flex-1 rounded-full transition-colors',
                  played ? 'bg-[#bc8850]' : 'bg-muted-foreground/30'
                )}
                style={{ height: `${Math.round(bh * 100)}%` }}
              />
            );
          })}
        </div>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatClock(currentSec)} / {formatClock(totalSec)}
        </span>
      </div>
    </div>
  );
}
