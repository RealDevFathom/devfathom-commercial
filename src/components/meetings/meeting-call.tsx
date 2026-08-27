'use client';

import { useEffect, useRef, useState } from 'react';
import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client';
import { AlertTriangle, LogOut, Mic, MicOff, RefreshCw, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MeetingRoster } from '@/components/meetings/meeting-roster';
import type { MeetingAdmission } from '@/lib/meetings/admission';

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
  const [participants, setParticipants] = useState<string[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const syncRoster = () =>
      setParticipants([
        room.localParticipant.name || 'You',
        ...Array.from(room.remoteParticipants.values()).map((p) => p.name || 'Participant'),
      ]);
    room.on(RoomEvent.ConnectionStateChanged, setConnection);
    room.on(RoomEvent.ParticipantConnected, syncRoster);
    room.on(RoomEvent.ParticipantDisconnected, syncRoster);
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) track.attach();
    });
    room
      .connect(admission.serverUrl, admission.token)
      .then(syncRoster)
      .catch(() => {
        setError('The call could not connect. Check your network and try again.');
      });
    return () => {
      room.disconnect();
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
      if (enabled && publication?.videoTrack && element) publication.videoTrack.attach(element);
      if (!enabled && publication?.videoTrack && element) publication.videoTrack.detach(element);
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
    <main className="flex min-h-dvh flex-col bg-surface-inverse text-text-inverse">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="truncate font-display text-base font-semibold">{admission.title}</p>
          <p className="font-mono text-[10px] tracking-wider text-white/60 uppercase">
            {admission.role} · {reconnecting ? 'Connecting' : 'Live'}
          </p>
        </div>
        <Button variant="destructive" size="lg" onClick={onLeave} aria-label="Leave meeting">
          <LogOut /> Leave
        </Button>
      </header>
      {reconnecting ? (
        <div
          className="flex items-center justify-center gap-2 bg-warning-background px-4 py-2 text-sm text-warning-foreground"
          role="status"
        >
          <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" />
          {connection === ConnectionState.Reconnecting ? 'Reconnecting…' : 'Connecting securely…'}
        </div>
      ) : null}
      {error ? (
        <div
          className="flex items-center justify-center gap-2 bg-destructive-background px-4 py-2 text-sm text-destructive-foreground"
          role="alert"
        >
          <AlertTriangle className="size-4" /> {error}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-5">
        <section
          className="relative min-h-[55dvh] overflow-hidden rounded-lg border border-white/10 bg-black"
          aria-label="Meeting video"
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover"
          />
          {!cameraEnabled ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
              <span className="flex size-16 items-center justify-center rounded-full border border-white/15 bg-white/10">
                <VideoOff className="size-6" />
              </span>
              <p className="text-sm">Your camera is off</p>
            </div>
          ) : null}
        </section>
        <MeetingRoster participants={participants} />
      </div>
      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-white/10 px-4 py-4">
        <Button variant="secondary" size="lg" onClick={toggleMicrophone} aria-pressed={micEnabled}>
          {micEnabled ? <Mic /> : <MicOff />} {micEnabled ? 'Mute' : 'Unmute'}
        </Button>
        <Button variant="secondary" size="lg" onClick={toggleCamera} aria-pressed={cameraEnabled}>
          {cameraEnabled ? <Video /> : <VideoOff />} {cameraEnabled ? 'Stop video' : 'Start video'}
        </Button>
      </footer>
    </main>
  );
}
