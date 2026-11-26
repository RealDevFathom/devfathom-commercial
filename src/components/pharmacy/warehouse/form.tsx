'use client';

import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';

export function read(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

export function Field({
  label,
  name,
  type = 'text',
  required = true,
  value,
  min,
  max,
  step,
  scan = false,
}: {
  label: string;
  name: string;
  type?: 'text' | 'number' | 'password';
  required?: boolean;
  value?: string | number;
  min?: number;
  max?: number;
  step?: number | 'any';
  scan?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm text-text-body">
      {label}
      <Input
        className="min-h-11"
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        min={min}
        max={max}
        step={step}
        autoComplete="off"
        data-scan={scan || undefined}
      />
    </label>
  );
}

export function Choice({
  label,
  name,
  children,
  value,
}: {
  label: string;
  name: string;
  children: ReactNode;
  value?: string;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm text-text-body">
      {label}
      <SelectField className="min-h-11" required name={name} defaultValue={value}>
        {children}
      </SelectField>
    </label>
  );
}

export function Problem({ error, retry }: { error: { message: string }; retry?: () => void }) {
  return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{error.message}</p>
      {retry && (
        <Button onClick={retry} type="button" variant="outline">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>;
}

const WorkspaceFeedback = createContext<{
  online: boolean;
  announce: (text: string) => void;
} | null>(null);

function subscribeToConnectivity(update: () => void) {
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

export function WarehouseFeedback({ children }: { children: ReactNode }) {
  const online = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => false
  );
  const [notice, announce] = useState('');
  return (
    <WorkspaceFeedback.Provider value={{ online, announce }}>
      {!online && (
        <p role="status" className="text-sm text-warning">
          Waiting for a connection. Reconnect to confirm warehouse work.
        </p>
      )}
      <p role="status" aria-live="polite" className="empty:hidden text-sm text-success">
        {notice}
      </p>
      {children}
    </WorkspaceFeedback.Provider>
  );
}

/** Keep the command key across connection failures. An edited form is a new command. */
export function ActionForm<Result>({
  action,
  label,
  success,
  children,
  destructive,
  disabled,
}: {
  action: (data: FormData, key: string) => Promise<Result>;
  label: string;
  success: string | ((result: Result) => string);
  children?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const last = useRef<{ signature: string; key: string } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const utils = trpc.useUtils();
  const feedback = useContext(WorkspaceFeedback);
  const unavailable = disabled || feedback?.online === false;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || unavailable) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const signature = JSON.stringify(Array.from(data.entries()));
    if (!last.current || signature !== last.current.signature)
      last.current = { signature, key: crypto.randomUUID() };
    busy.current = true;
    setPending(true);
    setMessage(null);
    feedback?.announce('');
    try {
      const result = await action(data, last.current.key);
      const text = typeof success === 'string' ? success : success(result);
      last.current = null;
      form.reset();
      if (feedback) feedback.announce(text);
      else setMessage({ ok: true, text });
      await Promise.allSettled([
        utils.pharmacyWarehouse.invalidate(),
        utils.pharmacyInventory.transferBoard.invalidate(),
      ]);
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : 'The command could not be confirmed. Retry with the same values.',
      });
    } finally {
      setPending(false);
      busy.current = false;
    }
  }
  return (
    <form
      aria-label={label}
      aria-busy={pending}
      onSubmit={submit}
      className="space-y-3"
      onKeyDown={(event) => {
        if (
          event.key !== 'Enter' ||
          !(event.target instanceof HTMLInputElement) ||
          !event.target.dataset.scan
        )
          return;
        event.preventDefault();
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'input:not([type=hidden]),button[type=submit]'
          )
        );
        controls[controls.indexOf(event.target) + 1]?.focus();
      }}
    >
      {children && (
        <fieldset
          disabled={pending || unavailable}
          className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {children}
        </fieldset>
      )}
      <Button
        className="min-h-11"
        variant={destructive ? 'destructive' : 'secondary'}
        disabled={pending || unavailable}
        type="submit"
      >
        {pending ? 'Confirming…' : label}
      </Button>
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'text-sm text-success' : 'text-sm text-destructive'}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
