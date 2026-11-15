'use client';

import { useActionState, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/status-pill';
import { formatLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';
import {
  issueLoyaltyCard,
  revokeLoyaltyCard,
  type LoyaltyCardFormState,
} from './loyalty-card-actions';

const initial: LoyaltyCardFormState = { status: 'idle', message: '' };
const QR_MARGIN = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Opens the printable card in its own window: black on white whatever the app theme, with the
 * code spelled out under the QR for manual entry when a scan fails. Built from text nodes only;
 * the card carries no name, phone, balance or anything else about the customer.
 */
function printCard(code: string) {
  const popup = window.open('', '_blank', 'popup,width=420,height=560');
  if (!popup) return false;
  popup.opener = null;
  const doc = popup.document;
  doc.title = 'Loyalty card';
  const modules = encodeQr(code);
  const extent = modules.length + QR_MARGIN * 2;
  const wrap = doc.createElement('div');
  wrap.style.cssText =
    'font-family:monospace;text-align:center;padding:24px;color:#000;background:#fff';
  const heading = doc.createElement('p');
  heading.textContent = 'Loyalty card';
  heading.style.cssText = 'font-size:16px;font-weight:600;margin:0 0 12px';
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
  svg.setAttribute('width', '240');
  svg.setAttribute('height', '240');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Loyalty card QR code');
  const background = doc.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(extent));
  background.setAttribute('height', String(extent));
  background.setAttribute('fill', '#fff');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', qrSvgPath(modules, QR_MARGIN));
  path.setAttribute('fill', '#000');
  svg.append(background, path);
  const line = doc.createElement('p');
  line.textContent = formatLoyaltyCardCode(code);
  line.style.cssText = 'font-size:14px;letter-spacing:1px;margin:12px 0 0';
  wrap.append(heading, svg, line);
  doc.body.style.margin = '0';
  doc.body.append(wrap);
  popup.print();
  return true;
}

/**
 * DEV-748: issue, replace or revoke a customer's physical loyalty card. The QR holds an opaque
 * random code that is shown once, here, for printing: only its hash is kept, so a lost card is
 * replaced (which stops the old one at once) rather than re-printed. Points stay with the customer.
 */
export function LoyaltyCardPanel({
  branchId,
  customerId,
  activeCard,
}: {
  branchId: string;
  customerId: string;
  activeCard: { issuedAt: string } | null;
}) {
  const [state, action, pending] = useActionState(
    (previous: LoyaltyCardFormState, form: FormData) =>
      form.get('intent') === 'revoke'
        ? revokeLoyaltyCard(previous, form)
        : issueLoyaltyCard(previous, form),
    initial
  );
  const [printBlocked, setPrintBlocked] = useState(false);
  const issuedCode = state.status === 'issued' ? (state.code ?? null) : null;
  const preview = useMemo(() => {
    if (!issuedCode) return null;
    const modules = encodeQr(issuedCode);
    return { extent: modules.length + QR_MARGIN * 2, path: qrSvgPath(modules, QR_MARGIN) };
  }, [issuedCode]);
  const invalid = state.status === 'error';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {activeCard ? (
          <>
            <StatusPill status="active" label="Card active" />
            <span className="text-text-muted">Issued {activeCard.issuedAt.slice(0, 10)} (UTC)</span>
          </>
        ) : (
          <StatusPill status="none" label="No card" />
        )}
      </div>
      <form action={action} className="space-y-3" aria-describedby="loyalty-card-status">
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="customerId" value={customerId} />
        <div className="flex flex-wrap items-end gap-3">
          {activeCard ? (
            <label className="grid w-full min-w-0 gap-2 text-sm sm:flex-1">
              Reason for replacing or revoking the card
              <Input
                name="reason"
                required
                minLength={3}
                maxLength={200}
                placeholder="e.g. Card lost"
                aria-invalid={invalid || undefined}
                className="min-h-11"
              />
            </label>
          ) : null}
          <Button
            type="submit"
            name="intent"
            value="issue"
            size="touch"
            className="min-h-11"
            disabled={pending}
          >
            {pending ? 'Saving…' : activeCard ? 'Replace card' : 'Issue card'}
          </Button>
          {activeCard ? (
            <Button
              type="submit"
              name="intent"
              value="revoke"
              variant="destructive"
              size="touch"
              className="min-h-11"
              disabled={pending}
            >
              Revoke without replacing
            </Button>
          ) : null}
        </div>
      </form>
      <p
        id="loyalty-card-status"
        aria-live="polite"
        className={`text-sm ${invalid ? 'text-destructive' : 'text-text-muted'}`}
      >
        {state.message ||
          'The card’s QR holds only a random code, never the customer’s name, phone or balance. The cashier scans it at any branch to link the customer to the bill. Replacing or revoking a card stops the old one at once and keeps the points.'}
      </p>
      {issuedCode && preview ? (
        <div className="space-y-3 rounded-md border border-border-subtle bg-surface-card p-4">
          <p className="text-sm text-text-body">
            Print the card now. The code is shown only once; if the card is lost, replace it.
          </p>
          <svg
            viewBox={`0 0 ${preview.extent} ${preview.extent}`}
            width={176}
            height={176}
            shapeRendering="crispEdges"
            role="img"
            aria-label="Loyalty card QR code preview"
            className="text-text-strong"
          >
            <path d={preview.path} fill="currentColor" />
          </svg>
          <p className="font-mono text-sm tracking-wide tabular-nums text-text-strong">
            {formatLoyaltyCardCode(issuedCode)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="min-h-11"
            onClick={() => setPrintBlocked(!printCard(issuedCode))}
          >
            Print card
          </Button>
          {printBlocked ? (
            <p role="alert" className="text-sm text-destructive">
              Allow pop-ups for this site, then print again.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
