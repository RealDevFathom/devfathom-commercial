import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { VALUATION_EXPIRY_DAYS, type StockValueRow } from '@/lib/pharmacy/inventory-valuation';
import type { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';

type Valuation = Awaited<
  ReturnType<ReturnType<typeof pharmacyInventoryRouter.createCaller>['stockValuation']>
>;

function amount(minor: bigint | null, currency: string | null) {
  if (minor === null || !currency) return 'Not available';
  const magnitude = minor < 0n ? -minor : minor;
  const whole = (magnitude / 100n).toLocaleString('en-PK');
  const cents = (magnitude % 100n).toString().padStart(2, '0');
  return `${currency === 'PKR' ? 'Rs' : currency} ${minor < 0n ? '−' : ''}${whole}.${cents}`;
}

const valueClasses = 'break-words text-xl';
const linkClass = buttonVariants({ variant: 'outline', className: 'min-h-11' });
const disclosureClass =
  'flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-text-strong underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function CostBreakdown({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: StockValueRow[];
  currency: string;
}) {
  const preview = rows.slice(0, 5);
  const max = rows[0]?.costMinor ?? 0n;
  return (
    <SectionCard title={title}>
      {rows.length ? (
        <>
          <ul className="space-y-3" aria-label={title}>
            {preview.map(({ id, name, costMinor }) => (
              <li key={id} className="space-y-1">
                <div className="flex flex-wrap justify-between gap-x-4 text-sm">
                  <span className="break-words [overflow-wrap:anywhere]">{name}</span>
                  <span className="tabular-nums">{amount(costMinor, currency)}</span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-surface-sunken"
                  aria-hidden="true"
                >
                  <div
                    className="h-full bg-text-muted"
                    style={{
                      width: `${max > 0n && costMinor > 0n ? Number((costMinor * 100n) / max) : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <details className="mt-3">
            <summary className={disclosureClass}>
              Show as a table{rows.length > preview.length ? ` (all ${rows.length})` : ''}
            </summary>
            <Table
              containerProps={{
                role: 'region',
                'aria-label': `${title} table`,
                tabIndex: 0,
                className:
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              }}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>{title === 'Value by category' ? 'Category' : 'Product'}</TableHead>
                  <TableHead className="text-right">Value at cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ id, name, costMinor }) => (
                  <TableRow key={id}>
                    <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
                      {name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {amount(costMinor, currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </>
      ) : (
        <p className="text-sm text-text-muted">There’s no recorded value to show here yet.</p>
      )}
    </SectionCard>
  );
}

export function StockValueSummary({
  result,
  branch,
  missingPage,
}: {
  result: Valuation | null;
  branch: { id: string; name: string };
  missingPage?: number;
}) {
  if (!result) {
    return (
      <SectionCard title="Stock summary">
        <p role="status" className="text-sm text-text-body">
          The stock summary couldn’t load. You can still work with the branch stock below.
        </p>
      </SectionCard>
    );
  }
  const { money, productCount, businessTotal } = result;
  const missingHref = (page: number) =>
    `/pharmacy/inventory?${new URLSearchParams({
      branch: businessTotal ? 'all' : branch.id,
      missingCost: String(page),
    })}#missing-stock-cost`;
  const currency = money?.costCurrency ?? null;
  const showBreakdown = money && currency && money.costMinor !== null;
  const categories = money?.otherCategoryCount
    ? [
        ...money.categories,
        {
          id: 'other:category',
          name: `Other categories (${money.otherCategoryCount})`,
          costMinor: money.otherCategoriesMinor,
        },
      ]
    : (money?.categories ?? []);
  return (
    <>
      <SectionCard title={money ? 'Stock value' : 'Stock summary'} id="stock-value">
        <p className="mb-4 text-sm text-text-muted">
          {businessTotal ? 'All branches you can access' : branch.name}
          {money ? ' · Current stock, including stock held or in transit' : null}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat
            label="Products in stock"
            value={productCount.toLocaleString('en-PK')}
            valueClassName={valueClasses}
          />
          {money ? (
            <>
              <Stat
                label="Value at cost"
                value={amount(money.costMinor, currency)}
                valueClassName={valueClasses}
                sub={`Cost recorded and reflected in Finance for ${money.coveredProductCount.toLocaleString('en-PK')} products`}
              />
              <Stat
                label="Value at selling price"
                value={amount(money.sellingMinor, money.sellingCurrency)}
                valueClassName={valueClasses}
                sub="Before discounts, using prices recorded on the packs. Includes stock that cannot be sold."
              />
            </>
          ) : null}
        </div>
        {money ? (
          <>
            {showBreakdown ? (
              <div className="mt-5 grid gap-4 border-t border-border-subtle pt-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {VALUATION_EXPIRY_DAYS.map((days, index) => (
                  <Stat
                    key={days}
                    label={`Expires within ${days} days`}
                    value={amount(money.expiringMinor[index] ?? null, currency)}
                    valueClassName={valueClasses}
                    sub="At cost, not yet expired"
                  />
                ))}
                <Stat
                  label="Expired stock"
                  value={amount(money.expiredMinor, currency)}
                  valueClassName={valueClasses}
                  sub="At cost"
                />
                <Stat
                  label="Held or in transit"
                  value={amount(money.heldMinor, currency)}
                  valueClassName={valueClasses}
                  sub="At cost, including stock set aside or damaged"
                />
              </div>
            ) : null}
            <div className="mt-4 space-y-2 text-sm text-text-body">
              {money.mixedCurrencies ? (
                <p role="note">
                  Cost is not shown because Finance entries use different currencies.
                </p>
              ) : money.costMinor === null && productCount > 0 ? (
                <p role="note">There is no value recorded in Finance for this stock yet.</p>
              ) : null}
              {money.missingCost.count > 0 ? (
                <p>
                  {money.missingCost.count.toLocaleString('en-PK')}{' '}
                  {money.missingCost.count === 1 ? 'product has' : 'products have'} no cost
                  recorded.{' '}
                  <Link
                    className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    href={missingHref(1)}
                  >
                    See products without a cost
                  </Link>
                </p>
              ) : null}
              {money.unpostedProductCount > 0 ? (
                <p>
                  {money.unpostedProductCount.toLocaleString('en-PK')} products have some stock with
                  a cost on file but no positive value recorded against that stock in Finance.
                </p>
              ) : null}
              {money.missingPriceCount > 0 ? (
                <p>
                  {money.missingPriceCount.toLocaleString('en-PK')} products have stock without a
                  selling price. That stock is not included in the selling-price total.
                </p>
              ) : null}
              {showBreakdown && money.unassignedCostMinor !== 0n ? (
                <p>
                  {amount(money.unassignedCostMinor, currency)} of the Finance total could not be
                  matched to products in stock.
                </p>
              ) : null}
              {showBreakdown ? (
                <p>
                  The expiry amounts overlap. Stock without an expiry date is not included in them.
                </p>
              ) : null}
              {money.canOpenFinanceReport ? (
                <Link
                  className={linkClass}
                  href={`/pharmacy/finance?${new URLSearchParams({ branch: branch.id, ledgerInstant: money.asOf })}#stock-valuation`}
                >
                  {businessTotal
                    ? `Open Finance valuation for ${branch.name}`
                    : 'Open full valuation in Finance'}
                </Link>
              ) : null}
            </div>
          </>
        ) : null}
      </SectionCard>
      {money && missingPage && money.missingCost.count > 0 ? (
        <SectionCard title="Products without a recorded cost" id="missing-stock-cost">
          <p className="mb-3 text-sm text-text-muted">
            These products have at least one batch in stock without a recorded cost.
          </p>
          <ul className="list-inside list-disc space-y-1 break-words text-sm">
            {money.missingCost.rows.map(({ id, name }) => (
              <li key={id}>{name}</li>
            ))}
          </ul>
          <nav
            aria-label="Products without a cost pages"
            className="mt-4 flex flex-wrap items-center gap-3"
          >
            {money.missingCost.page > 1 ? (
              <Link className={linkClass} href={missingHref(money.missingCost.page - 1)}>
                Previous
              </Link>
            ) : null}
            <span className="text-sm">
              Page {money.missingCost.page} of {money.missingCost.lastPage}
            </span>
            {money.missingCost.page < money.missingCost.lastPage ? (
              <Link className={linkClass} href={missingHref(money.missingCost.page + 1)}>
                Next
              </Link>
            ) : null}
          </nav>
        </SectionCard>
      ) : null}
      {showBreakdown ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <CostBreakdown title="Value by category" rows={categories} currency={currency} />
          <CostBreakdown
            title="Top 20 products by value"
            rows={money.topProducts}
            currency={currency}
          />
        </div>
      ) : null}
    </>
  );
}
