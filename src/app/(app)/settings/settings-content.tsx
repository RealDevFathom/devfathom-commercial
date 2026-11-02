'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { signOutEverything } from '@/lib/auth/sign-out';
import { toast } from 'sonner';
import { useTheme } from '@/components/theme-provider';
import Link from 'next/link';
import {
  User,
  Lock,
  Palette,
  Save,
  Loader2,
  X,
  Check,
  Moon,
  Sun,
  Monitor,
  Key,
  Plus,
  Trash2,
  Copy,
  ExternalLink,
  AlertCircle,
  LogOut,
  Bell,
  Webhook,
  ChevronDown,
  History,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import { PrintRoutingSection } from '@/components/restaurant/print-routing-section';
export { PrintRoutingSection };
import { useEntitlements } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import {
  usePreferences,
  type Density,
  type TypeScale,
  type Accent,
  type Layout,
  type Icons,
} from '@/components/preferences-provider';
import { passwordRules, passwordMeetsPolicy } from '@/lib/password-policy';
import type {
  NotificationPrefs,
  NotificationCategory,
  NotificationChannel,
} from '@/lib/notifications';

function formatDay(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

type UiError = { message?: string; data?: { code?: string } | null };
type EntitlementModule = EntitlementView['modules'][number] | undefined;

function readableError(error: UiError, forbiddenFallback: string, fallback: string) {
  return error.data?.code === 'FORBIDDEN' ? error.message || forbiddenFallback : fallback;
}

function disabledModuleMessage(module: EntitlementModule, key: 'api' | 'webhooks') {
  if (module?.source === 'NONE') {
    return 'This feature is not included in your organization’s current plan. Contact your administrator or DevFathom sales to enable it.';
  }
  if (module?.source === 'OVERRIDE') {
    return key === 'api'
      ? 'API access is disabled for this organization. Existing tokens cannot authenticate, and new tokens cannot be created. Contact your platform administrator to enable it.'
      : 'Webhooks are disabled for this organization. Deliveries are paused, and new endpoints cannot be added. Events produced while disabled are not replayed.';
  }
  return key === 'api'
    ? 'API access is currently unavailable for this organization. Contact your administrator for assistance.'
    : 'Webhooks are currently unavailable for this organization. Contact your administrator for assistance.';
}

/** Print routing configures restaurant KOT/KDS/receipt printers; other verticals never see it. */
export function RestaurantPrintRoutingSection() {
  const { vertical } = useEntitlements();
  return vertical === 'RESTAURANT' ? <PrintRoutingSection /> : null;
}

export function SettingsContent() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';

  return (
    <div className="min-w-0 w-full space-y-6">
      <PageHeader
        eyebrow="WORKSPACE"
        heading="Settings"
        description="Manage your profile, security, and preferences."
      />

      {/* Profile */}
      <ProfileSection />

      {/* Password */}
      <PasswordSection />

      {/* Two-factor authentication (IMP-AUTH-02) */}
      <TwoFactorSection />

      {/* Recent sign-ins (IMP-AUTH-03 — visibility half) */}
      <RecentSignInsSection />

      {/* Notification preferences (IMP-AUTH-04) */}
      <NotificationsSection />

      {/* Appearance */}
      <AppearanceSection />

      {/* API Tokens (admin only) */}
      {isAdmin && <ApiTokensSection />}

      {/* Outbound webhooks (admin only, IMP-REST-03) */}
      {isAdmin && <WebhooksSection />}

      {/* Branch routing for authenticated print bridges (restaurant vertical only). */}
      {isAdmin && <RestaurantPrintRoutingSection />}

      <ReceiptDesignerLink />

      {/* Account info */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold text-foreground">Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Email
              </p>
              <p className="text-foreground font-mono text-xs">{session?.user?.email}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Role
              </p>
              <p className="text-foreground">{session?.user?.role}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Department
              </p>
              <p className="text-foreground">{session?.user?.department}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Title
              </p>
              <p className="text-foreground">{session?.user?.title}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Leave the company */}
      <ResignationSection />
    </div>
  );
}

// The receipt designer edits restaurant branch layouts; fail closed for every other vertical.
export function ReceiptDesignerLink() {
  if (useEntitlements().vertical !== 'RESTAURANT') return null;
  return (
    <Link
      href="/settings/receipts"
      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Receipt designer and layout settings
    </Link>
  );
}

/* ============================================================
   Appearance — "The Sounding" design revamp (spec §6)
   Theme (ThemeProvider) + the five configurable surface toggles
   (density / type / accent / layout / icons via usePreferences).
   ============================================================ */
type SegmentOption<T extends string> = {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
};

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  'aria-label'?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-0.5 rounded-xl border border-border bg-background p-0.5"
    >
      {options.map((opt) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PreferenceRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { density, type, accent, layout, icons, setPreference } = usePreferences();
  // Best-effort, non-blocking mirror to the user record so prefs follow the
  // account. localStorage (via PreferencesProvider) is the source of truth, so
  // we deliberately neither await nor surface errors from this write.
  const persist = trpc.dashboard.updateAppearance.useMutation();

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10">
            <Palette className="h-3.5 w-3.5 text-violet-500" />
          </div>
          Appearance
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Personalize the workspace. Changes apply instantly and are remembered on this device.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <PreferenceRow label="Theme" description="Light or dark surfaces.">
          <SegmentedControl
            aria-label="Theme"
            value={theme === 'dark' ? 'dark' : 'light'}
            options={[
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
            ]}
            onChange={(v) => setTheme(v)}
          />
        </PreferenceRow>

        <PreferenceRow
          label="Density"
          description="Comfortable spacing or a tighter, compact layout."
        >
          <SegmentedControl<Density>
            aria-label="Density"
            value={density}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'compact', label: 'Compact' },
            ]}
            onChange={(v) => {
              setPreference('density', v);
              persist.mutate({ density: v });
            }}
          />
        </PreferenceRow>

        <PreferenceRow label="Type scale" description="Overall text size across the app.">
          <SegmentedControl<TypeScale>
            aria-label="Type scale"
            value={type}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'lg', label: 'Large' },
            ]}
            onChange={(v) => {
              setPreference('type', v);
              persist.mutate({ type: v });
            }}
          />
        </PreferenceRow>

        <PreferenceRow label="Accent" description="How much brass the interface uses.">
          <SegmentedControl<Accent>
            aria-label="Accent"
            value={accent}
            options={[
              { value: 'quiet', label: 'Quiet' },
              { value: 'bold', label: 'Bold' },
            ]}
            onChange={(v) => {
              setPreference('accent', v);
              persist.mutate({ accent: v });
            }}
          />
        </PreferenceRow>

        <PreferenceRow
          label="Navigation layout"
          description="A left side rail or a top navigation bar."
        >
          <SegmentedControl<Layout>
            aria-label="Navigation layout"
            value={layout}
            options={[
              { value: 'rail', label: 'Side rail' },
              { value: 'top', label: 'Top nav' },
            ]}
            onChange={(v) => {
              setPreference('layout', v);
              persist.mutate({ layout: v });
            }}
          />
        </PreferenceRow>

        <PreferenceRow label="Nav icons" description="Numbered indices or architectural icons.">
          <SegmentedControl<Icons>
            aria-label="Nav icons"
            value={icons}
            options={[
              { value: 'numeric', label: 'Numbered' },
              { value: 'architectural', label: 'Icons' },
            ]}
            onChange={(v) => {
              setPreference('icons', v);
              persist.mutate({ icons: v });
            }}
          />
        </PreferenceRow>
      </CardContent>
    </Card>
  );
}

export function ProfileSection() {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const {
    data: profile,
    error: profileError,
    isLoading: profileLoading,
  } = trpc.team.getById.useQuery({ id: session?.user?.id ?? '' }, { enabled: !!session?.user?.id });

  const updateProfile = trpc.team.updateProfile.useMutation({
    onSuccess: () => {
      utils.team.getById.invalidate();
      setEditing(false);
      setError('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    },
    // A refused save stays visible on the open form; it is never a silent no-op.
    onError: (err) => setError(err.message),
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  // Edit opens only once the profile has loaded; until then the button says why
  // it is unavailable instead of doing nothing.
  const canEdit = Boolean(profile);
  const startEdit = () => {
    if (!profile) return;
    setName(profile.name);
    setPhone(profile.phone || '');
    setBio(profile.bio || '');
    setSkills(profile.skills);
    setError('');
    setEditing(true);
  };

  const handleSave = () => {
    updateProfile.mutate({
      name: name.trim() || undefined,
      phone: phone || null,
      bio: bio || null,
      skills,
    });
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              <User className="h-3.5 w-3.5 text-primary" />
            </div>
            Profile
          </CardTitle>
          {!editing && (
            <button
              onClick={startEdit}
              disabled={!canEdit}
              aria-disabled={!canEdit}
              title={
                profileError
                  ? 'Your profile could not be loaded.'
                  : profileLoading
                    ? 'Loading your profile…'
                    : undefined
              }
              className="text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
            >
              Edit
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {profileError && !editing && (
          <p
            role="alert"
            className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            Your profile could not be loaded, so it cannot be edited yet. {profileError.message}
          </p>
        )}
        {!editing ? (
          <div className="flex items-start gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={session?.user?.image ?? undefined} />
              <AvatarFallback className="bg-secondary text-foreground font-bold text-xl">
                {session?.user?.name
                  ?.split(' ')
                  .map((n) => n[0])
                  .join('')}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-base font-semibold text-foreground">
                {profile?.name || session?.user?.name}
              </p>
              <p className="text-sm text-muted-foreground">{profile?.title}</p>
              {profile?.phone && (
                <p className="text-sm text-muted-foreground mt-1">{profile.phone}</p>
              )}
              {profile?.bio && (
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{profile.bio}</p>
              )}
              {profile?.skills && profile.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {profile.skills.map((s) => (
                    <span
                      key={s}
                      className="rounded-lg bg-secondary px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
              {success && (
                <p className="text-xs text-emerald-500 mt-2 flex items-center gap-1">
                  <Check className="h-3 w-3" />
                  Profile updated
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="profile-name"
                  className="block text-xs font-medium text-foreground mb-1"
                >
                  Name
                </label>
                <input
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label
                  htmlFor="profile-phone"
                  className="block text-xs font-medium text-foreground mb-1"
                >
                  Phone
                </label>
                <input
                  id="profile-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="profile-bio"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Bio
              </label>
              <textarea
                id="profile-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label
                htmlFor="profile-skills"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Skills
              </label>
              <div className="flex gap-2">
                <input
                  id="profile-skills"
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (skillInput.trim() && !skills.includes(skillInput.trim())) {
                        setSkills([...skills, skillInput.trim()]);
                        setSkillInput('');
                      }
                    }
                  }}
                  placeholder="Add skill..."
                  className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>
              {skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {skills.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      {s}
                      <button
                        onClick={() => setSkills(skills.filter((sk) => sk !== s))}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Your profile was not saved. {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditing(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateProfile.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {updateProfile.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordSection() {
  const changePassword = trpc.team.changePassword.useMutation({
    onSuccess: () => {
      setCurrent('');
      setNewPw('');
      setConfirm('');
      setSuccess(true);
      setError('');
      setTimeout(() => setSuccess(false), 3000);
    },
    onError: (err) => setError(err.message),
  });

  // IMP-AUTH-03: revoke every other session, then sign this device out too.
  const signOutEverywhere = trpc.team.signOutEverywhere.useMutation({
    onSuccess: () => void signOutEverything(),
  });

  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = () => {
    setError('');
    if (newPw !== confirm) {
      setError('Passwords do not match');
      return;
    }
    // IMP-AUTH-05: enforce the SHARED policy client-side (matches the server +
    // the invite flow), not just a length check, so the two can't drift.
    if (!passwordMeetsPolicy(newPw)) {
      setError('Password does not meet all the requirements below.');
      return;
    }
    changePassword.mutate({ currentPassword: current, newPassword: newPw });
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10">
            <Lock className="h-3.5 w-3.5 text-amber-500" />
          </div>
          Password
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-red-500 rounded-lg bg-red-500/10 px-3 py-2">{error}</p>
        )}
        {success && (
          <p className="text-sm text-emerald-500 rounded-lg bg-emerald-500/10 px-3 py-2 flex items-center gap-1">
            <Check className="h-3.5 w-3.5" />
            Password changed successfully
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              Current Password
            </label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">New Password</label>
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Confirm</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
        {/* IMP-AUTH-05: live password-policy checklist (shared passwordRules). */}
        {newPw.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
            {passwordRules.map((rule) => {
              const ok = rule.test(newPw);
              return (
                <li
                  key={rule.id}
                  className={cn(
                    'flex items-center gap-1.5 text-[11px]',
                    ok ? 'text-emerald-500' : 'text-muted-foreground'
                  )}
                >
                  <Check className={cn('h-3 w-3', ok ? 'opacity-100' : 'opacity-30')} />
                  {rule.label}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={!current || !newPw || !confirm || changePassword.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            {changePassword.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Change Password
          </button>
        </div>

        {/* IMP-AUTH-03: cross-device session kill switch. */}
        <div className="flex items-center justify-between border-t border-border/60 pt-4">
          <div>
            <p className="text-xs font-medium text-foreground">Sign out everywhere</p>
            <p className="text-[11px] text-muted-foreground">
              Revoke all sessions on every device. Use this if you suspect your account is
              compromised.
            </p>
          </div>
          <button
            onClick={() => signOutEverywhere.mutate()}
            disabled={signOutEverywhere.isPending}
            className="shrink-0 rounded-xl border border-border px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
          >
            {signOutEverywhere.isPending ? 'Signing out…' : 'Sign out everywhere'}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================================================
   Recent sign-ins (IMP-AUTH-03 — visibility half)
   Surfaces the caller's own successful LOGIN rows from the audit trail.
   Auth is stateless JWT, so individual sessions can't be enumerated or
   revoked one-by-one — "Sign out everywhere" (Password section) is the only
   kill switch. This card is the matching visibility view.
   ============================================================ */

// Best-effort, dependency-free user-agent summary. Order matters: Edge and
// Chrome UAs both contain "Safari", and Edge contains "Chrome", so the more
// specific brands are checked first. Falls back to a trimmed raw UA so a row
// never renders blank.
function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;
}

function RecentSignInsSection() {
  const { data: signIns, isLoading } = trpc.team.mySignIns.useQuery();

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/10">
            <History className="h-3.5 w-3.5 text-indigo-500" />
          </div>
          Recent sign-ins
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Your latest successful sign-ins. Individual sessions can&apos;t be listed or revoked
          one-by-one — use <span className="font-medium text-foreground">Sign out everywhere</span>{' '}
          in the Password section to revoke them all.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading sign-ins…
          </div>
        ) : signIns && signIns.length > 0 ? (
          <div className="divide-y divide-border/60">
            {signIns.map((s) => (
              <div key={s.id} className="flex items-center gap-3 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {parseUserAgent(s.userAgent)}
                  </p>
                  <p className="text-[11px] font-mono text-muted-foreground">
                    {s.ip ?? 'Unknown IP'}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
                  {formatDeliveryTime(s.createdAt)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No recent sign-ins recorded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   Notification preferences (IMP-AUTH-04)
   Per-category × per-channel opt-outs. Honored by notify().
   ============================================================ */
const NOTIFICATION_SETTINGS: ReadonlyArray<{
  key: NotificationCategory;
  label: string;
  desc: string;
}> = [
  { key: 'task', label: 'Tasks', desc: 'Task assignments and updates' },
  { key: 'mention', label: 'Mentions', desc: 'When someone @mentions you in chat' },
  { key: 'meeting', label: 'Meetings', desc: 'Meeting invites' },
  { key: 'leave', label: 'Time off', desc: 'Decisions on your leave requests' },
  { key: 'invoice', label: 'Invoices', desc: 'Invoice and billing activity' },
  { key: 'project', label: 'Projects', desc: 'Project membership and files' },
  { key: 'client', label: 'Clients', desc: 'Client and contract changes' },
  { key: 'resignation', label: 'Resignations', desc: 'Resignation submissions and decisions' },
  { key: 'note', label: 'Notes', desc: 'When a note is shared with you' },
];

function NotificationsSection() {
  const utils = trpc.useUtils();
  const { data: prefs, isLoading } = trpc.team.getNotificationPrefs.useQuery();

  const update = trpc.team.updateNotificationPrefs.useMutation({
    // Optimistic: flip the cell in cache immediately, roll back on error,
    // and reconcile with the server afterwards.
    onMutate: async (next) => {
      await utils.team.getNotificationPrefs.cancel();
      const prev = utils.team.getNotificationPrefs.getData();
      utils.team.getNotificationPrefs.setData(undefined, next as NotificationPrefs);
      return { prev };
    },
    onError: (_err, _next, context) => {
      utils.team.getNotificationPrefs.setData(undefined, context?.prev ?? null);
    },
    onSettled: () => {
      utils.team.getNotificationPrefs.invalidate();
    },
  });

  // Unset / non-false = enabled (notify() defaults everything ON).
  const isOn = (cat: NotificationCategory, ch: NotificationChannel) => prefs?.[cat]?.[ch] !== false;

  const toggle = (cat: NotificationCategory, ch: NotificationChannel, value: boolean) => {
    // Build a full explicit matrix from current state, then flip one cell, so
    // the persisted blob is self-contained and unambiguous.
    const next = {} as Record<NotificationCategory, { inApp: boolean; email: boolean }>;
    for (const s of NOTIFICATION_SETTINGS) {
      next[s.key] = { inApp: isOn(s.key, 'inApp'), email: isOn(s.key, 'email') };
    }
    next[cat][ch] = value;
    update.mutate(next);
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/10">
            <Bell className="h-3.5 w-3.5 text-sky-500" />
          </div>
          Notifications
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Choose how you&apos;re notified. Turn off in-app or email for any category.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading preferences…
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {/* Column headers */}
            <div className="flex items-center gap-4 pb-2">
              <div className="flex-1" />
              <span className="w-12 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                In-app
              </span>
              <span className="w-12 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Email
              </span>
            </div>
            {NOTIFICATION_SETTINGS.map((s) => (
              <div key={s.key} className="flex items-center gap-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{s.label}</p>
                  <p className="text-[11px] text-muted-foreground">{s.desc}</p>
                </div>
                <div className="flex w-12 justify-center">
                  <Switch
                    size="sm"
                    checked={isOn(s.key, 'inApp')}
                    onCheckedChange={(v) => toggle(s.key, 'inApp', v)}
                  />
                </div>
                <div className="flex w-12 justify-center">
                  <Switch
                    size="sm"
                    checked={isOn(s.key, 'email')}
                    onCheckedChange={(v) => toggle(s.key, 'email', v)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TwoFactorSection() {
  const utils = trpc.useUtils();
  const status = trpc.twoFactor.getStatus.useQuery();
  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [error, setError] = useState('');

  const begin = trpc.twoFactor.beginEnrollment.useMutation({
    onSuccess: (d) => {
      setEnrolling(d);
      setError('');
    },
    onError: (e) => setError(e.message),
  });
  const confirm = trpc.twoFactor.confirmEnrollment.useMutation({
    onSuccess: (d) => {
      setRecoveryCodes(d.recoveryCodes);
      setEnrolling(null);
      setCode('');
      setError('');
      utils.twoFactor.getStatus.invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const disable = trpc.twoFactor.disable.useMutation({
    onSuccess: () => {
      setDisableOpen(false);
      setDisableCode('');
      setError('');
      utils.twoFactor.getStatus.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const enabled = status.data?.enabled;

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10">
            <Lock className="h-3.5 w-3.5 text-emerald-500" />
          </div>
          Two-Factor Authentication
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Require a time-based code from an authenticator app at sign-in.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-red-500 rounded-lg bg-red-500/10 px-3 py-2">{error}</p>
        )}

        {/* One-time recovery codes after enabling — shown once. */}
        {recoveryCodes && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
            <p className="text-sm font-semibold text-foreground">Save your recovery codes</p>
            <p className="text-xs text-muted-foreground">
              Each code works once if you lose your authenticator. They won&apos;t be shown again.
            </p>
            <div className="grid grid-cols-2 gap-1.5 font-mono text-xs">
              {recoveryCodes.map((c) => (
                <code
                  key={c}
                  className="rounded bg-background border border-border px-2 py-1 text-foreground"
                >
                  {c}
                </code>
              ))}
            </div>
            <button
              onClick={() => setRecoveryCodes(null)}
              className="mt-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0C2E2C]"
            >
              I&apos;ve saved them
            </button>
          </div>
        )}

        {enabled && !recoveryCodes ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <Check className="h-4 w-4" /> Two-factor authentication is on.
            </p>
            {disableOpen ? (
              <div className="flex items-center gap-2">
                <input
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  placeholder="Code"
                  className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
                />
                <button
                  onClick={() => disable.mutate({ token: disableCode })}
                  disabled={!disableCode || disable.isPending}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                >
                  Disable
                </button>
                <button
                  onClick={() => setDisableOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDisableOpen(true)}
                className="shrink-0 rounded-xl border border-border px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
              >
                Disable
              </button>
            )}
          </div>
        ) : enrolling ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Add this account to your authenticator app — scan the URI or enter the key manually —
              then enter the 6-digit code to confirm.
            </p>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                Setup key
              </p>
              <code className="block break-all rounded-lg bg-background border border-border px-3 py-2 text-xs font-mono text-foreground">
                {enrolling.secret}
              </code>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">otpauth:// URI</summary>
              <code className="mt-1 block break-all rounded-lg bg-background border border-border px-3 py-2 font-mono text-foreground">
                {enrolling.otpauthUri}
              </code>
            </details>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => confirm.mutate({ token: code })}
                disabled={code.length < 6 || confirm.isPending}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-50"
              >
                {confirm.isPending ? 'Verifying…' : 'Verify & enable'}
              </button>
              <button
                onClick={() => setEnrolling(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          !recoveryCodes && (
            <button
              onClick={() => begin.mutate()}
              disabled={begin.isPending}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-50"
            >
              {begin.isPending ? 'Starting…' : 'Enable two-factor authentication'}
            </button>
          )
        )}
      </CardContent>
    </Card>
  );
}

const AVAILABLE_SCOPES = [
  { value: '*', label: 'Full Access' },
  { value: 'tasks:read', label: 'Tasks (read)' },
  { value: 'tasks:write', label: 'Tasks (write)' },
  { value: 'projects:read', label: 'Projects (read)' },
  { value: 'projects:write', label: 'Projects (write)' },
  { value: 'clients:read', label: 'Clients (read)' },
  { value: 'clients:write', label: 'Clients (write)' },
  { value: 'team:read', label: 'Team (read)' },
  { value: 'finance:read', label: 'Finance (read)' },
  { value: 'finance:write', label: 'Finance (write)' },
  { value: 'meetings:read', label: 'Meetings (read)' },
  { value: 'meetings:write', label: 'Meetings (write)' },
];

export function ApiTokensSection() {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const apiModule = entitlements.modules.find((module) => module.key === 'api');
  const apiEnabled = apiModule?.enabled ?? entitlements.enabledModules.includes('api');
  const noticeId = 'api-entitlement-notice';
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['*']);
  const [boundUserId, setBoundUserId] = useState<string>('');
  const [formError, setFormError] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newTokenBoundUser, setNewTokenBoundUser] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const tokensQuery = trpc.apiTokens.list.useQuery();
  const usageQuery = trpc.apiTokens.usage.useQuery(); // IMP-REST-01
  const teamQuery = trpc.team.getAll.useQuery(undefined, {
    enabled: apiEnabled && showCreate,
  });
  const { data: tokens } = tokensQuery;
  const { data: usage } = usageQuery;
  const { data: team } = teamQuery;
  const createToken = trpc.apiTokens.create.useMutation({
    onSuccess: (result) => {
      utils.apiTokens.list.invalidate();
      setNewToken(result.token);
      setNewTokenBoundUser(result.boundUser?.name ?? null);
      setShowCreate(false);
      setName('');
      setSelectedScopes(['*']);
      setBoundUserId('');
      setFormError('');
    },
    onError: (error) => {
      const message = readableError(
        error,
        'API access is disabled for this organization.',
        'The token could not be created. Please try again.'
      );
      setFormError(message);
      toast.error(message);
    },
  });
  const revokeToken = trpc.apiTokens.revoke.useMutation({
    onSuccess: () => utils.apiTokens.list.invalidate(),
    onError: (error) =>
      toast.error(
        readableError(
          error,
          'API access is disabled for this organization.',
          'The token could not be revoked. Please try again.'
        )
      ),
  });

  // Smart scope gating: if the token is bound to a non-admin user, hide
  // finance scopes by default. Admin can still enable them manually.
  const selectedUser = team?.find((u) => u.id === boundUserId);
  const isEmployeeBinding = !!selectedUser && selectedUser.role !== 'ADMIN';

  const handleCopy = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
              <Key className="h-3.5 w-3.5 text-blue-500" />
            </div>
            API Tokens
            {!apiEnabled && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                <Lock className="h-3 w-3" aria-hidden="true" /> Disabled
              </span>
            )}
          </CardTitle>
          <Link
            href="/api-docs"
            target="_blank"
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> API Docs
          </Link>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Use these tokens to access DevFathom from external tools, scripts, or AI assistants.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!apiEnabled && (
          <div
            id={noticeId}
            className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-foreground"
          >
            <Lock
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <p>{disabledModuleMessage(apiModule, 'api')}</p>
          </div>
        )}

        {tokensQuery.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {readableError(
              tokensQuery.error,
              'API access is disabled for this organization.',
              'API tokens could not be loaded. Please try again.'
            )}
          </p>
        )}
        {usageQuery.error && !tokensQuery.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            Token usage could not be loaded. Please try again.
          </p>
        )}

        {/* Newly created token */}
        {newToken && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">Token created — save it now</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This is the only time you&apos;ll see the full token.
                  {newTokenBoundUser && (
                    <>
                      {' '}
                      It will act on behalf of{' '}
                      <span className="font-semibold text-foreground">{newTokenBoundUser}</span>.
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={() => {
                  setNewToken(null);
                  setNewTokenBoundUser(null);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-background border border-border px-3 py-2 text-xs font-mono text-foreground break-all">
                {newToken}
              </code>
              <button
                onClick={handleCopy}
                className="flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-[#0C2E2C] transition-colors"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Token list */}
        {tokens && tokens.length > 0 ? (
          <div className="divide-y divide-border/60">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-3 group">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <Key className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                    <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary shrink-0">
                      acts as {t.user.name}
                    </span>
                    {!apiEnabled && (
                      <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                        Blocked
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] font-mono text-muted-foreground">{t.prefix}...</p>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {t.scopes.slice(0, 4).map((s) => (
                      <span
                        key={s}
                        className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                    {t.scopes.length > 4 && (
                      <span className="text-[9px] text-muted-foreground">
                        +{t.scopes.length - 4}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] text-muted-foreground">
                    {t.lastUsedAt
                      ? `Used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : 'Never used'}
                  </p>
                  {/* IMP-REST-01: per-token request metrics from the audit trail. */}
                  {usage?.[t.id] ? (
                    <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {usage[t.id].total.toLocaleString()} req
                      {usage[t.id].failure > 0 && (
                        <span className="text-red-500"> · {usage[t.id].failure} failed</span>
                      )}
                      {usage[t.id].last7d > 0 && (
                        <span className="text-muted-foreground/70">
                          {' '}
                          · {usage[t.id].last7d} in 7d
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/60">
                      0 req
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => revokeToken.mutate({ id: t.id })}
                  disabled={revokeToken.isPending}
                  aria-label={`Revoke ${t.name}`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 focus-visible:text-red-500 disabled:opacity-50 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">No API tokens yet</p>
        )}

        {/* Create form */}
        {!apiEnabled ? (
          <button
            type="button"
            disabled
            aria-describedby={noticeId}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 py-2 text-xs font-medium text-muted-foreground disabled:cursor-not-allowed"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> API access disabled
          </button>
        ) : showCreate ? (
          <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-3">
            {formError && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {formError}
              </p>
            )}
            {teamQuery.error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                Team members could not be loaded. You can still create a token for yourself.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="api-token-name"
                  className="block text-xs font-medium text-foreground mb-1"
                >
                  Token Name
                </label>
                <input
                  id="api-token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Shehroz · Claude Code"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label
                  htmlFor="api-token-user"
                  className="block text-xs font-medium text-foreground mb-1"
                >
                  Token acts as
                </label>
                <select
                  id="api-token-user"
                  value={boundUserId}
                  onChange={(e) => setBoundUserId(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="">Myself ({session?.user?.name})</option>
                  {team
                    ?.filter((u) => u.id !== session?.user?.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                        {u.role === 'ADMIN' ? ' (admin)' : ''}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">
              All changes made with this token will be logged as{' '}
              <span className="font-semibold text-foreground">
                {selectedUser?.name ?? session?.user?.name}
              </span>{' '}
              in activity feeds and stats.
            </p>
            <div>
              <p
                id="api-token-scopes-label"
                className="block text-xs font-medium text-foreground mb-1.5"
              >
                Scopes
              </p>
              <div
                role="group"
                aria-labelledby="api-token-scopes-label"
                className="flex flex-wrap gap-1.5"
              >
                {AVAILABLE_SCOPES.map((s) => {
                  const isFinance = s.value.startsWith('finance:');
                  const isBlocked = isEmployeeBinding && isFinance;
                  return (
                    <button
                      key={s.value}
                      disabled={isBlocked}
                      onClick={() =>
                        setSelectedScopes((prev) =>
                          prev.includes(s.value)
                            ? prev.filter((sc) => sc !== s.value)
                            : [...prev, s.value]
                        )
                      }
                      className={cn(
                        'rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors',
                        selectedScopes.includes(s.value)
                          ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                          : 'bg-secondary text-muted-foreground hover:text-foreground',
                        isBlocked && 'opacity-40 cursor-not-allowed line-through'
                      )}
                      title={
                        isBlocked ? 'Non-admin users cannot be granted finance scopes' : undefined
                      }
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              {isEmployeeBinding && (
                <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-500">
                  Finance scopes are hidden for non-admin users.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowCreate(false);
                  setName('');
                  setSelectedScopes(['*']);
                  setBoundUserId('');
                }}
                className="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (name.trim() && selectedScopes.length > 0) {
                    setFormError('');
                    // Filter out finance scopes if we're binding to a non-admin
                    // (belt-and-suspenders with the server validation)
                    const finalScopes = isEmployeeBinding
                      ? selectedScopes.filter((s) => !s.startsWith('finance:'))
                      : selectedScopes;
                    createToken.mutate({
                      name: name.trim(),
                      scopes: finalScopes,
                      userId: boundUserId || undefined,
                    });
                  }
                }}
                disabled={!name.trim() || selectedScopes.length === 0 || createToken.isPending}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createToken.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Create Token
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => {
              setFormError('');
              setShowCreate(true);
            }}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> New Token
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   Outbound webhooks (IMP-REST-03) — admin only
   Mirrors WEBHOOK_EVENTS in src/lib/webhooks.ts, which is server-only
   (pulls in node:crypto) and therefore can't be imported into this client
   component. Keep the two lists in sync.
   ============================================================ */
const WEBHOOK_EVENT_OPTIONS = [
  { value: 'invoice.paid', label: 'Invoice paid', desc: 'An invoice is fully paid' },
  { value: 'task.created', label: 'Task created', desc: 'A new task is created' },
] as const;

type WebhookListItem = inferRouterOutputs<AppRouter>['webhooks']['list'][number];

function formatDeliveryTime(d: Date | string) {
  return new Date(d).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function WebhooksSection() {
  const utils = trpc.useUtils();
  const entitlements = useEntitlements();
  const webhooksModule = entitlements.modules.find((module) => module.key === 'webhooks');
  const webhooksEnabled =
    webhooksModule?.enabled ?? entitlements.enabledModules.includes('webhooks');
  const noticeId = 'webhooks-entitlement-notice';
  const webhooksQuery = trpc.webhooks.list.useQuery();
  const { data: webhooks } = webhooksQuery;

  const createWebhook = trpc.webhooks.create.useMutation({
    onSuccess: (result) => {
      utils.webhooks.list.invalidate();
      setNewSecret(result.secret);
      setUrl('');
      setSelectedEvents([]);
      setShowCreate(false);
      setError('');
    },
    onError: (e) => {
      const message = readableError(
        e,
        'Webhooks are disabled for this organization.',
        'The webhook could not be created. Please try again.'
      );
      setError(message);
      toast.error(message);
    },
  });
  const updateWebhook = trpc.webhooks.update.useMutation({
    onSuccess: () => utils.webhooks.list.invalidate(),
    onError: (e) =>
      toast.error(
        readableError(
          e,
          'Webhooks are disabled for this organization.',
          'The webhook could not be updated. Please try again.'
        )
      ),
  });
  const deleteWebhook = trpc.webhooks.delete.useMutation({
    onSuccess: () => utils.webhooks.list.invalidate(),
    onError: (e) =>
      toast.error(
        readableError(
          e,
          'Webhooks are disabled for this organization.',
          'The webhook could not be deleted. Please try again.'
        )
      ),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (newSecret) {
      navigator.clipboard.writeText(newSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const toggleEvent = (value: string) =>
    setSelectedEvents((prev) =>
      prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]
    );

  const handleCreate = () => {
    setError('');
    if (!url.trim() || selectedEvents.length === 0) return;
    createWebhook.mutate({
      url: url.trim(),
      events: selectedEvents as ('invoice.paid' | 'task.created')[],
    });
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-fuchsia-500/10">
            <Webhook className="h-3.5 w-3.5 text-fuchsia-500" />
          </div>
          Webhooks
          {!webhooksEnabled && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
              <Lock className="h-3 w-3" aria-hidden="true" /> Disabled
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Send a signed POST to your endpoint when events happen. Verify each request with the{' '}
          <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">
            X-DevFathom-Signature
          </code>{' '}
          HMAC-SHA256 header.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!webhooksEnabled && (
          <div
            id={noticeId}
            className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-foreground"
          >
            <Lock
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <p>{disabledModuleMessage(webhooksModule, 'webhooks')}</p>
          </div>
        )}

        {webhooksQuery.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {readableError(
              webhooksQuery.error,
              'Webhooks are disabled for this organization.',
              'Webhooks could not be loaded. Please try again.'
            )}
          </p>
        )}

        {/* Signing secret — shown exactly once after creation */}
        {newSecret && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">
                  Webhook created — save the signing secret
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This is the only time you&apos;ll see it. Use it to verify the{' '}
                  <code className="text-[10px]">sha256=</code> signature on each delivery.
                </p>
              </div>
              <button
                onClick={() => setNewSecret(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-background border border-border px-3 py-2 text-xs font-mono text-foreground break-all">
                {newSecret}
              </code>
              <button
                onClick={handleCopy}
                className="flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-[#0C2E2C] transition-colors"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Webhook list */}
        {webhooks && webhooks.length > 0 ? (
          <div className="divide-y divide-border/60">
            {webhooks.map((w) => (
              <WebhookRow
                key={w.id}
                webhook={w}
                busy={updateWebhook.isPending || deleteWebhook.isPending}
                moduleEnabled={webhooksEnabled}
                onToggleActive={(active) => updateWebhook.mutate({ id: w.id, active })}
                onDelete={() => deleteWebhook.mutate({ id: w.id })}
              />
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">No webhooks yet</p>
        )}

        {/* Create form */}
        {!webhooksEnabled ? (
          <button
            type="button"
            disabled
            aria-describedby={noticeId}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 py-2 text-xs font-medium text-muted-foreground disabled:cursor-not-allowed"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Webhooks disabled
          </button>
        ) : showCreate ? (
          <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-3">
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            )}
            <div>
              <label
                htmlFor="webhook-url"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Endpoint URL
              </label>
              <input
                id="webhook-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/webhooks/devfathom"
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <p
                id="webhook-events-label"
                className="block text-xs font-medium text-foreground mb-1.5"
              >
                Events
              </p>
              <div
                role="group"
                aria-labelledby="webhook-events-label"
                className="flex flex-col gap-1.5"
              >
                {WEBHOOK_EVENT_OPTIONS.map((evt) => {
                  const on = selectedEvents.includes(evt.value);
                  return (
                    <button
                      key={evt.value}
                      onClick={() => toggleEvent(evt.value)}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                        on
                          ? 'border-primary/30 bg-primary/5'
                          : 'border-border bg-background hover:bg-secondary/40'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 items-center justify-center rounded border',
                          on ? 'border-primary bg-primary text-white' : 'border-border'
                        )}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="flex-1">
                        <span className="block text-xs font-mono font-medium text-foreground">
                          {evt.value}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">{evt.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowCreate(false);
                  setUrl('');
                  setSelectedEvents([]);
                  setError('');
                }}
                className="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!url.trim() || selectedEvents.length === 0 || createWebhook.isPending}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createWebhook.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Create Webhook
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => {
              setError('');
              setShowCreate(true);
            }}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> New Webhook
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function WebhookRow({
  webhook,
  busy,
  moduleEnabled,
  onToggleActive,
  onDelete,
}: {
  webhook: WebhookListItem;
  busy: boolean;
  moduleEnabled: boolean;
  onToggleActive: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const deliveriesQuery = trpc.webhooks.recentDeliveries.useQuery(
    { webhookId: webhook.id },
    { enabled: open }
  );
  const { data: deliveries, isLoading } = deliveriesQuery;

  const latest = webhook.deliveries[0];

  return (
    <div className="py-3 group">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-foreground"
          title="Recent deliveries"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate font-mono">{webhook.url}</p>
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {webhook.events.map((e) => (
              <span
                key={e}
                className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground font-mono"
              >
                {e}
              </span>
            ))}
            <span className="text-[10px] text-muted-foreground/70">
              · {webhook._count.deliveries} deliver
              {webhook._count.deliveries === 1 ? 'y' : 'ies'}
            </span>
            {latest && (
              <span
                className={cn('text-[10px]', latest.success ? 'text-emerald-500' : 'text-red-500')}
              >
                · last {latest.success ? 'OK' : 'failed'}
              </span>
            )}
            {!moduleEnabled && (
              <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                · Paused by organization
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            size="sm"
            checked={webhook.active}
            disabled={busy || !moduleEnabled}
            aria-label={`${webhook.active ? 'Deactivate' : 'Activate'} ${webhook.url}`}
            onCheckedChange={(v) => onToggleActive(v)}
          />
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${webhook.url}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 focus-visible:text-red-500 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 ml-11 rounded-lg border border-border/60 bg-secondary/20 p-2">
          {isLoading ? (
            <p className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading deliveries…
            </p>
          ) : deliveriesQuery.error ? (
            <p role="alert" className="px-1 py-2 text-[11px] text-destructive">
              Delivery history could not be loaded. Please try again.
            </p>
          ) : deliveries && deliveries.length > 0 ? (
            <div className="divide-y divide-border/40">
              {deliveries.map((d) => (
                <div key={d.id} className="flex items-center gap-2 px-1 py-1.5">
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                      d.success
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : 'bg-red-500/15 text-red-500'
                    )}
                  >
                    {d.success ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                  </span>
                  <span className="font-mono text-[10px] text-foreground">{d.event}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {d.statusCode ?? '—'}
                  </span>
                  {d.error && (
                    <span className="truncate text-[10px] text-red-500" title={d.error}>
                      {d.error}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                    {formatDeliveryTime(d.attemptedAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 py-2 text-[11px] text-muted-foreground">No deliveries yet</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Leave the company — employee self-service resignation
   ============================================================ */
function ResignationSection() {
  const utils = trpc.useUtils();
  const { data: resignations } = trpc.resignations.mine.useQuery();
  const [showResign, setShowResign] = useState(false);

  // mine is returned newest-first, so the head is the most recent request.
  const latest = resignations?.[0];
  const status = latest?.status;

  const withdraw = trpc.resignations.withdraw.useMutation({
    onSuccess: () => utils.resignations.mine.invalidate(),
  });

  // A new request can be filed when there's nothing on record, or the most
  // recent one is no longer active (withdrawn or declined).
  const canResign = !latest || status === 'WITHDRAWN' || status === 'DECLINED';

  return (
    <Card className="border-destructive/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-destructive/10">
            <LogOut className="h-3.5 w-3.5 text-destructive" />
          </div>
          Leave the company
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Submitting a resignation sends a request to HR for review. It is not final until approved.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === 'PENDING' && latest && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Resignation pending review</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Proposed last working day: {formatDay(latest.proposedLastDay)}. HR will be in
                  touch.
                </p>
                <p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap leading-relaxed">
                  &ldquo;{latest.reason}&rdquo;
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => withdraw.mutate({ id: latest.id })}
                disabled={withdraw.isPending}
              >
                {withdraw.isPending && <Loader2 className="animate-spin" />}
                {withdraw.isPending ? 'Withdrawing...' : 'Withdraw'}
              </Button>
            </div>
            {withdraw.error && (
              <p className="text-xs text-destructive text-right">{withdraw.error.message}</p>
            )}
          </div>
        )}

        {status === 'APPROVED' && latest && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-500" /> Resignation approved
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Your last working day is{' '}
              <span className="font-medium text-foreground">
                {formatDay(latest.lastWorkingDay ?? latest.proposedLastDay)}
              </span>
              .
            </p>
            {latest.reviewNote && (
              <p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap leading-relaxed">
                Note{latest.reviewedBy ? ` from ${latest.reviewedBy.name}` : ''}: &ldquo;
                {latest.reviewNote}&rdquo;
              </p>
            )}
          </div>
        )}

        {status === 'DECLINED' && latest && (
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <p className="text-sm font-semibold text-foreground">Resignation declined</p>
            {latest.reviewNote ? (
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap leading-relaxed">
                &ldquo;{latest.reviewNote}&rdquo;
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                Your previous request was not approved.
              </p>
            )}
          </div>
        )}

        {canResign ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Considering moving on? You can formally resign here.
            </p>
            <Button variant="destructive" size="sm" onClick={() => setShowResign(true)}>
              <LogOut className="h-3.5 w-3.5" />
              Resign from the company
            </Button>
          </div>
        ) : null}
      </CardContent>

      <ResignDialog open={showResign} onOpenChange={setShowResign} />
    </Card>
  );
}

function ResignDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState('');
  const [lastDay, setLastDay] = useState('');

  const submit = trpc.resignations.submit.useMutation({
    onSuccess: () => {
      utils.resignations.mine.invalidate();
      setReason('');
      setLastDay('');
      onOpenChange(false);
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= 10;
  const dateValid = !!lastDay && lastDay >= today;
  const canSubmit = reasonValid && dateValid && !submit.isPending;

  const reset = () => {
    setReason('');
    setLastDay('');
    submit.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (submit.isPending) return;
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-destructive">
            <LogOut className="h-4 w-4" /> Resign from the company
          </DialogTitle>
          <DialogDescription>
            This sends a resignation request to HR for review. You can withdraw it any time before
            it&apos;s reviewed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Reason <span className="text-destructive">*</span>
            </label>
            <Textarea
              autoFocus
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Let HR know why you're leaving (at least 10 characters)."
              disabled={submit.isPending}
            />
            {reason.length > 0 && !reasonValid && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Please write at least 10 characters.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Proposed last working day <span className="text-destructive">*</span>
            </label>
            <Input
              type="date"
              min={today}
              value={lastDay}
              onChange={(e) => setLastDay(e.target.value)}
              disabled={submit.isPending}
            />
            {lastDay && !dateValid && (
              <p className="mt-1 text-[11px] text-destructive">
                Your last working day can&apos;t be in the past.
              </p>
            )}
          </div>

          {submit.error && <p className="text-xs text-destructive">{submit.error.message}</p>}
        </div>

        <DialogFooter showCloseButton>
          <Button
            variant="destructive"
            onClick={() => {
              if (!canSubmit) return;
              submit.mutate({ reason: trimmed, proposedLastDay: new Date(lastDay) });
            }}
            disabled={!canSubmit}
          >
            {submit.isPending && <Loader2 className="animate-spin" />}
            {submit.isPending ? 'Submitting...' : 'Submit resignation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
