'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch as StudioSwitch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useAssistant } from '@/lib/assistant-store';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { inviteCopyForVertical, type BaseRole } from '@/lib/team/invite-copy';
import { AddMemberModal } from '../team/team-content';

const inputClass =
  'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20';
const labelClass =
  'mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground';

function Card({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-border/70 bg-card shadow-sm', className)}>
      <div className="border-b border-border/60 px-5 py-4">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Status({ value }: { value: string }) {
  const positive = ['ACTIVE', 'READY', 'VERIFIED', 'ENABLED'].includes(value);
  const warning = ['PENDING', 'DRAFT', 'GRACE', 'ONBOARDING', 'INVITED'].includes(value);
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.1em]',
        positive && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        warning && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        !positive && !warning && 'bg-muted text-muted-foreground'
      )}
    >
      {value.replaceAll('_', ' ')}
    </span>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      {children}
    </Button>
  );
}

function formValue(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

export function OrganizationAskFathomSettings() {
  const { data: session, status } = useSession();
  if (
    status !== 'authenticated' ||
    session?.user.role !== 'ADMIN' ||
    !session.user.organizationId
  ) {
    return null;
  }
  return (
    <AskFathomSettingsForm
      key={session.user.organizationId}
      organizationId={session.user.organizationId}
    />
  );
}

function AskFathomSettingsForm({ organizationId }: { organizationId: string }) {
  const utils = trpc.useUtils();
  const settings = trpc.organizationAdmin.askFathomSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const mutation = trpc.organizationAdmin.setAskFathomEnabled.useMutation();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const confirmed =
    settings.data?.organizationId === organizationId && !settings.isError
      ? settings.data.askFathomEnabled
      : null;
  const selected = draft ?? confirmed;

  const save = async () => {
    if (selected === null || confirmed === null || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await mutation.mutateAsync({ askFathomEnabled: selected });
      if (!active.current) return;
      if (result.organizationId !== organizationId) {
        throw new Error('Workspace changed. Reload settings before saving again.');
      }
      // A request started before this save must not overwrite the confirmed flag.
      await utils.organizationAdmin.askFathomSettings.cancel();
      if (!active.current) return;
      utils.organizationAdmin.askFathomSettings.setData(undefined, result);
      const assistant = useAssistant.getState();
      assistant.confirmSettings(result, Math.max(Date.now(), assistant.settingsUpdatedAt + 1));
      setDraft(null);
      setSaved(true);
      void utils.organizationAdmin.askFathomSettings.invalidate();
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : 'Chat settings could not be saved.');
      }
    } finally {
      if (active.current) setSaving(false);
    }
  };

  return (
    <Card
      title="Ask Fathom chat"
      description="Control company access to the Ask Fathom chat assistant."
    >
      <p id="ask-fathom-scope" className="text-sm text-text-body">
        Turning chat off closes Ask Fathom for this company. Reports, Insights, and other enabled
        module AI remain available under their own permissions.
      </p>
      <div className="mt-4 flex min-h-11 flex-wrap items-center gap-4">
        <label htmlFor="ask-fathom-enabled" className="text-sm font-semibold text-text-strong">
          Enable Ask Fathom chat
        </label>
        <StudioSwitch
          id="ask-fathom-enabled"
          checked={selected ?? false}
          onCheckedChange={(checked) => {
            setDraft(checked);
            setSaved(false);
          }}
          disabled={confirmed === null || saving}
          aria-describedby="ask-fathom-scope ask-fathom-status"
          className="motion-reduce:transition-none [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
        />
        <Button
          type="button"
          onClick={() => void save()}
          disabled={confirmed === null || saving || (draft === null && !error)}
          className="min-h-11 motion-reduce:transform-none motion-reduce:transition-none"
        >
          {saving ? 'Saving…' : error ? 'Retry save' : 'Save chat setting'}
        </Button>
      </div>
      <p id="ask-fathom-status" role="status" className="mt-3 text-sm text-text-muted">
        {saving
          ? 'Saving chat setting…'
          : saved
            ? 'Chat setting saved.'
            : confirmed === null
              ? 'Chat availability has not been confirmed.'
              : `Saved setting: chat ${confirmed ? 'on' : 'off'}.${draft !== null ? ' Unsaved change.' : ''}`}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error} Your selection is kept. Retry save.
        </p>
      )}
      {confirmed === null && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm text-text-muted">
            {settings.isFetching
              ? 'Loading chat settings…'
              : 'Chat settings could not be loaded for this workspace.'}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={settings.isFetching}
            onClick={() => void settings.refetch()}
            className="min-h-11"
          >
            Retry settings
          </Button>
        </div>
      )}
    </Card>
  );
}

export function OrganizationAdminContent() {
  const utils = trpc.useUtils();
  const overview = trpc.organizationAdmin.overview.useQuery();
  const [revealedScimToken, setRevealedScimToken] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const refresh = async () => {
    await utils.organizationAdmin.overview.invalidate();
  };
  const success = (message: string) => {
    toast.success(message);
    void refresh();
  };
  const failure = (error: { message: string }) => toast.error(error.message);

  const profile = trpc.organizationAdmin.updateProfile.useMutation({
    onSuccess: () => success('Workspace profile updated.'),
    onError: failure,
  });
  const brand = trpc.organizationAdmin.updateBrand.useMutation({
    onSuccess: () => success('Brand updated.'),
    onError: failure,
  });
  const email = trpc.organizationAdmin.updateEmail.useMutation({
    onSuccess: () => success('Email settings updated.'),
    onError: failure,
  });
  const member = trpc.organizationAdmin.updateMember.useMutation({
    onSuccess: () => success('Member access updated.'),
    onError: failure,
  });
  const addMember = trpc.organizationAdmin.createMember.useMutation({
    onSuccess: () => success('Staff member added.'),
    onError: failure,
  });
  const password = trpc.organizationAdmin.resetMemberPassword.useMutation({
    onSuccess: () => toast.success('Password reset and existing sessions revoked.'),
    onError: failure,
  });
  const role = trpc.organizationAdmin.upsertRole.useMutation({
    onSuccess: () => success('Role saved.'),
    onError: failure,
  });
  const removeRole = trpc.organizationAdmin.removeRole.useMutation({
    onSuccess: () => success('Role removed.'),
    onError: failure,
  });
  const addDomain = trpc.organizationAdmin.addDomain.useMutation({
    onSuccess: () => success('Domain added. Publish the verification TXT record.'),
    onError: failure,
  });
  const retryDomain = trpc.organizationAdmin.retryDomain.useMutation({
    onSuccess: () => success('Domain verification queued.'),
    onError: failure,
  });
  const createScim = trpc.organizationAdmin.createScimToken.useMutation({
    onSuccess: (result) => {
      setRevealedScimToken(result.token);
      success('SCIM token created. Copy it now.');
    },
    onError: failure,
  });
  const revokeScim = trpc.organizationAdmin.revokeScimToken.useMutation({
    onSuccess: () => success('SCIM token revoked.'),
    onError: failure,
  });

  if (overview.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (overview.error || !overview.data) {
    return (
      <Card title="Organization administration">
        <p className="text-sm text-destructive">
          {overview.error?.message ?? 'Organization information is unavailable.'}
        </p>
      </Card>
    );
  }

  const { organization, entitlements, pharmacyBranches } = overview.data;
  // Pharmacy staff join through an emailed invite with a pharmacy role template, never an
  // admin-chosen temporary password; base roles use the pharmacy vocabulary.
  const isPharmacy = organization.vertical === 'PHARMACY';
  const baseRoleLabels = isPharmacy
    ? inviteCopyForVertical('PHARMACY').baseRoleLabels
    : ({ ADMIN: 'ADMIN', HR: 'HR', EMPLOYEE: 'EMPLOYEE' } satisfies Record<BaseRole, string>);
  const createRoleErrors = !role.variables?.id ? role.error?.data?.validation : null;
  const createRoleKeyError = createRoleErrors?.key?.[0];
  const createRolePermissionsError = createRoleErrors?.permissions?.[0];
  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    profile.mutate({
      displayName: formValue(values, 'displayName'),
      timezone: formValue(values, 'timezone'),
      locale: formValue(values, 'locale'),
      primaryContactName: formValue(values, 'primaryContactName') || null,
      primaryContactEmail: formValue(values, 'primaryContactEmail'),
    });
  };
  const submitBrand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    brand.mutate({
      primaryColor: formValue(values, 'primaryColor'),
      accentColor: formValue(values, 'accentColor'),
      logoUrl: formValue(values, 'logoUrl'),
      markUrl: formValue(values, 'markUrl'),
      faviconUrl: formValue(values, 'faviconUrl'),
      supportEmail: formValue(values, 'supportEmail'),
      fromName: formValue(values, 'fromName') || null,
    });
  };
  const submitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    let configuration: Record<string, unknown> = {};
    try {
      configuration = JSON.parse(formValue(values, 'configuration') || '{}') as Record<
        string,
        unknown
      >;
    } catch {
      toast.error('Provider configuration must be valid JSON.');
      return;
    }
    email.mutate({
      provider: formValue(values, 'provider'),
      fromName: formValue(values, 'fromName') || null,
      fromAddress: formValue(values, 'fromAddress'),
      replyTo: formValue(values, 'replyTo'),
      apiKey: formValue(values, 'apiKey') || undefined,
      configuration,
    });
  };

  return (
    <div className="mx-auto max-w-[1320px] space-y-6">
      <PageHeader
        eyebrow="ORGANIZATION CONTROL"
        heading={organization.displayName}
        description="Manage your workspace identity, people, access, and licensed capabilities."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Lifecycle', organization.status],
          ['Deployment', organization.deploymentMode],
          ['Seats', `${entitlements.activeSeats}/${entitlements.seatLimit}`],
          ['Package', organization.package?.name ?? 'Custom'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-border/70 bg-card p-4">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 font-display text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <Card
        title="License and modules"
        description="Your platform operator controls package, contract, seat ceiling, and expiry."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entitlements.modules
            .filter(
              (module) =>
                module.source !== 'NONE' ||
                verticalForModuleKey(module.key) === organization.vertical
            )
            .map((module) => (
              <div key={module.key} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">{module.name}</p>
                  <Status value={module.enabled ? 'ENABLED' : 'DISABLED'} />
                </div>
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                  {module.source}
                  {module.expiresAt
                    ? ` · expires ${new Date(module.expiresAt).toLocaleDateString()}`
                    : ''}
                </p>
              </div>
            ))}
        </div>
      </Card>

      <OrganizationAskFathomSettings />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Workspace profile">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitProfile}>
            <label className="sm:col-span-2">
              <span className={labelClass}>Display name</span>
              <Input name="displayName" defaultValue={organization.displayName} required />
            </label>
            <label>
              <span className={labelClass}>Timezone</span>
              <Input name="timezone" defaultValue={organization.timezone} required />
            </label>
            <label>
              <span className={labelClass}>Locale</span>
              <Input name="locale" defaultValue={organization.locale} required />
            </label>
            <label>
              <span className={labelClass}>Primary contact</span>
              <Input
                name="primaryContactName"
                defaultValue={organization.primaryContactName ?? ''}
              />
            </label>
            <label>
              <span className={labelClass}>Contact email</span>
              <Input
                name="primaryContactEmail"
                type="email"
                defaultValue={organization.primaryContactEmail ?? ''}
              />
            </label>
            <div className="sm:col-span-2">
              <SubmitButton pending={profile.isPending}>Save profile</SubmitButton>
            </div>
          </form>
        </Card>

        <Card title="Workspace brand" description="Applied to this organization’s workspace UI.">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitBrand}>
            <label>
              <span className={labelClass}>Primary</span>
              <input
                className="h-10 w-full rounded-lg border border-border bg-background p-1"
                name="primaryColor"
                type="color"
                defaultValue={organization.brand?.primaryColor ?? '#111110'}
              />
            </label>
            <label>
              <span className={labelClass}>Accent</span>
              <input
                className="h-10 w-full rounded-lg border border-border bg-background p-1"
                name="accentColor"
                type="color"
                defaultValue={organization.brand?.accentColor ?? '#FF684F'}
              />
            </label>
            {[
              ['logoUrl', 'Logo URL'],
              ['markUrl', 'Mark URL'],
              ['faviconUrl', 'Favicon URL'],
              ['supportEmail', 'Support email'],
              ['fromName', 'Sender name'],
            ].map(([name, label]) => (
              <label key={name} className={name === 'fromName' ? '' : 'sm:col-span-2'}>
                <span className={labelClass}>{label}</span>
                <Input
                  name={name}
                  type={name.includes('Url') ? 'url' : name.includes('Email') ? 'email' : 'text'}
                  defaultValue={String(
                    organization.brand?.[name as keyof NonNullable<typeof organization.brand>] ?? ''
                  )}
                />
              </label>
            ))}
            <div className="sm:col-span-2">
              <SubmitButton pending={brand.isPending}>Apply brand</SubmitButton>
            </div>
          </form>
        </Card>
      </div>

      <Card
        title="People and access"
        description={`${entitlements.activeSeats} of ${entitlements.seatLimit} licensed ${entitlements.seatLimit === 1 ? 'seat' : 'seats'} ${entitlements.activeSeats === 1 ? 'is' : 'are'} currently occupied.`}
      >
        {isPharmacy ? (
          <div
            role="group"
            aria-label="Invite pharmacy staff"
            className="mb-5 flex flex-col gap-3 rounded-xl bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-sm font-semibold">Invite pharmacy staff</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Staff receive an email invite, set their own password and get the pharmacy role you
                choose. Once they accept, assign their branches from{' '}
                <Link
                  href="/pharmacy/settings/branches"
                  className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  pharmacy branches
                </Link>
                . Each invite occupies one licensed seat ({entitlements.activeSeats}/
                {entitlements.seatLimit} used).
              </p>
            </div>
            <Button type="button" className="min-h-11 shrink-0" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" /> Invite staff member
            </Button>
          </div>
        ) : (
          <form
            className="mb-5 grid gap-3 rounded-xl bg-muted/35 p-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Add staff member"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const form = event.currentTarget;
              addMember.mutate(
                {
                  name: formValue(values, 'name'),
                  email: formValue(values, 'email'),
                  password: formValue(values, 'password'),
                  title: formValue(values, 'title'),
                  role: formValue(values, 'role') as 'ADMIN' | 'HR' | 'EMPLOYEE',
                  department: formValue(values, 'department'),
                  organizationRoleId: formValue(values, 'organizationRoleId') || null,
                  branchIds: values.getAll('branchId').map(String),
                },
                { onSuccess: () => form.reset() }
              );
            }}
          >
            <p className="text-sm font-semibold sm:col-span-2 lg:col-span-3">Add staff member</p>
            <label>
              <span className={labelClass}>Full name</span>
              <Input name="name" required />
            </label>
            <label>
              <span className={labelClass}>Email</span>
              <Input name="email" type="email" required />
            </label>
            <label>
              <span className={labelClass}>Title</span>
              <Input name="title" placeholder="Cashier" required />
            </label>
            <label>
              <span className={labelClass}>System role</span>
              <select className={inputClass} name="role" defaultValue="EMPLOYEE">
                {['ADMIN', 'HR', 'EMPLOYEE'].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelClass}>Department</span>
              <select className={inputClass} name="department" required>
                {organization.departments.map((department) => (
                  <option key={department.key} value={department.key}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={labelClass}>Role template</span>
              <select className={inputClass} name="organizationRoleId" defaultValue="">
                <option value="">No custom role</option>
                {organization.roles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {pharmacyBranches.length > 0 && (
              <fieldset className="sm:col-span-2 lg:col-span-3">
                <legend className={labelClass}>Pharmacy branches</legend>
                <div className="flex flex-wrap gap-3">
                  {pharmacyBranches.map((branch) => (
                    <label key={branch.id} className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="branchId"
                        value={branch.id}
                        className="size-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      {branch.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="sm:col-span-2 lg:col-span-2">
              <span className={labelClass}>Temporary password</span>
              <Input name="password" type="password" minLength={12} required />
            </label>
            <div className="flex items-end">
              <SubmitButton pending={addMember.isPending}>Add staff</SubmitButton>
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-3">
              12–256 characters, with a lowercase letter, an uppercase letter and a digit. The new
              member occupies one licensed seat ({entitlements.activeSeats}/
              {entitlements.seatLimit} used).
            </p>
          </form>
        )}
        {inviteOpen && (
          <AddMemberModal onClose={() => setInviteOpen(false)} onInvited={() => void refresh()} />
        )}
        <div className="divide-y divide-border/60">
          {organization.users.map((user) => (
            <details key={user.id} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4">
                <div>
                  <p className="text-sm font-semibold">{user.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {user.email} · {user.title}
                  </p>
                </div>
                <Status value={user.status} />
              </summary>
              <div className="grid gap-5 rounded-xl bg-muted/35 p-4 lg:grid-cols-2">
                <form
                  key={`${user.role}:${user.status}:${user.department}:${user.organizationRoleId ?? ''}:${user.title}`}
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const values = new FormData(form);
                    member.mutate(
                      {
                        id: user.id,
                        role: formValue(values, 'role') as 'ADMIN' | 'HR' | 'EMPLOYEE',
                        status: formValue(values, 'status') as
                          | 'ACTIVE'
                          | 'INACTIVE'
                          | 'ON_LEAVE'
                          | 'INVITED',
                        organizationRoleId: formValue(values, 'organizationRoleId') || null,
                        title: formValue(values, 'title'),
                        department: formValue(values, 'department') as
                          | 'LEADERSHIP'
                          | 'ENGINEERING'
                          | 'PRODUCT'
                          | 'QUALITY'
                          | 'MARKETING'
                          | 'DESIGN',
                      },
                      {
                        // Access fields are intentionally uncontrolled so native form reset
                        // semantics remain available. A refused update must put them back to
                        // the last server-confirmed values instead of displaying an unsaved
                        // Goods-in (or other role) grant as if it succeeded.
                        onError: () => form.reset(),
                      }
                    );
                  }}
                >
                  {[
                    ['role', 'System role', ['ADMIN', 'HR', 'EMPLOYEE'], user.role],
                    [
                      'status',
                      'Status',
                      ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'INVITED'],
                      user.status,
                    ],
                  ].map(([name, label, options, value]) => (
                    <label key={String(name)}>
                      <span className={labelClass}>{String(label)}</span>
                      <select
                        className={inputClass}
                        name={String(name)}
                        defaultValue={String(value)}
                      >
                        {(options as string[]).map((option) => (
                          <option key={option} value={option}>
                            {name === 'role' ? baseRoleLabels[option as BaseRole] : option}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    <span className={labelClass}>Department</span>
                    {/* The organization's own departments, not a hardcoded agency
                        list: a pharmacy files staff under Counter, Dispensary, and
                        the rest its vertical defines. */}
                    <select className={inputClass} name="department" defaultValue={user.department}>
                      {organization.departments.map((department) => (
                        <option key={department.key} value={department.key}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className={labelClass}>Custom role</span>
                    <select
                      className={inputClass}
                      name="organizationRoleId"
                      defaultValue={user.organizationRoleId ?? ''}
                    >
                      <option value="">No custom role</option>
                      {organization.roles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="sm:col-span-2">
                    <span className={labelClass}>Title</span>
                    <Input name="title" defaultValue={user.title} required />
                  </label>
                  <SubmitButton pending={member.isPending}>Update access</SubmitButton>
                </form>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    password.mutate({
                      id: user.id,
                      password: formValue(values, 'password'),
                    });
                    event.currentTarget.reset();
                  }}
                >
                  <label>
                    <span className={labelClass}>Temporary password</span>
                    <Input name="password" type="password" minLength={12} required />
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    12–256 characters, with a lowercase letter, an uppercase letter and a digit. All
                    existing sessions are revoked.
                  </p>
                  <SubmitButton pending={password.isPending}>Reset password</SubmitButton>
                </form>
              </div>
            </details>
          ))}
        </div>
      </Card>

      <Card
        title="Custom roles"
        description="Deny rules win. Use exact actions or namespace wildcards."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
          <div className="grid gap-3 sm:grid-cols-2">
            {organization.roles.map((item) => (
              <details key={item.id} className="rounded-xl border border-border/60 p-3">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{item.name}</p>
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {item._count.users} members
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                    {item.permissions
                      .map((permission) => `${permission.effect} ${permission.capability}`)
                      .join(' · ') || 'No rules'}
                  </p>
                </summary>
                <form
                  className="mt-3 space-y-3 border-t border-border/60 pt-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    try {
                      role.mutate({
                        id: item.id,
                        key: formValue(values, 'key'),
                        name: formValue(values, 'name'),
                        description: formValue(values, 'description') || null,
                        permissions: JSON.parse(formValue(values, 'permissions')) as Array<{
                          capability: string;
                          effect: 'ALLOW' | 'DENY';
                        }>,
                      });
                    } catch {
                      toast.error('Permission rules must be valid JSON.');
                    }
                  }}
                >
                  <Input name="key" defaultValue={item.key} aria-label="Role key" required />
                  <Input name="name" defaultValue={item.name} aria-label="Role name" required />
                  <Input
                    name="description"
                    defaultValue={item.description ?? ''}
                    aria-label="Role description"
                  />
                  <textarea
                    className={cn(inputClass, 'min-h-28 py-2 font-mono text-xs')}
                    name="permissions"
                    aria-label="Permission rules"
                    defaultValue={JSON.stringify(
                      item.permissions.map((permission) => ({
                        capability: permission.capability,
                        effect: permission.effect,
                      })),
                      null,
                      2
                    )}
                  />
                  <div className="flex flex-wrap justify-between gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={removeRole.isPending || item.isSystem}
                      onClick={() => {
                        if (window.confirm(`Remove ${item.name}?`)) {
                          removeRole.mutate({ id: item.id });
                        }
                      }}
                    >
                      {item.isSystem ? 'System role' : 'Remove'}
                    </Button>
                    <SubmitButton pending={role.isPending}>Update role</SubmitButton>
                  </div>
                </form>
              </details>
            ))}
          </div>
          <form
            className="space-y-3 rounded-xl bg-muted/35 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              try {
                role.mutate({
                  key: formValue(values, 'key'),
                  name: formValue(values, 'name'),
                  description: formValue(values, 'description') || null,
                  permissions: JSON.parse(formValue(values, 'permissions')) as Array<{
                    capability: string;
                    effect: 'ALLOW' | 'DENY';
                  }>,
                });
              } catch {
                toast.error('Permission rules must be valid JSON.');
              }
            }}
          >
            <label>
              <span className={labelClass}>Role key</span>
              <Input
                name="key"
                placeholder="delivery-lead"
                aria-invalid={Boolean(createRoleKeyError)}
                aria-describedby="create-role-key-help"
                onChange={() => role.reset()}
                required
              />
              <p
                id="create-role-key-help"
                className={cn(
                  'mt-1.5 text-[11px]',
                  createRoleKeyError ? 'text-destructive' : 'text-muted-foreground'
                )}
                role={createRoleKeyError ? 'alert' : undefined}
              >
                {createRoleKeyError ??
                  'Use lowercase letters, numbers, dots, underscores, and hyphens.'}
              </p>
            </label>
            <label>
              <span className={labelClass}>Role name</span>
              <Input name="name" required />
            </label>
            <label>
              <span className={labelClass}>Description</span>
              <Input name="description" />
            </label>
            <label>
              <span className={labelClass}>Permission JSON</span>
              <textarea
                className={cn(inputClass, 'min-h-28 py-2 font-mono text-xs')}
                name="permissions"
                aria-invalid={Boolean(createRolePermissionsError)}
                aria-describedby={
                  createRolePermissionsError ? 'create-role-permissions-error' : undefined
                }
                onChange={() => role.reset()}
                defaultValue={'[{"capability":"projects:*","effect":"ALLOW"}]'}
              />
              {createRolePermissionsError ? (
                <p
                  id="create-role-permissions-error"
                  className="mt-1.5 text-[11px] text-destructive"
                  role="alert"
                >
                  {createRolePermissionsError}
                </p>
              ) : null}
            </label>
            <SubmitButton pending={role.isPending}>Create role</SubmitButton>
          </form>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card
          title="Domains"
          description="Publish the TXT record exactly, then retry verification."
        >
          <div className="space-y-3">
            {organization.domains.map((domain) => (
              <div key={domain.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{domain.host}</p>
                    <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                      _devfathom-verification.{domain.host}
                    </p>
                  </div>
                  <Status value={domain.verificationStatus} />
                </div>
                {domain.verificationStatus !== 'VERIFIED' ? (
                  <>
                    <code className="mt-3 block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-[10px]">
                      {domain.verificationToken}
                    </code>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      disabled={retryDomain.isPending}
                      onClick={() => retryDomain.mutate({ id: domain.id })}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
            <form
              className="grid gap-3 rounded-xl bg-muted/35 p-4 sm:grid-cols-[1fr_120px_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                addDomain.mutate({
                  host: formValue(values, 'host'),
                  kind: formValue(values, 'kind'),
                  isPrimary: values.get('isPrimary') === 'on',
                });
              }}
            >
              <Input name="host" placeholder="hub.example.com" required />
              <Input name="kind" defaultValue="APP" required />
              <SubmitButton pending={addDomain.isPending}>Add</SubmitButton>
              <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-3">
                <input name="isPrimary" type="checkbox" /> Primary workspace domain
              </label>
            </form>
          </div>
        </Card>

        <Card
          title="Identity and SCIM"
          description="Identity connections are configured by the platform team."
        >
          <div className="space-y-3">
            {organization.identityConnections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center justify-between rounded-xl border border-border/60 p-3"
              >
                <div>
                  <p className="text-sm font-semibold">{connection.name}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {connection.protocol} · {connection.enforceSso ? 'enforced' : 'optional'} ·{' '}
                    {connection.allowJit ? 'JIT on' : 'JIT off'}
                  </p>
                </div>
                <Status value={connection.status} />
              </div>
            ))}
            {!organization.identityConnections.length ? (
              <p className="text-xs text-muted-foreground">No enterprise identity connection.</p>
            ) : null}
            {revealedScimToken ? (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs font-semibold">Copy this token now</p>
                <code className="mt-2 block break-all text-[10px]">{revealedScimToken}</code>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(revealedScimToken);
                    toast.success('Token copied.');
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
            ) : null}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                createScim.mutate({ name: formValue(values, 'name'), expiresAt: null });
              }}
            >
              <Input name="name" placeholder="Directory sync" required />
              <Button type="submit" disabled={createScim.isPending}>
                <KeyRound className="h-4 w-4" /> Token
              </Button>
            </form>
            {organization.scimTokens.map((token) => (
              <div key={token.id} className="flex items-center justify-between text-xs">
                <span>
                  {token.name} · <code>{token.prefix}…</code>
                </span>
                {token.revokedAt ? (
                  <Status value="REVOKED" />
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revokeScim.isPending}
                    onClick={() => revokeScim.mutate({ id: token.id })}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Email delivery"
        description="Provider credentials are encrypted and never shown again."
      >
        <form className="grid gap-4 md:grid-cols-2" onSubmit={submitEmail}>
          <label>
            <span className={labelClass}>Provider</span>
            <Input
              name="provider"
              defaultValue={organization.emailSettings?.provider ?? 'PLATFORM'}
            />
          </label>
          <label>
            <span className={labelClass}>Sender name</span>
            <Input name="fromName" defaultValue={organization.emailSettings?.fromName ?? ''} />
          </label>
          <label>
            <span className={labelClass}>From address</span>
            <Input
              name="fromAddress"
              type="email"
              defaultValue={organization.emailSettings?.fromAddress ?? ''}
            />
          </label>
          <label>
            <span className={labelClass}>Reply-to</span>
            <Input
              name="replyTo"
              type="email"
              defaultValue={organization.emailSettings?.replyTo ?? ''}
            />
          </label>
          <label>
            <span className={labelClass}>Provider API key</span>
            <Input
              name="apiKey"
              type="password"
              placeholder={
                organization.emailSettings?.encryptedApiKey ? 'Stored — leave blank to keep' : ''
              }
            />
          </label>
          <label>
            <span className={labelClass}>Provider configuration JSON</span>
            <textarea
              className={cn(inputClass, 'min-h-20 py-2 font-mono text-xs')}
              name="configuration"
              defaultValue={JSON.stringify(
                organization.emailSettings?.configuration ?? {},
                null,
                2
              )}
            />
          </label>
          <div className="md:col-span-2">
            <SubmitButton pending={email.isPending}>Save email settings</SubmitButton>
          </div>
        </form>
      </Card>

      <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-muted/35 p-4 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 text-primary" />
        Lifecycle, contract, module, deployment, and destructive data controls remain
        platform-managed.
      </div>
    </div>
  );
}
