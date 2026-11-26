import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { starterHistory } from '@/lib/pharmacy/migration/starter-history';

const FIELD_LABEL: Readonly<Record<string, string>> = {
  packSize: 'Pack size',
  controlled: 'Controlled',
  active: 'Active',
};

export function cataloguePageNumber(value: string) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1;
}

export function TenantMedicineCatalogue({
  products,
  more,
  query,
  page,
  batches,
}: {
  products: {
    id: string;
    productName: string;
    manufacturer: string | null;
    saleable: boolean;
    controlled: boolean;
  }[];
  more: boolean;
  query: string;
  page: number;
  batches: number;
}) {
  const pageHref = (page: number) =>
    '?' + new URLSearchParams({ q: query, cataloguePage: String(page) });
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        heading="Medicine catalogue"
        eyebrow="Pharmacy / Stock"
        actions={
          <Link href="?view=imports" className={buttonVariants({ variant: 'outline' })}>
            Import history{batches > 0 && ` (${batches} staged)`}
          </Link>
        }
      />
      <SectionCard title="Your medicines">
        <form className="flex flex-wrap items-end gap-3" action="/pharmacy/medicines">
          <label className="grid min-w-0 flex-1 gap-2 text-sm">
            Search medicines
            <Input
              name="q"
              type="search"
              maxLength={200}
              defaultValue={query}
              placeholder="Name, manufacturer or alias"
            />
          </label>
          <Button type="submit">Search</Button>
        </form>
        <ul className="mt-4 divide-y divide-border-subtle">
          {products.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 break-words">
                <span className="font-semibold">{m.productName}</span>
                {m.manufacturer && <p className="text-sm text-text-muted">{m.manufacturer}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {m.controlled && <StatusPill status="Controlled" tone="warning" />}
                <StatusPill status={m.saleable ? 'Active' : 'Inactive'} />
              </div>
            </li>
          ))}
        </ul>
        {!products.length && (
          <p className="py-4 text-sm text-text-muted">
            {query
              ? 'No medicines match this search.'
              : 'No medicines yet. Check Import history for setup progress.'}
          </p>
        )}
        <nav aria-label="Catalogue pages" className="flex items-center gap-3">
          <span>Page {page}</span>
          {page > 1 && (
            <Link className={buttonVariants({ variant: 'outline' })} href={pageHref(page - 1)}>
              Previous
            </Link>
          )}
          {more && (
            <Link className={buttonVariants({ variant: 'outline' })} href={pageHref(page + 1)}>
              Next
            </Link>
          )}
        </nav>
      </SectionCard>
    </div>
  );
}

export function StarterHistory({
  data,
  list,
  page,
}: {
  data: Awaited<ReturnType<typeof starterHistory>>;
  list: 'conflicts' | 'narcotics';
  page: number;
}) {
  const { run, rows, more } = data;
  const href = (list: string, page: number) =>
    '?' + new URLSearchParams({ view: 'imports', list, reviewPage: String(page) });
  return (
    <SectionCard title="Starter catalogue system import">
      <p role="status" className="text-sm">
        {!run
          ? 'No system import recorded.'
          : run.completedAt
            ? `Complete. ${run.added} medicines added, ${run.matched} already present, ${run.editsKept} existing products with differences.`
            : run.total
              ? `${run.processed} of ${run.total} products loaded. You can use the catalogue while setup continues.`
              : 'Queued. Waiting for the starter catalogue to load.'}
      </p>
      {run && (
        <>
          <nav aria-label="Starter review lists" className="my-4 flex flex-wrap gap-2">
            <Link
              aria-current={list === 'conflicts' ? 'page' : undefined}
              className={buttonVariants({ variant: list === 'conflicts' ? 'default' : 'outline' })}
              href={href('conflicts', 1)}
            >
              Field conflicts
            </Link>
            <Link
              aria-current={list === 'narcotics' ? 'page' : undefined}
              className={buttonVariants({ variant: list === 'narcotics' ? 'default' : 'outline' })}
              href={href('narcotics', 1)}
            >
              NARCOTICS review
            </Link>
          </nav>
          {!rows.length && (
            <p className="text-sm text-text-muted">
              {list === 'conflicts'
                ? 'No conflicting fields on this page.'
                : 'No NARCOTICS products on this page.'}
            </p>
          )}
          <ul className="divide-y divide-border-subtle">
            {rows.map((r) => (
              <li key={r.sourceId + '-' + r.field} className="py-3">
                <p className="break-words font-semibold">
                  {r.productName}{' '}
                  <span className="font-mono text-sm text-text-muted">{r.sourceId}</span>
                </p>
                {r.existingValue !== null && (
                  <p className="text-sm">
                    {FIELD_LABEL[r.field]} · Pharmacy {r.existingValue} · Starter {r.starterValue}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <nav aria-label="Review pages" className="mt-3 flex gap-2">
            {page > 1 && (
              <Link className={buttonVariants({ variant: 'outline' })} href={href(list, page - 1)}>
                Previous review page
              </Link>
            )}
            {more && (
              <Link className={buttonVariants({ variant: 'outline' })} href={href(list, page + 1)}>
                Next review page
              </Link>
            )}
          </nav>
        </>
      )}
    </SectionCard>
  );
}
