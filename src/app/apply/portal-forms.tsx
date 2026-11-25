'use client';
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { portalNotice } from '@/lib/university/portal-labels';
import { postPortalAction } from '@/lib/university/portal-client';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
export type Language = 'en' | 'ur';
const subscribeHydration = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false
  );
}
export function Field({
  name,
  label,
  initial = '',
  required = false,
  type = 'text',
  max,
}: {
  name: string;
  label: string;
  initial?: string;
  required?: boolean;
  type?: string;
  max?: number;
}) {
  const [initialValue] = useState(initial);
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        className="min-h-11"
        name={name}
        type={type}
        defaultValue={initialValue}
        required={required}
        maxLength={max}
      />
    </label>
  );
}
export function Picker({
  name,
  label,
  children,
  initial,
}: {
  name: string;
  label: string;
  children: ReactNode;
  initial?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <SelectField name={name} defaultValue={initial} required>
        {children}
      </SelectField>
    </label>
  );
}
export function PortalForm({
  action,
  label,
  children,
  language = 'en',
  secondary,
  confirm,
}: {
  action: string;
  label: string;
  children?: ReactNode;
  language?: Language;
  secondary?: { action: string; label: string };
  confirm?: string;
}) {
  const hydrated = useHydrated();
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const button = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const selected = button?.value || action,
      input = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setMessage('');
    try {
      const r = await postPortalAction(selected, input);
      if (selected === 'profile') {
        const number = form.elements.namedItem('number');
        if (number instanceof HTMLInputElement) number.value = '';
      }
      setMessage(
        language === 'ur'
          ? 'درخواست محفوظ ہو گئی۔'
          : 'Saved' + (r.status ? ' · ' + r.status : '') + '.'
      );
      router.refresh();
    } catch (error) {
      setMessage(
        portalNotice(error instanceof Error ? error.message : 'Unable to save.', language)
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form method="post" action="/apply/portal/form" onSubmit={submit} className="grid gap-3">
      <fieldset className="contents" disabled={!hydrated}>
        {children}
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" type="submit" value={action} disabled={busy || !hydrated}>
            {busy ? (language === 'ur' ? 'انتظار کریں…' : 'Please wait…') : label}
          </Button>
          {secondary && (
            <Button
              className="min-h-11"
              type="submit"
              value={secondary.action}
              variant="outline"
              disabled={busy || !hydrated}
            >
              {secondary.label}
            </Button>
          )}
        </div>
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </fieldset>
    </form>
  );
}
export function SignIn({ language }: { language: Language }) {
  const hydrated = useHydrated();
  const router = useRouter(),
    ur = language === 'ur';
  const [challenge, setChallenge] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const input = Object.fromEntries(new FormData(e.currentTarget));
      if (challenge) {
        await postPortalAction('verify', { challenge, code: input.code });
        router.refresh();
      } else {
        const result = await postPortalAction('sign-in', { email: input.email });
        setChallenge(result.challenge ?? '');
      }
    } catch (err) {
      setError(portalNotice(err instanceof Error ? err.message : 'Unable to sign in.', language));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      method="post"
      action="/apply/portal/form"
      onSubmit={submit}
      className="grid max-w-lg gap-3"
    >
      <fieldset className="contents" disabled={!hydrated}>
        {challenge ? (
          <>
            <p>
              {ur
                ? 'اپنے ای میل پر بھیجا گیا آٹھ ہندسوں کا کوڈ درج کریں۔'
                : 'Enter the eight-digit code we sent to your email. It expires in 15 minutes.'}
            </p>
            <label>
              {ur ? 'تصدیقی کوڈ' : 'Sign-in code'}
              <Input
                className="min-h-11"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{8}"
                required
                maxLength={8}
              />
            </label>
          </>
        ) : (
          <Field
            name="email"
            label={ur ? 'ای میل پتہ' : 'Email address'}
            type="email"
            required
            max={254}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="min-h-11" disabled={busy || !hydrated}>
            {busy
              ? ur
                ? 'انتظار کریں…'
                : 'Please wait…'
              : challenge
                ? ur
                  ? 'داخل ہوں'
                  : 'Sign in'
                : ur
                  ? 'کوڈ بھیجیں'
                  : 'Email me a code'}
          </Button>
          {challenge && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setChallenge('');
                setError('');
              }}
            >
              {ur ? 'نیا کوڈ حاصل کریں' : 'Request another code'}
            </Button>
          )}
        </div>
        <p role="status" aria-live="polite">
          {error}
        </p>
      </fieldset>
    </form>
  );
}
const chunk = 256 * 1024;
function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function UploadDocument({ language }: { language: Language }) {
  const hydrated = useHydrated();
  const ur = language === 'ur',
    router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form),
      file = data.get('file');
    if (!(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024) {
      setMessage(ur ? 'فائل پانچ میگا بائٹ تک ہو سکتی ہے۔' : 'Choose a file of up to 5 MB.');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
        n.toString(16).padStart(2, '0')
      ).join('');
      const start = await postPortalAction('upload-start', {
        label: data.get('label'),
        filename: file.name,
        mime: file.type,
        size: file.size,
        hash,
      });
      if (!start.complete) {
        for (let i = 0; i < Math.ceil(bytes.length / chunk); i++) {
          if (!start.received?.includes(i))
            await postPortalAction('upload-part', {
              id: start.id,
              part: i,
              base64: toBase64(bytes.subarray(i * chunk, (i + 1) * chunk)),
            });
          setMessage(Math.min(100, Math.round(((i + 1) * chunk * 100) / bytes.length)) + '%');
        }
        await postPortalAction('upload-finish', { id: start.id });
      }
      form.reset();
      setMessage(ur ? 'فائل محفوظ ہو گئی۔' : 'Document received.');
      router.refresh();
    } catch (error) {
      setMessage(
        (error instanceof Error ? error.message : 'Upload interrupted.') +
          ' ' +
          (ur ? 'جاری رکھنے کے لیے وہی فائل منتخب کریں۔' : 'Select the same file to resume.')
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      method="post"
      action="/apply/portal/form"
      onSubmit={submit}
      className="grid max-w-lg gap-3"
    >
      <fieldset className="contents" disabled={!hydrated}>
        <Picker label={ur ? 'دستاویز کی قسم' : 'Document type'} name="label">
          {['Identity', 'Qualification', 'Equivalence', 'Supporting evidence'].map((v, i) => (
            <option key={v} value={v}>
              {ur ? ['شناخت', 'تعلیمی سند', 'مساوات', 'دوسرا ثبوت'][i] : v}
            </option>
          ))}
        </Picker>
        <label>
          {ur ? 'فائل (پانچ میگا بائٹ تک)' : 'PDF, JPEG or PNG (up to 5 MB)'}
          <Input
            type="file"
            className="min-h-11"
            accept=".pdf,.jpg,.jpeg,.png"
            name="file"
            required
          />
        </label>
        <Button type="submit" disabled={busy || !hydrated}>
          {ur ? 'دستاویز اپ لوڈ کریں' : 'Upload document'}
        </Button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </fieldset>
    </form>
  );
}
export function PrintDocument({ language }: { language: Language }) {
  return (
    <Button type="button" className="print:hidden" onClick={() => window.print()}>
      {language === 'ur' ? 'پرنٹ کریں' : 'Print'}
    </Button>
  );
}
