'use client';

import { useState } from 'react';
import { PasswordInput } from '@/components/ui/password-input';
import { Button } from '@/components/ui/button';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Loader2, Check, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { passwordRules, passwordMeetsPolicy } from '@/lib/password-policy';
import { cn } from '@/lib/utils';
import { inviteCopyForVertical } from '@/lib/team/invite-copy';

const inputClass =
  'flex h-12 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-4 text-sm text-text-strong placeholder:text-text-muted transition-colors focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30';

// The invitation payload carries no vertical, so the anonymous accept page uses
// the neutral workspace copy.
const inviteCopy = inviteCopyForVertical(null);

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const { data, isLoading, error: queryError } = trpc.invitations.get.useQuery({ token });
  const accept = trpc.invitations.accept.useMutation();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [error, setError] = useState('');

  // Loading
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-accent-brand" />
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Accept your invitation
        </h1>
        <p className="text-sm text-muted-foreground">Verifying your invitation...</p>
      </div>
    );
  }

  // Error / invalid / expired
  if (queryError || !data) {
    return (
      <div role="status" aria-live="polite" className="space-y-5 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Invitation unavailable
        </h1>
        <p className="text-sm text-muted-foreground">
          This invitation link is invalid or has expired.
        </p>
        <a
          href="/login"
          className="inline-flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  const policyOk = passwordMeetsPolicy(password);
  const confirmOk = password.length > 0 && password === confirm;
  const phoneOk = phone.trim().length > 0;
  const canSubmit = policyOk && confirmOk && phoneOk && !accept.isPending;

  const addSkill = () => {
    const v = skillInput.trim();
    if (v && !skills.includes(v)) {
      setSkills([...skills, v]);
      setSkillInput('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!passwordMeetsPolicy(password)) {
      setError('Please choose a password that meets all the requirements.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!phone.trim()) {
      setError('Please enter your phone number.');
      return;
    }

    try {
      await accept.mutateAsync({
        token,
        password,
        phone: phone.trim(),
        bio: bio || undefined,
        skills,
      });

      const result = await signIn('credentials', {
        email: data.email,
        password,
        redirect: false,
      });

      if (!result || result.error) {
        // Account is activated but auto sign-in failed — send them to login.
        router.push('/login');
        router.refresh();
        return;
      }

      router.push('/dashboard?landing=1');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <div className="mb-7">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Welcome, {data.name.split(' ')[0]}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Set a password to activate your DevFathom account.
        </p>
      </div>

      {/* Read-only summary */}
      <dl className="mb-6 grid grid-cols-1 gap-x-4 gap-y-4 rounded-[var(--radius-md)] border border-border-subtle bg-surface-sunken p-4 sm:grid-cols-2">
        <div>
          <dt className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Full Name
          </dt>
          <dd className="mt-1 text-sm text-foreground">{data.name}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Email
          </dt>
          <dd className="mt-1 break-all text-sm text-foreground">{data.email}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Job Title
          </dt>
          <dd className="mt-1 text-sm text-foreground">{data.title}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Department
          </dt>
          <dd className="mt-1 text-sm text-foreground">{titleCase(data.department)}</dd>
        </div>
        {data.role === 'ADMIN' && (
          <div>
            <dt className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Role
            </dt>
            <dd className="mt-1 text-sm text-foreground">Admin</dd>
          </div>
        )}
      </dl>

      {error && (
        <div
          id="account-error"
          role="alert"
          className="mb-5 rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Password */}
        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium text-foreground">
            New Password <span className="text-accent-brand">*</span>
          </label>
          <PasswordInput
            id="password"
            aria-invalid={Boolean(error)}
            aria-describedby={
              error ? 'account-error password-requirements' : 'password-requirements'
            }
            revealed={showPassword}
            onReveal={() => setShowPassword((visible) => !visible)}
            placeholder="Create a password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />

          {/* Live password requirements checklist */}
          <ul id="password-requirements" className="mt-2 space-y-1.5">
            {passwordRules.map((rule) => {
              const met = rule.test(password);
              return (
                <li key={rule.id} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors',
                      met ? 'bg-success/15 text-success' : 'bg-muted text-transparent'
                    )}
                  >
                    {met ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                    )}
                  </span>
                  <span className={met ? 'text-foreground' : 'text-muted-foreground'}>
                    {rule.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Confirm Password */}
        <div className="space-y-2">
          <label htmlFor="confirm" className="block text-sm font-medium text-foreground">
            Confirm Password <span className="text-accent-brand">*</span>
          </label>
          <input
            id="confirm"
            aria-invalid={Boolean(error) || (confirm.length > 0 && !confirmOk)}
            aria-describedby={
              error
                ? 'account-error'
                : confirm.length > 0 && !confirmOk
                  ? 'confirm-error'
                  : undefined
            }
            type={showPassword ? 'text' : 'password'}
            placeholder="Re-enter your password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClass}
          />
          {confirm.length > 0 && !confirmOk && (
            <p id="confirm-error" role="status" className="text-xs text-destructive">
              Passwords do not match.
            </p>
          )}
        </div>

        {/* Phone */}
        <div className="space-y-2">
          <label htmlFor="phone" className="block text-sm font-medium text-foreground">
            Phone <span className="text-accent-brand">*</span>
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            required
            placeholder={inviteCopy.phonePlaceholder}
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Bio */}
        <div className="space-y-2">
          <label htmlFor="bio" className="block text-sm font-medium text-foreground">
            Bio
          </label>
          <textarea
            id="bio"
            rows={3}
            placeholder="A short introduction..."
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className={cn(inputClass, 'h-auto resize-none py-2.5')}
          />
        </div>

        {/* Skills */}
        <div className="space-y-2">
          <label htmlFor="skills" className="block text-sm font-medium text-foreground">
            Skills
          </label>
          <input
            id="skills"
            type="text"
            placeholder="Add skill, press Enter..."
            value={skillInput}
            onChange={(e) => setSkillInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSkill();
              }
            }}
            className={inputClass}
          />
          {skills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {skills.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-border-subtle bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                >
                  {s}
                  <button
                    type="button"
                    onClick={() => setSkills(skills.filter((sk) => sk !== s))}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`Remove ${s}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <Button
          type="submit"
          disabled={!canSubmit}
          className="group flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
        >
          {accept.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating account...
            </>
          ) : (
            'Create account'
          )}
        </Button>
      </form>
    </div>
  );
}
