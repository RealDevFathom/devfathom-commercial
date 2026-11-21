'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import type { inferRouterOutputs } from '@trpc/server';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { AppRouter } from '@/server/routers/_app';

type SettingsView = inferRouterOutputs<AppRouter>['aiSettings']['get'];
type ProviderView = SettingsView['providers'][number];
type Provider = ProviderView['provider'];
type Mode = SettingsView['mode']['value'];
type CapStatus = ProviderView['capStatus'];

const PROVIDERS = ['anthropic', 'openai', 'bedrock'] as const satisfies readonly Provider[];

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Bedrock',
};

/** What a provider needs, by variable name only. Values are never read into the page. */
const CONFIGURATION_HINT: Record<Provider, string> = {
  anthropic: 'Set ANTHROPIC_API_KEY_SECRET_ID to the Secrets Manager secret for its key.',
  openai: 'Set OPENAI_API_KEY_SECRET_ID to the Secrets Manager secret for its key.',
  bedrock: 'Set BEDROCK_REGION. Bedrock uses the instance role, never static keys.',
};

const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string; hint: string }> = [
  { value: 'Auto', label: 'Auto', hint: 'Follow the fallback order.' },
  {
    value: 'ForceAnthropic',
    label: 'Anthropic',
    hint: 'Always try Anthropic first, then the order if fallback is on.',
  },
  {
    value: 'ForceOpenAI',
    label: 'OpenAI',
    hint: 'Always try OpenAI first, then the order if fallback is on.',
  },
  {
    value: 'ForceBedrock',
    label: 'Bedrock',
    hint: 'Always try Bedrock first, then the order if fallback is on.',
  },
  { value: 'Disabled', label: 'Disabled', hint: 'Turn AI off for every organization.' },
];

const TIER_LABEL = { cheap: 'Cheap', standard: 'Standard', deep: 'Deep' } as const;

const CAP_STATUS: Record<CapStatus, { label: string; tone: StatusTone; bar: string }> = {
  under: { label: 'Under cap', tone: 'success', bar: 'bg-success' },
  near: { label: 'Near cap', tone: 'warning', bar: 'bg-warning' },
  at: { label: 'At cap · skipped', tone: 'danger', bar: 'bg-destructive' },
  over: { label: 'Over cap · skipped', tone: 'danger', bar: 'bg-destructive' },
  unknown: { label: 'Spend unknown · skipped', tone: 'warning', bar: 'bg-warning' },
};

const SAVED_MESSAGE = 'Saved. Changes apply within 30 seconds.';

const money = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

const chainText = (chain: readonly Provider[]) =>
  chain.length ? chain.map((name) => PROVIDER_LABEL[name]).join(' → ') : 'None';

const sectionClass = 'rounded-2xl border border-border-default bg-surface-card';
const sectionHeaderClass = 'border-b border-border-subtle px-5 py-4';
const eyebrowClass = 'font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted';

function SourcePill({ isOverride }: { isOverride: boolean }) {
  return isOverride ? (
    <StatusPill status="override" tone="info" label="Override" />
  ) : (
    <StatusPill status="default" tone="neutral" label="Default" />
  );
}

type OrderDraft = Array<{ provider: Provider; included: boolean }>;

function orderFromView(order: readonly Provider[]): OrderDraft {
  return [
    ...order.map((provider) => ({ provider, included: true })),
    ...PROVIDERS.filter((provider) => !order.includes(provider)).map((provider) => ({
      provider,
      included: false,
    })),
  ];
}

export function AiSettingsConsole() {
  const utils = trpc.useUtils();
  const settings = trpc.aiSettings.get.useQuery();
  const prices = trpc.aiSettings.listModelPrices.useQuery();
  const [message, setMessage] = useState('');
  const [orderDraft, setOrderDraft] = useState<OrderDraft | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const saved = async () => {
    setMessage(SAVED_MESSAGE);
    await Promise.all([
      utils.aiSettings.get.invalidate(),
      utils.aiSettings.listModelPrices.invalidate(),
    ]);
  };
  const failed = (error: { message: string }) => setMessage(error.message);
  const callbacks = { onSuccess: saved, onError: failed };
  const mode = trpc.aiSettings.setMode.useMutation(callbacks);
  const order = trpc.aiSettings.setProviderOrder.useMutation({
    onSuccess: async () => {
      setOrderDraft(null);
      await saved();
    },
    onError: failed,
  });
  const fallback = trpc.aiSettings.setFallbackEnabled.useMutation(callbacks);
  const cap = trpc.aiSettings.setMonthlyCap.useMutation(callbacks);
  const model = trpc.aiSettings.setTierModel.useMutation(callbacks);
  const reset = trpc.aiSettings.reset.useMutation({
    onSuccess: async (_result, input) => {
      if (input.scope === 'all' || input.scope === 'providerOrder') setOrderDraft(null);
      setConfirmReset(false);
      await saved();
    },
    onError: failed,
  });
  const price = trpc.aiSettings.upsertModelPrice.useMutation(callbacks);

  if (settings.isLoading || prices.isLoading) {
    return (
      <section className={cn('mt-7 p-5', sectionClass)} aria-busy="true">
        <p className="text-sm text-text-muted">Loading AI settings…</p>
      </section>
    );
  }
  if (!settings.data || prices.error) {
    return (
      <section className={cn('mt-7 p-5', sectionClass)}>
        <p role="alert" className="text-sm text-destructive">
          {settings.error?.message ?? prices.error?.message ?? 'Unable to load AI settings.'}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          AI keeps running on the last saved settings. Reload the page to try again.
        </p>
      </section>
    );
  }
  const data = settings.data;
  const draft = orderDraft ?? orderFromView(data.providerOrder.value);
  const draftOrder = draft.filter((entry) => entry.included).map((entry) => entry.provider);

  const submit = (event: FormEvent<HTMLFormElement>, action: (values: FormData) => void) => {
    event.preventDefault();
    setMessage('');
    action(new FormData(event.currentTarget));
  };
  const move = (index: number, offset: -1 | 1) => {
    const next = [...draft];
    const [entry] = next.splice(index, 1);
    next.splice(index + offset, 0, entry);
    setOrderDraft(next);
  };
  const toggle = (index: number) =>
    setOrderDraft(
      draft.map((entry, position) =>
        position === index ? { ...entry, included: !entry.included } : entry
      )
    );

  return (
    <div className="mt-7 space-y-7">
      <div role="status" aria-live="polite" className="min-h-5 text-sm text-text-muted">
        {message}
      </div>

      <section className={sectionClass} aria-labelledby="ai-routing-title">
        <div className={cn(sectionHeaderClass, 'flex flex-wrap items-start justify-between gap-4')}>
          <div className="min-w-0">
            <p className={eyebrowClass}>SuperAdmin · AI providers</p>
            <h2 id="ai-routing-title" className="mt-1 font-display text-xl font-semibold">
              AI routing
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              Saved changes apply within {data.appliesWithinSeconds} seconds. Provider keys stay in
              AWS Secrets Manager and are never shown here.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="touch"
            onClick={() => {
              setMessage('');
              setConfirmReset(true);
            }}
          >
            <RotateCcw aria-hidden />
            Reset to defaults
          </Button>
        </div>

        {data.routing !== 'active' ? (
          <p
            role="note"
            className="border-b border-border-subtle bg-warning/10 px-5 py-3 text-sm text-warning"
          >
            {data.routing === 'bypassed'
              ? 'AI_PROVIDER selects a provider outside routing, so these settings are not used until it is unset or set to auto, anthropic, openai or bedrock.'
              : data.routing === 'disabled'
                ? 'AI_PROVIDER=disabled turns AI off in this environment, whatever is saved here.'
                : 'AI_PROVIDER has an unrecognised value, so AI is unavailable in this environment.'}
          </p>
        ) : null}

        <div className="grid gap-px bg-border-subtle lg:grid-cols-2">
          <form
            key={data.mode.value}
            aria-label="Active provider"
            className="space-y-4 bg-surface-card p-5"
            onSubmit={(event) =>
              submit(event, (form) => mode.mutate({ mode: String(form.get('mode')) as Mode }))
            }
          >
            <fieldset>
              <legend className="flex w-full items-center justify-between gap-3">
                <span className="text-xs font-semibold">Active provider</span>
                <SourcePill isOverride={data.mode.isOverride} />
              </legend>
              <div className="mt-3 grid gap-2">
                {MODE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border-default bg-surface-page px-3 py-2.5 transition-colors hover:bg-surface-sunken has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30"
                  >
                    <input
                      type="radio"
                      name="mode"
                      value={option.value}
                      defaultChecked={data.mode.value === option.value}
                      className="mt-1 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-xs text-text-muted">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-xs text-text-muted">
              Tried now, in order:{' '}
              <span className="font-mono text-text-strong" data-testid="ai-chain">
                {chainText(data.chain)}
              </span>
            </p>
            <Button type="submit" size="touch" disabled={mode.isPending}>
              {mode.isPending ? 'Saving…' : 'Save active provider'}
            </Button>
          </form>

          <div className="space-y-5 bg-surface-card p-5">
            <form
              aria-labelledby="ai-order-title"
              className="space-y-3"
              onSubmit={(event) =>
                submit(event, () => {
                  if (draftOrder.length) order.mutate({ providerOrder: draftOrder });
                })
              }
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id="ai-order-title" className="text-xs font-semibold">
                  Fallback order
                </h3>
                <SourcePill isOverride={data.providerOrder.isOverride} />
              </div>
              <ol className="space-y-2">
                {draft.map((entry, index) => {
                  const label = PROVIDER_LABEL[entry.provider];
                  return (
                    <li
                      key={entry.provider}
                      className="flex min-h-11 items-center gap-3 rounded-xl border border-border-default bg-surface-page px-3 py-1.5"
                    >
                      <span className="w-4 font-mono text-xs tabular-nums text-text-muted">
                        {entry.included ? draftOrder.indexOf(entry.provider) + 1 : '–'}
                      </span>
                      <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          checked={entry.included}
                          onChange={() => toggle(index)}
                          className="size-4 accent-primary"
                          aria-label={`Include ${label} in the order`}
                        />
                        {label}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        aria-label={`Move ${label} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        aria-label={`Move ${label} down`}
                        disabled={index === draft.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ol>
              {draftOrder.length ? null : (
                <p role="alert" className="text-xs text-destructive">
                  Keep at least one provider in the order.
                </p>
              )}
              <p className="text-xs text-text-muted">
                Default (
                {data.providerOrder.defaultSource === 'environment'
                  ? 'AI_PROVIDER_ORDER'
                  : 'built-in'}
                ): <span className="font-mono">{chainText(data.providerOrder.defaultValue)}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="touch" disabled={order.isPending || !draftOrder.length}>
                  {order.isPending ? 'Saving…' : 'Save order'}
                </Button>
                {data.providerOrder.isOverride ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={reset.isPending}
                    onClick={() => {
                      setMessage('');
                      reset.mutate({ scope: 'providerOrder' });
                    }}
                  >
                    Use default order
                  </Button>
                ) : null}
              </div>
            </form>

            <div className="flex items-start justify-between gap-4 border-t border-border-subtle pt-5">
              <div className="min-w-0">
                <p id="ai-fallback-label" className="text-xs font-semibold">
                  Fallback
                </p>
                <p id="ai-fallback-hint" className="mt-1 text-xs text-text-muted">
                  When a provider is not configured, at its cap or fails, try the next one. Off
                  means only the first provider is tried.
                </p>
              </div>
              <div className="flex min-h-11 shrink-0 items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  {data.fallbackEnabled.value ? 'On' : 'Off'}
                </span>
                <Switch
                  checked={data.fallbackEnabled.value}
                  disabled={fallback.isPending}
                  aria-label="Fall back to the next provider"
                  aria-describedby="ai-fallback-hint"
                  onCheckedChange={(checked) => {
                    setMessage('');
                    fallback.mutate({ fallbackEnabled: checked });
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={sectionClass} aria-labelledby="ai-providers-title">
        <div className={sectionHeaderClass}>
          <p className={eyebrowClass}>Asia/Karachi · {data.month.label}</p>
          <h2 id="ai-providers-title" className="mt-1 font-display text-xl font-semibold">
            Providers, caps and models
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            A provider at its monthly cap is skipped until the month ends or the cap is raised.
          </p>
        </div>
        <div className="grid gap-px bg-border-subtle xl:grid-cols-3">
          {data.providers.map((view) => (
            <ProviderPanel
              key={view.provider}
              view={view}
              busy={cap.isPending || model.isPending || reset.isPending}
              onCap={(capUsd) => {
                setMessage('');
                cap.mutate({ provider: view.provider, capUsd });
              }}
              onModel={(tier, value) => {
                setMessage('');
                model.mutate({ provider: view.provider, tier, model: value });
              }}
              onResetCap={() => {
                setMessage('');
                reset.mutate({ scope: 'cap', provider: view.provider });
              }}
              onResetModel={(tier) => {
                setMessage('');
                reset.mutate({ scope: 'model', provider: view.provider, tier });
              }}
            />
          ))}
        </div>
      </section>

      <section className={sectionClass} aria-labelledby="ai-prices-title">
        <div className={sectionHeaderClass}>
          <h2 id="ai-prices-title" className="font-display text-xl font-semibold">
            Model prices
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            USD per million tokens, versioned by effective date. Spend is priced with the latest row
            in effect at the time of each call.
          </p>
        </div>
        <form
          aria-label="Add a model price"
          className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-6"
          onSubmit={(event) =>
            submit(event, (form) =>
              price.mutate({
                provider: String(form.get('provider')) as Provider,
                model: String(form.get('model')),
                inputUsdPerMTok: String(form.get('input')),
                outputUsdPerMTok: String(form.get('output')),
                effectiveFrom: new Date(String(form.get('effectiveFrom'))),
              })
            )
          }
        >
          <StudioSelect
            name="provider"
            aria-label="Provider"
            className="h-11 rounded-xl border border-border-default bg-surface-page px-3 text-sm"
          >
            {PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_LABEL[value]}
              </option>
            ))}
          </StudioSelect>
          <Input
            name="model"
            aria-label="Model"
            placeholder="Model identifier"
            required
            maxLength={200}
            className="h-11"
          />
          <Input
            name="input"
            aria-label="Input price"
            type="number"
            min="0.000001"
            max="1000000"
            step="0.000001"
            placeholder="Input price"
            required
            className="h-11"
          />
          <Input
            name="output"
            aria-label="Output price"
            type="number"
            min="0.000001"
            max="1000000"
            step="0.000001"
            placeholder="Output price"
            required
            className="h-11"
          />
          <Input
            name="effectiveFrom"
            aria-label="Effective from"
            type="datetime-local"
            required
            className="h-11"
          />
          <Button type="submit" size="touch" disabled={price.isPending}>
            Save price
          </Button>
        </form>
        <div className="overflow-x-auto border-t border-border-subtle">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="p-4">Provider</th>
                <th>Model</th>
                <th className="text-right">Input</th>
                <th className="text-right">Output</th>
                <th className="px-4">Effective</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {prices.data?.map((row) => (
                <tr key={row.id} className="hover:bg-surface-sunken/50">
                  <td className="p-4">
                    {PROVIDER_LABEL[row.provider as Provider] ?? row.provider}
                  </td>
                  <td className="font-mono text-xs">{row.model}</td>
                  <td className="text-right tabular-nums">${row.inputUsdPerMTok}</td>
                  <td className="text-right tabular-nums">${row.outputUsdPerMTok}</td>
                  <td className="px-4">{row.effectiveFrom.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {prices.data?.length ? null : (
            <p className="px-5 py-8 text-center text-sm text-text-muted">
              No price rows yet. Built-in list prices are used until one is saved.
            </p>
          )}
        </div>
      </section>

      <Dialog
        open={confirmReset}
        onOpenChange={(open) => {
          if (!open && !reset.isPending) setConfirmReset(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reset AI routing to defaults?</DialogTitle>
            <DialogDescription>
              The active provider returns to Auto, fallback turns on, and the order, monthly caps
              and tier models return to their environment defaults. Changes apply within{' '}
              {data.appliesWithinSeconds} seconds. Model prices are not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={reset.isPending}
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={reset.isPending}
              onClick={() => reset.mutate({ scope: 'all' })}
            >
              {reset.isPending ? 'Resetting…' : 'Reset to defaults'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderPanel({
  view,
  busy,
  onCap,
  onModel,
  onResetCap,
  onResetModel,
}: {
  view: ProviderView;
  busy: boolean;
  onCap: (capUsd: string) => void;
  onModel: (tier: ProviderView['models'][number]['tier'], model: string) => void;
  onResetCap: () => void;
  onResetModel: (tier: ProviderView['models'][number]['tier']) => void;
}) {
  const label = PROVIDER_LABEL[view.provider];
  const status = CAP_STATUS[view.capStatus];
  const percent =
    view.spentUsd === null
      ? 0
      : view.capUsd > 0
        ? Math.min(100, (view.spentUsd / view.capUsd) * 100)
        : 100;
  const capId = `ai-cap-${view.provider}`;

  return (
    <div
      className="min-w-0 space-y-5 bg-surface-card p-5"
      role="group"
      aria-labelledby={`ai-provider-${view.provider}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`ai-provider-${view.provider}`} className="font-display text-lg font-semibold">
          {label}
        </h3>
        <StatusPill
          status={view.configured ? 'configured' : 'not-configured'}
          tone={view.configured ? 'success' : 'neutral'}
          label={view.configured ? 'Configured' : 'Not configured'}
        />
      </div>
      {view.configured ? null : (
        <p className="text-xs text-text-muted">
          Skipped until configured. {CONFIGURATION_HINT[view.provider]}
        </p>
      )}

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold">Spend this month</p>
          <StatusPill status={view.capStatus} tone={status.tone} label={status.label} />
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">
          {view.spentUsd === null ? 'Unknown' : money(view.spentUsd)}{' '}
          <span className="text-sm font-normal text-text-muted">of {money(view.capUsd)}</span>
        </p>
        <div
          role="progressbar"
          aria-label={`${label} spend against its monthly cap`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={
            view.spentUsd === null
              ? 'Spend unknown'
              : `${money(view.spentUsd)} of ${money(view.capUsd)}`
          }
          className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
        >
          <div className={cn('h-full', status.bar)} style={{ width: `${percent}%` }} />
        </div>
      </div>

      <form
        key={`cap-${view.capUsd}`}
        aria-label={`${label} monthly cap`}
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          onCap(String(new FormData(event.currentTarget).get('cap')));
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={capId} className="text-xs font-semibold">
            Monthly cap (USD)
          </label>
          <SourcePill isOverride={view.capIsOverride} />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={capId}
            name="cap"
            type="number"
            min="0"
            max="1000000"
            step="0.0001"
            defaultValue={String(view.capUsd)}
            required
            className="h-11"
          />
          <Button
            type="submit"
            variant="outline"
            size="touch"
            disabled={busy}
            aria-label={`Save ${label} monthly cap`}
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-text-muted">
          Default {money(view.defaultCapUsd)} ({view.defaultCapSource})
          {view.capIsOverride ? (
            <>
              {' · '}
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0"
                disabled={busy}
                onClick={onResetCap}
                aria-label={`Use the default ${label} cap`}
              >
                Use default
              </Button>
            </>
          ) : null}
        </p>
      </form>

      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold">Tier models</legend>
        {view.models.map((entry) => {
          const inputId = `ai-model-${view.provider}-${entry.tier}`;
          const tierLabel = TIER_LABEL[entry.tier];
          return (
            <form
              key={`${entry.tier}-${entry.value}`}
              aria-label={`${label} ${tierLabel.toLowerCase()} model`}
              className="space-y-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                onModel(entry.tier, String(new FormData(event.currentTarget).get('model')));
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={inputId} className="text-xs text-text-muted">
                  {tierLabel}
                </label>
                <SourcePill isOverride={entry.isOverride} />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={inputId}
                  name="model"
                  defaultValue={entry.value}
                  required
                  maxLength={200}
                  pattern="\S+"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-11 font-mono text-xs md:text-xs"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="touch"
                  disabled={busy}
                  aria-label={`Save ${label} ${tierLabel.toLowerCase()} model`}
                >
                  Save
                </Button>
              </div>
              {entry.isOverride ? (
                <p className="text-xs text-text-muted">
                  Default <span className="font-mono">{entry.defaultValue}</span>
                  {' · '}
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto px-0"
                    disabled={busy}
                    onClick={() => onResetModel(entry.tier)}
                    aria-label={`Use the default ${label} ${tierLabel.toLowerCase()} model`}
                  >
                    Use default
                  </Button>
                </p>
              ) : null}
            </form>
          );
        })}
      </fieldset>
    </div>
  );
}
