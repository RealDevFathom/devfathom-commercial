'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { browserUuid } from '@/lib/browser-uuid';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
import type { GrowthBranchScope, GrowthList } from '@/lib/restaurant/growth-generation';

function validGrowthRange(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = (end - start) / 86_400_000 + 1;
  return Number.isInteger(days) && days >= 1 && days <= 45;
}
export function GrowthEntries({
  branchId,
  branchScope,
  entries,
  onGenerate,
}: {
  branchId: string;
  branchScope: GrowthBranchScope;
  entries: GrowthList | null;
  onGenerate: (
    input: unknown
  ) => Promise<
    | { status: 'SAVED'; result: { insightId: string; status: string } }
    | { status: 'INVALID'; message: string }
  >;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    branchId: string;
    from: string;
    to: string;
    requestId: string;
  } | null>(null);
  return (
    <SectionCard title="Saved insights" titleLevel={2}>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label>
          Branch
          <RestaurantBranchSelect
            name="branch"
            defaultValue={branchId}
            branches={branchScope.status === 'AVAILABLE' ? branchScope.branches : []}
            error={branchScope.status === 'UNAVAILABLE'}
            required
          />
        </label>
        <Button className="min-h-11" type="submit" variant="outline">
          Open branch
        </Button>
      </form>
      {entries?.status === 'AVAILABLE' ? (
        <>
          {!entries.items.length && <p>No saved insights for this branch.</p>}
          <ul className="space-y-2">
            {entries.items.map((item) => (
              <li key={item.id}>
                <Link
                  className="underline focus-visible:ring-2 focus-visible:ring-ring"
                  href={`/restaurant/growth?${new URLSearchParams({ branch: branchId, insight: item.id })}`}
                >
                  {item.createdAt} · {item.status}
                </Link>
              </li>
            ))}
          </ul>
          {entries.truncated && <p>Showing the latest 20 saved insights.</p>}
          <form
            className="mt-4 space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const input = pending ?? {
                branchId,
                from: String(fields.get('from')),
                to: String(fields.get('to')),
                requestId: browserUuid(),
              };
              if (!validGrowthRange(input.from, input.to)) {
                setError('Choose an ordered date range containing no more than 45 calendar dates.');
                return;
              }
              setPending(input);
              setBusy(true);
              setError(null);
              try {
                const result = await onGenerate(input);
                if (result.status === 'INVALID') {
                  setPending(null);
                  setError(result.message);
                  return;
                }
                setPending(null);
                router.push(
                  `/restaurant/growth?${new URLSearchParams({ branch: branchId, insight: result.result.insightId })}`
                );
              } catch {
                setError(
                  'The result is unknown. Reconcile this same request before generating another.'
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="text-sm text-text-muted">
              Check source evidence for a new insight. Unsupported or sparse evidence is saved as
              unavailable; recommendations require qualifying evidence.
            </p>
            <div className="flex flex-wrap gap-3">
              <label>
                From
                <Input
                  className="min-h-11"
                  name="from"
                  type="date"
                  required
                  disabled={busy || !!pending}
                />
              </label>
              <label>
                Through
                <Input
                  className="min-h-11"
                  name="to"
                  type="date"
                  required
                  disabled={busy || !!pending}
                />
              </label>
            </div>
            <Button className="min-h-11" type="submit" disabled={busy}>
              {busy
                ? 'Checking evidence…'
                : pending
                  ? 'Reconcile saved request'
                  : 'Generate insight'}
            </Button>
            {error && <p role="alert">{error}</p>}
          </form>
        </>
      ) : (
        <p role="status">
          {entries?.status === 'DENIED' || branchScope.status === 'DENIED'
            ? 'You do not have access to this branch.'
            : branchId
              ? 'Saved insights are unavailable.'
              : 'Choose an authorized branch to view saved insights.'}
        </p>
      )}
    </SectionCard>
  );
}
