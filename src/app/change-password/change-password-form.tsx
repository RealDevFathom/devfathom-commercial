'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signOutEverything } from '@/lib/auth/sign-out';
import { passwordMeetsPolicy, passwordRules } from '@/lib/password-policy';
import { trpc } from '@/lib/trpc';

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const changePassword = trpc.team.changePassword.useMutation({
    onSuccess: () => {
      void signOutEverything('/login');
    },
    onError: (failure) => setError(failure.message),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (!passwordMeetsPolicy(newPassword)) {
      setError('Password does not meet the requirements below.');
      return;
    }
    changePassword.mutate({ currentPassword, newPassword });
  };

  return (
    <form className="mt-6 space-y-4" onSubmit={submit}>
      <label className="block text-sm text-text-body">
        Current password
        <Input
          className="mt-1.5 min-h-11"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>
      <label className="block text-sm text-text-body">
        New password
        <Input
          className="mt-1.5 min-h-11"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <label className="block text-sm text-text-body">
        Confirm new password
        <Input
          className="mt-1.5 min-h-11"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </label>
      {newPassword.length > 0 ? (
        <ul className="grid gap-1 sm:grid-cols-2">
          {passwordRules.map((rule) => (
            <li key={rule.id} className="text-xs text-text-muted">
              {rule.test(newPassword) ? 'Met' : 'Needed'}: {rule.label}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" className="min-h-11" disabled={changePassword.isPending}>
          {changePassword.isPending ? 'Saving…' : 'Change password'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void signOutEverything('/login')}
        >
          Sign out
        </Button>
      </div>
    </form>
  );
}
