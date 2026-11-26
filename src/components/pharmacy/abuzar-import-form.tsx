'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { SelectField } from '@/components/ui/select-field';

const steps = {
  catalogue: 'Catalogue review',
  parties: 'Suppliers and customers',
  prices: 'Prices and shelf locations',
  stock: 'Opening stock',
  balances: 'Customer and supplier balances',
  history: 'Reference history',
  reconcile: 'Reconciliation',
} as const;
type Step = keyof typeof steps;
const names = [
  'manifest.json',
  'products.csv',
  'parties.csv',
  'stock.csv',
  'balances.csv',
  'history.csv',
];
type Totals = {
  products: number;
  stockUnits: string;
  stockValueMinor: string;
  customerBalanceMinor: string;
  supplierBalanceMinor: string;
};
type Report = {
  confirmation?: string;
  blocked?: boolean;
  create?: number;
  applied?: number;
  source?: { totals: Totals; issues: unknown[] };
  skipped?: { row: number; reason: string }[];
  expected?: Totals;
  actual?: Totals;
  differences?: unknown[];
  effects?: { stockValueMinor: string; customerBalanceMinor: string; supplierBalanceMinor: string };
};
type HistoryRow = {
  sourceId: string;
  kind: string;
  date: string;
  productCode: string | null;
  quantity: string | null;
  amount: string | null;
};
const endpoint = '/api/pharmacy/abuzar-import';
const labels: Record<keyof Totals, string> = {
  products: 'Products',
  stockUnits: 'Stock units',
  stockValueMinor: 'Stock value (paisa)',
  customerBalanceMinor: 'Customer balances (paisa)',
  supplierBalanceMinor: 'Supplier balances (paisa)',
};
export function AbuzarImportForm() {
  const access = trpc.pharmacyOwnerImport.options.useQuery(undefined, { retry: false });
  const [branch, setBranch] = useState(''),
    [location, setLocation] = useState(''),
    [step, setStep] = useState<Step>('catalogue'),
    [sourceBranch, setSourceBranch] = useState(''),
    [cutover, setCutover] = useState(''),
    [files, setFiles] = useState<File[]>([]),
    [existing, setExisting] = useState(false);
  const [witnesses, setWitnesses] = useState<{ id: string; name: string }[]>([]),
    [witness, setWitness] = useState(''),
    [secret, setSecret] = useState('');
  const [report, setReport] = useState<Report | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [posted, setPosted] = useState(false);
  const [query, setQuery] = useState(''),
    [archive, setArchive] = useState<HistoryRow[] | null>(null),
    [next, setNext] = useState<string | null>(null);
  const branchId = branch || access.data?.branches[0]?.id || '';
  const locations = access.data?.locations.filter((l) => l.branchId === branchId) ?? [];
  const loc = location || locations[0]?.id || '';
  useEffect(() => {
    if (step !== 'stock' || !branchId) return;
    const abort = new AbortController();
    fetch(endpoint + '?' + new URLSearchParams({ branch: branchId, list: 'witnesses' }), {
      signal: abort.signal,
    })
      .then(async (r) => {
        if (r.ok) setWitnesses(await r.json());
      })
      .catch(() => {});
    return () => abort.abort();
  }, [branchId, step]);
  const invalidate = () => {
    setReport(null);
    setPosted(false);
    setError('');
  };
  const financial = step === 'stock' || step === 'balances';
  const ready =
    !!branchId &&
    !!sourceBranch.trim() &&
    names.every((n) => files.filter((f) => f.name === n).length === 1) &&
    (!financial || !!cutover) &&
    (step !== 'stock' || !!loc);
  async function submit(apply: boolean) {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      const compress = typeof CompressionStream !== 'undefined';
      if (compress) form.set('encoding', 'gzip');
      for (const name of names) {
        const f = files.find((f) => f.name === name)!;
        if (f.size > 64 * 1024 * 1024) throw new Error('A prepared file exceeds 64 MiB.');
        const body = compress
          ? await new Response(f.stream().pipeThrough(new CompressionStream('gzip'))).blob()
          : f;
        form.set(name, body, name);
      }
      form.set(
        'selection',
        JSON.stringify({
          branchId,
          step,
          sourceBranch: sourceBranch.trim(),
          addToExisting: existing,
          ...(financial ? { cutover } : {}),
          ...(step === 'stock'
            ? { stockLocationId: loc, ...(witness ? { witnessId: witness } : {}) }
            : {}),
          ...(apply ? { confirmed: report?.confirmation } : {}),
        })
      );
      if (apply && step === 'stock' && witness) form.set('witnessSecret', secret);
      const res = await fetch(endpoint, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not process this export.');
      setReport(data);
      setPosted(apply);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : 'Could not process this export.');
    } finally {
      setBusy(false);
      setSecret('');
    }
  }
  async function search(after = '') {
    setBusy(true);
    setError('');
    try {
      const result = await fetch(
        endpoint + '?' + new URLSearchParams({ branch: branchId, document: query, after })
      );
      const json = await result.json();
      if (!result.ok) throw new Error(json.error);
      setArchive((items) => (after ? [...(items ?? []), ...json.rows] : json.rows));
      setNext(json.next);
    } catch {
      setError('Could not read the history archive.');
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'abuzar-' + step + '-report.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!access.data) return null;
  return (
    <SectionCard title="Import a prepared Abuzar export">
      <fieldset disabled={busy} className="grid gap-4" onChange={invalidate}>
        <label>
          Prepared export files
          <Input
            type="file"
            accept=".csv,.json"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <p className="text-sm text-text-muted">
          Choose manifest.json and the products, parties, stock, balances and history CSV files from
          the same export.
        </p>
        <label>
          Destination branch
          <SelectField
            value={branchId}
            onChange={(e) => {
              setBranch(e.target.value);
              setLocation('');
              setWitness('');
              setArchive(null);
              setNext(null);
            }}
          >
            {access.data.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          Source branch code
          <Input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
        </label>
        <label>
          Import step
          <SelectField value={step} onChange={(e) => setStep(e.target.value as Step)}>
            {Object.entries(steps).map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </SelectField>
        </label>
        {financial && (
          <label>
            Cut-over date
            <Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} />
          </label>
        )}
        {step === 'stock' && (
          <>
            <label>
              Stock location
              <SelectField value={loc} onChange={(e) => setLocation(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </SelectField>
            </label>
            <label>
              Controlled stock witness
              <SelectField value={witness} onChange={(e) => setWitness(e.target.value)}>
                <option value="">Leave controlled stock for review</option>
                {witnesses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </SelectField>
            </label>
          </>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={existing}
            onChange={(e) => setExisting(e.target.checked)}
          />
          Add to existing pharmacy with posted sales (owner only)
        </label>
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button disabled={!ready || busy} onClick={() => submit(false)}>
          {busy ? 'Working…' : step === 'reconcile' ? 'Run reconciliation' : 'Preview step'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-destructive">
          {error}
        </p>
      )}
      {report && (
        <div aria-live="polite" className="mt-4 grid gap-3">
          <h3>
            {posted ? 'Step complete' : step === 'reconcile' ? 'Reconciliation' : 'Review totals'}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Source</th>
                  {report.actual && <th scope="col">Imported</th>}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(labels) as (keyof Totals)[]).map((k) => (
                  <tr key={k}>
                    <th scope="row" className="text-left">
                      {labels[k]}
                    </th>
                    <td className="text-right">
                      {(report.source?.totals ?? report.expected)?.[k]}
                    </td>
                    {report.actual && <td className="text-right">{report.actual[k]}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.confirmation && (
            <p>
              {report.create} rows to apply. {report.skipped?.length ?? 0} skipped.
              {posted && ' Applied ' + report.applied + ' rows.'}
            </p>
          )}
          {report.effects && (
            <p>
              Step totals in paisa — stock {report.effects.stockValueMinor}, customer balances{' '}
              {report.effects.customerBalanceMinor}, supplier balances{' '}
              {report.effects.supplierBalanceMinor}.
            </p>
          )}
          {report.blocked && (
            <p role="alert">Posted sales found. The owner must choose Add to existing.</p>
          )}
          {report.differences && <p>{report.differences.length} row differences.</p>}
          {report.skipped?.slice(0, 10).map((s) => (
            <p key={s.row}>
              Row {s.row} · {s.reason}
            </p>
          ))}
          {step === 'stock' && witness && !posted && (
            <label>
              Witness PIN or authenticator code
              <Input
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            {report.confirmation && !posted && (
              <Button
                disabled={
                  !!report.blocked ||
                  busy ||
                  !report.create ||
                  (step === 'stock' && !!witness && !secret)
                }
                onClick={() => submit(true)}
              >
                Confirm totals and apply
              </Button>
            )}
            <Button variant="secondary" onClick={download}>
              Download row report
            </Button>
          </div>
          {posted && step === 'catalogue' && (
            <Link className="underline" href="/pharmacy/medicines/staged">
              Review the staged catalogue
            </Link>
          )}
        </div>
      )}
      <div className="mt-6 grid gap-3">
        <h3>Imported from Abuzar</h3>
        <label>
          Original document number
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setArchive(null);
              setNext(null);
            }}
          />
        </label>
        <div>
          <Button
            variant="secondary"
            disabled={busy || !branchId || !query.trim()}
            onClick={() => search()}
          >
            Search reference history
          </Button>
        </div>
        {archive && <p>{archive.length} matching lines</p>}
        {archive?.map((r) => (
          <p key={r.sourceId}>
            {r.date} · {r.kind} · {r.productCode} · {r.quantity} units · {r.amount}
          </p>
        ))}
        {next && (
          <Button variant="secondary" disabled={busy} onClick={() => search(next)}>
            More history lines
          </Button>
        )}
      </div>
    </SectionCard>
  );
}
