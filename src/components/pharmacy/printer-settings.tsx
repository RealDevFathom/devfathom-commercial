'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  counterFormatFromLayout,
  printPrinterTestPage,
  type PrinterTestFormat,
} from '@/lib/pharmacy/counter-browser-print';
import type { CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import type { ReceiptLayout } from '@/lib/receipts/configuration';
import { trpc } from '@/lib/trpc';

import { PharmacyPrintBridges } from './print-bridges';

const controlClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

const PAPER_OPTIONS: { value: PrinterTestFormat; label: string }[] = [
  { value: 'THERMAL', label: 'Thermal receipt printer · 80 mm' },
  { value: 'THERMAL_58', label: 'Thermal receipt printer · 58 mm' },
  { value: 'A4', label: 'Standard printer · A4 sheet' },
];

/** The saved layout with only the paper fields replaced; every other field is preserved. */
export function layoutWithPaper(layout: ReceiptLayout, paper: PrinterTestFormat): ReceiptLayout {
  if (paper === 'A4') return { ...layout, browserPaper: 'A4' };
  const thermal: ReceiptLayout = { ...layout, paperWidth: paper === 'THERMAL_58' ? 58 : 80 };
  delete thermal.browserPaper;
  return thermal;
}

type Notice = { tone: 'status' | 'alert'; text: string };

function BranchPrinterForm({
  branchId,
  branchName,
  layout,
  revision,
  canSave,
}: {
  branchId: string;
  branchName: string;
  layout: ReceiptLayout;
  revision: number;
  canSave: boolean;
}) {
  const utils = trpc.useUtils();
  const saved = counterFormatFromLayout(layout) as PrinterTestFormat;
  const [paper, setPaper] = useState<PrinterTestFormat>(saved);
  const [testLocale, setTestLocale] = useState<CounterReceiptLocale>('en');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [testNotice, setTestNotice] = useState<Notice | null>(null);
  const save = trpc.pharmacySales.counterSaveReceiptFormat.useMutation({
    onSuccess: async () => {
      setNotice({ tone: 'status', text: `Saved for ${branchName}.` });
      await utils.pharmacySales.counterReceiptFormat.invalidate({ branchId });
    },
    onError: (error) =>
      setNotice({
        tone: 'alert',
        text:
          error.data?.code === 'CONFLICT'
            ? 'These settings changed elsewhere. Reload the page, then save again.'
            : error.data?.code === 'FORBIDDEN'
              ? 'Only a workspace administrator can change printer settings.'
              : 'Printer settings were not saved. Check your connection and try again.',
      }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || save.isPending) return;
    setNotice(null);
    save.mutate({ branchId, revision, layout: layoutWithPaper(layout, paper) });
  }

  async function testPrint() {
    setTestNotice(null);
    try {
      await printPrinterTestPage(paper, testLocale, branchName);
      setTestNotice({
        tone: 'status',
        text: 'Print dialog opened. Choose your printer and matching paper, then check that the ruler line fits on one line. DevFathom cannot see whether the page printed or the dialog was cancelled.',
      });
    } catch (error) {
      setTestNotice({
        tone: 'alert',
        text: error instanceof Error ? error.message : 'The print dialog could not open.',
      });
    }
  }

  const dirty = paper !== saved;

  return (
    <div className="space-y-6">
      <form className="space-y-4" onSubmit={submit} aria-describedby="printer-paper-help">
        <div className="max-w-md">
          <Label htmlFor="printer-paper">Receipt printer and paper</Label>
          <StudioSelect
            id="printer-paper"
            className={controlClass}
            value={paper}
            disabled={!canSave || save.isPending}
            onChange={(event) => {
              setPaper(event.target.value as PrinterTestFormat);
              setNotice(null);
            }}
          >
            {PAPER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </StudioSelect>
        </div>
        <p id="printer-paper-help" className="max-w-prose text-sm text-text-muted">
          The counter opens receipts on this paper for {branchName}; a cashier can still change it
          for one session. Thermal ESC/POS jobs use the saved roll width (now {layout.paperWidth}{' '}
          mm). A4 uses the ordinary browser / OS print dialog.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-11"
            type="submit"
            disabled={!canSave || !dirty || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save printer settings'}
          </Button>
          {dirty ? (
            <StatusPill status="unsaved" tone="warning" label="Unsaved change" />
          ) : (
            <StatusPill status="saved" tone="success" label="Saved" />
          )}
        </div>
        {!canSave ? (
          <p className="text-sm text-text-muted">
            Only a workspace administrator can change printer settings. You can still print a test
            page.
          </p>
        ) : null}
        {notice ? (
          <p
            role={notice.tone}
            className={
              notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'
            }
          >
            {notice.text}
          </p>
        ) : null}
      </form>

      <div className="space-y-4 border-t border-border-subtle pt-6">
        <h3 className="text-base font-semibold text-text-strong">Test print</h3>
        <p className="max-w-prose text-sm text-text-muted">
          Prints a sample page on the paper selected above. It has no sale, receipt number or
          amount. A successful test here does not certify a printer model: confirm on your own
          device that text is sharp and the ruler line does not wrap.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="printer-test-locale">Test language</Label>
            <StudioSelect
              id="printer-test-locale"
              className={controlClass}
              value={testLocale}
              onChange={(event) => setTestLocale(event.target.value as CounterReceiptLocale)}
            >
              <option value="en">English</option>
              <option value="ur">اردو</option>
            </StudioSelect>
          </div>
          <Button className="min-h-11" type="button" variant="outline" onClick={testPrint}>
            Print test page
          </Button>
        </div>
        {testNotice ? (
          <p
            role={testNotice.tone}
            className={
              testNotice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'
            }
          >
            {testNotice.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * DEV-742: branch receipt printer settings and a browser/OS test print for
 * pharmacy. Saving is enforced server-side (administrators only); this console
 * only reflects that. No restaurant kitchen routing is offered here.
 * DEV-904: administrators also enrol and revoke the branch's thermal print bridges.
 */
export function PharmacyPrinterSettingsConsole({ canSave }: { canSave: boolean }) {
  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
  });
  const branches = branchesQuery.data?.branches ?? [];
  const [selected, setSelected] = useState('');
  const branchId = branches.some((branch) => branch.id === selected)
    ? selected
    : (branches[0]?.id ?? '');
  const branch = branches.find((candidate) => candidate.id === branchId);
  const format = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    { enabled: branchId !== '', retry: false }
  );

  if (branchesQuery.isLoading) {
    return (
      <SectionCard title="Receipt printer" titleLevel={2}>
        <p className="text-sm text-text-muted" role="status">
          Loading branches…
        </p>
      </SectionCard>
    );
  }
  if (branchesQuery.isError) {
    return (
      <SectionCard title="Receipt printer" titleLevel={2}>
        <p className="text-sm text-destructive" role="alert">
          Branches could not be loaded. Reload the page to try again.
        </p>
      </SectionCard>
    );
  }
  if (!branch) {
    return (
      <SectionCard title="Receipt printer" titleLevel={2}>
        <p className="text-sm text-text-body">
          No active pharmacy branch is available. Add or activate a branch first.
        </p>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard title="Receipt printer" titleLevel={2}>
        <div className="space-y-6">
          <div className="max-w-md">
            <Label htmlFor="printer-branch">Branch</Label>
            <StudioSelect
              id="printer-branch"
              className={controlClass}
              value={branchId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {branches.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.code})
                </option>
              ))}
            </StudioSelect>
          </div>
          {format.isLoading ? (
            <p className="text-sm text-text-muted" role="status">
              Loading saved printer settings…
            </p>
          ) : format.isError || !format.data ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive" role="alert">
                Saved printer settings for {branch.name} could not be loaded. Nothing was changed.
              </p>
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                onClick={() => void format.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <BranchPrinterForm
              key={`${branchId}:${format.data.revision}`}
              branchId={branchId}
              branchName={branch.name}
              layout={format.data.layout}
              revision={format.data.revision}
              canSave={canSave}
            />
          )}
        </div>
      </SectionCard>
      {canSave ? (
        <SectionCard title="Thermal print bridges" titleLevel={2}>
          <PharmacyPrintBridges key={branchId} branchId={branchId} branchName={branch.name} />
        </SectionCard>
      ) : null}
    </>
  );
}
