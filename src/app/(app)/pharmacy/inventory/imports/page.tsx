import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { readImportedStock, type ImportedStockQuery } from '@/lib/pharmacy/imported-stock';

export const metadata: Metadata = { title: 'Imported stock · Pharmacy inventory' };
const ROUTE = '/pharmacy/inventory/imports';

export default async function ImportedStockPage({
  searchParams,
}: {
  searchParams: Promise<ImportedStockQuery>;
}) {
  const data = await readImportedStock(await searchParams);
  const pageHref = (page: number) =>
    `${ROUTE}?${new URLSearchParams({ q: data?.search ?? '', page: String(page) })}`;
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy inventory"
        heading="Check imported stock"
        description="Stock lines brought in from your old system, kept as they were so you can check them."
        actions={
          <Link href="/pharmacy/inventory" className={buttonVariants({ variant: 'secondary' })}>
            Back to Inventory
          </Link>
        }
      />
      {!data ? (
        <SectionCard title="Inventory access required" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Sign in to an active workspace with Pharmacy Inventory enabled. Ask a workspace
            administrator if you need access.
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="Awaiting verification" titleLevel={2}>
            <p className="text-sm text-text-body">
              These quantities come straight from your old system and cannot be sold yet. Check
              each line’s batch, expiry date and shelf count, and what its pack size means. The
              numbers are shown exactly as imported, without converting packs into units.
            </p>
            <section aria-label="Imported row totals" className="mt-5 grid gap-5 sm:grid-cols-2">
              <Stat
                label="Imported medicine rows"
                value={data.importedRows.toLocaleString('en-US')}
                sub="All completed imports in this workspace"
              />
              <Stat
                label="Rows with reported stock"
                value={data.reportedStockRows.toLocaleString('en-US')}
                sub="Lines whose original quantity is above zero"
              />
            </section>
            <p className="mt-4 text-sm text-text-muted">
              These totals count imported lines, not medicines or units you can sell. Your
              sellable stock is on the Inventory page. A blank or unreadable quantity shows as
              Unknown.
            </p>
          </SectionCard>
          <SectionCard title="Imported medicine lines" titleLevel={2}>
            <form action={ROUTE} method="get" className="mb-5 flex flex-wrap items-end gap-3">
              <label
                className="min-w-0 flex-1 basis-64 text-sm text-text-body"
                htmlFor="import-search"
              >
                Search medicine name
                <Input
                  id="import-search"
                  name="q"
                  type="search"
                  maxLength={160}
                  defaultValue={data.search}
                  className="mt-1 min-h-11"
                />
              </label>
              <Button type="submit" className="min-h-11">
                Search imports
              </Button>
              {data.search ? (
                <Link
                  href={ROUTE}
                  className={buttonVariants({ variant: 'ghost', className: 'min-h-11' })}
                >
                  Clear search
                </Link>
              ) : null}
            </form>
            {data.rows.length === 0 ? (
              <p
                role="status"
                className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted"
              >
                {data.importedRows === 0
                  ? 'No imported stock lines yet. Lines appear here once a stock list from your old system has been imported.'
                  : 'No imported medicine names match this search. Clear the search or try another name.'}
              </p>
            ) : (
              <Table>
                <caption className="sr-only">
                  Imported stock references awaiting verification, with original source counts and
                  row identity.
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Medicine name</TableHead>
                    <TableHead scope="col" numeric>
                      Original QTY
                    </TableHead>
                    <TableHead scope="col" numeric>
                      Original PackQty
                    </TableHead>
                    <TableHead scope="col" numeric>
                      Original PackUnits
                    </TableHead>
                    <TableHead scope="col">Source row identity</TableHead>
                    <TableHead scope="col">Verification status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="min-w-48 max-w-80 whitespace-normal break-words">
                        {row.productName || 'Unknown medicine name'}
                      </TableCell>
                      <TableCell numeric className="whitespace-pre-wrap">
                        {row.originalQty ?? 'Unknown'}
                      </TableCell>
                      <TableCell numeric className="whitespace-pre-wrap">
                        {row.originalPackQty ?? 'Unknown'}
                      </TableCell>
                      <TableCell numeric className="whitespace-pre-wrap">
                        {row.originalPackUnits ?? 'Unknown'}
                      </TableCell>
                      <TableCell className="min-w-48 max-w-80 whitespace-normal break-all text-xs text-text-muted">
                        <p>Source: {row.sourceId}</p>
                        <p>Import batch: {row.batchId}</p>
                        <p>Source row: {row.rowNumber}</p>
                        <p>Row ID: {row.id}</p>
                      </TableCell>
                      <TableCell>
                        <StatusPill status="awaiting" label="Awaiting verification" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <nav
              aria-label="Imported stock pagination"
              className="mt-5 flex flex-wrap items-center gap-3"
            >
              <p role="status" className="mr-auto text-sm text-text-muted">
                {data.matchingRows.toLocaleString('en-US')} matching rows · Page {data.page} of{' '}
                {data.pages} · Up to {data.pageSize} rows per page
              </p>
              {data.page > 1 ? (
                <Link
                  href={pageHref(data.page - 1)}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  Previous
                </Link>
              ) : (
                <Button disabled variant="secondary">
                  Previous
                </Button>
              )}
              {data.page < data.pages ? (
                <Link
                  href={pageHref(data.page + 1)}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  Next
                </Link>
              ) : (
                <Button disabled variant="secondary">
                  Next
                </Button>
              )}
            </nav>
          </SectionCard>
        </>
      )}
    </main>
  );
}
