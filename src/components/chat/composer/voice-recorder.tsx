'use client';

/**
 * Voice-message recorder for the chat composer.
 *
 * Mounts in "recording" mode (the parent only renders it after the user taps
 * the mic), captures audio via MediaRecorder, then shows an inline preview
 * player before the clip is uploaded and sent as a normal message carrying a
 * single audio attachment. The mic stream is ALWAYS released on stop / cancel /
 * unmount so the OS recording indicator never lingers.
 *
 * Tap-to-start / tap-to-stop (no hold-to-record) so it works on touch too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, Play, Pause, Trash2, Send, Loader2, Mic, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

import { uploadAttachment } from '@/lib/chat/upload-client';
import { MAX_ATTACHMENT_BYTES, type SendAttachmentInput } from '@/lib/chat/contract';
import { cn } from '@/lib/utils';

/** Hard cap on a single recording. */
const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Preferred containers, best-first. Opus-in-WebM everywhere; mp4 for Safari.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* isTypeSupported can throw on ancient impls — ignore and keep looking */
    }
  }
  return undefined; // let the browser pick its own default
}

/** Base mime (codecs stripped) → file extension our upload route allows. */
function extForMime(mime: string): string {
  switch (mime.split(';')[0].trim().toLowerCase()) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return 'webm';
  }
}

/** ms → `m:ss`. */
function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type BrowserKind = 'chrome' | 'edge' | 'safari' | 'firefox' | 'other';

/** Best-effort UA sniff — used only to tailor the "how to unblock" hint. */
function detectBrowser(): BrowserKind {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'chrome'; // Chrome UA also says "Safari"
  if (/Safari\//.test(ua) && /Apple/.test(navigator.vendor)) return 'safari';
  return 'other';
}

/** Browser-specific instructions for re-enabling a blocked mic. */
function blockedHint(browser: BrowserKind): string {
  switch (browser) {
    case 'chrome':
    case 'edge':
      return 'Click the microphone icon in the address bar, allow access, then try again.';
    case 'firefox':
      return 'Click the microphone icon in the address bar, clear the block, then try again.';
    case 'safari':
      return 'Open Safari → Settings → Websites → Microphone, allow this site, then try again.';
    default:
      return 'Enable microphone access for this site in your browser settings, then try again.';
  }
}

/**
 * Read the current mic permission via the Permissions API when the browser
 * supports it. `microphone` isn't in TS's `PermissionName` union and Firefox
 * throws on it, so the query is cast + guarded; unknown ⇒ fall through to a
 * normal getUserMedia prompt. Returns the status object too so callers can
 * react to live `change` events.
 */
async function queryMicPermission(): Promise<{
  state: PermissionState | 'unknown';
  status: PermissionStatus | null;
}> {
  try {
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (!perms?.query) return { state: 'unknown', status: null };
    const status = await perms.query({ name: 'microphone' as PermissionName });
    return { state: status.state, status };
  } catch {
    return { state: 'unknown', status: null };
  }
}

type Status = 'requesting' | 'recording' | 'preview' | 'error';

export interface VoiceRecorderProps {
  /**
   * Fired with the uploaded audio attachment (incl. `duration` ms) on send. May
   * return a promise that resolves once the message is persisted; if it rejects,
   * the recorder keeps the clip (and its blob) mounted so the user can retry.
   */
  onSend: (attachment: SendAttachmentInput) => void | Promise<void>;
  /** Fired when the user cancels / discards, or recording can't start. */
  onCancel: () => void;
}

export function VoiceRecorder({ onSend, onCancel }: VoiceRecorderProps) {
  const [status, setStatus] = useState<Status>('requesting');
  const [errorMsg, setErrorMsg] = useState('');
  const [errorHint, setErrorHint] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalDurationMs, setFinalDurationMs] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef<string | undefined>(undefined);
  const startTsRef = useRef<number>(0);
  const lastElapsedRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // Set when the user cancels (or we unmount) so `onstop` skips building a preview.
  const abortRef = useRef(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  // Live mic PermissionStatus (when supported) so we can detach its listener.
  const permStatusRef = useRef<PermissionStatus | null>(null);

  // --- teardown helpers ----------------------------------------------------
  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  /** Stop the recorder + timer + mic. `onstop` turns the chunks into a preview. */
  const finishRecording = useCallback(() => {
    stopTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    releaseStream();
  }, [stopTimer, releaseStream]);

  // Watch the live mic permission (when the browser exposes it) so a recording
  // automatically resumes the moment the user flips a block to "allow".
  const startRef = useRef<(() => Promise<void>) | null>(null);
  const watchPermission = useCallback((statusObj: PermissionStatus | null) => {
    if (permStatusRef.current && permStatusRef.current !== statusObj) {
      permStatusRef.current.onchange = null;
    }
    permStatusRef.current = statusObj;
    if (statusObj) {
      statusObj.onchange = () => {
        if (statusObj.state === 'granted') void startRef.current?.();
      };
    }
  }, []);

  // --- recording -----------------------------------------------------------
  const start = useCallback(async () => {
    // `navigator.mediaDevices` is undefined on insecure origins — the #1 reason
    // the native mic prompt never appears in dev (LAN IP / plain http).
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      setStatus('error');
      setErrorMsg(
        insecure ? 'Microphone needs a secure connection.' : 'Voice recording isn’t supported here.'
      );
      setErrorHint(
        insecure
          ? 'Open the app over HTTPS (or http://localhost) — browsers only allow mic access on secure origins.'
          : 'Try a recent Chrome, Edge, Firefox, or Safari.'
      );
      return;
    }

    setStatus('requesting');
    setErrorMsg('');
    setErrorHint('');

    // Call getUserMedia FIRST — this is what fires the browser's native
    // Allow/Block popup. We deliberately don't await anything before it, so the
    // user-activation from the mic tap carries through (Safari needs that) and
    // an undecided permission always prompts, exactly like a native app.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as DOMException | undefined)?.name;
      setStatus('error');
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        // Permission was dismissed or previously blocked — the browser won't
        // re-popup until it's reset, so point the user at how to do that, and
        // watch for them flipping it back to Allow to resume automatically.
        setErrorMsg('Microphone access was blocked.');
        setErrorHint(blockedHint(detectBrowser()));
        const { status } = await queryMicPermission();
        watchPermission(status);
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setErrorMsg('No microphone found. Connect one and try again.');
      } else {
        setErrorMsg('Couldn’t start recording. Please try again.');
      }
      return;
    }

    streamRef.current = stream;
    const mime = pickMimeType();
    mimeRef.current = mime;

    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      releaseStream();
      setStatus('error');
      setErrorMsg('Couldn’t start recording. Please try again.');
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      // Cancelled or unmounted mid-recording — drop everything, no preview.
      if (abortRef.current) {
        chunksRef.current = [];
        return;
      }
      const type = recorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      blobRef.current = blob;
      // Duration from the elapsed timer — WebM blob metadata is frequently
      // `Infinity` until fully buffered, so the wall-clock measure is reliable.
      setFinalDurationMs(lastElapsedRef.current);
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setStatus('preview');
    };

    recorder.start();
    startTsRef.current = performance.now();
    lastElapsedRef.current = 0;
    setElapsedMs(0);
    setStatus('recording');

    timerRef.current = window.setInterval(() => {
      const e = performance.now() - startTsRef.current;
      lastElapsedRef.current = e;
      setElapsedMs(e);
      if (e >= MAX_DURATION_MS) finishRecording(); // auto-stop at the cap
    }, 100);
  }, [releaseStream, finishRecording, watchPermission]);

  // Keep the permission-change auto-resume pointed at the latest `start`.
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Auto-start on mount; guarantee teardown on unmount.
  useEffect(() => {
    void start();
    return () => {
      abortRef.current = true;
      stopTimer();
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* noop */
        }
      }
      releaseStream();
      if (permStatusRef.current) {
        permStatusRef.current.onchange = null;
        permStatusRef.current = null;
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions -------------------------------------------------------------
  const handleCancel = useCallback(() => {
    abortRef.current = true;
    finishRecording();
    onCancel();
  }, [finishRecording, onCancel]);

  const handleDiscard = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    blobRef.current = null;
    onCancel();
  }, [onCancel]);

  const togglePreviewPlay = useCallback(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const handleSend = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob || isUploading) return;
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      toast.error('Recording is too large to send.');
      return;
    }
    const mime = (mimeRef.current || blob.type || 'audio/webm').split(';')[0].trim();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = new File([blob], `voice-message-${stamp}.${extForMime(mime)}`, { type: mime });

    setIsUploading(true);

    let att: SendAttachmentInput;
    try {
      att = await uploadAttachment(file);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send voice message');
      setIsUploading(false);
      return;
    }

    try {
      // Resolves only once the parent has persisted the message — only then is it
      // safe to let go of the clip. We deliberately DON'T revoke the blob URL or
      // clear the blob here: the parent dismisses us on success and the unmount
      // cleanup releases the object URL.
      await onSend({ ...att, type: att.type ?? mime, duration: Math.round(finalDurationMs) });
    } catch {
      // Send failed: the parent already surfaced the error and rolled back the
      // optimistic message. Keep the blob + preview mounted and re-enable the
      // controls so the user can retry the SAME recording.
      setIsUploading(false);
    }
  }, [isUploading, finalDurationMs, onSend]);

  // --- render --------------------------------------------------------------
  const iconBtn =
    'flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground';
  const primaryBtn =
    'flex size-8 items-center justify-center rounded-lg bg-[#bc8850] text-white transition-colors hover:bg-[#bc8850]/90 disabled:cursor-not-allowed disabled:opacity-50';

  if (status === 'error') {
    return (
      <div className="flex items-start gap-2.5 px-3 py-3 text-sm">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">{errorMsg}</p>
          {errorHint && <p className="mt-0.5 text-xs text-muted-foreground">{errorHint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void start()}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-[#bc8850] transition-colors hover:bg-[#bc8850]/10"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (status === 'preview') {
    const total = finalDurationMs;
    const fraction = total > 0 ? Math.min(playbackMs / total, 1) : 0;
    return (
      <div className="flex items-center gap-3 px-3 py-3">
        {previewUrl && (
          <audio
            ref={previewAudioRef}
            src={previewUrl}
            className="hidden"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={(e) => setPlaybackMs(e.currentTarget.currentTime * 1000)}
            onEnded={() => {
              setIsPlaying(false);
              setPlaybackMs(0);
            }}
          />
        )}
        <button
          type="button"
          onClick={togglePreviewPlay}
          aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
          className={iconBtn}
        >
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[#bc8850]"
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatClock(isPlaying || playbackMs > 0 ? playbackMs : total)} / {formatClock(total)}
          </span>
        </div>

        <button
          type="button"
          onClick={handleDiscard}
          disabled={isUploading}
          aria-label="Discard recording"
          className={cn(iconBtn, 'hover:text-destructive disabled:opacity-50')}
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={isUploading}
          aria-label="Send voice message"
          className={primaryBtn}
        >
          {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
    );
  }

  // 'requesting' | 'recording'
  const isRequesting = status === 'requesting';
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      {isRequesting ? (
        <>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">Starting microphone…</span>
        </>
      ) : (
        <>
          <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500/60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
          </span>
          <span className="flex items-center gap-1.5 text-sm">
            <Mic className="size-4 text-red-500" />
            <span className="font-medium text-foreground">Recording</span>
          </span>
          <span
            className="ml-1 font-mono text-sm tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {formatClock(elapsedMs)}
          </span>
          <span className="flex-1" />
        </>
      )}

      <button
        type="button"
        onClick={handleCancel}
        aria-label="Cancel recording"
        className={cn(iconBtn, 'hover:text-destructive')}
      >
        <Trash2 className="size-4" />
      </button>
      <button
        type="button"
        onClick={finishRecording}
        disabled={isRequesting}
        aria-label="Stop recording"
        className={primaryBtn}
      >
        <Square className="size-4 fill-current" />
      </button>
    </div>
  );
}
