'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type BusinessChartPoint = { label: string; value: number | null; previous?: number | null };

export function reportMoney(minor: number, currency?: string | null) {
  const value = (minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${value}` : `${value} (currency unconfirmed)`;
}

/** Common dashboard chart for a named period. The table also works before hydration. */
export function BusinessChart({
  title,
  points,
  empty,
  format,
  comparison = false,
  line = false,
}: {
  title: string;
  points: BusinessChartPoint[];
  empty: string;
  format: (value: number) => string;
  comparison?: boolean;
  line?: boolean;
}) {
  if (!points.some((point) => point.value || point.previous)) {
    return (
      <p className="text-sm text-text-muted">
        {points.some((point) => point.value === null)
          ? 'No recorded value for this period.'
          : empty}
      </p>
    );
  }
  const Chart = line ? LineChart : BarChart;
  return (
    <figure aria-label={title} className="min-w-0">
      <div className="h-56 w-full min-w-0" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <Chart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              minTickGap={18}
            />
            <YAxis
              width={48}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickFormatter={(value) =>
                Intl.NumberFormat(undefined, { notation: 'compact' }).format(Number(value) / 100)
              }
            />
            <Tooltip
              formatter={(value) => format(Number(value))}
              contentStyle={{
                background: 'var(--surface-card)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-strong)',
              }}
            />
            {comparison && (
              <Line
                dataKey="previous"
                name="Previous 30 days"
                stroke="var(--text-muted)"
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {line ? (
              <Line
                dataKey="value"
                name={title}
                stroke="var(--text-strong)"
                strokeWidth={2}
                dot={false}
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
          </Chart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Period or category</th>
            <th>Value</th>
            {comparison && <th>Previous 30 days</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{point.value == null ? 'No recorded value' : format(point.value)}</td>
              {comparison && (
                <td>{point.previous == null ? 'No recorded value' : format(point.previous)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
