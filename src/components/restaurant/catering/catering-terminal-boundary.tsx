'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { type ReactNode, createContext, useLayoutEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import type { Session } from 'next-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { OperatorSwitch } from '@/components/restaurant/pos/operator-switch';
import {
  RequestError,
  useTerminalSession,
  type TerminalSessionRequest,
} from '../pos/use-terminal-session';

export type CateringTerminal = {
  ready: boolean;
  identity: string;
  request: TerminalSessionRequest;
};

export const CateringTerminalContext = createContext<CateringTerminal>({
  ready: false,
  identity: '',
  request: async () => {
    throw new RequestError(401, 'Connect an enrolled terminal.');
  },
});

function staffIdentity(session: Session | null, organizationId: string) {
  const user = session?.user;
  if (
    !user?.id ||
    user.organizationId !== organizationId ||
    user.status !== 'ACTIVE' ||
    user.organizationStatus !== 'ACTIVE' ||
    user.sessionRevoked ||
    !session?.expires ||
    !Number.isFinite(Date.parse(session.expires)) ||
    Date.parse(session.expires) <= Date.now()
  )
    return null;
  return JSON.stringify([user.id, user.organizationId, user.role, user.department]);
}

export function CateringTerminalBoundary({
  organizationId,
  branchId,
  children,
}: {
  organizationId: string;
  branchId: string;
  children: ReactNode;
}) {
  const staff = useSession();
  const terminal = useTerminalSession({ autoEstablish: false });
  const { runtime } = terminal;
  const staffKey = staffIdentity(staff.data, organizationId);
  const matching = runtime?.organizationId === organizationId && runtime.branchId === branchId;
  const ready = Boolean(
    staff.status === 'authenticated' &&
    staffKey &&
    matching &&
    runtime?.state === 'UNLOCKED' &&
    runtime.operator &&
    terminal.online &&
    !terminal.pending
  );
  // Contains identity only. Session and device credentials never leave this boundary.
  const identity = JSON.stringify([
    organizationId,
    branchId,
    staffKey,
    runtime?.deviceId,
    runtime?.operator?.staffProfileId,
  ]);
  const current = useRef({ ready, identity });
  useLayoutEffect(() => {
    current.current = { ready, identity };
  }, [ready, identity]);
  const sending = useRef(false);
  const [requestPending, setRequestPending] = useState(false);
  const request: TerminalSessionRequest = async (path, options) => {
    if (
      sending.current ||
      !current.current.ready ||
      identity !== current.current.identity ||
      !navigator.onLine
    )
      throw new RequestError(401, 'Reconnect and unlock the terminal for this event branch.');
    sending.current = true;
    setRequestPending(true);
    try {
      // Auth.js remains an independent guard; refresh it before every terminal money command.
      const fresh = await staff.update();
      if (
        !fresh ||
        staffIdentity(fresh, organizationId) !== staffKey ||
        identity !== current.current.identity
      )
        throw new RequestError(
          403,
          'Staff access changed. Sign in again and reconnect the terminal.'
        );
      return await terminal.checkoutRequest(path, options);
    } catch (error) {
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        terminal.clearTerminalState();
        terminal.handleError(error);
      }
      throw error;
    } finally {
      sending.current = false;
      setRequestPending(false);
    }
  };
  return (
    <>
      <SectionCard title="Catering terminal">
        {!staffKey ? (
          <p role="status">
            A current staff sign-in for this organization is required.{' '}
            <a className="underline" href="/login">
              Sign in
            </a>
            .
          </p>
        ) : null}
        {!runtime ? (
          <>
            <p>
              No authenticated enrolled-terminal session is connected. Enroll this browser in{' '}
              <a className="underline" href="/restaurant/devices">
                Restaurant Devices
              </a>
              , then sign in again here; enrollment signs out the staff session.
            </p>
            <Button
              className="mt-3 min-h-11"
              disabled={!staffKey || !terminal.online || Boolean(terminal.pending)}
              onClick={() => void terminal.establish()}
            >
              {terminal.pending === 'establish' ? 'Connecting…' : 'Connect enrolled terminal'}
            </Button>
          </>
        ) : (
          <>
            <p>
              {runtime.deviceName} · {runtime.branchName} ·{' '}
              {runtime.operator?.displayName ?? 'Locked'}
            </p>
            {!matching ? (
              <p role="alert">
                This terminal belongs to another organization or branch. Select an event in its
                enrolled branch or use the correct enrolled browser.
              </p>
            ) : null}
            {runtime.state === 'LOCKED' ? (
              <form
                aria-label="Unlock catering terminal"
                onSubmit={terminal.unlock}
                className="mt-3 grid gap-3 sm:grid-cols-2"
              >
                <fieldset
                  className="contents"
                  disabled={!staffKey || !matching || !terminal.online || Boolean(terminal.pending)}
                >
                  <label>
                    Terminal operator
                    <StudioSelect
                      className="min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3"
                      required
                      value={terminal.operatorId}
                      onChange={(e) => terminal.setOperatorId(e.target.value)}
                    >
                      <option value="">Select operator</option>
                      {terminal.operators.map((op) => (
                        <option key={op.staffProfileId} value={op.staffProfileId}>
                          {op.displayName} · {op.role}
                        </option>
                      ))}
                    </StudioSelect>
                  </label>
                  <label>
                    Operator PIN
                    <Input
                      type="password"
                      className="min-h-11"
                      inputMode="numeric"
                      pattern="[0-9]{4,8}"
                      maxLength={8}
                      autoComplete="current-password"
                      required
                      value={terminal.operatorPin}
                      onChange={(e) => terminal.setOperatorPin(e.target.value.replace(/\D/g, ''))}
                    />
                  </label>
                  <Button
                    type="submit"
                    className="min-h-11"
                    disabled={terminal.operatorDirectoryState !== 'ready'}
                  >
                    Unlock terminal
                  </Button>
                  {terminal.operatorDirectoryState === 'error' ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void terminal.loadOperators(runtime)}
                    >
                      Retry operators
                    </Button>
                  ) : null}
                </fieldset>
              </form>
            ) : (
              <div className="mt-3 flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={requestPending || Boolean(terminal.pending) || !terminal.online}
                  onClick={() => void terminal.lock()}
                >
                  Lock terminal
                </Button>
                <OperatorSwitch
                  activeOperatorId={runtime.operator?.staffProfileId ?? ''}
                  operators={terminal.operators}
                  pending={requestPending || !ready}
                  onSwitch={terminal.switchOperator}
                />
              </div>
            )}
          </>
        )}
        {!terminal.online ? (
          <p role="status">Offline. Money commands require a connection.</p>
        ) : null}
        {terminal.notice ? (
          <p
            role={
              terminal.notice.tone === 'danger' || terminal.notice.tone === 'warning'
                ? 'alert'
                : 'status'
            }
            className="mt-3"
          >
            {terminal.notice.message}
          </p>
        ) : null}
        <p className="mt-3 text-sm text-text-muted">
          The server checks the enrolled device, active branch, linked operator and catering
          permission on every command. Refunds and cash adjustments require their respective
          permissions.
        </p>
      </SectionCard>
      <CateringTerminalContext.Provider
        value={{ ready: ready && !requestPending, identity, request }}
      >
        {children}
      </CateringTerminalContext.Provider>
    </>
  );
}
