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
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy inventory · Import references"
        heading="Imported stock"
        description="Original medicine stock references retained from imports for reconciliation."
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
          <SectionCard title="Import references and reconciliation" titleLevel={2}>
            <p className="text-sm text-text-body">
              These are original source quantities retained for reconciliation, not
              available-to-sell balances. This view does not report whether a source row has been
              reconciled with posted stock. Reconcile batch, expiry, physical count, and pack
              meanings against Inventory; no quantities here are multiplied or rounded into units.
            </p>
            <section aria-label="Imported row totals" className="mt-5 grid gap-5 sm:grid-cols-2">
              <Stat
                label="Imported medicine rows"
                value={data.importedRows.toLocaleString('en-US')}
                sub="All retained import reference rows in this workspace"
              />
              <Stat
                label="Rows with reported stock"
                value={data.reportedStockRows.toLocaleString('en-US')}
                sub="Original QTY is a valid positive decimal; all imports"
              />
            </section>
            <p className="mt-4 text-sm text-text-muted">
              Totals count source rows, not distinct medicines or verified sellable units. Search
              filters the list below. Posted stock balances remain on Inventory. Blank or invalid
              source counts appear as Unknown; valid decimals keep their original precision.
            </p>
          </SectionCard>
          <SectionCard title="Imported medicine references" titleLevel={2}>
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
                  ? 'No imported medicine references are visible in this workspace.'
                  : 'No imported medicine names match this search. Clear the search or try another name.'}
              </p>
            ) : (
              <Table>
                <caption className="sr-only">
                  Imported stock references for reconciliation, with original source counts and row
                  identity.
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
                    <TableHead scope="col">Record type</TableHead>
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
                        <StatusPill status="reference" tone="neutral" label="Import reference" />
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
    </div>
  );
}
