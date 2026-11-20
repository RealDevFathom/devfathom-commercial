import { SelectField as StudioSelect } from '@/components/ui/select-field';import type { Prisma } from '@/generated/prisma/client';
import { Button } from '@/components/ui/button';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformRead('/platform/audit');
  const raw = await searchParams;
  const query = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.slice(0, 300) : '',
    ])
  );
  const q = query.q?.trim().slice(0, 100);
  const organizationId = query.org?.trim();
  const actorId = query.actor?.trim();
  const action = query.action?.trim();
  const parseDate = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      ? date
      : undefined;
  };
  const from = parseDate(query.from);
  const through = parseDate(query.through);
  const dateError =
    (query.from && !from) || (query.through && !through) || (from && through && from > through);
  let cursor: { createdAt: Date; id: string } | undefined;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      const createdAt = new Date(decoded.createdAt);
      if (
        typeof decoded.id === 'string' &&
        decoded.id.length <= 100 &&
        Number.isFinite(createdAt.getTime())
      ) {
        cursor = { createdAt, id: decoded.id };
      }
    } catch {
      /* Invalid cursors show a recoverable error instead of broadening the query. */
    }
  }
  const invalid = Boolean(dateError || (query.cursor && !cursor));
  const pageSize = 100;
  const success =
    query.outcome === 'success' ? true : query.outcome === 'failure' ? false : undefined;
  const actorSearchLimit = 1000;
  const ledger = await withPlatformDb(async (db) => {
    // Free-text search also matches actors by name or email. Resolve matching
    // identities first because audit rows store only actor IDs. Tenant actors are
    // scoped to the selected organization, and overflow is reported, never hidden.
    const actorMatch = {
      OR: [
        { name: { contains: q, mode: 'insensitive' as const } },
        { email: { contains: q, mode: 'insensitive' as const } },
      ],
    };
    const [searchPlatformActors, searchTenantActors] =
      q && !invalid
        ? await Promise.all([
            db.platformUser.findMany({
              where: actorMatch,
              select: { id: true },
              orderBy: { id: 'asc' },
              take: actorSearchLimit + 1,
            }),
            db.user.findMany({
              where: { ...actorMatch, ...(organizationId ? { organizationId } : {}) },
              select: { id: true },
              orderBy: { id: 'asc' },
              take: actorSearchLimit + 1,
            }),
          ])
        : [[], []];
    const actorSearchTruncated =
      searchPlatformActors.length > actorSearchLimit ||
      searchTenantActors.length > actorSearchLimit;
    const platformMatchIds = searchPlatformActors.slice(0, actorSearchLimit).map(({ id }) => id);
    const tenantMatchIds = searchTenantActors.slice(0, actorSearchLimit).map(({ id }) => id);
    const where: Prisma.PlatformAuditLogWhereInput = {
      ...(invalid ? { id: { in: [] } } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(action ? { action } : {}),
      ...(from || through
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(through ? { lt: new Date(through.getTime() + 86400000) } : {}),
            },
          }
        : {}),
      AND: [
        ...(actorId
          ? [{ OR: [{ actorPlatformUserId: actorId }, { actorTenantUserId: actorId }] }]
          : []),
        ...(cursor
          ? [
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ]
          : []),
      ],
      ...(success === undefined ? {} : { success }),
      ...(q
        ? {
            OR: [
              { action: { contains: q, mode: 'insensitive' } },
              { targetType: { contains: q, mode: 'insensitive' } },
              { targetId: { contains: q, mode: 'insensitive' } },
              { reason: { contains: q, mode: 'insensitive' } },
              ...(platformMatchIds.length
                ? [{ actorPlatformUserId: { in: platformMatchIds } }]
                : []),
              ...(tenantMatchIds.length ? [{ actorTenantUserId: { in: tenantMatchIds } }] : []),
            ],
          }
        : {}),
    };
    const logs = await db.platformAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { organization: { select: { displayName: true } } },
      take: pageSize + 1,
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
      rows: logs,
      platformActorsById: new Map(platformActors.map((actor) => [actor.id, actor])),
      tenantActorsById: new Map(tenantActors.map((actor) => [actor.id, actor])),
      actorSearchTruncated,
    };
  });
  const { rows, platformActorsById, tenantActorsById, actorSearchTruncated } = ledger;

  const logs = rows.slice(0, pageSize);
  const last = logs.at(-1);
  const params = new URLSearchParams();
  for (const key of ['q', 'outcome', 'org', 'actor', 'action', 'from', 'through']) {
    if (query[key]) params.set(key, query[key]);
  }
  const firstHref = `/platform/audit?${params}`;
  if (last)
    params.set(
      'cursor',
      Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })
      ).toString('base64url')
    );
  // Export only the authorized visible page. Quote CSV fields and neutralize
  // spreadsheet formulas, including leading whitespace/control characters.
  const csvCell = (value: unknown) => {
    const text = String(value ?? '');
    const safe =
      /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const csv = [
    [
      'ID',
      'Time (UTC)',
      'Action',
      'Organization ID',
      'Organization',
      'Platform actor ID',
      'Tenant actor ID',
      'Target type',
      'Target ID',
      'Outcome',
      'Reason',
      'Error',
    ],
    ...logs.map((log) => [
      log.id,
      log.createdAt.toISOString(),
      log.action,
      log.organizationId,
      log.organization?.displayName,
      log.actorPlatformUserId,
      log.actorTenantUserId,
      log.targetType,
      log.targetId,
      log.success ? 'Success' : 'Failure',
      log.reason,
      log.error,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');

  return (
    <div className="mx-auto max-w-[1480px] [&_.platform-page-heading_.eyebrow]:text-text-body [&_.platform-page-heading_p]:text-text-body">
      <PlatformPageHeading
        eyebrow="Security / immutable operations record"
        title="Audit ledger"
        description="Platform commands, support entry, lifecycle changes, denied operations, and actor attribution. Every command declares what it records: credentials and ciphertext are never written to this ledger."
      />
      <form className="mt-6 grid gap-3 border border-border-default bg-surface-card p-4 rounded-2xl sm:grid-cols-2 lg:grid-cols-4 sm:items-end">
        <label className="grid gap-1.5 text-xs">
          Search
          <input
            name="q"
            defaultValue={q}
            placeholder="Search actor name or email, action, target, or reason"
            className="h-10 border border-border-default bg-surface-card px-3 text-sm outline-none focus:border-accent-brand"
          />
        </label>
        {(
          [
            ['org', 'Organization ID', 'text'],
            ['actor', 'Actor ID (platform or tenant)', 'text'],
            ['action', 'Exact action', 'text'],
            ['from', 'From date (UTC)', 'date'],
            ['through', 'Through date (UTC)', 'date'],
          ] as const
        ).map(([name, label, type]) => (
          <label key={name} className="grid gap-1.5 text-xs">
            {label}
            <input
              name={name}
              type={type}
              defaultValue={query[name]}
              className="h-11 min-w-0 rounded-xl border border-border-default bg-surface-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        ))}
        <label className="grid gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-body">
            Outcome
          </span>
          <StudioSelect
            name="outcome"
            defaultValue={query.outcome ?? ''}
            className="h-10 w-full border border-border-default bg-surface-card px-3 text-sm"
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </StudioSelect>
        </label>
        <Button type="submit" className="min-h-11">
          Filter
        </Button>
      </form>
      {invalid ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          Invalid date range or pagination cursor. Correct the dates or return to the first page.
        </p>
      ) : null}
      {actorSearchTruncated ? (
        <p role="status" className="mt-4 text-sm text-text-body">
          This search matched more than {actorSearchLimit} actor accounts, so only the first{' '}
          {actorSearchLimit} are included in actor matching. Narrow the search, pick an
          organization, or use the Actor ID filter to see every record for one actor.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <p className="text-text-body">{logs.length} records on this page. Dates use UTC.</p>
        <a
          className="underline focus-visible:outline-2 focus-visible:outline-ring"
          href={firstHref}
        >
          First page
        </a>
        {logs.length ? (
          <a
            className="underline focus-visible:outline-2 focus-visible:outline-ring"
            download="platform-audit.csv"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + csv)}`}
          >
            Export this page (CSV)
          </a>
        ) : null}
        {rows.length > pageSize ? (
          <a
            rel="next"
            className="underline focus-visible:outline-2 focus-visible:outline-ring"
            href={`/platform/audit?${params}`}
          >
            Older records
          </a>
        ) : null}
      </div>
      <div
        role="region"
        aria-label="Audit records"
        tabIndex={0}
        className="mt-6 overflow-x-auto border border-border-default bg-surface-card focus-visible:outline-2 focus-visible:outline-ring"
      >
        <table className="w-full min-w-[1000px] text-left [&_th]:text-text-body">
          <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-body">
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
            {!logs.length ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-sm text-text-body">
                  No records match these filters. Adjust the filters to try again.
                </td>
              </tr>
            ) : null}
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
                    {log.createdAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}
                  </td>
                  <td className="px-4 py-4 text-xs font-semibold">{log.action}</td>
                  <td className="px-4 py-4 text-xs">
                    {log.organization?.displayName ?? 'Platform'}
                  </td>
                  <td className="px-4 py-4">
                    {actor ? (
                      <>
                        <p className="text-xs font-semibold">{actor.name}</p>
                        <p className="mt-0.5 text-[10px] text-text-body">{actor.email}</p>
                      </>
                    ) : (
                      <p className="text-xs text-text-body">
                        {actorId ? 'Deleted or unavailable actor' : 'Anonymous'}
                      </p>
                    )}
                    {actorId ? (
                      <p
                        className="mt-1 max-w-48 truncate font-mono text-[8px] text-text-body"
                        title={`Actor ID: ${actorId}`}
                      >
                        {actorId}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-xs">{log.targetType ?? '—'}</p>
                    <p className="mt-1 max-w-40 truncate font-mono text-[8px] text-text-body">
                      {log.targetId}
                    </p>
                  </td>
                  <td className="px-4 py-4">
                    <PlatformStatus value={log.success ? 'SUCCEEDED' : 'FAILED'} />
                  </td>
                  <td className="max-w-sm px-4 py-4 text-xs text-text-body">
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
