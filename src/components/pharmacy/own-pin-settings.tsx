'use client';

import { useState } from 'react';
import Link from 'next/link';
import { KeyRound, Loader2, RotateCcw } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { OWN_PIN_MAX_LENGTH, OWN_PIN_RULES, ownPinProblem } from '@/lib/pharmacy/own-pin-policy';
import { trpc } from '@/lib/trpc';

type Notice = { tone: 'alert' | 'status'; text: string };

function NoticeLine({ notice, id }: { notice: Notice | null; id: string }) {
  if (!notice) return null;
  return (
    <p
      id={id}
      role={notice.tone}
      className={notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'}
    >
      {notice.text}
    </p>
  );
}

/**
 * DEV-931 — "Your PIN": the signed-in person creates or changes their own approval PIN after
 * re-entering their account password. The server checks the password, the PIN rules and
 * the organization; this form only explains them. The PIN is never shown back.
 */
export function OwnPinSettings({ onboardingHref }: { onboardingHref?: string }) {
  const utils = trpc.useUtils();
  const status = trpc.pharmacyPin.status.useQuery(undefined, { retry: false });
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const save = trpc.pharmacyPin.setMine.useMutation({
    onSuccess: async (result) => {
      setPassword('');
      setPin('');
      setConfirmPin('');
      setNotice({
        tone: 'status',
        text:
          result.action === 'created'
            ? 'Your PIN is set. Use it whenever an approval asks for your own PIN.'
            : 'Your PIN is changed. Use the new PIN from now on.',
      });
      await utils.pharmacyPin.status.invalidate();
    },
    onError: (error) => {
      setPassword('');
      setNotice({ tone: 'alert', text: error.message });
    },
  });

  const data = status.data;
  const hasPin = data?.state === 'SET';
  const blocked = data?.supportSession === true;

  return (
    <div className="space-y-6">
      <SectionCard
        title={hasPin ? 'Change your PIN' : 'Create your PIN'}
        titleLevel={2}
        actions={
          status.isLoading ? null : data ? (
            <StatusPill
              status={data.state}
              tone={data.state === 'SET' ? (data.locked ? 'warning' : 'success') : 'warning'}
              label={
                data.state === 'SET'
                  ? data.locked
                    ? 'Locked'
                    : 'Set'
                  : data.state === 'RESET'
                    ? 'Reset'
                    : 'Not set'
              }
            />
          ) : null
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Approvals ask for your own PIN: confirming your medicine import, approving catalogue
            edits, discounts and refunds, changing the maximum discount and downloading your data.
            Nobody else can see your PIN, and it is never shown again after you save it.
          </p>
          {status.isLoading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your PIN…
            </p>
          ) : status.isError || !data ? (
            <p role="alert" className="text-sm text-destructive">
              Your PIN could not be loaded. Reload the page to try again.
            </p>
          ) : blocked ? (
            <p role="status" className="text-sm text-text-muted">
              A support session cannot set or reset a PIN.
            </p>
          ) : (
            <>
              {data.state === 'RESET' ? (
                <p role="status" className="text-sm text-text-body">
                  Your PIN was reset by the owner or a manager. Create a new one to approve again.
                </p>
              ) : null}
              {data.locked ? (
                <p role="status" className="text-sm text-text-body">
                  Your PIN is locked after too many wrong tries. You can wait, or set a new PIN now.
                </p>
              ) : null}
              <form
                className="grid max-w-md gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const problem = ownPinProblem(pin, confirmPin);
                  if (problem) {
                    setNotice({ tone: 'alert', text: problem });
                    return;
                  }
                  if (!password) {
                    setNotice({ tone: 'alert', text: 'Enter your current password.' });
                    return;
                  }
                  setNotice(null);
                  save.mutate({ currentPassword: password, pin, confirmPin });
                }}
              >
                <div className="grid gap-2">
                  <Label htmlFor="own-pin-password">Your current password</Label>
                  <Input
                    id="own-pin-password"
                    type="password"
                    autoComplete="current-password"
                    className="h-11"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={notice?.tone === 'alert' && !password ? true : undefined}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="own-pin-new">{hasPin ? 'New PIN' : 'PIN'}</Label>
                  <Input
                    id="own-pin-new"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={OWN_PIN_MAX_LENGTH}
                    className="h-11"
                    aria-describedby="own-pin-rules"
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                  />
                  <p id="own-pin-rules" className="text-sm text-text-muted">
                    {OWN_PIN_RULES}
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="own-pin-confirm">Type the PIN again</Label>
                  <Input
                    id="own-pin-confirm"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={OWN_PIN_MAX_LENGTH}
                    className="h-11"
                    value={confirmPin}
                    onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <NoticeLine notice={notice} id="own-pin-notice" />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" className="min-h-11" disabled={save.isPending}>
                    {save.isPending ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                    ) : (
                      <KeyRound data-icon="inline-start" aria-hidden />
                    )}
                    {save.isPending ? 'Saving…' : hasPin ? 'Change PIN' : 'Save PIN'}
                  </Button>
                  {onboardingHref && notice?.tone === 'status' ? (
                    <Link
                      href={onboardingHref}
                      className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
                    >
                      Back to onboarding
                    </Link>
                  ) : null}
                </div>
              </form>
            </>
          )}
        </div>
      </SectionCard>
      {data?.canResetOthers ? <StaffPinResets /> : null}
    </div>
  );
}

/** The owner's or a staff manager's list: reset a member's PIN so they create a new one. */
function StaffPinResets() {
  const utils = trpc.useUtils();
  const members = trpc.pharmacyPin.members.useQuery(undefined, { retry: false });
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const reset = trpc.pharmacyPin.resetForMember.useMutation({
    onSuccess: async () => {
      setNotice({
        tone: 'status',
        text: `${selected?.name ?? 'Their'} PIN is reset. They create a new one under Your PIN.`,
      });
      setSelected(null);
      setPassword('');
      await utils.pharmacyPin.members.invalidate();
    },
    onError: (error) => {
      setPassword('');
      setNotice({ tone: 'alert', text: error.message });
    },
  });

  return (
    <SectionCard title="Staff PINs" titleLevel={2}>
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          If someone forgets their PIN or it may be known to others, reset it. Their old PIN stops
          working at once and they create a new one themselves. You never see or choose it.
        </p>
        {members.isLoading ? (
          <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading staff…
          </p>
        ) : members.isError || !members.data ? (
          <p role="alert" className="text-sm text-destructive">
            Staff PINs could not be loaded. Reload the page to try again.
          </p>
        ) : members.data.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nobody else works here yet. Invite a colleague from Team.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle">
            {members.data.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="min-w-0 text-sm font-medium break-words text-text-strong">
                  {member.name}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    status={member.hasPin ? 'set' : 'not-set'}
                    tone={member.hasPin ? 'success' : 'neutral'}
                    label={member.hasPin ? 'PIN set' : 'No PIN'}
                  />
                  {member.canReset && member.hasPin ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Reset ${member.name}'s PIN`}
                      onClick={() => {
                        setNotice(null);
                        setPassword('');
                        setSelected({ id: member.id, name: member.name });
                      }}
                    >
                      <RotateCcw data-icon="inline-start" aria-hidden /> Reset PIN
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {selected ? (
          <form
            className="grid max-w-md gap-3 rounded-sm border border-border-subtle p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!password) {
                setNotice({ tone: 'alert', text: 'Enter your current password.' });
                return;
              }
              reset.mutate({ userId: selected.id, currentPassword: password });
            }}
          >
            <p className="text-sm text-text-body">
              Reset {selected.name}&apos;s PIN? Their current PIN stops working now.
            </p>
            <div className="grid gap-2">
              <Label htmlFor="staff-pin-reset-password">Your current password</Label>
              <Input
                id="staff-pin-reset-password"
                type="password"
                autoComplete="current-password"
                className="h-11"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="destructive"
                className="min-h-11"
                disabled={reset.isPending}
              >
                {reset.isPending ? 'Resetting…' : 'Reset PIN'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                onClick={() => {
                  setSelected(null);
                  setPassword('');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        <NoticeLine notice={notice} id="staff-pin-notice" />
      </div>
    </SectionCard>
  );
}
