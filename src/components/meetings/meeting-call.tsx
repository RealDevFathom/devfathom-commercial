'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteVideoTrack,
} from 'livekit-client';
import { AlertTriangle, LogOut, Mic, MicOff, RefreshCw, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MeetingRoster } from '@/components/meetings/meeting-roster';
import type { MeetingAdmission } from '@/lib/meetings/admission-contract';

type RemoteTile = { identity: string; name: string; track: RemoteVideoTrack | null };

/**
 * One remote participant's video. The track is attached in an effect rather
 * than during render so it is detached again on unmount or replacement — a
 * track left attached to a discarded element keeps decoding.
 */
function RemoteVideo({ tile }: { tile: RemoteTile }) {
  const elementRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    const track = tile.track;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [tile.track]);

  return (
    <div className="relative aspect-video min-w-0 overflow-hidden rounded-lg border border-border bg-black">
      <video ref={elementRef} autoPlay playsInline className="h-full w-full object-cover" />
      {tile.track ? null : (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted">
          <VideoOff aria-hidden className="size-6" />
        </div>
      )}
      <p className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-sm bg-black/60 px-2 py-1 text-xs text-white">
        {tile.name}
      </p>
    </div>
  );
}

export function MeetingCall({
  admission,
  onLeave,
}: {
  admission: MeetingAdmission;
  onLeave: () => void;
}) {
  const roomRef = useRef<Room | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Connecting);
  const [remotes, setRemotes] = useState<RemoteTile[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    // One derivation from room state, run on every event that can change it.
    // Rebuilding the whole list is what keeps the roster and the tiles from
    // disagreeing after a reconnect replaces the underlying publications.
    const sync = () =>
      setRemotes(
        Array.from(room.remoteParticipants.values()).map((participant) => ({
          identity: participant.identity,
          name: participant.name || 'Participant',
          track:
            (participant.getTrackPublication(Track.Source.Camera)?.videoTrack as
              RemoteVideoTrack | undefined) ?? null,
        }))
      );

    const attachAudio = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) track.attach();
    };
    const detachAudio = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) track.detach();
    };

    room.on(RoomEvent.ConnectionStateChanged, setConnection);
    room.on(RoomEvent.ParticipantConnected, sync);
    room.on(RoomEvent.ParticipantDisconnected, sync);
    room.on(RoomEvent.TrackSubscribed, (track) => {
      attachAudio(track);
      sync();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      detachAudio(track);
      sync();
    });
    room.on(RoomEvent.TrackMuted, sync);
    room.on(RoomEvent.TrackUnmuted, sync);

    room
      .connect(admission.serverUrl, admission.token)
      .then(sync)
      .catch(() => {
        setError('The call could not connect. Check your network and try again.');
      });

    return () => {
      void room.disconnect();
      roomRef.current = null;
    };
  }, [admission]);

  async function toggleCamera() {
    const room = roomRef.current;
    if (!room) return;
    try {
      const enabled = !cameraEnabled;
      await room.localParticipant.setCameraEnabled(enabled);
      setCameraEnabled(enabled);
      const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const element = localVideoRef.current;
      if (!publication?.videoTrack || !element) return;
      if (enabled) publication.videoTrack.attach(element);
      else publication.videoTrack.detach(element);
    } catch {
      setError('Camera access was denied or is unavailable.');
    }
  }

  async function toggleMicrophone() {
    const room = roomRef.current;
    if (!room) return;
    try {
      const enabled = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setMicEnabled(enabled);
    } catch {
      setError('Microphone access was denied or is unavailable.');
    }
  }

  const reconnecting =
    connection === ConnectionState.Reconnecting || connection === ConnectionState.Connecting;

  return (
    <main data-theme="dark" className="flex min-h-dvh flex-col bg-surface-page text-text-strong">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-base font-semibold">{admission.title}</h1>
          <p className="font-mono text-[10px] tracking-wider text-text-muted uppercase">
            {admission.role} · {reconnecting ? 'Connecting' : 'Live'}
          </p>
        </div>
        <Button variant="destructive" size="lg" onClick={onLeave}>
          <LogOut aria-hidden /> Leave
        </Button>
      </header>

      {reconnecting ? (
        <div
          className="flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm text-warning-foreground"
          role="status"
        >
          <RefreshCw aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {connection === ConnectionState.Reconnecting ? 'Reconnecting…' : 'Connecting securely…'}
        </div>
      ) : null}
      {error ? (
        <div
          className="flex items-center justify-center gap-2 bg-destructive/15 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle aria-hidden className="size-4" /> {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-5">
        <section className="min-w-0 space-y-3" aria-label="Meeting video">
          {remotes.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {remotes.map((tile) => (
                <RemoteVideo key={tile.identity} tile={tile} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-[40dvh] items-center justify-center rounded-lg border border-border bg-surface-sunken p-6 text-center">
              <p className="text-sm text-text-body">
                {reconnecting
                  ? 'Connecting you to the room…'
                  : 'You are the only one here. Others will appear as they join.'}
              </p>
            </div>
          )}

          <div className="relative aspect-video max-h-[30dvh] overflow-hidden rounded-lg border border-border bg-black sm:max-w-xs">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-cover"
            />
            {cameraEnabled ? null : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted">
                <VideoOff aria-hidden className="size-6" />
                <p className="text-xs">Your camera is off</p>
              </div>
            )}
            <p className="absolute bottom-2 left-2 rounded-sm bg-black/60 px-2 py-1 text-xs text-white">
              You
            </p>
          </div>
        </section>

        <MeetingRoster participants={['You', ...remotes.map((tile) => tile.name)]} />
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-border px-4 py-4">
        <Button variant="secondary" size="lg" onClick={toggleMicrophone} aria-pressed={micEnabled}>
          {micEnabled ? <Mic aria-hidden /> : <MicOff aria-hidden />}
          {micEnabled ? 'Mute' : 'Unmute'}
        </Button>
        <Button variant="secondary" size="lg" onClick={toggleCamera} aria-pressed={cameraEnabled}>
          {cameraEnabled ? <Video aria-hidden /> : <VideoOff aria-hidden />}
          {cameraEnabled ? 'Stop video' : 'Start video'}
        </Button>
      </footer>
    </main>
  );
}
