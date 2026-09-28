import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { Button } from '@/components/ui/button';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { requirePlatformSession } from '@/lib/platform/auth';
import { forceEndSupportSession, listActiveSupportSessions } from '@/lib/tenancy/support-session';

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const actor = await requirePlatformRead('/platform/support');
  const { result } = await searchParams;
  const sessions = await listActiveSupportSessions(actor);

  async function endSession(form: FormData) {
    'use server';
    const operator = await requirePlatformSession(undefined, 'support:write');
    if (form.get('confirm') !== 'yes') redirect('/platform/support?result=invalid');
    try {
      await forceEndSupportSession({
        actor: operator,
        supportSessionId: String(form.get('supportSessionId') ?? ''),
        reason: String(form.get('reason') ?? ''),
      });
    } catch {
      redirect('/platform/support?result=error');
    }
    revalidatePath('/platform/support');
    redirect('/platform/support?result=ended');
  }

  return (
    <div className="space-y-7">
      <PlatformPageHeading
        eyebrow="Operations / support"
        title="Active support sessions"
        description="Review support access across workspaces. Ending a session revokes access on the operator’s next request."
        action={
          <Link
            href="/platform/support"
            className="text-sm underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Refresh sessions
          </Link>
        }
      />
      {result ? (
        <p
          role={result === 'ended' ? 'status' : 'alert'}
          className="rounded-xl border border-border-default bg-surface-card p-4 text-sm"
        >
          {result === 'ended'
            ? 'Support session ended. Its audit history is preserved.'
            : 'Unable to end the session. Refresh and retry with a reason of 10–500 characters and confirmation.'}
        </p>
      ) : null}
      {sessions.length === 0 ? (
        <section className="rounded-2xl border border-border-default bg-surface-card p-6">
          <h2 className="font-semibold">No active support sessions</h2>
          <p className="mt-2 text-sm text-text-muted">
            Open an organization to start audited support access.
          </p>
          <Link href="/platform/organizations" className="mt-4 inline-block text-sm underline">
            View organizations
          </Link>
        </section>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {sessions.map((session) => (
            <section
              key={session.id}
              className="min-w-0 rounded-2xl border border-border-default bg-surface-card p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="break-words text-lg font-semibold">
                  {session.organization.displayName}
                </h2>
                <PlatformStatus value={session.launchUsedAt ? 'ACTIVE' : 'PENDING'} />
              </div>
              <dl className="mt-4 grid gap-2 text-sm">
                <div>
                  <dt className="text-text-muted">Operator</dt>
                  <dd>{session.operatorName}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Reason</dt>
                  <dd className="break-words">{session.reason}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Expires</dt>
                  <dd>
                    <time dateTime={session.expiresAt.toISOString()}>
                      {session.expiresAt.toUTCString()}
                    </time>
                  </dd>
                </div>
              </dl>
              <details className="mt-5 border-t border-border-subtle pt-4">
                <summary className="cursor-pointer text-sm font-semibold text-destructive focus-visible:ring-2 focus-visible:ring-ring">
                  End support access
                </summary>
                <form action={endSession} className="mt-4 space-y-4">
                  <input type="hidden" name="supportSessionId" value={session.id} />
                  <label className="block text-sm">
                    Reason for ending access
                    <textarea
                      name="reason"
                      required
                      minLength={10}
                      maxLength={500}
                      className="mt-2 min-h-24 w-full rounded-xl border border-border-default bg-surface-page p-3 focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="flex items-start gap-3 text-sm">
                    <input type="checkbox" name="confirm" value="yes" required className="mt-1" />I
                    confirm this will end the operator’s support access.
                  </label>
                  <Button type="submit" variant="destructive" className="min-h-11">
                    End session
                  </Button>
                </form>
              </details>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
