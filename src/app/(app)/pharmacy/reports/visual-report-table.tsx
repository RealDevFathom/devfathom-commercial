'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import type { ChartRow } from '@/lib/pharmacy/visual-chart';

export function VisualReportTable({
  rows,
  title,
  scope,
  format,
  select,
  unit,
  currency,
  extra,
}: {
  rows: ChartRow[];
  unit: 'percent' | 'money' | 'units';
  currency: string | null;
  title: string;
  scope: string;
  format: (value: number) => string;
  select: (row: ChartRow) => void;
  extra?: { label: string; format: (row: ChartRow) => string };
}) {
  const [search, setSearch] = useState(''),
    [sort, setSort] = useState<'label' | 'value'>('value'),
    [asc, setAsc] = useState(false);
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState(false);
  const visible = rows
    .filter((row) => row.label.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sort === 'value' && (a.value === null || b.value === null))
        return Number(a.value === null) - Number(b.value === null);
      const primary =
        sort === 'label' ? a.label.localeCompare(b.label) : (a.value ?? 0) - (b.value ?? 0);
      return (asc ? primary : -primary) || a.key.localeCompare(b.key);
    });
  function sortBy(next: typeof sort) {
    setAsc(next === sort ? !asc : next === 'label');
    setSort(next);
  }
  async function excel() {
    setExporting(true);
    setError(false);
    try {
      const { reportWorkbook } = await import('@/lib/pharmacy/visual-report-workbook');
      const wb = reportWorkbook(title, scope, visible, unit, currency, extra?.label);
      const bytes = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = title + '.xlsx';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError(true);
    } finally {
      setExporting(false);
    }
  }
  return (
    <SectionCard
      title={title + ' · figures'}
      actions={
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="outline" disabled={!visible.length || exporting} onClick={excel}>
            {exporting ? 'Preparing workbook…' : 'Export to Excel'}
          </Button>
          <Button variant="outline" disabled={!visible.length} onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-text-muted">{scope}</p>
      <label className="mb-4 block max-w-sm text-sm print:hidden">
        Search figures
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {error && <p role="alert">The workbook could not be created. Try exporting again.</p>}
      <Table>
        <TableHeader>
          <TableRow>
            {(['label', 'value'] as const).map((key) => (
              <TableHead
                key={key}
                className={key === 'value' ? 'text-right' : ''}
                aria-sort={key === sort ? (asc ? 'ascending' : 'descending') : 'none'}
              >
                <Button variant="ghost" className="print:hidden" onClick={() => sortBy(key)}>
                  {key === 'label' ? 'Group' : 'Value'} {sort === key ? (asc ? '↑' : '↓') : ''}
                </Button>
                <span className="hidden print:inline">{key === 'label' ? 'Group' : 'Value'}</span>
              </TableHead>
            ))}
            {extra && <TableHead className="text-right">{extra.label}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                <Button variant="ghost" className="print:hidden" onClick={() => select(row)}>
                  {row.label}
                </Button>
                <span className="hidden print:inline">{row.label}</span>
                {row.excluded > 0 && (
                  <span className="block text-xs text-warning">{row.excluded} excluded</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.value === null ? 'Unavailable' : format(row.value)}
              </TableCell>
              {extra && (
                <TableCell className="text-right tabular-nums">{extra.format(row)}</TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!visible.length && (
        <p className="py-4 text-sm text-text-muted">
          {rows.length
            ? 'No matching groups. Change the search.'
            : 'No figures for these dates and branches.'}
        </p>
      )}
    </SectionCard>
  );
}
