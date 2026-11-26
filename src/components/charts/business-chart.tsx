'use client';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';

export type BusinessChartPoint = {
  label: string;
  value: number | null;
  previous?: number | null;
  previousKey?: string;
  secondary?: number | null;
  key?: string;
};
export function reportMoney(minor: number, currency?: string | null) {
  const value = (minor / 100).toLocaleString('en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? currency + ' ' + value : value + ' (currency unconfirmed)';
}
export function BusinessChart({
  title,
  points,
  empty,
  format,
  comparison = false,
  line = false,
  secondaryLabel,
  onSelect,
  onSelectPrevious,
  unitScale = 100,
}: {
  title: string;
  points: BusinessChartPoint[];
  empty: string;
  format: (n: number) => string;
  comparison?: boolean;
  line?: boolean;
  secondaryLabel?: string;
  onSelect?: (point: BusinessChartPoint) => void;
  onSelectPrevious?: (point: BusinessChartPoint) => void;
  unitScale?: number;
}) {
  if (!points.length) return <p className="py-8 text-sm text-text-muted">{empty}</p>;
  const tick = { fill: 'var(--text-muted)', fontSize: 11 };
  return (
    <figure aria-label={title} className="min-w-0">
      <div className="h-56 w-full min-w-0" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart
            data={points}
            accessibilityLayer={false}
            margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
            onClick={(state) => {
              const point = points[Number(state.activeIndex)];
              if (point) onSelect?.(point);
            }}
          >
            <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
            <XAxis
              dataKey="label"
              tick={tick}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(label) =>
                String(label).length > 13 ? String(label).slice(0, 12) + '…' : String(label)
              }
            />
            <YAxis
              width={46}
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={(n) =>
                Intl.NumberFormat('en', { notation: 'compact' }).format(Number(n) / unitScale)
              }
            />
            <Tooltip
              formatter={(v) => format(Number(v))}
              cursor={{ stroke: 'var(--border-default)', fill: 'var(--surface-sunken)' }}
              contentStyle={{
                background: 'var(--surface-card)',
                color: 'var(--text-strong)',
                borderColor: 'var(--border-default)',
              }}
            />
            {comparison && (
              <Line
                dataKey="previous"
                name="Previous period"
                activeDot={
                  onSelectPrevious
                    ? ({ cx, cy, payload }) => (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={5}
                          fill="var(--text-muted)"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectPrevious(payload);
                          }}
                        />
                      )
                    : undefined
                }
                stroke="var(--text-muted)"
                strokeOpacity={0.65}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {secondaryLabel && (
              <Line
                dataKey="secondary"
                name={secondaryLabel}
                stroke="var(--text-muted)"
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {line ? (
              <Line
                dataKey="value"
                name={title}
                stroke="var(--accent-brand)"
                strokeWidth={2.5}
                dot={{ r: 2 }}
                isAnimationActive={false}
              />
            ) : (
              <Bar
                dataKey="value"
                name={title}
                fill="var(--text-strong)"
                maxBarSize={44}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {comparison && <p className="text-xs text-text-muted">Dashed line · Previous period</p>}
      {secondaryLabel && <p className="text-xs text-text-muted">Dotted line · {secondaryLabel}</p>}
      <details className="mt-3">
        <summary className="cursor-pointer py-2 text-sm font-medium focus-visible:outline-ring">
          Chart values and details
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className="text-left">
                  Group
                </th>
                <th scope="col" className="text-right">
                  Value
                </th>
                {comparison && <th scope="col">Previous</th>}
                {secondaryLabel && <th scope="col">{secondaryLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr className="border-t border-border-subtle" key={p.key ?? i}>
                  <th scope="row" className="text-left">
                    {onSelect ? (
                      <Button type="button" variant="ghost" onClick={() => onSelect(p)}>
                        {p.label}
                      </Button>
                    ) : (
                      p.label
                    )}
                  </th>
                  <td className="text-right">
                    {p.value == null ? 'Unavailable' : format(p.value)}
                  </td>
                  {comparison && (
                    <td className="text-right">
                      {onSelectPrevious && p.previousKey ? (
                        <Button
                          variant="ghost"
                          aria-label={'Previous period, ' + p.previousKey}
                          onClick={() => onSelectPrevious(p)}
                        >
                          {p.previous == null ? 'Unavailable' : format(p.previous)}
                        </Button>
                      ) : p.previous == null ? (
                        '—'
                      ) : (
                        format(p.previous)
                      )}
                    </td>
                  )}
                  {secondaryLabel && (
                    <td className="text-right">
                      {p.secondary == null ? '—' : format(p.secondary)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
