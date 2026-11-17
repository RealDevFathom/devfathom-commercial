'use client';

import { useMemo, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import { encodeQrCode } from '@/lib/qr-code';

/** The otpauth:// URI as a scannable QR code (SVG, one path, theme-safe light quiet zone). */
export function AuthenticatorQrCode({ uri }: { uri: string }) {
  const svg = useMemo(() => {
    try {
      const modules = encodeQrCode(uri);
      const quiet = 4;
      const size = modules.length + quiet * 2;
      let path = '';
      modules.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        })
      );
      return { size, path };
    } catch {
      return null;
    }
  }, [uri]);
  if (!svg) return null;
  // Exception to the token rule: scanners need dark modules on a light quiet zone in both
  // themes, so the QR code keeps fixed black-on-white whatever the theme.
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${svg.size} ${svg.size}`}
      className="h-44 w-44 rounded-[var(--radius-xs)] border border-border bg-white"
      shapeRendering="crispEdges"
    >
      <path d={svg.path} fill="#000" />
    </svg>
  );
}

/**
 * DEV-879: the member's authenticator for manager and owner approvals. Enrolling turns off
 * their fixed approval PIN; the owner or an administrator handles recovery; the owner can
 * require an authenticator for every approval in the organization.
 */
export function ApprovalAuthenticatorSection() {
  const utils = trpc.useUtils();
  const status = trpc.approvalAuthenticator.getStatus.useQuery();
  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const begin = trpc.approvalAuthenticator.beginEnrollment.useMutation({
    onSuccess: (data) => {
      setEnrolling(data);
      setCode('');
      setPassword('');
      setError('');
    },
    onError: (e) => setError(e.message),
  });
  const confirm = trpc.approvalAuthenticator.confirmEnrollment.useMutation({
    onSuccess: () => {
      setEnrolling(null);
      setCode('');
      setError('');
      void utils.approvalAuthenticator.invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const setRequired = trpc.approvalAuthenticator.setRequired.useMutation({
    onSuccess: () => void utils.approvalAuthenticator.getStatus.invalidate(),
    onError: (e) => setError(e.message),
  });

  const data = status.data;

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
            <KeyRound className="h-3.5 w-3.5 text-foreground" aria-hidden />
          </div>
          Authenticator for approvals
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Approve refunds, discounts and other manager or owner actions with a code that changes
          every 30 seconds, instead of a fixed PIN. You can read the code to the cashier by phone.
          Approvals need the counter to be online.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {status.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : status.isError || !data ? (
          <p className="text-sm text-muted-foreground">
            Approval authenticator status could not be loaded. Refresh the page to try again.
          </p>
        ) : data.enrolled ? (
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status="active" label="Set up" />
            <p className="text-sm text-muted-foreground">
              Your PIN is no longer accepted for approvals. Enter the code from your app instead. If
              you lose your phone, ask the owner or an administrator to reset it.
            </p>
          </div>
        ) : enrolling ? (
          <div className="space-y-3">
            <ol
              aria-label="Set up an authenticator for approvals"
              className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground"
            >
              <li>
                Open an authenticator app on your phone, such as Google Authenticator or Microsoft
                Authenticator.
              </li>
              <li>Scan this QR code, or add an account with the setup key below.</li>
              <li>
                Enter the 6-digit code the app shows, then select &quot;Verify &amp; turn on&quot;.
              </li>
            </ol>
            <AuthenticatorQrCode uri={enrolling.otpauthUri} />
            <div>
              <p className="mb-1 font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Setup key
              </p>
              <code className="block rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs break-all text-foreground">
                {enrolling.secret}
              </code>
            </div>
            <label
              htmlFor="approval-authenticator-code"
              className="block text-xs font-medium text-foreground"
            >
              6-digit code from your app
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="approval-authenticator-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                aria-invalid={Boolean(error) || undefined}
                className="w-32"
              />
              <Button
                onClick={() => confirm.mutate({ token: code })}
                disabled={code.length !== 6 || confirm.isPending}
              >
                {confirm.isPending ? 'Verifying…' : 'Verify & turn on'}
              </Button>
              <Button variant="ghost" onClick={() => setEnrolling(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : data.available ? (
          <div className="flex flex-wrap items-end gap-3">
            <StatusPill status="neutral" label={data.required ? 'Required' : 'Not set up'} />
            <div className="w-full space-y-1 sm:w-auto">
              <label
                htmlFor="approval-authenticator-password"
                className="block text-xs font-medium text-foreground"
              >
                Your current password
              </label>
              <Input
                id="approval-authenticator-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="sm:w-56"
              />
            </div>
            <Button
              onClick={() => begin.mutate({ currentPassword: password })}
              disabled={!password || begin.isPending}
            >
              {begin.isPending ? 'Starting…' : 'Set up authenticator'}
            </Button>
            {data.required && (
              <p className="w-full text-sm text-muted-foreground">
                Your organization requires an authenticator for approvals. Your PIN will not approve
                anything until you set one up.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Approval authenticators are not available until the server encryption key is configured.
          </p>
        )}

        {data?.isOwner && (
          <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
            <div>
              <p
                id="require-approval-authenticator"
                className="text-sm font-medium text-foreground"
              >
                Require authenticator for approvals
              </p>
              <p className="text-xs text-muted-foreground">
                Turns fixed PINs off for every approval in your organization. Members who have not
                set up an authenticator cannot approve until they do.
              </p>
            </div>
            <Switch
              aria-labelledby="require-approval-authenticator"
              checked={data.required}
              disabled={setRequired.isPending}
              onCheckedChange={(required) => setRequired.mutate({ required })}
            />
          </div>
        )}

        {data?.canManage && <ApprovalAuthenticatorRecovery />}
      </CardContent>
    </Card>
  );
}

/** Owner and administrators: reset a member's approval authenticator when they lose their phone. */
function ApprovalAuthenticatorRecovery() {
  const utils = trpc.useUtils();
  const members = trpc.approvalAuthenticator.members.useQuery();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const reset = trpc.approvalAuthenticator.resetForMember.useMutation({
    onSuccess: () => {
      setConfirming(null);
      setPassword('');
      setMessage('Reset. The member can set up a new authenticator.');
      void utils.approvalAuthenticator.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const enrolled = (members.data ?? []).filter((member) => member.enrolled);

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <p className="text-sm font-medium text-foreground">Reset a member&apos;s authenticator</p>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {members.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading members…</p>
      ) : members.isError ? (
        <p className="text-xs text-muted-foreground">Members could not be loaded.</p>
      ) : enrolled.length === 0 ? (
        <p className="text-xs text-muted-foreground">No member has set up an authenticator yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-[var(--radius-sm)] border border-border">
          {enrolled.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span className="text-sm text-foreground">{member.name}</span>
              {confirming === member.id ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="current-password"
                    aria-label="Your current password"
                    placeholder="Your current password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-7 w-44 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!password || reset.isPending}
                    onClick={() => reset.mutate({ userId: member.id, currentPassword: password })}
                  >
                    Confirm reset
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setConfirming(null);
                      setPassword('');
                    }}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirming(member.id)}>
                  Reset
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
