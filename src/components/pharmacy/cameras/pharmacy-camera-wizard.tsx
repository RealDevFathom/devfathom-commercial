'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { OperatorSafeSelector } from '@/components/restaurant/operator-safe-selector';

/** The only sources the diagnostic simulator answers; never a real device address. */
export const PHARMACY_SIMULATOR_SOURCES = [
  { value: 'sim-camera-1', label: 'Simulator camera 1' },
  { value: 'sim-counter-1', label: 'Simulator counter camera' },
  { value: 'sim-fridge-1', label: 'Simulator fridge camera' },
] as const;
export type PharmacySimulatorSource = (typeof PHARMACY_SIMULATOR_SOURCES)[number]['value'];

export type PharmacyCameraWizardBranch = { id: string; name: string };
export type PharmacyCameraWizardGateway = {
  id: string;
  name: string;
  branchId: string;
  status: string;
};
export type PharmacyCameraWizardValues = {
  branchId: string;
  name: string;
  gatewayId: string;
  sourceRef: PharmacySimulatorSource;
  username: string;
  password: string;
  registerAnyway: boolean;
};

const field =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * Same callback architecture as the restaurant wizard: test first, then
 * register, with an explicit "register anyway" for an offline camera. Only the
 * diagnostic simulator is supported; no physical camera is contacted.
 */
export function PharmacyCameraWizard({
  branches,
  gateways,
  gatewaysLoading = false,
  gatewaysError = false,
  onTest,
  onSubmit,
  busy = false,
}: {
  branches: PharmacyCameraWizardBranch[];
  gateways: PharmacyCameraWizardGateway[];
  gatewaysLoading?: boolean;
  gatewaysError?: boolean;
  onTest: (
    values: PharmacyCameraWizardValues
  ) => Promise<{ outcome: 'ok' | 'auth-failed' | 'unreachable'; discoveredProfile?: string }>;
  onSubmit: (values: PharmacyCameraWizardValues) => Promise<void>;
  busy?: boolean;
}) {
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0]!.id : '');
  const [gatewayId, setGatewayId] = useState('');
  const [tested, setTested] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [pending, setPending] = useState(false);
  const effectiveBranchId = branchId || (branches.length === 1 ? branches[0]!.id : '');

  function values(form: HTMLFormElement, registerAnyway: boolean): PharmacyCameraWizardValues {
    const data = new FormData(form);
    return {
      branchId: effectiveBranchId,
      name: String(data.get('name') ?? ''),
      gatewayId,
      sourceRef: String(data.get('sourceRef')) as PharmacySimulatorSource,
      username: String(data.get('username') ?? ''),
      password: String(data.get('password') ?? ''),
      registerAnyway,
    };
  }
  async function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await onTest(values(event.currentTarget, false));
      setTested(result.outcome === 'ok');
      setOutcome(
        result.outcome === 'ok'
          ? `Simulator responded · ${result.discoveredProfile ?? 'diagnostic profile'}. This is not physical camera or live video proof.`
          : result.outcome === 'auth-failed'
            ? 'Authentication failed.'
            : 'Camera is unreachable.'
      );
    } catch {
      setTested(false);
      setOutcome('Connection check failed. Check your access and gateway setup, then try again.');
    } finally {
      setPending(false);
    }
  }
  async function register(form: HTMLFormElement, registerAnyway: boolean) {
    setPending(true);
    try {
      await onSubmit(values(form, registerAnyway));
      setTested(false);
      setOutcome(
        registerAnyway
          ? 'Camera registered offline. Enable it after a successful connection test.'
          : 'Camera registered. Choose its preset below.'
      );
      form.reset();
    } catch {
      setOutcome('Registration failed. Check your access and gateway setup, then try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <SectionCard eyebrow="Camera setup" title="Register a camera">
      <p className="mb-4 text-sm text-text-muted">
        Diagnostic simulator only. Choose a simulator source; no physical camera, DVR or network
        address is contacted, and no live video is available.
      </p>
      {branches.length > 1 && (
        <label className="mb-4 block text-sm font-medium text-text-strong">
          Branch
          <StudioSelect
            aria-label="Branch"
            className={field}
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              setGatewayId('');
              setTested(false);
              setOutcome('');
            }}
          >
            <option value="" disabled>
              Select branch
            </option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </StudioSelect>
        </label>
      )}
      {branches.length === 0 && (
        <p role="status" className="mb-4 text-sm text-text-muted">
          No active pharmacy branches are available for your access.
        </p>
      )}
      <form
        aria-label="Register a camera"
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(event) => {
          if (!tested) return void test(event);
          event.preventDefault();
          void register(event.currentTarget, false);
        }}
        onChange={() => {
          setTested(false);
          setOutcome('');
        }}
      >
        <label className="text-sm font-medium text-text-strong">
          Camera name
          <Input name="name" required maxLength={120} />
        </label>
        <div className="text-sm font-medium text-text-strong">
          <span>Camera gateway</span>
          <OperatorSafeSelector
            label="Camera gateway"
            name="gatewayId"
            required
            value={gatewayId}
            onChange={setGatewayId}
            loading={gatewaysLoading}
            error={gatewaysError}
            disabled={!effectiveBranchId || busy || pending}
            emptyLabel="No active gateways for this branch"
            options={gateways
              .filter(
                (gateway) => gateway.branchId === effectiveBranchId && gateway.status === 'ACTIVE'
              )
              .map((gateway) => ({
                value: gateway.id,
                label: gateway.name,
                code: gateway.status.toLocaleLowerCase(),
              }))}
          />
        </div>
        <label className="text-sm font-medium text-text-strong">
          Simulator source
          <StudioSelect name="sourceRef" required className={field} defaultValue="sim-counter-1">
            {PHARMACY_SIMULATOR_SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label} ({source.value})
              </option>
            ))}
          </StudioSelect>
        </label>
        <p className="text-sm text-text-muted">
          Use placeholder credentials. They are sealed in private storage and never shown again; do
          not enter a real device password.
        </p>
        <label className="text-sm font-medium text-text-strong">
          Username
          <Input name="username" required maxLength={200} autoComplete="off" />
        </label>
        <label className="text-sm font-medium text-text-strong">
          Password
          <Input
            name="password"
            required
            maxLength={500}
            type="password"
            autoComplete="new-password"
          />
        </label>
        {outcome && (
          <p role="status" className="md:col-span-2 text-sm text-text-muted">
            {outcome}
          </p>
        )}
        <div className="md:col-span-2 flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || pending || !effectiveBranchId || !gatewayId}>
            {tested ? 'Register camera' : 'Test connection'}
          </Button>
          {!tested && outcome && !outcome.startsWith('Camera registered') && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || pending || !effectiveBranchId || !gatewayId}
              onClick={(event) => {
                const form = event.currentTarget.closest('form');
                if (form?.reportValidity()) void register(form, true);
              }}
            >
              Register anyway
            </Button>
          )}
        </div>
      </form>
    </SectionCard>
  );
}
