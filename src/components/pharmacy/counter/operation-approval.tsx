'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type OperationApprovers = {
  mode: 'SOLO' | 'STAFFED';
  users: { id: string; name: string | null; email?: string }[];
};

/** Credentials live only in form state, never in persisted recovery payloads. */
export function OperationApproval({
  id,
  data,
  loading,
  error,
  disabled,
  pin,
  checkerId,
  onPin,
  onChecker,
}: {
  id: string;
  data?: OperationApprovers;
  loading?: boolean;
  error?: boolean;
  disabled?: boolean;
  pin: string;
  checkerId: string;
  onPin: (pin: string) => void;
  onChecker: (id: string) => void;
}) {
  return (
    <fieldset disabled={disabled || loading || error || !data} className="space-y-2">
      <legend className="font-semibold">Approval</legend>
      {loading && <p role="status">Loading approval policy…</p>}
      {error && <p role="alert">Approval policy unavailable. Reload before continuing.</p>}
      {data?.mode === 'STAFFED' && (
        <>
          <Label htmlFor={`${id}-checker`}>Independent owner or manager</Label>
          <select
            id={`${id}-checker`}
            value={checkerId}
            onChange={(event) => {
              onChecker(event.target.value);
              onPin('');
            }}
            className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="">Choose checker</option>
            {data.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name || user.email}
              </option>
            ))}
          </select>
          {data.users.length === 0 && (
            <p role="alert">No active checker is assigned to this branch.</p>
          )}
        </>
      )}
      <Label htmlFor={`${id}-pin`}>{data?.mode === 'SOLO' ? 'Owner PIN' : 'Checker PIN'}</Label>
      <Input
        id={`${id}-pin`}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={pin}
        onChange={(event) => onPin(event.target.value)}
        className="h-11"
      />
      <p className="text-sm text-text-muted">
        Re-enter the PIN for each attempt. Approval is checked and audited by the server.
      </p>
    </fieldset>
  );
}

export function operationApprovalReady(
  data: OperationApprovers | undefined,
  pin: string,
  checkerId: string
) {
  return Boolean(data && /^\d{4,8}$/.test(pin) && (data.mode === 'SOLO' || checkerId));
}
