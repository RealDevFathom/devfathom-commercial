'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { cn } from '@/lib/utils';

function formatDay(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function SettingsContent() {
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const isAdmin = session?.user?.role === 'ADMIN';

  return (
    <div className="max-w-2xl space-y-6 animate-fade-in">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1.5 text-[15px]">
          Manage your profile, security, and preferences.
        </p>
      </div>

      {/* Profile */}
      <ProfileSection />

      {/* Password */}
      <PasswordSection />

      {/* Appearance */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10">
              <Palette className="h-3.5 w-3.5 text-violet-500" />
            </div>
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-3">Theme</label>
            <div className="flex gap-3">
              {(
                [
                  { value: 'light', label: 'Light', icon: Sun },
                  { value: 'dark', label: 'Dark', icon: Moon },
                  { value: 'system', label: 'System', icon: Monitor },
                ] as const
              ).map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={cn(
                    'flex flex-1 flex-col items-center gap-2 rounded-xl border p-4 transition-all',
                    theme === t.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border bg-card hover:border-border hover:bg-secondary/30'
                  )}
                >
                  <t.icon
                    className={cn(
                      'h-5 w-5',
                      theme === t.value ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                  <span
                    className={cn(
                      'text-xs font-medium',
                      theme === t.value ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* API Tokens (admin only) */}
      {isAdmin && <ApiTokensSection />}

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

function ProfileSection() {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const { data: profile } = trpc.team.getById.useQuery(
    { id: session?.user?.id ?? '' },
    { enabled: !!session?.user?.id }
  );

  const updateProfile = trpc.team.updateProfile.useMutation({
    onSuccess: () => {
      utils.team.getById.invalidate();
      setEditing(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    },
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [success, setSuccess] = useState(false);

  const startEdit = () => {
    if (!profile) return;
    setName(profile.name);
    setPhone(profile.phone || '');
    setBio(profile.bio || '');
    setSkills(profile.skills);
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
              className="text-xs font-medium text-primary hover:underline"
            >
              Edit
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
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
                <label className="block text-xs font-medium text-foreground mb-1">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Phone</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Skills</label>
              <div className="flex gap-2">
                <input
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
    if (newPw.length < 8) {
      setError('Password must be at least 8 characters');
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

function ApiTokensSection() {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const { data: tokens } = trpc.apiTokens.list.useQuery();
  const { data: team } = trpc.team.getAll.useQuery();
  const createToken = trpc.apiTokens.create.useMutation({
    onSuccess: (result) => {
      utils.apiTokens.list.invalidate();
      setNewToken(result.token);
      setNewTokenBoundUser(result.boundUser?.name ?? null);
      setName('');
      setSelectedScopes(['*']);
      setBoundUserId('');
    },
  });
  const revokeToken = trpc.apiTokens.revoke.useMutation({
    onSuccess: () => utils.apiTokens.list.invalidate(),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['*']);
  const [boundUserId, setBoundUserId] = useState<string>('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newTokenBoundUser, setNewTokenBoundUser] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
                </div>
                <button
                  onClick={() => revokeToken.mutate({ id: t.id })}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10 transition-all"
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
        {showCreate ? (
          <div className="rounded-xl border border-primary/20 bg-card p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Token Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Shehroz · Claude Code"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Token acts as
                </label>
                <select
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
              <label className="block text-xs font-medium text-foreground mb-1.5">Scopes</label>
              <div className="flex flex-wrap gap-1.5">
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
                    setShowCreate(false);
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
            onClick={() => setShowCreate(true)}
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
          Submitting a resignation sends a request to HR for review. It is not final until
          approved.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === 'PENDING' && latest && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  Resignation pending review
                </p>
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
