'use client';

import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

import {
  diagnosticAmount,
  profitabilityDiagnostics,
  type ProfitabilityDiagnostics,
} from './profitability-diagnostics';

export type { ProfitabilityDiagnostics } from './profitability-diagnostics';

const reasons: Record<string, string> = {
  NO_RECIPE: 'Link a recipe',
  RECIPE_UNAVAILABLE: 'Review the active recipe version',
  NO_PORTION_COST: 'Review recipe portion yield',
  MISSING_INGREDIENT_COST: 'Complete ingredient costs',
};

function DiagnosticsPanel({ diagnostics }: { diagnostics: ProfitabilityDiagnostics }) {
  if (diagnostics.status === 'unavailable') {
    return (
      <SectionCard title="Recipe review priorities">
        <p role="status">{diagnostics.reason}</p>
      </SectionCard>
    );
  }
  let result;
  try {
    result = profitabilityDiagnostics(diagnostics.report);
  } catch {
    return (
      <SectionCard title="Recipe review priorities">
        <p role="alert">
          Diagnostics unavailable. Check the report amounts and select valid business dates, up to
          90 days.
        </p>
      </SectionCard>
    );
  }
  const { report, currency, scopeLabel } = diagnostics;
  const amount = (value: string) => diagnosticAmount(value, currency);
  return (
    <SectionCard title="Recipe review priorities" className="space-y-4">
      <div className="space-y-2 text-sm text-text-muted">
        <p>
          {report.range.from} to {report.range.to} · {scopeLabel} · {currency || 'Currency unknown'}{' '}
          · Business dates
        </p>
        <p>
          Source: existing food-cost reader, sales and recipe costing. Recipe-cost freshness
          unavailable.
        </p>
        <StatusPill
          status={report.truncated ? 'Partial sample' : 'Returned report rows'}
          tone={report.truncated ? 'warning' : 'neutral'}
        />
        <p>
          {result.costedCount} products with costed sales; {result.gapCount} with excluded sales;{' '}
          {result.productCount} distinct products returned. A product can have both.{' '}
          {report.truncated
            ? 'Rankings and concentration cover returned rows only; omitted sales may change priorities.'
            : 'Coverage describes this report, not the entire menu.'}
        </p>
        <p>
          Theoretical contribution = net sales − theoretical recipe cost for costed sales. It is not
          net profit or cash. Payroll, marketplace fees and actual inventory variance are not
          included. Unknown recipe cost is not zero.
        </p>
      </div>
      {!result.productCount ? (
        <p>No sales rows in this period. Check the report filters.</p>
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h4 className="font-semibold text-text-strong">
              Largest negative theoretical contributions
            </h4>
            <p className="text-sm text-text-muted">
              Review recipe quantities, yield, ingredient costs and recorded sales before deciding
              on menu changes.
            </p>
            {result.negative.length ? (
              <>
                <p className="text-sm text-text-muted">
                  Top {result.negative.length} of {result.negativeCount}: {result.concentration}% of
                  returned negative contribution magnitude ({amount(result.topTotal)} /{' '}
                  {amount(result.negativeTotal)}).
                </p>
                <div
                  role="region"
                  aria-label="Negative theoretical contributions"
                  tabIndex={0}
                  className="max-w-full overflow-x-auto rounded-sm border border-border-subtle focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <table className="w-full min-w-[36rem] text-sm">
                    <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                      <tr>
                        <th className="p-3 text-left">Product</th>
                        <th className="p-3 text-right">Quantity</th>
                        <th className="p-3 text-right">Net sales</th>
                        <th className="p-3 text-right">Recipe cost</th>
                        <th className="p-3 text-right">Contribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.negative.map((row) => (
                        <tr
                          key={row.productId}
                          className="border-t border-border-subtle hover:bg-surface-sunken"
                        >
                          <th scope="row" className="p-3 text-left font-medium">
                            {row.productName}
                          </th>
                          <td className="p-3 text-right tabular-nums">{row.quantity}</td>
                          <td className="p-3 text-right tabular-nums">{amount(row.netSales)}</td>
                          <td className="p-3 text-right tabular-nums">
                            {amount(row.theoreticalCost)}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {amount(row.contribution)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-sm text-text-muted">
                No known negative contributions in returned costed sales. This does not establish
                profitability for uncosted sales.
              </p>
            )}
          </div>
          <div className="min-w-0 space-y-3">
            <h4 className="font-semibold text-text-strong">
              Largest cost-coverage gaps by net sales
            </h4>
            <p className="text-sm text-text-muted">
              Top {result.gaps.length} of {result.gapCount} products with excluded sales. Sales
              exposure is not realized loss. Resolve coverage before comparing margins.
            </p>
            {result.gaps.length ? (
              <div
                role="region"
                aria-label="Cost coverage priorities"
                tabIndex={0}
                className="max-w-full overflow-x-auto rounded-sm border border-border-subtle focus-visible:outline-2 focus-visible:outline-ring"
              >
                <table className="w-full min-w-[32rem] text-sm">
                  <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                    <tr>
                      <th className="p-3 text-left">Product / review</th>
                      <th className="p-3 text-right">Quantity</th>
                      <th className="p-3 text-right">Uncosted net sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.gaps.map((row) => (
                      <tr
                        key={row.productId}
                        className="border-t border-border-subtle hover:bg-surface-sunken"
                      >
                        <th scope="row" className="p-3 text-left font-medium">
                          {row.productName}
                          <span className="mt-1 block font-normal text-text-muted">
                            {row.reasons
                              .map((reason) => reasons[reason] ?? 'Review recipe coverage')
                              .join('; ')}
                          </span>
                        </th>
                        <td className="p-3 text-right tabular-nums">{row.quantity}</td>
                        <td className="p-3 text-right tabular-nums">{amount(row.netSales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                No recipe-cost exclusions in returned sales.
              </p>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export function ProfitabilityReportTabs({
  foodCost,
  dishProfitability,
  catering,
  diagnostics,
}: {
  foodCost: ReactNode;
  dishProfitability: ReactNode;
  catering: ReactNode;
  diagnostics?: ProfitabilityDiagnostics;
}) {
  return (
    <Tabs defaultValue="food-cost">
      <TabsList aria-label="Profitability reports">
        <TabsTrigger value="food-cost">Food cost</TabsTrigger>
        <TabsTrigger value="dish-profitability">Dish profitability</TabsTrigger>
        <TabsTrigger value="catering">Catering</TabsTrigger>
      </TabsList>
      <TabsContent value="food-cost" className="space-y-6">
        {diagnostics ? <DiagnosticsPanel diagnostics={diagnostics} /> : null}
        {foodCost}
      </TabsContent>
      <TabsContent value="dish-profitability" className="space-y-6">
        {diagnostics ? <DiagnosticsPanel diagnostics={diagnostics} /> : null}
        {dishProfitability}
      </TabsContent>
      <TabsContent value="catering">{catering}</TabsContent>
    </Tabs>
  );
}
