'use client';

import { useActionState, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/status-pill';
import { formatLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';
import { formatWorkspaceDate } from '@/lib/timezone';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';
import {
  createPrintDocument,
  openPrintWindow,
  sendToPrintWindow,
  serializePrintDocument,
  type PrintWindow,
} from '@/lib/browser-print/print-window';
import {
  issueLoyaltyCard,
  revokeLoyaltyCard,
  type LoyaltyCardFormState,
} from './loyalty-card-actions';

const initial: LoyaltyCardFormState = { status: 'idle', message: '' };
type WalletTestPasses = NonNullable<LoyaltyCardFormState['walletTestPasses']>;
const QR_MARGIN = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Opens the printable card in its own window: black on white whatever the app theme, with the
 * code spelled out under the QR for manual entry when a scan fails. Built from text nodes only;
 * the card carries no name, phone, balance or anything else about the customer.
 */
async function printCard(code: string): Promise<boolean> {
  // DEV-973: an isolated window that prints itself, so this page never freezes.
  let popup: PrintWindow | null;
  try {
    popup = openPrintWindow('popup,width=420,height=560');
  } catch {
    popup = null;
  }
  if (!popup) return false;
  const doc = createPrintDocument('Loyalty card');
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
  try {
    await sendToPrintWindow(popup, serializePrintDocument(doc));
  } catch {
    return false;
  }
  return true;
}

/**
 * DEV-747: saves one wallet test pass as a JSON file: the pass content Apple or Google would
 * receive, unsigned. It holds the card code, balance and point value, and nothing about the
 * customer. Returns false when the browser cannot make a download link.
 */
function downloadWalletTestPass(passes: WalletTestPasses, platform: 'apple' | 'google') {
  if (typeof URL.createObjectURL !== 'function') return false;
  const file = new Blob(
    [
      JSON.stringify(
        {
          mode: passes.mode,
          platform: platform === 'apple' ? 'APPLE_WALLET' : 'GOOGLE_WALLET',
          notice: passes.notice,
          pass: passes[platform],
        },
        null,
        2
      ),
    ],
    { type: 'application/json' }
  );
  const href = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = href;
  link.download = `loyalty-card-${platform}-wallet-test-pass.json`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return true;
}

function formatPointValue(minor: number) {
  const whole = minor / 100;
  return `PKR ${Number.isInteger(whole) ? whole.toLocaleString('en-US') : whole.toFixed(2)}`;
}

/** DEV-747: the card as Apple and Google Wallet TEST passes, offered once with the card. */
function WalletTestPasses({ passes }: { passes: WalletTestPasses }) {
  const [blocked, setBlocked] = useState(false);
  return (
    <div className="space-y-3 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-text-strong">Wallet passes</h4>
        <StatusPill status="warning" label="Test only" />
      </div>
      <p className="text-sm text-text-body">
        The same card for Apple Wallet and Google Wallet: same QR, same points at every branch. Pass
        shows <span className="tabular-nums">{passes.balancePoints.toLocaleString('en-US')}</span>{' '}
        points, 1 point = {formatPointValue(passes.pointValueMinor)}.
      </p>
      <p className="text-sm text-text-muted">
        These unsigned files preview the card and its counter QR. Shoppers can scan the branch
        poster and verify their phone to see the wallet options available for this programme.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="min-h-11"
          onClick={() => setBlocked(!downloadWalletTestPass(passes, 'apple'))}
        >
          Download Apple Wallet test pass
        </Button>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="min-h-11"
          onClick={() => setBlocked(!downloadWalletTestPass(passes, 'google'))}
        >
          Download Google Wallet test pass
        </Button>
      </div>
      {blocked ? (
        <p role="alert" className="text-sm text-destructive">
          This browser cannot save the test pass. Try another browser.
        </p>
      ) : null}
    </div>
  );
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
  timeZone,
}: {
  branchId: string;
  customerId: string;
  activeCard: { issuedAt: string } | null;
  /** Workspace IANA zone: the issue date shows on the organisation's clock (UTC when absent). */
  timeZone?: string | null;
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
  const walletTestPasses = state.status === 'issued' ? (state.walletTestPasses ?? null) : null;
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
            <span className="text-text-muted">
              Issued {formatWorkspaceDate(activeCard.issuedAt, timeZone)}
            </span>
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
            Print the card now. The code is shown only once; if the card or the phone holding its
            wallet pass is lost, replace it.
          </p>
          <svg
            viewBox={`0 0 ${preview.extent} ${preview.extent}`}
            width={176}
            height={176}
            shapeRendering="crispEdges"
            role="img"
            aria-label="Loyalty card QR code preview"
          >
            {/* Exception to the semantic-token rule: a QR must be dark modules on a light quiet
                zone in both themes, or scanners misread it, so it is drawn black on white like
                the printed card. Remove when a theme-invariant scan-surface token exists. */}
            <rect width={preview.extent} height={preview.extent} fill="#fff" />
            <path d={preview.path} fill="#000" />
          </svg>
          <p className="font-mono text-sm tracking-wide tabular-nums text-text-strong">
            {formatLoyaltyCardCode(issuedCode)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="min-h-11"
            onClick={async () => setPrintBlocked(!(await printCard(issuedCode)))}
          >
            Print card
          </Button>
          {printBlocked ? (
            <p role="alert" className="text-sm text-destructive">
              Allow pop-ups for this site, then print again.
            </p>
          ) : null}
          {walletTestPasses ? <WalletTestPasses passes={walletTestPasses} /> : null}
        </div>
      ) : null}
    </div>
  );
}
