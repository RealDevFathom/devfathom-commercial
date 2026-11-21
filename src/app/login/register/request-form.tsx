'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Upload } from 'lucide-react';
import pharmacyStyles from '@/components/pharmacy/auth-screens.module.css';
import type { LoginVertical } from '../vertical';

type Fields = Record<string, string[]>;
export function RequestForm({ vertical }: { vertical: Exclude<LoginVertical, 'default'> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Fields>({});
  const [reference, setReference] = useState('');
  const [licenceFileName, setLicenceFileName] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setFields({});
    try {
      const response = await fetch('/api/workspace-requests', {
        method: 'POST',
        body: new FormData(event.currentTarget),
      });
      const body = await response.json();
      if (!response.ok || body.status !== 'pending' || !body.id) {
        setFields(body.fields ?? {});
        setError(body.error ?? 'We could not save your request. Please try again.');
        requestAnimationFrame(() => resultRef.current?.focus());
        return;
      }
      setReference(body.id);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch {
      setError('We could not save your request. Check your connection and try again.');
      requestAnimationFrame(() => resultRef.current?.focus());
    } finally {
      setPending(false);
    }
  }
  function field(
    name: string,
    label: string,
    type = 'text',
    placeholder = '',
    required = true,
    hint?: string
  ) {
    return (
      <div className="min-w-0 space-y-2">
        <label htmlFor={name} className="block">
          {label}
          {!required && <span className="ms-2 font-normal text-text-muted">Optional</span>}
        </label>
        <input
          id={name}
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          maxLength={type === 'text' ? 200 : undefined}
          autoComplete={
            name === 'ownerName'
              ? 'name'
              : name === 'email'
                ? 'email'
                : name === 'phone'
                  ? 'tel'
                  : vertical === 'pharmacy' && name === 'address'
                    ? 'street-address'
                    : undefined
          }
          aria-invalid={!!fields[name]}
          aria-describedby={fields[name] || hint ? `${name}-help` : undefined}
          accept={type === 'file' ? '.pdf,.jpg,.jpeg,.png' : undefined}
          min={
            name === 'rooms'
              ? 1
              : name === 'validUntil'
                ? new Date().toISOString().slice(0, 10)
                : undefined
          }
          max={name === 'rooms' ? 100000 : undefined}
        />
        {(fields[name] || hint) && (
          <p
            id={`${name}-help`}
            className={`text-xs leading-5 ${fields[name] ? 'text-destructive' : 'text-text-muted'}`}
          >
            {fields[name]?.join(' ') ?? hint}
          </p>
        )}
      </div>
    );
  }
  function select(name: string, label: string, options: string[]) {
    return (
      <div className="space-y-2">
        <label htmlFor={name} className="block">
          {label}
        </label>
        <StudioSelect
          id={name}
          name={name}
          aria-invalid={vertical === 'pharmacy' ? !!fields[name] : undefined}
          aria-describedby={vertical === 'pharmacy' && fields[name] ? `${name}-help` : undefined}
        >
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </StudioSelect>
        {vertical === 'pharmacy' && fields[name] && (
          <p id={`${name}-help`} className="text-xs leading-5 text-destructive">
            {fields[name].join(' ')}
          </p>
        )}
      </div>
    );
  }
  if (reference)
    return (
      <div
        ref={resultRef}
        tabIndex={-1}
        role="status"
        className="mt-10 rounded-[var(--radius-md)] border border-border-default bg-surface-card p-6"
      >
        <StatusPill status="Pending approval" tone="warning" />
        <h2 className="mt-5 text-xl font-semibold">Your request is saved</h2>
        <p className="mt-3 text-sm leading-6 text-text-muted">
          A DevFathom admin will review your details before setting up your workspace. Your account
          invitation follows approval.
        </p>
        <p className="mt-4 break-all font-mono text-xs">Reference: {reference}</p>
      </div>
    );
  return (
    <form
      onSubmit={submit}
      className={`${vertical === 'pharmacy' ? 'mt-9' : 'mt-10'} space-y-8`}
      aria-busy={pending}
    >
      <input type="hidden" name="vertical" value={vertical} />
      {(error || vertical !== 'pharmacy') && (
        <div ref={resultRef} tabIndex={-1}>
          {error && (
            <p
              role="alert"
              className="rounded-[var(--radius-sm)] border border-destructive p-4 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      )}
      <fieldset disabled={pending} className="space-y-5">
        <legend>
          {vertical === 'pharmacy'
            ? 'Pharmacy'
            : vertical === 'restaurant'
              ? 'Restaurant'
              : 'Property'}
        </legend>
        {vertical === 'hotel' &&
          select('propertyMode', 'How it operates', [
            'Hotel',
            'Hostel',
            'Apartments',
            'Resort',
            'Venue',
          ])}
        {field(
          'companyName',
          vertical === 'pharmacy'
            ? 'Legal business name'
            : vertical === 'restaurant'
              ? 'Restaurant name'
              : 'Property name',
          'text',
          vertical === 'pharmacy'
            ? 'As printed on the licence'
            : vertical === 'hotel'
              ? 'Margalla Suites'
              : ''
        )}
        {vertical === 'pharmacy' ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              {field(
                'branchName',
                'Branch name',
                'text',
                'Model Town',
                true,
                'Printed on customer receipts.'
              )}
              {field('address', 'Premises address', 'text', 'Shop number and street')}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {select('province', 'Province', [
                'Punjab',
                'Sindh',
                'Khyber Pakhtunkhwa',
                'Balochistan',
                'Islamabad Capital Territory',
                'Gilgit-Baltistan',
                'Azad Jammu and Kashmir',
              ])}
              {field('city', 'City', 'text', 'Lahore')}
            </div>
            {field(
              'ntn',
              'NTN',
              'text',
              '1234567-8',
              false,
              'Needed before fiscal invoices can be issued.'
            )}
          </>
        ) : vertical === 'restaurant' ? (
          <>
            {select('branches', 'Branches', ['1', '2 to 5', '6 or more'])}
            <fieldset>
              <legend className="text-sm">How guests order</legend>
              <p className="mb-3 text-xs text-text-muted">
                Choose every channel you take orders through.
              </p>
              <div className="flex flex-wrap gap-4">
                {['Dine-in', 'Takeaway', 'Delivery'].map((channel) => (
                  <label key={channel} className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      name="channels"
                      value={channel}
                      defaultChecked={channel !== 'Delivery'}
                    />
                    {channel}
                  </label>
                ))}
              </div>
              {fields.channels && (
                <p className="text-xs text-destructive">{fields.channels.join(' ')}</p>
              )}
            </fieldset>
          </>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              {field('address', 'Address', 'text', 'Street and building')}
              {field('city', 'City', 'text', 'Islamabad')}
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
              {field('rooms', 'Rooms', 'number', '24')}
              {field('checkIn', 'Check-in from', 'time')}
              {field('checkOut', 'Check-out by', 'time')}
            </div>
            <p className="text-xs text-text-muted">
              Proposed operating details for your setup review.
            </p>
          </>
        )}
      </fieldset>
      {vertical === 'pharmacy' && (
        <>
          <fieldset disabled={pending} className="space-y-5 border-t border-border-subtle pt-8">
            <legend>Drug sale licence</legend>
            <div className="grid gap-5 sm:grid-cols-2">
              {select('licenceCategory', 'Licence category', [
                'Pharmacy',
                'Medical store',
                'Distributor',
              ])}
              {field('licenceNumber', 'Licence number', 'text', 'As printed on the licence')}
              {field('validUntil', 'Valid until', 'date')}
              {field(
                'issuingAuthority',
                'Issuing authority',
                'text',
                'As printed on the licence',
                false
              )}
            </div>
            <div className="space-y-2">
              <span id="licenceCopy-label" className="text-sm font-semibold">
                Licence copy
              </span>
              <label htmlFor="licenceCopy" className={pharmacyStyles.upload}>
                <span
                  aria-hidden="true"
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--accent-quiet)] text-accent-brand"
                >
                  <Upload className="size-[18px]" />
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="block break-words text-sm font-semibold">
                    {licenceFileName || 'Upload a photo or scan of the licence'}
                  </span>
                  <span
                    id="licenceCopy-hint"
                    className="block text-xs font-normal leading-5 text-text-muted"
                  >
                    PDF, JPG or PNG, up to 1 MB. Stored privately with your request.
                  </span>
                </span>
                <input
                  id="licenceCopy"
                  name="licenceCopy"
                  type="file"
                  required
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="sr-only"
                  aria-labelledby="licenceCopy-label"
                  aria-invalid={!!fields.licenceCopy}
                  aria-describedby={
                    fields.licenceCopy ? 'licenceCopy-hint licenceCopy-help' : 'licenceCopy-hint'
                  }
                  onChange={(event) => setLicenceFileName(event.target.files?.[0]?.name ?? '')}
                />
              </label>
              {fields.licenceCopy && (
                <p id="licenceCopy-help" className="text-xs leading-5 text-destructive">
                  {fields.licenceCopy.join(' ')}
                </p>
              )}
            </div>
          </fieldset>
          <fieldset disabled={pending} className="space-y-5 border-t border-border-subtle pt-8">
            <legend>Pharmacist on record</legend>
            <p className="text-xs text-text-muted">The qualified person named on the licence.</p>
            <div className="grid gap-5 sm:grid-cols-2">
              {field('pharmacistName', 'Full name')}
              {field(
                'pharmacistRegistration',
                'Registration number',
                'text',
                '',
                true,
                'From the Pharmacy Council certificate.'
              )}
            </div>
          </fieldset>
        </>
      )}
      {vertical === 'restaurant' && (
        <fieldset disabled={pending} className="space-y-5 border-t border-border-subtle pt-8">
          <legend>First branch</legend>
          <div className="grid gap-5 sm:grid-cols-2">
            {field('branchName', 'Branch name', 'text', 'Gulberg')}
            {field(
              'businessDayCloses',
              'Business day closes at',
              'time',
              '',
              true,
              'Orders before this time count toward the day that just ended.'
            )}
          </div>
          {field('address', 'Address', 'text', 'Street, area, city')}
        </fieldset>
      )}
      <fieldset disabled={pending} className="space-y-5 border-t border-border-subtle pt-8">
        <legend>{vertical === 'pharmacy' ? 'Your account' : 'Your contact details'}</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          {field('ownerName', 'Your name')}
          {field('phone', 'Mobile', 'tel', '+92 300 1234567')}
        </div>
        {field('email', 'Work email', 'email', `you@${vertical}.pk`)}
        <p className="text-xs leading-6 text-text-muted">
          Your account will be created by invitation after approval. Set your password securely when
          accepting the invitation.
        </p>
      </fieldset>
      <label className="flex items-start gap-3 border-t border-border-subtle pt-6">
        <input type="checkbox" name="authorized" required disabled={pending} />
        <span>
          {vertical === 'pharmacy'
            ? 'I’m authorised to register this pharmacy and its licence.'
            : `I own or manage this ${vertical === 'hotel' ? 'property' : 'restaurant'} and can set it up.`}
        </span>
      </label>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Saving your request…' : 'Request workspace'}
      </Button>
      <p className="text-xs leading-6 text-text-muted">
        A DevFathom admin reviews the request and sets up your workspace. It goes live once the
        required setup is complete.
      </p>
    </form>
  );
}
