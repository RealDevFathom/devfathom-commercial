'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SIGNIN_ALLOWED_STATUSES } from '@/lib/auth/constants';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

type MemberAccess = inferRouterOutputs<AppRouter>['organizationAdmin']['memberAccess'];
type SubRole = MemberAccess['groups'][number]['subRoles'][number];
type Ticking = MemberAccess['ticking'];

/** What an administrator can do beyond the ticks, by how they are an administrator. */
export const MEMBER_ACCESS_ADMIN_NOTES = {
  full: 'As a workspace administrator, this person can also do things the ticks do not show: act at every branch, close and reopen the day, reset staff PINs and change workspace settings. Where the Pharmacy Finance module is on and they keep finance access, they can also record and pay supplier invoices; reversing one also needs Manage their branches and their own PIN.',
  'access-only':
    'This person has administrator access, so they can also use the workspace settings and the other administrator screens, which the ticks do not show.',
  'role-only':
    'This person is a workspace administrator, so some pharmacy checks let them act at every branch, close and reopen the day, and reset staff PINs, which the ticks do not show.',
} as const;

/** Shown when the screen has no editing information for this person. */
export const MEMBER_ACCESS_READ_ONLY_NOTE = 'You cannot change these ticks.';

/** DEV-959B: how ticking works, shown to someone who may change them. */
export const MEMBER_ACCESS_EDIT_NOTE =
  'Tick or untick to change what this person can do. A change applies from their next action, and every change is recorded with your name.';

/** Why one box cannot be changed by this viewer. */
export const MEMBER_ACCESS_NOT_HELD_NOTE = 'You cannot change this: you cannot do it yourself.';

/** The outcome of a change: why it was refused, or a note about what else it changed. */
export type MemberAccessOutcome = { error: string | null; note: string | null };

/** What the panel calls to change ticks; the server decides and re-checks every rule. */
export type MemberAccessEditor = {
  pending: boolean;
  setSubRole: (input: {
    subRoleKey: string;
    ticked: boolean;
    pin?: string;
  }) => Promise<MemberAccessOutcome>;
  applyRole: (input: { roleKey: string; pin?: string }) => Promise<MemberAccessOutcome>;
};

type Notice = { text: string; error: boolean } | null;

function noticeOf(outcome: MemberAccessOutcome): Notice {
  if (outcome.error) return { text: outcome.error, error: true };
  return outcome.note ? { text: outcome.note, error: false } : null;
}

/** Which boxes this viewer may change: giving needs the sub-role; the owner may take any away. */
function changeable(ticking: Ticking | undefined, subRole: SubRole): boolean {
  if (!ticking?.editing.allowed) return false;
  if (subRole.state === 'off') return ticking.viewerHolds.includes(subRole.key);
  return ticking.viewerIsOwner || ticking.viewerHolds.includes(subRole.key);
}

function roleSummary(member: MemberAccess['member']): string {
  const role = member.roleName
    ? `${member.roleName}${member.customRole ? ' (custom role)' : ''}`
    : 'No pharmacy role';
  if (member.exceptionCount === 0) return role;
  const exceptions = `${member.exceptionCount} personal ${
    member.exceptionCount === 1 ? 'exception' : 'exceptions'
  }`;
  return `${role}, plus ${exceptions}`;
}

/** The one-line warning and the editor's PIN, before a weighty sub-role is given. */
function PinConfirm({
  subRole,
  line,
  pending,
  onConfirm,
  onCancel,
}: {
  subRole: SubRole;
  line: string;
  pending: boolean;
  onConfirm: (pin: string) => Promise<MemberAccessOutcome>;
  onCancel: () => void;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pin = String(new FormData(event.currentTarget).get('pin') ?? '');
    setError((await onConfirm(pin)).error);
  }
  return (
    <form
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-line`}
      className="mt-2 space-y-2 rounded-xs border border-border-subtle bg-surface-sunken p-3"
    >
      <p id={`${id}-title`} className="text-sm font-medium text-foreground">
        Give {subRole.label}?
      </p>
      <p id={`${id}-line`} className="text-sm text-text-muted">
        {line}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1.5 text-sm">
          Your PIN
          <Input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            maxLength={8}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-h-11 w-40"
          />
        </label>
        <Button type="submit" className="min-h-11" disabled={pending}>
          {pending ? 'Saving…' : 'Give it'}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function SubRoleRow({
  subRole,
  ticking,
  editor,
  onChanged,
}: {
  subRole: SubRole;
  ticking?: Ticking;
  editor?: MemberAccessEditor;
  onChanged: (notice: Notice) => void;
}) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const stateLabel =
    subRole.state === 'on' ? 'Allowed' : subRole.state === 'partial' ? 'Partly allowed' : '';
  const editable = Boolean(editor) && changeable(ticking, subRole);
  const weightyLine = ticking?.weighty[subRole.key];
  const personal = ticking?.personal[subRole.key];

  function toggle(checked: boolean) {
    if (!editor || !editable || editor.pending) return;
    if (checked && weightyLine) {
      setConfirming(true);
      return;
    }
    void editor
      .setSubRole({ subRoleKey: subRole.key, ticked: checked })
      .then((outcome) => onChanged(noticeOf(outcome)));
  }

  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        className="mt-0.5"
        checked={subRole.state === 'on'}
        indeterminate={subRole.state === 'partial'}
        disabled={!editable || editor?.pending}
        onCheckedChange={(checked) => toggle(checked)}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p id={`${id}-label`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-foreground">{subRole.label}</span>
          {stateLabel ? <span className="sr-only">{stateLabel}</span> : null}
          {subRole.sensitive ? (
            <span className="eyebrow inline-flex items-center gap-1 text-warning">
              <ShieldAlert className="size-3" aria-hidden />
              Extra care
            </span>
          ) : null}
          {personal ? (
            <span className="eyebrow text-text-muted">
              {personal === 'ALLOW' ? 'Added for this person' : 'Removed for this person'}
            </span>
          ) : null}
        </p>
        <ul
          id={`${id}-description`}
          className="list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-text-muted"
        >
          {subRole.allows.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {ticking?.editing.allowed && !editable ? (
          <p className="text-xs text-text-muted">{MEMBER_ACCESS_NOT_HELD_NOTE}</p>
        ) : null}
        {confirming && editor && weightyLine ? (
          <PinConfirm
            subRole={subRole}
            line={weightyLine}
            pending={editor.pending}
            onCancel={() => setConfirming(false)}
            onConfirm={async (pin) => {
              const outcome = await editor.setSubRole({
                subRoleKey: subRole.key,
                ticked: true,
                pin,
              });
              if (!outcome.error) {
                setConfirming(false);
                onChanged(noticeOf(outcome));
              }
              return outcome;
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

/** Choosing a ready-made role ticks exactly its sub-roles (and clears personal ticks). */
function StartingRole({
  ticking,
  editor,
  onChanged,
}: {
  ticking: Ticking;
  editor: MemberAccessEditor;
  onChanged: (notice: Notice) => void;
}) {
  const id = useId();
  const [roleKey, setRoleKey] = useState(ticking.roleKey ?? '');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roleKey) return;
    const form = event.currentTarget;
    const pin = String(new FormData(form).get('pin') ?? '');
    const outcome = await editor.applyRole({ roleKey, ...(pin ? { pin } : {}) });
    if (!outcome.error) form.reset();
    onChanged(noticeOf(outcome));
  }
  return (
    <form
      onSubmit={submit}
      aria-label="Start from a ready-made role"
      className="flex flex-wrap items-end gap-2"
    >
      <label htmlFor={`${id}-role`} className="grid gap-1.5 text-sm">
        Start from a ready-made role
        <select
          id={`${id}-role`}
          value={roleKey}
          onChange={(event) => setRoleKey(event.target.value)}
          aria-describedby={`${id}-help`}
          className="min-h-11 rounded-control border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="">Choose a role</option>
          {ticking.startingRoles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm">
        Your PIN
        <Input
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          aria-describedby={`${id}-help`}
          className="min-h-11 w-40"
        />
      </label>
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={!roleKey || editor.pending}
      >
        {editor.pending ? 'Saving…' : 'Use this role'}
      </Button>
      <p id={`${id}-help`} className="w-full text-sm text-text-muted">
        Ticks exactly that role&apos;s sub-roles and clears this person&apos;s own ticks. Your PIN
        is needed when the role gives a sub-role that carries extra weight.
      </p>
    </form>
  );
}

/** "What this person can do": every sub-role, grouped by role, theirs ticked (DEV-959B: editable). */
export function MemberAccessPanel({ userId }: { userId: string }) {
  const access = trpc.organizationAdmin.memberAccess.useQuery({ userId }, { retry: false });
  const utils = trpc.useUtils();
  const setSubRole = trpc.organizationAdmin.setMemberSubRole.useMutation();
  const applyRole = trpc.organizationAdmin.applyMemberRoleTemplate.useMutation();
  const groups = access.data?.groups ?? [];

  async function run(
    change: () => Promise<{ changed: string[] }>,
    wanted?: string
  ): Promise<MemberAccessOutcome> {
    try {
      const result = await change();
      await utils.organizationAdmin.memberAccess.invalidate({ userId });
      const others = result.changed.filter((key) => key !== wanted);
      return { error: null, note: wanted && others.length ? alsoChanged(groups, others) : null };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'The change could not be saved.',
        note: null,
      };
    }
  }

  const editor: MemberAccessEditor = {
    pending: setSubRole.isPending || applyRole.isPending,
    setSubRole: (input) =>
      run(() => setSubRole.mutateAsync({ userId, ...input }), input.subRoleKey),
    applyRole: (input) => run(() => applyRole.mutateAsync({ userId, ...input })),
  };
  return (
    <MemberAccessView
      isLoading={access.isLoading}
      isError={access.isError}
      data={access.data}
      onRetry={() => void access.refetch()}
      editor={editor}
    />
  );
}

/** Names the other sub-roles a change moved with it (dispensing carries prescriptions). */
function alsoChanged(groups: MemberAccess['groups'], keys: string[]): string {
  const label = (key: string) =>
    groups.flatMap((group) => group.subRoles).find((subRole) => subRole.key === key)?.label ??
    key;
  return `Saved. This also changed: ${keys.map(label).join(', ')}.`;
}

/** The view itself, without the queries, so every state renders from plain props. */
export function MemberAccessView(access: {
  isLoading: boolean;
  isError: boolean;
  data: (Omit<MemberAccess, 'ticking'> & { ticking?: Ticking }) | undefined;
  onRetry: () => void;
  editor?: MemberAccessEditor;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  if (access.isLoading) {
    return (
      <div className="space-y-3" aria-label="Loading what this person can do">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (access.isError || !access.data) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-text-muted">
          What this person can do could not be loaded. Nothing about their access has changed.
        </p>
        <Button variant="outline" onClick={access.onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { member, groups, ticking } = access.data;
  const editor = ticking?.editing.allowed ? access.editor : undefined;
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p className="text-foreground">{roleSummary(member)}</p>
        {!SIGNIN_ALLOWED_STATUSES.has(member.status) ? (
          <p className="text-text-muted">
            {member.name} cannot sign in right now, so they cannot use any of this.
          </p>
        ) : null}
        {member.administrator ? (
          <p className="text-text-muted">{MEMBER_ACCESS_ADMIN_NOTES[member.administrator]}</p>
        ) : null}
        <p className="text-text-muted">
          {editor
            ? MEMBER_ACCESS_EDIT_NOTE
            : (ticking?.editing.reason ?? MEMBER_ACCESS_READ_ONLY_NOTE)}
        </p>
        <p
          role={notice?.error ? 'alert' : 'status'}
          aria-live="polite"
          className={notice?.error ? 'text-destructive' : 'text-foreground'}
        >
          {notice?.text ?? ''}
        </p>
      </div>
      {editor && ticking ? (
        <StartingRole ticking={ticking} editor={editor} onChanged={setNotice} />
      ) : null}
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {groups.map((group) => (
          <section
            key={group.roleKey}
            aria-labelledby={`access-group-${group.roleKey}`}
            className="min-w-0 border-t border-border-subtle pt-3"
          >
            <Eyebrow id={`access-group-${group.roleKey}`}>{group.roleName}</Eyebrow>
            <ul className="divide-y divide-border-subtle">
              {group.subRoles.map((subRole) => (
                <SubRoleRow
                  key={subRole.key}
                  subRole={subRole}
                  ticking={ticking}
                  editor={editor}
                  onChanged={setNotice}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** A row action that opens the view in a dialog. */
export function MemberAccessButton({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  // Long content: start at the top, not on the footer Close button.
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        What they can do<span className="sr-only">: {name}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
          initialFocus={titleRef}
        >
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
              What {name} can do
            </DialogTitle>
            <DialogDescription>
              Every sub-role in the pharmacy, grouped by the role it usually comes with. Ticked ones
              are what this person can do now.
            </DialogDescription>
          </DialogHeader>
          {open ? <MemberAccessPanel userId={userId} /> : null}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
