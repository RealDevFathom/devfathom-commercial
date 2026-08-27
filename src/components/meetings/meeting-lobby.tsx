'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AlertTriangle, LockKeyhole, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { MeetingCall } from '@/components/meetings/meeting-call';
import type { MeetingAdmission } from '@/lib/meetings/admission';

export function MeetingLobby({ publicId }: { publicId: string }) {
  const [accessCode, setAccessCode] = useState('');
  const [admission, setAdmission] = useState<MeetingAdmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function admit(code = accessCode) {
    setLoading(true);
    setError(null);
    const response = await fetch(`/meet/${encodeURIComponent(publicId)}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(code ? { accessCode: code } : {}),
    }).catch(() => null);
    if (!response?.ok) {
      setLoading(false);
      if (code) setError('This meeting is unavailable or the access code is invalid.');
      return;
    }
    setAdmission((await response.json()) as MeetingAdmission);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    // PublicId is only a locator; attempt signed-in admission once on entry.
    void fetch(`/meet/${encodeURIComponent(publicId)}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as MeetingAdmission) : null
      )
      .catch(() => null)
      .then((result) => {
        if (cancelled) return;
        setAdmission(result);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [publicId]);

  if (admission) return <MeetingCall admission={admission} onLeave={() => setAdmission(null)} />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void admit();
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-page p-4 sm:p-8">
      <SectionCard
        className="w-full max-w-lg rounded-xl p-6 sm:p-8"
        eyebrow="DEVFATHOM MEETINGS"
        title="Join securely"
      >
        <div className="mb-6 flex size-12 items-center justify-center rounded-md bg-accent-quiet text-accent-brand">
          <Video className="size-5" />
        </div>
        <p className="mb-6 text-sm leading-relaxed text-text-body">
          Sign in as an invited member, or enter the one-time access code from your invitation.
          Meeting details stay private until admission succeeds.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="meeting-access-code"
              className="font-mono text-xs tracking-wide text-text-strong uppercase"
            >
              Guest access code
            </label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
              <input
                id="meeting-access-code"
                type="password"
                autoComplete="one-time-code"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'meeting-access-error' : undefined}
                className="h-11 w-full rounded-sm border border-border bg-surface-card pr-3 pl-10 text-sm text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
            </div>
          </div>
          {error ? (
            <p
              id="meeting-access-error"
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="h-11 w-full"
            disabled={loading || !accessCode.trim()}
          >
            {loading ? 'Checking access…' : 'Continue to meeting'}
          </Button>
        </form>
        <p className="mt-5 text-xs leading-relaxed text-text-muted">
          Invited members are admitted automatically when signed in. Access codes are never added to
          the page URL.
        </p>
      </SectionCard>
    </main>
  );
}
