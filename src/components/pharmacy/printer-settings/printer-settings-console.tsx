'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import {
  counterFormatForSettings,
  type PharmacyReceiptOutput,
} from '@/lib/pharmacy/printer-settings';
import {
  buildPrinterTestPage,
  openPrinterTestPage,
  PrinterTestPrintError,
  type PrinterTestFormat,
} from '@/lib/pharmacy/printer-test-print';
import { thermalPaperForWidth } from '@/lib/pharmacy/print-job-ui';
import { ThermalBridgePanel } from './thermal-bridge-panel';

type PaperWidth = 58 | 80;
type Draft = {
  branchId: string;
  revision: number;
  paperWidth: PaperWidth;
  output: PharmacyReceiptOutput;
};
type TestStatus =
  | { kind: 'idle' }
  | { kind: 'opened'; format: PrinterTestFormat }
  | { kind: 'confirmed'; format: PrinterTestFormat }
  | { kind: 'problem'; format: PrinterTestFormat }
  | { kind: 'error'; message: string };

const OPTION =
  'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border-default bg-surface-page px-3 py-2.5 transition-colors hover:bg-surface-sunken has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60';
const SELECT =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 py-2 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export const PAPER_LABEL: Record<PrinterTestFormat, string> = {
  THERMAL: 'Thermal roll · 80 mm',
  THERMAL_58: 'Thermal roll · 58 mm',
  A4: 'A4 sheet',
};

const WIDTH_OPTIONS: ReadonlyArray<{ value: PaperWidth; label: string; hint: string }> = [
  {
    value: 80,
    label: '80 mm roll',
    hint: 'Most counter thermal printers. 48 characters per line.',
  },
  { value: 58, label: '58 mm roll', hint: 'Compact printers. 32 characters per line.' },
];
const OUTPUT_OPTIONS: ReadonlyArray<{ value: PharmacyReceiptOutput; label: string; hint: string }> =
  [
    { value: 'THERMAL', label: 'Thermal roll', hint: 'Uses the roll width above.' },
    { value: 'A4', label: 'A4 sheet', hint: 'An office printer with normal paper.' },
  ];

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } } | null)?.data?.code;
}

function testErrorMessage(error: unknown): string {
  if (error instanceof PrinterTestPrintError && error.code === 'POPUP_BLOCKED') {
    return 'Your browser blocked the print window. Allow pop-ups for this site, then select Print test page again.';
  }
  return 'The print dialog did not open. Select Print test page again. If it keeps failing, reload this page.';
}

/**
 * DEV-742: branch printer settings and a browser/OS test print for the pharmacy.
 * Saving needs an administrator (the server enforces it; `canEdit` only shapes the UI).
 * Reading and test printing need counter access to the chosen branch.
 */
export function PharmacyPrinterSettings({ canEdit }: { canEdit: boolean }) {
  const ids = useId();
  const utils = trpc.useUtils();
  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
  });
  const branches = branchesQuery.data?.branches ?? [];
  const [selectedBranch, setSelectedBranch] = useState('');
  const branchId = branches.some((branch) => branch.id === selectedBranch)
    ? selectedBranch
    : (branches[0]?.id ?? '');
  const branch = branches.find((row) => row.id === branchId);

  const formatQuery = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    // An audited read, and a focus refetch must not silently replace an admin's draft.
    { enabled: Boolean(branchId), retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false }
  );
  const saved = formatQuery.data;
  const save = trpc.pharmacySales.counterSaveReceiptFormat.useMutation();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveMessage, setSaveMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [testFormat, setTestFormat] = useState<{
    branchId: string;
    format: PrinterTestFormat;
  } | null>(null);
  const [testLocale, setTestLocale] = useState<CounterReceiptLocale>('en');
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });

  const current =
    saved && draft && draft.branchId === branchId && draft.revision === saved.revision
      ? draft
      : saved
        ? {
            branchId,
            revision: saved.revision,
            paperWidth: saved.layout.paperWidth,
            output: saved.output,
          }
        : null;
  const dirty =
    !!saved &&
    !!current &&
    (current.paperWidth !== saved.layout.paperWidth || current.output !== saved.output);
  const savedFormat = saved ? counterFormatForSettings(saved) : 'THERMAL';
  const chosenTestFormat =
    testFormat && testFormat.branchId === branchId ? testFormat.format : savedFormat;
  const editable = canEdit && !!saved && !save.isPending;

  function update(change: Partial<Pick<Draft, 'paperWidth' | 'output'>>) {
    if (!current) return;
    setDraft({ ...current, ...change });
    setSaveMessage(null);
    setConflict(false);
  }

  async function submit() {
    if (!saved || !current || !branch || !dirty) return;
    setSaveMessage(null);
    setConflict(false);
    try {
      const result = await save.mutateAsync({
        branchId,
        revision: saved.revision,
        // Header, footer and other shared layout text are carried through untouched.
        layout: { ...saved.layout, paperWidth: current.paperWidth },
        output: current.output,
      });
      // A read started before the save must not overwrite the newer revision afterwards.
      await utils.pharmacySales.counterReceiptFormat.cancel({ branchId });
      utils.pharmacySales.counterReceiptFormat.setData({ branchId }, result);
      setDraft(null);
      setSaveMessage({
        tone: 'success',
        text: `Saved for ${branch.name}. The counter opens with ${PAPER_LABEL[counterFormatForSettings(result)]} from its next load; staff can still switch paper for a single receipt.`,
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'CONFLICT') {
        setConflict(true);
        setSaveMessage({
          tone: 'error',
          text: 'Someone else changed this branch’s printer settings, so nothing was saved. Reload them, then make your change again.',
        });
      } else if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
        setSaveMessage({
          tone: 'error',
          text: 'You don’t have permission to change printer settings. Nothing was saved.',
        });
      } else {
        setSaveMessage({
          tone: 'error',
          text: 'The settings could not be saved. Your changes are still here; try Save again.',
        });
      }
    }
  }

  function printTest() {
    if (!branch) return;
    try {
      const html = buildPrinterTestPage({
        format: chosenTestFormat,
        locale: testLocale,
        branchName: branch.name,
        printedAt: new Date(),
        timeZone: branchesQuery.data?.timezone,
      });
      openPrinterTestPage(html);
      setTestStatus({ kind: 'opened', format: chosenTestFormat });
    } catch (error) {
      setTestStatus({ kind: 'error', message: testErrorMessage(error) });
    }
  }

  if (branchesQuery.isPending) {
    return (
      <SectionCard>
        <p role="status" className="text-sm text-text-muted">
          Loading branches…
        </p>
      </SectionCard>
    );
  }
  if (branchesQuery.isError) {
    return (
      <SectionCard title="Branches could not be loaded" titleLevel={2}>
        <p role="alert" className="text-sm text-text-body">
          Printer settings are unchanged. Check your connection and try again.
        </p>
        <Button
          className="mt-3"
          size="touch"
          variant="outline"
          onClick={() => void branchesQuery.refetch()}
        >
          Try again
        </Button>
      </SectionCard>
    );
  }
  if (!branches.length) {
    return (
      <SectionCard title="No active branches" titleLevel={2}>
        <p className="text-sm text-text-body">
          Add or reactivate a pharmacy branch before setting up its printers.
        </p>
      </SectionCard>
    );
  }

  const denied = formatQuery.isError && errorCode(formatQuery.error) === 'FORBIDDEN';
  const readOnlyNote = `${ids}-read-only`;

  return (
    <div className="min-w-0 space-y-6">
      <SectionCard>
        <label
          className="block max-w-md space-y-2 text-sm font-medium text-text-strong"
          htmlFor={`${ids}-branch`}
        >
          Branch
        </label>
        <select
          id={`${ids}-branch`}
          className={`${SELECT} mt-2 max-w-md`}
          value={branchId}
          disabled={dirty || save.isPending}
          aria-describedby={dirty ? `${ids}-branch-hint` : undefined}
          onChange={(event) => {
            setSelectedBranch(event.target.value);
            setDraft(null);
            setSaveMessage(null);
            setConflict(false);
            setTestStatus({ kind: 'idle' });
          }}
        >
          {branches.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        {dirty ? (
          <p id={`${ids}-branch-hint`} className="mt-2 text-xs text-text-muted">
            Save or discard your changes before switching branch.
          </p>
        ) : null}
      </SectionCard>

      {formatQuery.isPending ? (
        <SectionCard>
          <p role="status" className="text-sm text-text-muted">
            Loading printer settings for {branch?.name}…
          </p>
        </SectionCard>
      ) : denied ? (
        <SectionCard title="This branch is not available to you" titleLevel={2}>
          <p role="alert" className="text-sm text-text-body">
            You need counter access at {branch?.name} to open its printer settings. Choose another
            branch above, or ask a workspace administrator for access.
          </p>
        </SectionCard>
      ) : formatQuery.isError || !saved || !current ? (
        <SectionCard title="Printer settings could not be loaded" titleLevel={2}>
          <p role="alert" className="text-sm text-text-body">
            Nothing was changed. Try again, or ask an administrator to check this branch’s saved
            printer settings.
          </p>
          <Button
            className="mt-3"
            size="touch"
            variant="outline"
            onClick={() => void formatQuery.refetch()}
          >
            Try again
          </Button>
        </SectionCard>
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <SectionCard
            title="Saved paper for this branch"
            titleLevel={2}
            actions={<StatusPill status="saved" tone="neutral" label={PAPER_LABEL[savedFormat]} />}
          >
            <form
              className="space-y-5"
              aria-describedby={canEdit ? undefined : readOnlyNote}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {!canEdit ? (
                <p
                  id={readOnlyNote}
                  className="rounded-sm bg-surface-sunken px-3 py-2 text-sm text-text-body"
                >
                  Only a workspace administrator can change saved printer settings. You can still
                  print a test page below.
                </p>
              ) : null}
              <fieldset className="space-y-2" disabled={!editable}>
                <legend className="text-sm font-semibold text-text-strong">
                  Thermal roll width
                </legend>
                {WIDTH_OPTIONS.map((option) => (
                  <label key={option.value} className={OPTION}>
                    <input
                      type="radio"
                      name={`${ids}-width`}
                      value={option.value}
                      checked={current.paperWidth === option.value}
                      onChange={() => update({ paperWidth: option.value })}
                      className="mt-1 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-xs text-text-muted">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-2" disabled={!editable}>
                <legend className="text-sm font-semibold text-text-strong">
                  Paper the counter starts with
                </legend>
                {OUTPUT_OPTIONS.map((option) => (
                  <label key={option.value} className={OPTION}>
                    <input
                      type="radio"
                      name={`${ids}-output`}
                      value={option.value}
                      checked={current.output === option.value}
                      onChange={() => update({ output: option.value })}
                      className="mt-1 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-xs text-text-muted">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-xs text-text-muted">
                Receipt wording, reprint marks and receipt numbers are not changed here.
              </p>
              {saveMessage ? (
                <p
                  role={saveMessage.tone === 'error' ? 'alert' : 'status'}
                  className={
                    saveMessage.tone === 'error'
                      ? 'text-sm text-destructive'
                      : 'text-sm text-success'
                  }
                >
                  {saveMessage.text}
                </p>
              ) : null}
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="touch" disabled={!editable || !dirty}>
                    {save.isPending ? 'Saving…' : 'Save printer settings'}
                  </Button>
                  {conflict ? (
                    <Button
                      type="button"
                      size="touch"
                      variant="outline"
                      onClick={() => {
                        setDraft(null);
                        setConflict(false);
                        setSaveMessage(null);
                        void formatQuery.refetch();
                      }}
                    >
                      Reload saved settings
                    </Button>
                  ) : dirty ? (
                    <Button
                      type="button"
                      size="touch"
                      variant="outline"
                      disabled={save.isPending}
                      onClick={() => {
                        setDraft(null);
                        setSaveMessage(null);
                      }}
                    >
                      Discard changes
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </form>
          </SectionCard>

          <SectionCard title="Test print" titleLevel={2}>
            <div className="space-y-5">
              <p className="text-sm text-text-body">
                Prints a test page — not a receipt — through your browser’s print dialog. In the
                dialog, choose the printer and the same paper size, set margins to None or Default
                and scale to 100%.
              </p>
              <div className="space-y-2">
                <label
                  className="block text-sm font-semibold text-text-strong"
                  htmlFor={`${ids}-test-paper`}
                >
                  Paper
                </label>
                <select
                  id={`${ids}-test-paper`}
                  className={SELECT}
                  value={chosenTestFormat}
                  onChange={(event) => {
                    setTestFormat({ branchId, format: event.target.value as PrinterTestFormat });
                    setTestStatus({ kind: 'idle' });
                  }}
                >
                  {(Object.keys(PAPER_LABEL) as PrinterTestFormat[]).map((format) => (
                    <option key={format} value={format}>
                      {PAPER_LABEL[format]}
                      {format === savedFormat ? ' (saved)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-text-strong">
                  Test page language
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ['en', 'English', 'en', 'ltr', null],
                      ['ur', 'اردو', 'ur', 'rtl', 'Urdu'],
                    ] as const
                  ).map(([value, label, lang, dir, gloss]) => (
                    <label key={value} className={OPTION}>
                      <input
                        type="radio"
                        name={`${ids}-locale`}
                        value={value}
                        checked={testLocale === value}
                        onChange={() => {
                          setTestLocale(value);
                          setTestStatus({ kind: 'idle' });
                        }}
                        className="mt-1 size-4 shrink-0 accent-primary"
                      />
                      <span className="text-sm font-semibold">
                        {/* Isolate the Urdu word so its direction cannot reorder the gloss. */}
                        <bdi lang={lang} dir={dir}>
                          {label}
                        </bdi>
                        {gloss ? ` (${gloss})` : null}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button type="button" size="touch" onClick={printTest}>
                {testStatus.kind === 'idle' ? 'Print test page' : 'Print test page again'}
              </Button>
              <TestResult
                status={testStatus}
                onConfirm={(format) => setTestStatus({ kind: 'confirmed', format })}
                onProblem={(format) => setTestStatus({ kind: 'problem', format })}
              />
            </div>
          </SectionCard>
        </div>
      )}
      {/* Same condition as the loaded branch view above. */}
      {!formatQuery.isPending && !formatQuery.isError && saved && current ? (
        <ThermalBridgePanel
          branchId={branchId}
          branchName={branch?.name ?? ''}
          canEdit={canEdit}
          savedPaper={{
            paper: thermalPaperForWidth(saved.layout.paperWidth),
            output: saved.output,
          }}
        />
      ) : null}

      <PrinterConnectionGuide />
    </div>
  );
}

function TestResult({
  status,
  onConfirm,
  onProblem,
}: {
  status: TestStatus;
  onConfirm: (format: PrinterTestFormat) => void;
  onProblem: (format: PrinterTestFormat) => void;
}) {
  return (
    <div className="space-y-3">
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}
      {status.kind === 'opened' ? (
        <>
          <p role="status" className="text-sm text-text-body">
            The print dialog was opened for {PAPER_LABEL[status.format]}. DevFathom can’t see
            whether the page printed or the dialog was cancelled. Check the printer, then tell us
            what happened.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              onClick={() => onConfirm(status.format)}
            >
              It printed correctly
            </Button>
            <Button
              type="button"
              size="touch"
              variant="outline"
              onClick={() => onProblem(status.format)}
            >
              It didn’t print or looks wrong
            </Button>
          </div>
        </>
      ) : null}
      {status.kind === 'confirmed' ? (
        <p role="status" className="text-sm text-success">
          You confirmed the test page printed correctly on {PAPER_LABEL[status.format]} from this
          computer. This check is not saved and covers only this computer and printer.
        </p>
      ) : null}
      {status.kind === 'problem' ? (
        <div role="status" className="space-y-2 text-sm text-text-body">
          <p className="font-semibold text-text-strong">Things to check, then print again:</p>
          <ul className="list-disc space-y-1 ps-5">
            <li>If you pressed Cancel, nothing was sent to the printer.</li>
            <li>The print dialog shows the right printer, and it is switched on and online.</li>
            <li>
              The paper size in the dialog matches {PAPER_LABEL[status.format]}, with margins set to
              None or Default and scale at 100%.
            </li>
            <li>
              For thermal printers: the roll is loaded with the printable side facing the head.
            </li>
            <li>
              USB: the cable is firmly connected and the printer appears in this computer’s printer
              list.
            </li>
            <li>
              Network: the printer and this computer are on the same network, and the printer still
              has the address it was added with.
            </li>
            <li>
              Bluetooth: the printer is paired with this computer and added as a printer, not only
              paired.
            </li>
            <li>
              If the Urdu line shows boxes, this computer has no Urdu font for printing; use a
              computer that has one.
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * DEV-742: USB thermal first, with network and Bluetooth kept for other pharmacies. Wording
 * stays connection-level and brand-neutral: nothing is marked compatible until the actual
 * printer, driver and computer pass an authorized real-device test (DEV-744). Direct
 * printing without the dialog goes through an enrolled DEV-741 print bridge
 * (ThermalBridgePanel), never for A4.
 */
const CONNECTIONS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'USB thermal printer (set up first)',
    body: 'Connect the cable, install the printer’s driver so it appears in this computer’s printer list, then print a test page above on 58 mm or 80 mm.',
  },
  {
    title: 'Network thermal printer (Wi-Fi or Ethernet)',
    body: 'Give the printer a fixed address, add it to this computer’s printer list, and keep both on the same network.',
  },
  {
    title: 'Bluetooth thermal printer',
    body: 'Pair it in this computer’s settings and add it as a printer. Some Bluetooth thermal printers have no driver for computers, and printers that use Bluetooth Low Energy only cannot be used from the print dialog.',
  },
  {
    title: 'A4 office printer',
    body: 'Any printer installed on this computer with its own driver. Choose A4 above and print a test page.',
  },
];

function PrinterConnectionGuide() {
  return (
    <SectionCard title="How your printer connects" titleLevel={2}>
      <div className="space-y-4">
        <p className="text-sm text-text-body">
          Receipts and test pages print through this computer’s print dialog, so the printer must be
          installed on this computer. Whether a connection works depends on the printer, its driver
          and the computer’s operating system, not on DevFathom.
        </p>
        <ul className="grid gap-3 md:grid-cols-2">
          {CONNECTIONS.map((connection) => (
            <li
              key={connection.title}
              className="rounded-md border border-border-subtle bg-surface-page px-4 py-3"
            >
              <p className="text-sm font-semibold text-text-strong">{connection.title}</p>
              <p className="mt-1 text-sm text-text-body">{connection.body}</p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-text-muted">
          Sending receipts straight to a thermal printer, without the print dialog, needs an
          enrolled print bridge (see Thermal print bridge above). No printer model or connection is
          listed as supported until it has been tested on real hardware.
        </p>
      </div>
    </SectionCard>
  );
}
