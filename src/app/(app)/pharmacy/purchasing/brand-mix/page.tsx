import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import type { MarginOptimizedBrandProposal } from '@/lib/pharmacy/substitute-finder';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { AccessState, PurchasingHeader, PurchasingTabs } from '../_components/console-chrome';
import { SelectField, TextField } from '../_components/form-controls';
import { param, PURCHASING_ROUTE, tenantContext, type SearchQuery } from '../_lib/console';

export const metadata: Metadata = { title: 'Brand mix · Pharmacy' };
const ROUTE = `${PURCHASING_ROUTE}/brand-mix`;
const HEADING = 'Brand mix';
const DESCRIPTION =
  'Compare exact in-stock equivalents by observed contribution for purchasing review.';

export default async function BrandMixPage({
  searchParams,
}: {
  searchParams: Promise<SearchQuery>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const moduleEnabled = Boolean(ctx && hasModule(ctx.entitlements, 'pharmacy-procurement'));
  if (!ctx?.session?.user || !moduleEnabled) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }
  if (
    !(await can(subjectFromSession(ctx.session.user), 'pharmacy:procurement', undefined, {
      db: ctx.db,
    }))
  ) {
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
  }

  const organizationId = ctx.entitlements.organizationId;
  const header = (
    <>
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={ROUTE} />
    </>
  );
  let branches;
  let medicines;
  try {
    [branches, medicines] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.medicine.findMany({
        where: { organizationId, saleable: true },
        select: {
          id: true,
          productName: true,
          strengths: { select: { value: true, unit: true } },
          presentations: {
            select: { id: true, presentation: true, dosageForm: true, route: true },
            orderBy: [{ presentation: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ productName: 'asc' }, { id: 'asc' }],
      }),
    ]);
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Brand mix could not load">
          <p role="alert" className="text-sm text-text-muted">
            Branch and medicine choices are unavailable. Reload to retry.
          </p>
          <form action={ROUTE} method="get" className="mt-4">
            {['branch', 'presentation', 'quantity', 'compare'].map((name) =>
              param(query, name) ? (
                <input key={name} type="hidden" name={name} value={param(query, name)} />
              ) : null
            )}
            <Button type="submit" variant="outline" className="min-h-11">
              Reload choices
            </Button>
          </form>
        </SectionCard>
      </main>
    );
  }

  const branchId = param(query, 'branch') ?? (branches.length === 1 ? branches[0]!.id : '');
  const presentationId = param(query, 'presentation') ?? '';
  const quantity = param(query, 'quantity') ?? '1';
  const quantityCanonicalUnits = Number(quantity);
  const medicine = medicines.find((row) =>
    row.presentations.some((item) => item.id === presentationId)
  );
  const submitted = param(query, 'compare') === '1';
  const fieldError = submitted
    ? !branches.some((branch) => branch.id === branchId)
      ? { field: 'branch', message: 'Choose an available branch.' }
      : !medicine
        ? { field: 'presentation', message: 'Choose an available medicine presentation.' }
        : !/^\d+$/.test(quantity) ||
            !Number.isSafeInteger(quantityCanonicalUnits) ||
            quantityCanonicalUnits <= 0
          ? {
              field: 'quantity',
              message: 'Quantity must be a positive whole number of canonical units.',
            }
          : null
    : null;
  let proposals: MarginOptimizedBrandProposal[] | null = null;
  let readError: string | null = null;
  if (submitted && !fieldError && medicine) {
    try {
      proposals = await pharmacySalesRouter.createCaller(ctx).marginOptimizedBrandProposals({
        branchId,
        medicineId: medicine.id,
        presentationId,
        quantityCanonicalUnits,
      });
    } catch (error) {
      readError =
        error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
          ? 'You do not have access to this comparison. Ask a workspace administrator to check your procurement permission and module access.'
          : 'The comparison could not be read. Retry with the selections below.';
    }
  }
  const currency = ctx.organization?.currency?.trim();
  const money = (minor: number) =>
    `${currency && /^[A-Z]{3}$/.test(currency) ? currency : 'Currency unknown'} ${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const notice = fieldError ? { ...fieldError, kind: 'error' as const } : null;

  return (
    <main className="min-w-0 space-y-6">
      {header}
      <SectionCard title="Compare a medicine">
        <p className="mb-4 text-sm text-text-muted">
          Choose a reference presentation and quantity in canonical units. Only exact ingredients,
          strengths, dosage form and route qualify. Stock excludes supplier claims and customer
          restock reservations.
        </p>
        <form action={ROUTE} method="get" className="space-y-4" aria-label="Compare brand mix">
          <input type="hidden" name="compare" value="1" />
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <SelectField
              name="branch"
              label="Branch"
              notice={notice}
              required
              defaultValue={branchId}
              options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
              emptyHint="Add an active pharmacy branch in pharmacy onboarding before comparing stock."
            />
            <SelectField
              name="presentation"
              label="Reference medicine and presentation"
              notice={notice}
              required
              defaultValue={presentationId}
              options={medicines.flatMap((row) =>
                row.presentations.map((item) => ({
                  value: item.id,
                  label: `${row.productName} · ${row.strengths.map((strength) => `${strength.value.toString()} ${strength.unit}`).join(' + ')} · ${item.presentation} · ${item.dosageForm ?? 'Form missing'} · ${item.route ?? 'Route missing'}`,
                }))
              )}
              emptyHint="Add a saleable medicine with a presentation in the medicine register."
            />
            <TextField
              name="quantity"
              label="Quantity (canonical units)"
              notice={notice}
              type="number"
              min={1}
              step="1"
              required
              defaultValue={quantity}
            />
          </div>
          <Button
            type="submit"
            className="min-h-11"
            disabled={
              branches.length === 0 || !medicines.some((row) => row.presentations.length > 0)
            }
          >
            {readError ? 'Retry comparison' : 'Compare brands'}
          </Button>
        </form>
        {readError ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {readError}
          </p>
        ) : null}
        {!submitted ? (
          <p role="status" className="mt-4 text-sm text-text-muted">
            Select a medicine and compare to see this branch’s available brand mix.
          </p>
        ) : null}
      </SectionCard>
      {proposals !== null ? (
        <SectionCard title="Ranked brand mix">
          <p className="mb-4 text-sm text-text-muted">
            Ranked by contribution (printed MRP less observed lot cost) for {quantityCanonicalUnits}{' '}
            canonical units; margin rate breaks ties. Each row is one receipt lot. These are
            read-only inventory facts for pharmacist and purchasing review. Stock is rechecked when
            a sale is allocated.
          </p>
          {proposals.length === 0 ? (
            <p role="status" className="text-sm text-text-muted">
              No exact equivalent has enough saleable stock in this branch. Check the reference
              facts or reduce the quantity.
            </p>
          ) : (
            <Table>
              <caption className="sr-only">
                Exact equivalents ranked by contribution for {quantityCanonicalUnits} canonical
                units
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Brand / lot</TableHead>
                  <TableHead numeric>Available units</TableHead>
                  <TableHead numeric>MRP total</TableHead>
                  <TableHead numeric>Cost total</TableHead>
                  <TableHead numeric>Contribution</TableHead>
                  <TableHead numeric>Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposals.map((proposal) => (
                  <TableRow key={proposal.inventoryLotId}>
                    <TableCell>
                      <p className="font-medium">
                        {proposal.displayName} · {proposal.strength}
                      </p>
                      <p className="text-xs text-text-muted">
                        {proposal.dosageForm} · {proposal.route}
                      </p>
                      <p className="break-all font-mono text-xs text-text-muted">
                        Lot {proposal.inventoryLotId}
                      </p>
                    </TableCell>
                    <TableCell numeric>{proposal.availableCanonicalUnits}</TableCell>
                    <TableCell numeric className="whitespace-nowrap">
                      {money(proposal.priceMinor)}
                    </TableCell>
                    <TableCell numeric className="whitespace-nowrap">
                      {money(proposal.costMinor)}
                    </TableCell>
                    <TableCell numeric className="whitespace-nowrap">
                      {money(proposal.marginMinor)}
                    </TableCell>
                    <TableCell numeric>{(proposal.marginBps / 100).toFixed(2)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      ) : null}
    </main>
  );
}
