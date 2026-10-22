'use client';

import { useEffect, useState } from 'react';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

type Status = { enabled: boolean; required: boolean; recoveryCodes: number };

export function PlatformMfaCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);

  async function load() {
    const response = await fetch('/api/platform/mfa', { cache: 'no-store' });
    if (response.ok) setStatus((await response.json()) as Status);
  }
  useEffect(() => {
    let active = true;
    void fetch('/api/platform/mfa', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Status | null) => {
        if (active && body) setStatus(body);
      });
    return () => {
      active = false;
    };
  }, []);

  async function action(name: 'begin' | 'confirm' | 'regenerate' | 'disable') {
    setPending(true);
    try {
      const response = await fetch('/api/platform/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, ...(name === 'begin' ? {} : { code }) }),
      });
      const body = (await response.json()) as {
        error?: string;
        secret?: string;
        otpauthUri?: string;
        recoveryCodes?: string[];
      };
      if (!response.ok) {
        toast.error(body.error ?? 'MFA could not be updated.');
        return;
      }
      setSecret(body.secret ?? null);
      setOtpauthUri(body.otpauthUri ?? null);
      setRecoveryCodes(body.recoveryCodes ?? []);
      setCode('');
      await load();
      toast.success(name === 'begin' ? 'Enrollment started.' : 'MFA updated.');
    } catch {
      toast.error('MFA could not be updated.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-card">
      <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <div>
          <h2 className="font-display text-xl font-semibold">
            Operator multi-factor authentication
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            TOTP secrets are encrypted. Recovery codes are hashed and shown once.
          </p>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
          {status?.enabled ? 'Enabled' : 'Not enrolled'}
        </span>
      </div>
      <div className="space-y-4 p-5">
        {!status?.enabled && !secret ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void action('begin')}
            className="inline-flex h-10 items-center gap-2 rounded-sm bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Begin enrollment
          </button>
        ) : null}
        {secret ? (
          <div className="rounded-lg border border-border-subtle bg-surface-sunken/40 p-4">
            <p className="text-xs font-semibold">Add this account to your authenticator</p>
            <code className="mt-3 block break-all font-mono text-xs">{secret}</code>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-2 text-xs font-semibold underline"
              onClick={() => {
                void navigator.clipboard.writeText(otpauthUri ?? secret);
                toast.success('Authenticator URI copied.');
              }}
            >
              <Copy className="h-3.5 w-3.5" /> Copy authenticator URI
            </button>
          </div>
        ) : null}
        {(secret || status?.enabled) && !recoveryCodes.length ? (
          <div className="flex flex-wrap items-end gap-3">
            <label>
              <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                Current authenticator code
              </span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="h-11 rounded-lg border border-border-default bg-card px-3 font-mono text-sm tracking-[0.16em]"
              />
            </label>
            <button
              type="button"
              disabled={pending || code.length < 6}
              onClick={() => void action(secret ? 'confirm' : 'regenerate')}
              className="h-10 rounded-sm bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
            >
              {secret ? 'Confirm and require MFA' : 'Regenerate recovery codes'}
            </button>
          </div>
        ) : null}
        {recoveryCodes.length ? (
          <div className="rounded-lg border border-warning/25 bg-warning/10 p-4 text-text-strong">
            <p className="text-xs font-semibold">Save these recovery codes now</p>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs">
              {recoveryCodes.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
            <button
              type="button"
              className="mt-4 inline-flex items-center gap-2 text-xs font-semibold underline"
              onClick={() => {
                void navigator.clipboard.writeText(recoveryCodes.join('\n'));
                toast.success('Recovery codes copied.');
              }}
            >
              <Copy className="h-3.5 w-3.5" /> Copy all
            </button>
          </div>
        ) : null}
        {status?.enabled ? (
          <p className="text-xs text-text-muted">
            Policy {status.required ? 'requires' : 'allows'} MFA · {status.recoveryCodes} unused
            recovery codes.
          </p>
        ) : null}
      </div>
    </section>
  );
}
