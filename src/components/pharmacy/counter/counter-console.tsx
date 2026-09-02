'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

import { CounterCartPanel } from './counter-cart';
import { CounterKeymapLegend } from './counter-keymap-legend';
import { CounterReceiptView } from './counter-receipt-view';
import { CounterRxPanel } from './counter-rx-panel';
import { CounterSearchResults } from './counter-search-results';
import { CounterTenderPanel, type CounterTenderType } from './counter-tender-panel';
import { CounterUnitToggle } from './counter-unit-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import {
  counterAlertsFor,
  hasBlockingAlert,
  type CounterAlertLine,
} from '@/lib/pharmacy/counter-alerts';
import {
  COUNTER_ACTION_LABELS,
  formatBinding,
  matchCounterAction,
  resolveCounterKeymap,
  shouldHandleCounterKey,
  type CounterAction,
  type CounterKeymapPresetKey,
} from '@/lib/pharmacy/counter-keymap';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { previewSaleLine, type SaleUnitKind } from '@/lib/pharmacy/counter-pricing';
import { formatMinor, type CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import { trpc } from '@/lib/trpc';

type Notice = { tone: 'success' | 'warning' | 'danger' | 'neutral'; message: string };

/**
 * A stable per-browser identifier for the drawer session and receipt sequence.
 *
 * The counter is a workspace page rather than an enrolled terminal, so there is
 * no device record to borrow. Receipt numbers are per (branch, device), so the
 * id must survive a reload — a fresh id every load would restart the sequence
 * and hand two bills the same receipt number.
 *
 * Read on demand rather than held in state: `localStorage` does not exist
 * during the server render, and mirroring it into React state would only add a
 * cascading render to reach the same value.
 */
function counterDeviceId(): string {
  const key = 'devfathom.pharmacy.counter.device';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `counter-${crypto.randomUUID()}`;
  window.localStorage.setItem(key, created);
  return created;
}

/** Today, as the date-only value the settlement tables store. */
function businessDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * UX rule 11: the counter never shows the operator a raw reason code. The
 * mapping itself lives in `counter-messages` so it can be tested without the
 * console's client-side dependencies.
 */
const messageFrom = counterErrorMessage;

/**
 * PH-POS counter — POS-01, POS-02, POS-08 and POS-09 in one keyboard-first
 * surface.
 *
 * The whole bill is composable without a pointer: the scan field holds focus
 * for the life of the bill, the F-key map reaches every workflow, and the
 * prescription panel sits beside the cart so an authorization check never
 * navigates away from a half-composed sale.
 */
export function PharmacyCounterConsole() {
  const utils = trpc.useUtils();

  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [activeRow, setActiveRow] = useState<CounterSearchRow | null>(null);
  const [saleUnit, setSaleUnit] = useState<SaleUnitKind | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [heldSaleId, setHeldSaleId] = useState<string | null>(null);
  const [patientQuery, setPatientQuery] = useState('');
  const [submittedPatientQuery, setSubmittedPatientQuery] = useState('');
  const [patientId, setPatientId] = useState<string | null>(null);
  const [receiptLocale, setReceiptLocale] = useState<CounterReceiptLocale>('en');
  const [receiptFormat, setReceiptFormat] = useState<'THERMAL' | 'A4'>('THERMAL');
  const [receiptRenders, setReceiptRenders] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const rxPanelRef = useRef<HTMLDivElement>(null);
  const tenderRef = useRef<HTMLDivElement>(null);

  // ── Data ──────────────────────────────────────────────────────────────────

  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
  });
  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);

  // Derived, not mirrored into state: the default branch is simply "the first
  // one" until the operator picks another, so an effect would only add a render.
  const branchId = selectedBranchId || (branches[0]?.id ?? '');

  const keymapQuery = trpc.pharmacySales.counterKeymap.useQuery(undefined, { staleTime: 300_000 });
  const keymap = keymapQuery.data ?? resolveCounterKeymap({ preset: 'devfathom' });
  const saveKeymap = trpc.pharmacySales.counterSaveKeymap.useMutation({
    onSuccess: () => {
      void utils.pharmacySales.counterKeymap.invalidate();
      setNotice({ tone: 'success', message: 'Keymap saved for this operator.' });
    },
    onError: (error) => setNotice({ tone: 'danger', message: messageFrom(error) }),
  });

  const searchQuery = trpc.pharmacySales.counterSearch.useQuery(
    { branchId, query: submittedQuery },
    { enabled: Boolean(branchId) && submittedQuery.trim().length >= 2, staleTime: 10_000 }
  );

  const cartQuery = trpc.pharmacySales.counterCart.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: Boolean(branchId && saleId) }
  );

  const receiptQuery = trpc.pharmacySales.counterReceipt.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: Boolean(branchId && saleId) && cartQuery.data?.status === 'COMPLETED' }
  );

  const patientsQuery = trpc.pharmacyPrescriptions.counterPatients.useQuery(
    { query: submittedPatientQuery },
    { enabled: submittedPatientQuery.trim().length >= 2 && patientId === null }
  );

  const patientPanelQuery = trpc.pharmacyPrescriptions.counterPatientPanel.useQuery(
    { patientId: patientId ?? '' },
    { enabled: patientId !== null }
  );

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createSale = trpc.pharmacySales.create.useMutation();
  const addLine = trpc.pharmacySales.addLine.useMutation();
  const transition = trpc.pharmacySales.transition.useMutation();
  const tender = trpc.pharmacySales.tender.useMutation();
  const openDrawer = trpc.pharmacySales.openDrawer.useMutation();
  const captureDemand = trpc.pharmacySales.captureDemand.useMutation();

  const refreshCart = useCallback(async () => {
    await utils.pharmacySales.counterCart.invalidate();
    await utils.pharmacySales.counterReceipt.invalidate();
  }, [utils]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const cart = cartQuery.data ?? null;
  const patient = patientPanelQuery.data ?? null;

  const selectedOption = useMemo(
    () => activeRow?.saleUnits.find((option) => option.kind === saleUnit) ?? null,
    [activeRow, saleUnit]
  );

  const preview = useMemo(() => {
    if (
      !activeRow ||
      !selectedOption ||
      activeRow.printedMrpMinor === null ||
      activeRow.unitsPerPack === null
    ) {
      return null;
    }
    try {
      return previewSaleLine({
        option: selectedOption,
        quantity,
        printedMrpMinor: activeRow.printedMrpMinor,
        unitsPerPack: activeRow.unitsPerPack,
        roundingIncrementMinor: activeRow.roundingIncrementMinor,
        availableUnits: activeRow.onHandUnits,
      });
    } catch {
      return null;
    }
  }, [activeRow, quantity, selectedOption]);

  /**
   * POS-09 alerts for the composed bill.
   *
   * Built from the cart the server returned plus the prescription panel, so an
   * alert always describes a line that really exists and an authorization that
   * really was signed.
   */
  const alerts = useMemo(() => {
    const lines: CounterAlertLine[] = (cart?.lines ?? []).map((line) => {
      const prescriptionLine = patient?.prescriptions
        .flatMap((prescription) => prescription.lines.map((entry) => ({ prescription, entry })))
        .find(({ entry }) => entry.medicineId === line.medicineId);
      return {
        ref: line.saleLineId,
        medicine: {
          medicineId: line.medicineId,
          displayName: line.medicineName,
          rx: line.rx,
          controlled: line.controlled,
          restricted: line.restricted,
          highAlert: line.highAlert,
          lasa: line.lasa,
          coldChain: line.coldChain,
        },
        blocked: [],
        prescription: prescriptionLine
          ? {
              id: prescriptionLine.entry.prescriptionLineId,
              verified: prescriptionLine.entry.verified,
              expiresAt: new Date(prescriptionLine.prescription.validUntil),
              remainingAuthorizedUnits: prescriptionLine.entry.remainingAuthorizedUnits,
            }
          : null,
        requestedCanonicalUnits: line.canonicalUnits,
        nearestSafeExpiry: line.allocations[0] ? new Date(line.allocations[0].expiresAt) : null,
        discountMinor: line.discountMinor,
      };
    });
    return counterAlertsFor(lines, { at: new Date() });
  }, [cart, patient]);

  const blocked = hasBlockingAlert(alerts);
  const balanceMinor = cart ? cart.totals.netMinor - cart.totals.tenderedMinor : 0;
  const busy = pending !== null;
  const lineCount = cart?.lines.length ?? 0;

  // ── Actions ───────────────────────────────────────────────────────────────

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const runSearch = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setNotice({ tone: 'warning', message: 'Type at least two characters to search.' });
      return;
    }
    setSubmittedQuery(trimmed);
  }, [query]);

  const stageRow = useCallback((row: CounterSearchRow) => {
    setActiveRow(row);
    setQuantity(1);
    setSaleUnit(row.saleUnits[0]?.kind ?? null);
  }, []);

  const ensureSale = useCallback(async () => {
    if (saleId) return saleId;
    const created = await createSale.mutateAsync({ branchId, quotation: false });
    setSaleId(created.id);
    return created.id;
  }, [branchId, createSale, saleId]);

  const addToCart = useCallback(async () => {
    if (!activeRow || !selectedOption || !preview || busy) return;
    if (!preview.sufficient) {
      setNotice({
        tone: 'warning',
        message: `Only ${preview.availableUnits} safe units are on hand. Reduce the quantity or capture the shortfall.`,
      });
      return;
    }
    setPending('addToCart');
    setNotice(null);
    try {
      const activeSaleId = await ensureSale();
      await addLine.mutateAsync({
        branchId,
        saleId: activeSaleId,
        medicineId: activeRow.medicineId,
        presentationId: activeRow.presentationId,
        packLevelId: selectedOption.packLevelId,
        saleUnit: selectedOption.kind,
        quantity,
        canonicalUnitsPerSaleUnit: selectedOption.canonicalUnitsPerSaleUnit,
        // A stable key per (sale, medicine, unit, quantity) so a double-press of
        // the add chord cannot post the same line twice.
        idempotencyKey: `counter:${activeSaleId}:${activeRow.medicineId}:${selectedOption.packLevelId}:${selectedOption.kind}:${quantity}`,
      });
      await refreshCart();
      await utils.pharmacySales.counterSearch.invalidate();
      setNotice({
        tone: 'success',
        message: `${quantity} × ${activeRow.displayName} added.`,
      });
      setQuery('');
      focusSearch();
    } catch (error) {
      setNotice({ tone: 'danger', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    activeRow,
    addLine,
    branchId,
    busy,
    ensureSale,
    focusSearch,
    preview,
    quantity,
    refreshCart,
    selectedOption,
    utils,
  ]);

  const runTransition = useCallback(
    async (action: 'hold' | 'resume' | 'complete' | 'void', reason?: string) => {
      const target = action === 'resume' ? heldSaleId : saleId;
      if (!target || busy) return;
      setPending(action);
      setNotice(null);
      try {
        await transition.mutateAsync({ branchId, saleId: target, action, reason });
        if (action === 'hold') {
          setHeldSaleId(target);
          setSaleId(null);
        }
        if (action === 'resume') {
          setSaleId(target);
          setHeldSaleId(null);
        }
        if (action === 'void') {
          setSaleId(null);
        }
        await refreshCart();
        setNotice({ tone: 'success', message: `Bill ${action === 'void' ? 'voided' : action}.` });
        focusSearch();
      } catch (error) {
        setNotice({ tone: 'danger', message: messageFrom(error) });
      } finally {
        setPending(null);
      }
    },
    [branchId, busy, focusSearch, heldSaleId, refreshCart, saleId, transition]
  );

  const takePayment = useCallback(
    async (input: { type: CounterTenderType; amountMinor: number; cashReceivedMinor?: number }) => {
      if (!saleId || busy) return;
      setPending('tender');
      setNotice(null);
      try {
        const result = await tender.mutateAsync({
          branchId,
          saleId,
          deviceId: counterDeviceId(),
          businessDate: businessDate(),
          type: input.type,
          amountMinor: input.amountMinor,
          ...(input.cashReceivedMinor !== undefined
            ? { cashReceivedMinor: input.cashReceivedMinor }
            : {}),
          idempotencyKey: `counter-tender:${saleId}:${input.type}:${input.amountMinor}`,
        });
        await refreshCart();
        // A replayed idempotent tender returns the stored payload, which the
        // router types loosely. Narrow rather than assert: a replay that cannot
        // report its outcome should say so instead of claiming a settlement.
        setNotice(
          result && 'settled' in result
            ? {
                tone: 'success',
                message: result.settled
                  ? `Settled. Receipt ${result.receiptNumber ?? '—'}.`
                  : `Payment recorded. ${formatMinor(result.remainingMinor)} remaining.`,
              }
            : { tone: 'success', message: 'Payment already recorded for this key.' }
        );
      } catch (error) {
        setNotice({ tone: 'danger', message: messageFrom(error) });
      } finally {
        setPending(null);
      }
    },
    [branchId, busy, refreshCart, saleId, tender]
  );

  const captureShortfall = useCallback(async () => {
    if (busy || !branchId) return;
    const requested = activeRow?.displayName ?? (submittedQuery.trim() || query.trim());
    if (!requested) {
      setNotice({ tone: 'warning', message: 'Search for the medicine first, then capture it.' });
      return;
    }
    setPending('captureDemand');
    try {
      await captureDemand.mutateAsync({
        branchId,
        ...(saleId ? { saleId } : {}),
        ...(activeRow ? { requestedMedicineId: activeRow.medicineId } : {}),
        requestedText: requested,
        saleUnit: saleUnit ?? 'UNIT',
        quantity,
        reason: activeRow ? 'STOCKOUT' : 'NOT_CARRIED',
        inventoryRuleSnapshot: {
          query: submittedQuery || query,
          onHandUnits: activeRow?.onHandUnits ?? 0,
          blocked: activeRow?.blocked ?? [],
          capturedAt: new Date().toISOString(),
        },
      });
      setNotice({ tone: 'success', message: 'Unfulfilled demand captured.' });
      focusSearch();
    } catch (error) {
      setNotice({ tone: 'danger', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    activeRow,
    branchId,
    busy,
    captureDemand,
    focusSearch,
    query,
    quantity,
    saleId,
    saleUnit,
    submittedQuery,
  ]);

  const printReceipt = useCallback(() => {
    setReceiptRenders((count) => count + 1);
    window.print();
  }, []);

  // ── POS-01 keyboard map ───────────────────────────────────────────────────

  const runAction = useCallback(
    (action: CounterAction) => {
      switch (action) {
        case 'focusSearch':
          focusSearch();
          return;
        case 'selectPackUnit':
        case 'selectStripUnit':
        case 'selectLooseUnit': {
          const kind: SaleUnitKind =
            action === 'selectPackUnit' ? 'PACK' : action === 'selectStripUnit' ? 'STRIP' : 'UNIT';
          if (activeRow?.saleUnits.some((option) => option.kind === kind)) {
            setSaleUnit(kind);
          } else {
            setNotice({
              tone: 'warning',
              message: `This medicine is not sold by ${kind.toLowerCase()}.`,
            });
          }
          return;
        }
        case 'addToCart':
          void addToCart();
          return;
        case 'holdSale':
          void runTransition('hold');
          return;
        case 'resumeSale':
          void runTransition('resume');
          return;
        case 'openTender':
          tenderRef.current?.focus();
          return;
        case 'printReceipt':
          printReceipt();
          return;
        case 'focusPrescriptionPanel':
          rxPanelRef.current?.focus();
          return;
        case 'captureDemand':
          void captureShortfall();
          return;
        case 'voidSale':
          void runTransition('void', 'Voided from the counter.');
          return;
      }
    },
    [activeRow, addToCart, captureShortfall, focusSearch, printReceipt, runTransition]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleCounterKey(event)) return;
      const action = matchCounterAction(keymap.bindings, event);
      if (!action) return;
      // Claim the chord before the browser or a focused control can act on it,
      // so F9 reaches the tender panel rather than a browser default.
      event.preventDefault();
      runAction(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keymap.bindings, runAction]);

  /** Persistent scan focus (POS-01): the field regains focus after every action. */
  useEffect(() => {
    if (pending === null && document.activeElement === document.body) focusSearch();
  }, [focusSearch, pending]);

  const chordFor = useCallback(
    (kind: SaleUnitKind) =>
      formatBinding(
        keymap.bindings[
          kind === 'PACK'
            ? 'selectPackUnit'
            : kind === 'STRIP'
              ? 'selectStripUnit'
              : 'selectLooseUnit'
        ]
      ),
    [keymap.bindings]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (branchesQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Pharmacy" heading="Counter" description="Loading this workspace." />
        <SectionCard title="Loading">
          <p className="text-sm text-text-muted" role="status">
            Loading branches…
          </p>
        </SectionCard>
      </div>
    );
  }

  if (branchesQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Counter"
          description="This counter is unavailable."
        />
        <SectionCard title="Branches unavailable">
          <div className="space-y-3" role="alert">
            <p className="text-sm text-destructive">{messageFrom(branchesQuery.error)}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => void branchesQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Counter"
          description="No active branch is configured yet."
        />
        {/*
          UX rule 13: a precondition is a checklist with links, not a sentence.
          Name each gate the counter needs and link it to the page that clears
          it, so the operator is never told what is missing without being told
          where to go. Branch administration lives on the organization console;
          this lane owns the counter, not that surface, so it links there rather
          than duplicating it.
        */}
        <SectionCard title="Before this counter can sell">
          <div className="space-y-3">
            <p className="text-sm text-text-body">
              A counter dispenses from one active pharmacy branch. Two things must exist first:
            </p>
            <ul className="space-y-2 text-sm text-text-body">
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  1.
                </span>
                <span>An active pharmacy branch for this organization.</span>
                <Link
                  href="/organization"
                  className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Organization administration
                </Link>
              </li>
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  2.
                </span>
                <span>A stock location on that branch holding dispensable batches.</span>
                <Link
                  href="/organization"
                  className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Organization administration
                </Link>
              </li>
            </ul>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => void branchesQuery.refetch()}
            >
              Check again
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Counter"
        description="Keyboard-first dispensing: scan, choose a sale unit, allocate by FEFO, tender and print."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/*
              UX rule 1: never show the operator an identifier the application
              already knows. A sale id fragment names nothing a pharmacist can
              act on; the receipt number is the only bill identity that exists
              in the real world, and it exists only once the bill is settled.
              Before that, describe the bill by what it holds.
            */}
            <StatusPill
              status={saleId ? 'open' : 'idle'}
              tone={saleId ? 'info' : 'neutral'}
              label={
                cart?.receiptNumber
                  ? `Receipt ${cart.receiptNumber}`
                  : saleId
                    ? `Bill open · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`
                    : 'No open bill'
              }
            />
            {heldSaleId ? <StatusPill status="held" tone="warning" label="1 held" /> : null}
            {blocked ? <StatusPill status="blocked" tone="danger" label="Safety block" /> : null}
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => {
                setPending('drawer');
                openDrawer
                  .mutateAsync({
                    branchId,
                    deviceId: counterDeviceId(),
                    businessDate: businessDate(),
                    openingFloatMinor: 0,
                  })
                  .then(() =>
                    setNotice({ tone: 'success', message: 'Cash drawer opened for this counter.' })
                  )
                  .catch((error: unknown) =>
                    setNotice({ tone: 'warning', message: messageFrom(error) })
                  )
                  .finally(() => setPending(null));
              }}
            >
              Open drawer
            </Button>
          </div>
        }
      />

      {notice ? (
        <div
          role={notice.tone === 'success' ? 'status' : 'alert'}
          aria-live="polite"
          className={`flex items-center gap-3 rounded-lg border p-3 ${
            notice.tone === 'danger'
              ? 'border-destructive/30 bg-destructive/10'
              : notice.tone === 'warning'
                ? 'border-warning/30 bg-warning/10'
                : notice.tone === 'success'
                  ? 'border-success/30 bg-success/10'
                  : 'border-border-subtle bg-surface-sunken'
          }`}
        >
          <StatusPill status={notice.tone} tone={notice.tone} />
          <p className="min-w-0 text-sm text-text-body">{notice.message}</p>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <SectionCard eyebrow="POS-02" title="Scan and search">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="counter-search">Scan or search</Label>
                  <Input
                    id="counter-search"
                    ref={searchRef}
                    autoFocus
                    autoComplete="off"
                    value={query}
                    disabled={busy}
                    placeholder="Brand, generic, ingredient, strength, form, barcode, alias"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      runSearch();
                    }}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="counter-branch">Branch</Label>
                  <select
                    id="counter-branch"
                    value={branchId}
                    disabled={busy}
                    onChange={(event) => {
                      setSelectedBranchId(event.target.value);
                      setActiveRow(null);
                      setSaleId(null);
                      setHeldSaleId(null);
                    }}
                    className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} · {branch.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <CounterSearchResults
                rows={searchQuery.data?.rows ?? []}
                state={
                  submittedQuery.trim().length < 2
                    ? 'idle'
                    : searchQuery.isLoading
                      ? 'loading'
                      : searchQuery.isError
                        ? 'error'
                        : 'ready'
                }
                query={submittedQuery}
                activeMedicineId={activeRow?.medicineId ?? null}
                error={searchQuery.error ? messageFrom(searchQuery.error) : null}
                onSelect={stageRow}
                onCaptureDemand={() => void captureShortfall()}
                onRetry={() => void searchQuery.refetch()}
              />
            </div>
          </SectionCard>

          <SectionCard
            eyebrow="POS-03"
            title="Sale unit and quantity"
            actions={
              <Button
                type="button"
                className="h-11"
                disabled={busy || !activeRow || !preview}
                onClick={() => void addToCart()}
              >
                {pending === 'addToCart'
                  ? 'Adding…'
                  : `Add to cart (${formatBinding(keymap.bindings.addToCart)})`}
              </Button>
            }
          >
            {activeRow ? (
              <CounterUnitToggle
                options={activeRow.saleUnits}
                selected={saleUnit}
                quantity={quantity}
                preview={preview}
                disabled={busy}
                onSelect={setSaleUnit}
                onQuantityChange={setQuantity}
                chordFor={chordFor}
              />
            ) : (
              <p className="text-sm text-text-muted">
                Select a search result to choose its sale unit.
              </p>
            )}
          </SectionCard>

          <SectionCard eyebrow="POS-01" title="Workflow map">
            <CounterKeymapLegend
              keymap={keymap}
              saving={saveKeymap.isPending}
              disabled={busy}
              onPresetChange={(preset: CounterKeymapPresetKey) =>
                saveKeymap.mutate({ preset, overrides: {} })
              }
            />
          </SectionCard>
        </div>

        <div className="min-w-0 space-y-4">
          <SectionCard
            eyebrow="POS-03"
            title="Cart and FEFO allocation"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={busy || !saleId}
                  onClick={() => void runTransition('hold')}
                >
                  Hold
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={busy || !heldSaleId}
                  onClick={() => void runTransition('resume')}
                >
                  Resume
                </Button>
              </div>
            }
          >
            <CounterCartPanel
              cart={cart}
              state={
                !saleId
                  ? 'idle'
                  : cartQuery.isLoading
                    ? 'loading'
                    : cartQuery.isError
                      ? 'error'
                      : 'ready'
              }
              error={cartQuery.error ? messageFrom(cartQuery.error) : null}
              onRetry={() => void cartQuery.refetch()}
            />
          </SectionCard>

          <SectionCard eyebrow="POS-05" title="Tender">
            <CounterTenderPanel
              ref={tenderRef}
              balanceMinor={balanceMinor}
              blocked={blocked}
              pending={pending === 'tender'}
              disabled={busy || !saleId}
              error={tender.error ? messageFrom(tender.error) : null}
              onTender={(input) => void takePayment(input)}
            />
          </SectionCard>

          <SectionCard eyebrow="POS-08" title="Receipt">
            <CounterReceiptView
              receipt={receiptQuery.data ?? null}
              state={
                !saleId || cart?.status !== 'COMPLETED'
                  ? 'idle'
                  : receiptQuery.isLoading
                    ? 'loading'
                    : receiptQuery.isError
                      ? 'error'
                      : 'ready'
              }
              locale={receiptLocale}
              format={receiptFormat}
              reprint={receiptRenders > 0}
              error={receiptQuery.error ? messageFrom(receiptQuery.error) : null}
              onLocaleChange={setReceiptLocale}
              onFormatChange={setReceiptFormat}
              onPrint={printReceipt}
              onRetry={() => void receiptQuery.refetch()}
            />
          </SectionCard>
        </div>

        <div className="min-w-0">
          <SectionCard
            eyebrow="POS-09"
            title="Prescription and patient"
            actions={
              <kbd className="rounded-[3px] border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text-strong">
                {formatBinding(keymap.bindings.focusPrescriptionPanel)}
              </kbd>
            }
          >
            <CounterRxPanel
              ref={rxPanelRef}
              alerts={alerts}
              patient={patient}
              candidates={patientsQuery.data?.patients ?? []}
              query={patientQuery}
              state={
                patientPanelQuery.isError &&
                (patientPanelQuery.error?.data?.code === 'FORBIDDEN' ||
                  patientsQuery.error?.data?.code === 'FORBIDDEN')
                  ? 'denied'
                  : patientsQuery.isLoading || patientPanelQuery.isLoading
                    ? 'loading'
                    : patientsQuery.isError || patientPanelQuery.isError
                      ? 'error'
                      : submittedPatientQuery.trim().length >= 2
                        ? 'ready'
                        : 'idle'
              }
              error={
                patientsQuery.error
                  ? messageFrom(patientsQuery.error)
                  : patientPanelQuery.error
                    ? messageFrom(patientPanelQuery.error)
                    : null
              }
              disabled={busy}
              onQueryChange={setPatientQuery}
              onSearch={() => setSubmittedPatientQuery(patientQuery.trim())}
              onSelectPatient={setPatientId}
              onClearPatient={() => {
                setPatientId(null);
                setSubmittedPatientQuery('');
                setPatientQuery('');
              }}
            />
          </SectionCard>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {COUNTER_ACTION_LABELS.focusSearch}: {formatBinding(keymap.bindings.focusSearch)}
      </p>
    </div>
  );
}
