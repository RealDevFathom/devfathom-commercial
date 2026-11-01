'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

const controlClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring';

const PIN_PATTERN = /^\d{4,8}$/;

export type OperatorPinRow = {
  userId: string;
  name: string;
  email: string;
  isOwner: boolean;
  hasPin: boolean;
  pinSetAt: Date | string | null;
  locked: boolean;
};

export function OperatorPinPanel({
  rows,
  currentUserId,
  isOwner,
  pending,
  notice,
  onSubmit,
}: {
  rows: OperatorPinRow[];
  currentUserId: string;
  isOwner: boolean;
  pending: boolean;
  notice: { tone: 'success' | 'error'; text: string } | null;
  onSubmit: (input: { targetUserId: string; pin: string; currentPin?: string }) => void;
}) {
  const [targetUserId, setTargetUserId] = useState(currentUserId);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectable = isOwner ? rows : rows.filter((row) => row.userId === currentUserId);
  const target = selectable.find((row) => row.userId === targetUserId) ?? selectable[0];
  const self = target?.userId === currentUserId;
  // Owners may reset any PIN on session authority; a manager proves the current PIN.
  const needsCurrent = Boolean(target?.hasPin && self && !isOwner);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || pending) return;
    if (!PIN_PATTERN.test(pin)) return setError('Enter a PIN of 4 to 8 digits.');
    if (pin !== confirm) return setError('The two PIN entries do not match.');
    if (needsCurrent && !PIN_PATTERN.test(currentPin))
      return setError('Enter your current PIN to change it.');
    setError(null);
    onSubmit({
      targetUserId: target.userId,
      pin,
      ...(needsCurrent ? { currentPin } : {}),
    });
    // Never keep a PIN in component state after submission.
    setPin('');
    setConfirm('');
    setCurrentPin('');
  }

  if (!selectable.length)
    return (
      <p className="text-sm text-text-body">
        No active owner or manager is available. Assign the Owner, Owner / Operator or Manager role
        first.
      </p>
    );

  return (
    <div className="space-y-6">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
        {isOwner ? (
          <div className="sm:col-span-2">
            <Label htmlFor="pharmacy-pin-target">Owner or manager</Label>
            <select
              className={controlClass}
              id="pharmacy-pin-target"
              value={target?.userId ?? ''}
              disabled={pending}
              onChange={(event) => setTargetUserId(event.target.value)}
            >
              {selectable.map((row) => (
                <option key={row.userId} value={row.userId}>
                  {row.name}
                  {row.userId === currentUserId ? ' (you)' : ''} —{' '}
                  {row.isOwner ? 'Owner' : 'Manager'}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {needsCurrent ? (
          <div className="sm:col-span-2">
            <Label htmlFor="pharmacy-pin-current">Current PIN</Label>
            <Input
              id="pharmacy-pin-current"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              className="mt-1 min-h-11"
              value={currentPin}
              disabled={pending}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => setCurrentPin(event.target.value)}
            />
          </div>
        ) : null}
        <div>
          <Label htmlFor="pharmacy-pin-new">{target?.hasPin ? 'New PIN' : 'PIN'}</Label>
          <Input
            id="pharmacy-pin-new"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={8}
            className="mt-1 min-h-11"
            value={pin}
            disabled={pending}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby="pharmacy-pin-help"
            onChange={(event) => setPin(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pharmacy-pin-confirm">Confirm PIN</Label>
          <Input
            id="pharmacy-pin-confirm"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={8}
            className="mt-1 min-h-11"
            value={confirm}
            disabled={pending}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <p id="pharmacy-pin-help" className="text-sm text-text-muted sm:col-span-2">
          4 to 8 digits. The PIN is stored only as a secure hash and is never shown again. Setting a
          new PIN replaces the previous one and clears any lockout.
        </p>
        {error ? (
          <p className="text-sm text-destructive sm:col-span-2" role="alert">
            {error}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Button className="min-h-11" type="submit" disabled={!target || pending}>
            {pending ? 'Saving…' : target?.hasPin ? 'Reset PIN' : 'Set PIN'}
          </Button>
        </div>
      </form>
      {notice ? (
        <p
          className={notice.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
      <ul className="divide-y divide-border-subtle" aria-label="PIN status">
        {selectable.map((row) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.userId}>
            <div className="min-w-0">
              <p className="text-sm text-text-strong">
                {row.name}
                {row.userId === currentUserId ? ' (you)' : ''}
              </p>
              <p className="font-mono text-xs text-text-muted">
                {row.isOwner ? 'Owner' : 'Manager'} · {row.email}
              </p>
            </div>
            <StatusPill
              status={row.locked ? 'locked' : row.hasPin ? 'set' : 'none'}
              tone={row.locked ? 'warning' : row.hasPin ? 'success' : 'neutral'}
              label={row.locked ? 'Locked' : row.hasPin ? 'PIN set' : 'No PIN'}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OperatorPinConsole({
  initial,
  currentUserId,
  isOwner,
}: {
  initial: OperatorPinRow[];
  currentUserId: string;
  isOwner: boolean;
}) {
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const status = trpc.pharmacyOperatorPin.status.useQuery(undefined, { initialData: initial });
  const setPin = trpc.pharmacyOperatorPin.setPin.useMutation({
    onSuccess: async (result) => {
      setNotice({ tone: 'success', text: result.reset ? 'PIN reset.' : 'PIN set.' });
      await status.refetch();
    },
    onError: (error) => setNotice({ tone: 'error', text: error.message }),
  });
  return (
    <OperatorPinPanel
      rows={status.data ?? initial}
      currentUserId={currentUserId}
      isOwner={isOwner}
      pending={setPin.isPending}
      notice={notice}
      onSubmit={(input) => {
        setNotice(null);
        setPin.mutate(input);
      }}
    />
  );
}
