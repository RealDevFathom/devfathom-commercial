import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; outcome?: string }>;
}) {
  await requirePlatformRead('/platform/audit');
  const query = await searchParams;
  const q = query.q?.trim().slice(0, 100);
  const success =
    query.outcome === 'success' ? true : query.outcome === 'failure' ? false : undefined;
  const { logs, platformActorsById, tenantActorsById } = await withPlatformDb(async (db) => {
    const logs = await db.platformAuditLog.findMany({
      where: {
        ...(success === undefined ? {} : { success }),
        ...(q
          ? {
              OR: [
                { action: { contains: q, mode: 'insensitive' } },
                { targetType: { contains: q, mode: 'insensitive' } },
                { targetId: { contains: q, mode: 'insensitive' } },
                { reason: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { displayName: true } } },
      take: 500,
    });
    const platformActorIds = logs.flatMap((log) =>
      log.actorPlatformUserId ? [log.actorPlatformUserId] : []
    );
    const tenantActorIds = logs.flatMap((log) =>
      log.actorTenantUserId ? [log.actorTenantUserId] : []
    );
    const platformActors = platformActorIds.length
      ? await db.platformUser.findMany({
          where: { id: { in: platformActorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const tenantActors = tenantActorIds.length
      ? await db.user.findMany({
          where: { id: { in: tenantActorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];

    return {
      logs,
      platformActorsById: new Map(platformActors.map((actor) => [actor.id, actor])),
      tenantActorsById: new Map(tenantActors.map((actor) => [actor.id, actor])),
    };
  });

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Security / immutable operations record"
        title="Audit ledger"
        description="Platform commands, support entry, lifecycle changes, denied operations, and actor attribution. Every command declares what it records: credentials and ciphertext are never written to this ledger."
      />
      <form className="mt-6 grid gap-3 border border-border-default bg-surface-card p-4 sm:grid-cols-[1fr_200px_auto] sm:items-end">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search action, target, or reason"
          className="h-10 border border-border-default bg-surface-card px-3 text-sm outline-none focus:border-accent-brand"
        />
        <label className="grid gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
            Outcome
          </span>
          <select
            name="outcome"
            defaultValue={query.outcome ?? ''}
            className="h-10 w-full border border-border-default bg-surface-card px-3 text-sm"
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <button className="h-10 bg-abyss-900 px-4 text-xs font-semibold text-paper-white">
          Filter
        </button>
      </form>
      <div className="mt-6 overflow-x-auto border border-border-default bg-surface-card">
        <table className="w-full min-w-[1000px] text-left">
          <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Outcome</th>
              <th className="px-4 py-3">Reason / error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {logs.map((log) => {
              const actorId = log.actorPlatformUserId ?? log.actorTenantUserId;
              const actor = log.actorPlatformUserId
                ? platformActorsById.get(log.actorPlatformUserId)
                : log.actorTenantUserId
                  ? tenantActorsById.get(log.actorTenantUserId)
                  : undefined;

              return (
                <tr key={log.id}>
                  <td className="px-4 py-4 font-mono text-[9px]">
                    {log.createdAt.toLocaleString()}
                  </td>
                  <td className="px-4 py-4 text-xs font-semibold">{log.action}</td>
                  <td className="px-4 py-4 text-xs">
                    {log.organization?.displayName ?? 'Platform'}
                  </td>
                  <td className="px-4 py-4">
                    {actor ? (
                      <>
                        <p className="text-xs font-semibold">{actor.name}</p>
                        <p className="mt-0.5 text-[10px] text-text-muted">{actor.email}</p>
                      </>
                    ) : (
                      <p className="text-xs text-text-muted">
                        {actorId ? 'Deleted or unavailable actor' : 'Anonymous'}
                      </p>
                    )}
                    {actorId ? (
                      <p
                        className="mt-1 max-w-48 truncate font-mono text-[8px] text-text-muted"
                        title={`Actor ID: ${actorId}`}
                      >
                        {actorId}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-xs">{log.targetType ?? '—'}</p>
                    <p className="mt-1 max-w-40 truncate font-mono text-[8px] text-text-muted">
                      {log.targetId}
                    </p>
                  </td>
                  <td className="px-4 py-4">
                    <PlatformStatus value={log.success ? 'SUCCEEDED' : 'FAILED'} />
                  </td>
                  <td className="max-w-sm px-4 py-4 text-xs text-text-muted">
                    {log.error ?? log.reason ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
