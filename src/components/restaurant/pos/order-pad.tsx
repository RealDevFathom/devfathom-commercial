'use client';
import { useEffect, type ReactNode } from 'react';
import { usePosRuntime, type PosNotice } from './use-pos-runtime';
import { CheckoutPanel } from './checkout-panel';
import { DrawerPanel } from './drawer-panel';
import { DayClosePanel } from './day-close-panel';
import { MenuGrid } from './menu-grid';
import { OperatorSwitch } from './operator-switch';
import { RefundPanel } from './refund-panel';
import { OrderTicketPanel } from './order-ticket-panel';
import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { ORDER_CHANNELS } from '@/lib/restaurant/order-channels';
import type { CommercialTermsQuote } from '@/lib/restaurant/commercial-terms';
import { quoteDraftCheckTotal } from '@/lib/restaurant/draft-check-total';
import { shouldHandleCounterKey } from '@/lib/pharmacy/counter-keymap';
import type { PosDraftReview } from '@/lib/restaurant/pos-command-queue';

export function OrderPad({ demo = false }: { demo?: boolean }) {
  const pos = usePosRuntime({ demo });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F2' && event.key !== 'F9') return;
      if (!shouldHandleCounterKey(event, document.querySelector('[role="dialog"]') !== null))
        return;
      if (event.key === 'F2') {
        const search = document.getElementById('pos-menu-search');
        if (!(search instanceof HTMLElement)) return;
        event.preventDefault();
        search.focus();
      }
      if (event.key === 'F9') {
        const pay = document.querySelector<HTMLButtonElement>('[data-pos-pay]');
        if (!pay || pay.disabled) return;
        event.preventDefault();
        pay.click();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const { runtime, workspace, controls } = pos;
  if (!runtime || !workspace || !controls) {
    return (
      <PosShell
        status={pos.revoked ? 'Revoked' : 'not enrolled'}
        tone={pos.revoked ? 'warning' : 'neutral'}
        busy={pos.busy}
      >
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow={<span className="text-text-strong">Restaurant POS</span>}
            heading={pos.enrollmentHeading}
            description={<span className="text-text-body">{pos.enrollmentDescription}</span>}
          />
          {pos.notice ? <Notice notice={pos.notice} /> : null}
          <SectionCard title={pos.enrollmentTitle} titleLevel={2}>
            <div className="space-y-4">
              <p className="text-sm leading-6 text-text-muted">{pos.enrollmentMessage}</p>
              {pos.enrollmentState === 'missing' || pos.enrollmentState === 'unrecoverable' ? (
                <a
                  href={demo ? '/demo/restaurants' : '/login?callbackUrl=%2Frestaurant%2Fdevices'}
                  className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {demo ? 'Reopen restaurant demo' : 'Return to admin-assisted enrollment'}
                </a>
              ) : null}
            </div>
          </SectionCard>
        </div>
      </PosShell>
    );
  }

  if (runtime.state === 'LOCKED') {
    return (
      <PosShell status="locked" tone="warning" busy={pos.busy}>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant POS"
            heading="Terminal locked"
            description={`${runtime.deviceName} · ${runtime.branchName}`}
          />
          {pos.notice ? <Notice notice={pos.notice} /> : null}
          <SectionCard
            title="Unlock terminal"
            titleLevel={2}
            actions={<StatusPill status="locked" tone="warning" />}
          >
            <form onSubmit={workspace.unlock} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="operator-id">Operator</Label>
                <select
                  {...controls.operatorIdProps}
                  className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  <option value="">
                    {pos.operatorDirectoryState === 'loading'
                      ? 'Loading operators…'
                      : pos.operators.length === 0
                        ? 'No eligible operators'
                        : 'Choose an operator'}
                  </option>
                  {pos.operators.map((operator) => (
                    <option key={operator.staffProfileId} value={operator.staffProfileId}>
                      {operator.displayName} — {operator.role}
                    </option>
                  ))}
                </select>
                {pos.operatorDirectoryState === 'error' ? (
                  <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
                    <span role="alert">Operators could not be loaded.</span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={workspace.retryOperators}
                      className="h-11"
                    >
                      Retry
                    </Button>
                  </div>
                ) : pos.operatorDirectoryState === 'ready' && pos.operators.length === 0 ? (
                  <p className="text-sm text-text-muted" role="status">
                    No active operators are assigned to this branch. Ask a manager for access.
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="operator-pin">Operator PIN</Label>
                <Input {...controls.operatorPinProps} className="h-11" />
              </div>
              <Button
                type="submit"
                disabled={pos.busy || !pos.operatorId.trim() || !/^\d{4,8}$/.test(pos.operatorPin)}
                className="h-11 w-full"
              >
                {pos.pending === 'unlock' ? 'Unlocking…' : 'Unlock terminal'}
              </Button>
            </form>
          </SectionCard>
        </div>
      </PosShell>
    );
  }

  return (
    <PosShell
      flush
      status={pos.online ? 'Online' : 'Offline'}
      tone={pos.online ? 'success' : 'warning'}
      busy={pos.busy}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle p-2">
          <h1 className="shrink-0 text-sm font-semibold leading-5 text-text-strong">Order pad</h1>
          <p className="hidden text-xs text-text-muted md:block">F2 search · Enter add · F9 pay</p>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <StatusPill {...pos.operatorStatus} />
            <StatusPill {...pos.connectionStatus} />
            <StatusPill {...pos.queueStatus} />
            <OperatorSwitch {...workspace.operatorSwitchProps} />
            <DrawerPanel {...workspace.drawerPanelProps} />
            <DayClosePanel {...workspace.dayClosePanelProps} />
            <RefundPanel {...workspace.refundPanelProps} />
            <Button
              type="button"
              variant="outline"
              onClick={workspace.lockTerminal}
              disabled={pos.busy}
              className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
            >
              {pos.pending === 'lock' ? 'Locking…' : 'Lock terminal'}
            </Button>
          </div>
        </header>
        <div className="flex min-h-11 shrink-0 items-center px-2">
          {pos.pending ? (
            <Notice
              notice={{ tone: 'warning', message: 'Request pending. Controls are paused.' }}
            />
          ) : pos.notice ? (
            <Notice notice={pos.notice} />
          ) : null}
        </div>

        {!pos.online ||
        pos.queuedCount > 0 ||
        pos.reviewDrafts.length > 0 ||
        pos.discardedCount > 0 ? (
          <SectionCard compact eyebrow="Offline queue" title="Saved new orders">
            <div className="space-y-3 text-sm text-text-body">
              <p>
                {pos.online
                  ? `${pos.queuedCount} command(s) are waiting to replay.`
                  : 'New-order composition remains available from the cached catalog. Checkout, tenders, refunds, drawers, close, loyalty, customers, and existing-order edits require a connection.'}
              </p>
              {pos.discardedCount > 0 ? (
                <p role="alert">Revoked · {pos.discardedCount} queued order(s) discarded.</p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!pos.online || pos.busy || pos.queuedCount === 0}
                onClick={workspace.retryQueuedOrders}
              >
                Retry queued orders
              </Button>
              {pos.reviewDrafts.map((draft) => (
                <div
                  key={draft.draftId}
                  role="region"
                  aria-label={`Queued order ${draft.sequence} review`}
                  className="rounded-md border border-warning/30 bg-warning/10 p-3"
                >
                  <div id={`review-${draft.draftId}`} aria-live="polite" aria-atomic="true">
                    <p className="font-medium">Needs review · {draft.review?.message}</p>
                    <ReviewDetails review={draft.review} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      aria-describedby={`review-${draft.draftId}`}
                      disabled={
                        !pos.online || pos.busy || draft.review?.reason === 'COMPOSER_UNVERIFIED'
                      }
                      onClick={workspace.sendReviewedOrder(draft.draftId, draft.review)}
                    >
                      Send deliberately
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pos.busy}
                      onClick={workspace.discardReviewedOrder(draft)}
                    >
                      Discard queued order
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        ) : null}

        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-y-auto p-2 md:auto-rows-auto md:overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
          <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto md:col-start-2 md:row-start-1">
            <SectionCard
              compact
              eyebrow="New check"
              title="Open order"
              className="flex shrink-0 flex-col"
            >
              <form onSubmit={workspace.openOrder} className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  <div className="space-y-1.5">
                    <Label htmlFor="order-channel">Channel</Label>
                    <select
                      {...controls.orderChannelProps}
                      className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                    >
                      {ORDER_CHANNELS.map((value) => (
                        <option key={value} value={value}>
                          {value === 'DINE_IN'
                            ? 'Dine in'
                            : value === 'TAKEAWAY'
                              ? 'Takeaway'
                              : 'Delivery'}
                        </option>
                      ))}
                    </select>
                  </div>
                  {pos.channel === 'DELIVERY' ? (
                    <fieldset
                      className="space-y-3 rounded-lg border border-border-subtle p-3"
                      disabled={pos.busy || !pos.online}
                    >
                      <legend className="px-1 text-sm font-semibold text-text-strong">
                        Delivery details
                      </legend>
                      {!pos.online ? (
                        <p role="alert" className="text-sm text-warning">
                          Delivery is connected-only. Reconnect to continue; no delivery details are
                          stored locally.
                        </p>
                      ) : null}
                      <div className="space-y-1.5">
                        <Label htmlFor="delivery-customer-search">Customer name</Label>
                        <div className="flex gap-2">
                          <Input {...controls.deliveryCustomerSearchProps} className="h-11" />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              !pos.online ||
                              pos.customerQuery.trim().length < 2 ||
                              /[@+\d]{3}/.test(pos.customerQuery)
                            }
                            onClick={workspace.searchCustomers}
                          >
                            Search
                          </Button>
                        </div>
                        {pos.deliveryCustomers.map((customer) => (
                          <Button
                            key={customer.customerId}
                            type="button"
                            variant={
                              pos.deliveryCustomer?.customerId === customer.customerId
                                ? 'default'
                                : 'outline'
                            }
                            className="h-11 w-full justify-start"
                            onClick={workspace.selectCustomer(customer)}
                          >
                            {customer.displayName ?? 'Unnamed customer'}
                            {customer.identifiers[0]?.masked
                              ? ` · ${customer.identifiers[0].masked}`
                              : ''}
                          </Button>
                        ))}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="delivery-address">Saved address</Label>
                        <select
                          {...controls.deliveryAddressProps}
                          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <option value="">Select saved address</option>
                          {pos.deliveryAddresses.map((address) => (
                            <option key={address.id} value={address.id}>
                              {address.label} · {address.recipientName}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="delivery-zone">Delivery zone</Label>
                        <select
                          {...controls.deliveryZoneProps}
                          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <option value="">Select active zone</option>
                          {pos.deliveryZones.map((zone) => (
                            <option key={zone.id} value={zone.id}>
                              {zone.name}
                            </option>
                          ))}
                        </select>
                        {pos.selectedDeliveryZone ? (
                          <p className="text-sm text-text-muted">
                            Minimum {pos.selectedDeliveryZone!.minimumSubtotal} · Fee{' '}
                            {pos.selectedDeliveryZone!.fee} (non-taxable) · Promise{' '}
                            {pos.selectedDeliveryZone!.promisedMinutes} min
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="delivery-instructions">Delivery instructions</Label>
                        <Input {...controls.deliveryInstructionsProps} className="h-11" />
                      </div>
                    </fieldset>
                  ) : null}
                  {pos.channel === 'DINE_IN' ? (
                    <div className="space-y-3">
                      {pos.layoutState === 'loading' ? (
                        <p className="text-sm text-text-muted">Loading floor tables…</p>
                      ) : null}
                      {pos.layoutState === 'error' ? (
                        <p role="alert" className="text-sm text-destructive">
                          Floor plan unavailable. Check the connection and retry.
                        </p>
                      ) : null}
                      {pos.layoutState === 'denied' ? (
                        <p role="alert" className="text-sm text-destructive">
                          Permission denied for the floor plan.
                        </p>
                      ) : null}
                      {pos.layoutState === 'ready' &&
                      pos.layout?.floors.every((floor) => floor.tables.length === 0) ? (
                        <p className="text-sm text-text-muted">
                          No active tables are configured for this branch.
                        </p>
                      ) : null}
                      {pos.layout?.floors.map((floor) => (
                        <fieldset
                          key={floor.id}
                          className="space-y-2 rounded-lg border border-border-subtle p-3"
                        >
                          <legend className="px-1 text-sm font-semibold text-text-strong">
                            {floor.name}
                          </legend>
                          <div className="grid grid-cols-2 gap-2">
                            {floor.tables.map((table) => (
                              <label
                                key={table.id}
                                className="flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  checked={pos.tableIds.includes(table.id)}
                                  disabled={pos.busy || table.occupied}
                                  onChange={workspace.toggleTable(table)}
                                />
                                <span>{table.code}</span>
                                <span className="ml-auto text-xs text-text-muted">
                                  {table.occupied ? 'Occupied' : `${table.capacity} seats`}
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      ))}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="order-covers">Covers</Label>
                      <Input {...controls.orderCoversProps} className="h-11" />
                    </div>
                    {pos.channel === 'DINE_IN' ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="order-section">Floor section</Label>
                        <select
                          {...controls.orderSectionProps}
                          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                        >
                          <option value="">No section</option>
                          {pos.layout?.sections.map((section) => (
                            <option key={section.id} value={section.id}>
                              {section.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div />
                    )}
                  </div>
                  <p className="text-sm text-text-muted">
                    Server: {runtime.operator?.displayName ?? 'Active operator'}
                  </p>
                </div>
                <Button
                  type="submit"
                  aria-label={pos.pending === 'open' ? 'Opening…' : 'Open order'}
                  disabled={
                    pos.busy ||
                    !pos.draftMenu?.channelOpen ||
                    (pos.channel === 'DELIVERY' &&
                      (!pos.online ||
                        !pos.deliveryCustomer ||
                        !pos.deliveryAddressId ||
                        !pos.deliveryZoneId ||
                        pos.draftLines.length === 0))
                  }
                  className="h-11 w-full shrink-0 shadow-none hover:translate-y-0 active:translate-y-0"
                >
                  {pos.pending === 'open'
                    ? 'Sending…'
                    : `Send order${pos.draftLines.length ? ` (${pos.draftLines.length})` : ''}`}
                </Button>
              </form>
            </SectionCard>

            <SectionCard
              compact
              title="Composed order"
              className="shrink-0"
              actions={
                <span className="flex min-w-24 flex-col items-end text-right">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">
                    Estimated cash total
                  </span>
                  <span className="font-mono text-sm tabular-nums text-text-strong">
                    {draftCheckTotal(pos)}
                  </span>
                </span>
              }
            >
              <p className="mb-1 text-xs text-text-muted">
                {pos.channel === 'DINE_IN'
                  ? 'Dine in'
                  : pos.channel === 'TAKEAWAY'
                    ? 'Takeaway'
                    : 'Delivery'}
                {' · '}
                {pos.tableIds.length
                  ? pos.tableIds
                      .map(
                        (id) =>
                          pos.layout?.floors
                            .flatMap((floor) => floor.tables)
                            .find((table) => table.id === id)?.code ?? 'Table'
                      )
                      .join(', ')
                  : 'No table'}
              </p>
              {pos.draftLines.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Tap menu items to compose. Nothing is sent until Send order.
                </p>
              ) : (
                <div className="space-y-1">
                  {pos.draftLines.map((line) => (
                    <div
                      key={line.lineId}
                      className="flex min-h-11 items-center justify-between gap-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {line.quantity} × {line.name}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {draftModifiers(line, pos.draftMenu)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Decrease ${line.name}`}
                          className="size-11 shrink-0 px-0 shadow-none hover:translate-y-0 active:translate-y-0"
                          disabled={pos.busy || line.quantity <= 1}
                          onClick={workspace.adjustDraftQuantity(line.lineId, -1)}
                        >
                          −
                        </Button>
                        <span className="w-6 text-center font-mono text-sm tabular-nums">
                          {line.quantity}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Increase ${line.name}`}
                          className="size-11 shrink-0 px-0 shadow-none hover:translate-y-0 active:translate-y-0"
                          disabled={pos.busy}
                          onClick={workspace.adjustDraftQuantity(line.lineId, 1)}
                        >
                          +
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                          disabled={pos.busy}
                          onClick={workspace.removeDraftLine(line)}
                        >
                          Remove
                        </Button>
                      </span>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-11 w-full shadow-none hover:translate-y-0 active:translate-y-0"
                    disabled={pos.busy}
                    onClick={workspace.discardDraft}
                  >
                    Discard draft
                  </Button>
                </div>
              )}
            </SectionCard>

            <SectionCard
              compact
              className="shrink-0"
              eyebrow="Resume"
              title="Open orders"
              actions={
                <Button
                  type="button"
                  variant="outline"
                  onClick={workspace.refreshOrders}
                  disabled={pos.busy}
                  className="h-11"
                >
                  Refresh
                </Button>
              }
            >
              {pos.openOrders.length === 0 ? (
                <p className="text-sm text-text-muted">No open orders for this branch.</p>
              ) : (
                <div className="space-y-2">
                  {pos.openOrders.map((openOrder) => (
                    <Button
                      key={openOrder.id}
                      type="button"
                      variant={pos.order?.id === openOrder.id ? 'default' : 'outline'}
                      aria-pressed={pos.order?.id === openOrder.id}
                      onClick={workspace.selectOrder(openOrder)}
                      disabled={pos.busy}
                      className="min-h-11 h-auto w-full min-w-0 justify-between px-3 py-2"
                    >
                      <span className="truncate">
                        #{openOrder.orderNumber} · {openOrder.itemCount}{' '}
                        {openOrder.itemCount === 1 ? 'item' : 'items'}
                      </span>
                      <span className="shrink-0 font-mono text-xs">{openOrder.subtotal}</span>
                    </Button>
                  ))}
                </div>
              )}
            </SectionCard>
            <div className="min-h-96 shrink-0">
              <OrderTicketPanel {...workspace.orderTicketPanelProps} />
            </div>
          </div>

          <div className="min-h-128 min-w-0 md:min-h-0 md:col-start-1 md:row-start-1">
            <MenuGrid {...workspace.menuGridProps} />
          </div>
        </div>
      </div>
      <CheckoutPanel {...workspace.checkoutPanelProps} />
    </PosShell>
  );
}

function draftCheckTotal(pos: {
  channel: string;
  commercialTerms: CommercialTermsQuote | null;
  draftLines: Array<{
    lineId: string;
    quotedUnitPrice: string;
    quantity: number;
    menuItemId: string;
    modifierOptionIds: string[];
  }>;
  draftMenu: Parameters<typeof modifierDeltas>[1];
  selectedDeliveryZone?: { fee: string } | null;
}) {
  if (!pos.commercialTerms) return '…';
  const terms = pos.commercialTerms;
  try {
    return quoteDraftCheckTotal({
      lines: pos.draftLines.map((line) => ({
        id: line.lineId,
        unitPrice: line.quotedUnitPrice,
        quantity: line.quantity,
        modifierDeltas: modifierDeltas(line, pos.draftMenu),
      })),
      ...(terms.profiles.length ? { profiles: terms.profiles, rules: terms.rules } : {}),
      serviceChargeRate: pos.channel === 'DINE_IN' ? (terms.serviceChargeRate ?? '0') : '0',
      deliveryFee: pos.channel === 'DELIVERY' ? (pos.selectedDeliveryZone?.fee ?? '0.00') : '0.00',
    });
  } catch {
    return '—';
  }
}

function modifierDeltas(
  line: { menuItemId: string; modifierOptionIds: string[] },
  menu: {
    sections: Array<{
      items: Array<{
        id: string;
        modifierGroups?: Array<{ options: Array<{ id: string; priceDelta: string }> }>;
      }>;
    }>;
  } | null
) {
  if (!menu) return [];
  return menu.sections
    .flatMap((section) => section.items)
    .filter((item) => item.id === line.menuItemId)
    .flatMap((item) => item.modifierGroups ?? [])
    .flatMap((group) => group.options)
    .filter((option) => line.modifierOptionIds.includes(option.id))
    .map((option) => option.priceDelta);
}

function draftModifiers(
  line: { menuItemId: string; modifierOptionIds: string[] },
  menu: {
    sections: Array<{
      items: Array<{
        id: string;
        modifierGroups?: Array<{ options: Array<{ id: string; name: string }> }>;
      }>;
    }>;
  } | null
) {
  if (!menu) return '';
  const names = menu.sections
    .flatMap((section) => section.items)
    .filter((item) => item.id === line.menuItemId)
    .flatMap((item) => item.modifierGroups ?? [])
    .flatMap((group) => group.options)
    .filter((option) => line.modifierOptionIds.includes(option.id))
    .map((option) => option.name);
  return names.join(', ');
}

function PosShell({
  status,
  tone,
  busy,
  flush = false,
  children,
}: {
  status: string;
  tone: 'success' | 'warning' | 'neutral';
  busy: boolean;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="pos-calm studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#pos-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-[3px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to order pad
      </a>
      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-card px-3">
          <FathomMark className="size-7" variant="brand" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-text-strong">DevFathom</p>
            <p className="truncate text-xs text-text-muted">Restaurant POS</p>
          </div>
          <div className="ml-auto shrink-0" aria-live="polite">
            <StatusPill
              status={status}
              tone={tone}
              className={tone === 'neutral' ? '!text-text-strong' : undefined}
            />
          </div>
        </header>
        <main
          id="pos-main"
          aria-busy={busy}
          className={`studio-canvas relative min-h-0 flex-1 ${flush ? 'overflow-hidden' : 'overflow-y-auto'}`}
        >
          <div
            className={
              flush
                ? 'flex h-full min-h-0 w-full flex-col'
                : 'studio-stage mx-auto min-h-full w-full max-w-[1600px] px-4 py-4 sm:px-6'
            }
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function ReviewDetails({ review }: { review: PosDraftReview | null }) {
  const catalog = review?.catalog;
  if (!catalog) return null;
  const line = catalog.line;
  const channelName = (channel: string | null) =>
    channel === 'DINE_IN' ? 'Dine in' : channel === 'TAKEAWAY' ? 'Takeaway' : 'Delivery';
  return (
    <div className="mt-2 space-y-1 text-sm text-text-body">
      <p>
        Menu: {catalog.menuName} · {channelName(catalog.channel)}
      </p>
      <p>Channel: {catalog.channelOpen ? 'Open' : 'Closed'}</p>
      <p>
        Publication:{' '}
        {catalog.publicationMatchesOrder
          ? 'Same as the saved order'
          : 'Different from the saved order'}
      </p>
      {(catalog.channel !== catalog.orderChannel || !catalog.publicationMatchesOrder) && (
        <p>
          This menu is for a different channel or publication. Sending keeps the order’s original{' '}
          {channelName(catalog.orderChannel)} channel and publication; these menu prices will not
          replace its saved prices.
        </p>
      )}
      {line && (
        <>
          <p className="font-medium">
            Line {line.number} · {line.name ?? 'Item no longer on the menu'}
          </p>
          <p>
            Price: {line.quotedPrice ?? 'not recorded'} → {line.currentPrice ?? 'unavailable'}
          </p>
          {line.modifiers.map((modifier, index) => (
            <p key={modifier.optionId}>
              {modifier.name ?? `Selected modifier ${index + 1}`}:{' '}
              {modifier.quotedPrice ?? 'not recorded'} → {modifier.currentPrice ?? 'unavailable'}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

function Notice({ notice }: { notice: PosNotice }) {
  return (
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
  );
}
