'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';

const providers = ['anthropic', 'bedrock'] as const;
const tiers = ['cheap', 'standard', 'deep'] as const;

export function AiSettingsConsole() {
  const utils = trpc.useUtils();
  const settings = trpc.aiSettings.get.useQuery();
  const prices = trpc.aiSettings.listModelPrices.useQuery();
  const [message, setMessage] = useState('');
  const refresh = async () => {
    await Promise.all([
      utils.aiSettings.get.invalidate(),
      utils.aiSettings.listModelPrices.invalidate(),
    ]);
    setMessage('Saved.');
  };
  const failed = (error: { message: string }) => setMessage(error.message);
  const mode = trpc.aiSettings.updateMode.useMutation({ onSuccess: refresh, onError: failed });
  const budget = trpc.aiSettings.updateMonthlyBudget.useMutation({
    onSuccess: refresh,
    onError: failed,
  });
  const model = trpc.aiSettings.updateTierModel.useMutation({
    onSuccess: refresh,
    onError: failed,
  });
  const price = trpc.aiSettings.upsertModelPrice.useMutation({
    onSuccess: refresh,
    onError: failed,
  });

  if (settings.isLoading || prices.isLoading)
    return <p className="mt-7 text-sm text-text-muted">Loading AI settings…</p>;
  if (!settings.data || prices.error)
    return (
      <p className="mt-7 text-sm text-destructive">
        {settings.error?.message ?? prices.error?.message ?? 'Unable to load AI settings.'}
      </p>
    );
  const data = settings.data;

  const submit = (event: FormEvent<HTMLFormElement>, action: (values: FormData) => void) => {
    event.preventDefault();
    setMessage('');
    action(new FormData(event.currentTarget));
  };

  return (
    <div className="mt-7 space-y-7">
      <div aria-live="polite" className="min-h-5 text-sm text-text-muted">
        {message}
      </div>
      <section className="rounded-2xl border border-border-default bg-surface-card">
        <div className="border-b border-border-subtle px-5 py-4">
          <h2 className="font-display text-xl font-semibold">Routing policy</h2>
        </div>
        <div className="grid gap-6 p-5 lg:grid-cols-2">
          <form
            className="space-y-3"
            onSubmit={(event) =>
              submit(event, (form) =>
                mode.mutate({ mode: String(form.get('mode')) as typeof data.mode })
              )
            }
          >
            <label className="block text-xs font-semibold" htmlFor="ai-mode">
              Mode
            </label>
            <select
              id="ai-mode"
              name="mode"
              defaultValue={data.mode}
              className="h-11 w-full rounded-xl border border-border-default bg-surface-page px-3 text-sm"
            >
              {['Auto', 'ForceAnthropic', 'ForceBedrock', 'Disabled'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <Button size="lg" disabled={mode.isPending}>
              Save mode
            </Button>
          </form>
          <form
            className="space-y-3"
            onSubmit={(event) =>
              submit(event, (form) =>
                budget.mutate({ monthlyAnthropicBudgetUsd: String(form.get('budget')) })
              )
            }
          >
            <label className="block text-xs font-semibold" htmlFor="ai-budget">
              Monthly Anthropic budget (USD)
            </label>
            <Input
              id="ai-budget"
              name="budget"
              type="number"
              min="0.0001"
              max="1000000"
              step="0.0001"
              defaultValue={data.monthlyAnthropicBudgetUsd}
              required
            />
            <Button size="lg" disabled={budget.isPending}>
              Save budget
            </Button>
          </form>
        </div>
      </section>

      <section className="rounded-2xl border border-border-default bg-surface-card">
        <div className="border-b border-border-subtle px-5 py-4">
          <h2 className="font-display text-xl font-semibold">Tier models</h2>
        </div>
        <div className="grid gap-px bg-border-subtle md:grid-cols-2">
          {providers.map((provider) => (
            <div key={provider} className="space-y-5 bg-surface-card p-5">
              <h3 className="font-mono text-xs font-semibold uppercase tracking-wider">
                {provider}
              </h3>
              {tiers.map((tier) => {
                const key =
                  `${tier}${provider === 'anthropic' ? 'Anthropic' : 'Bedrock'}Model` as keyof typeof data;
                return (
                  <form
                    key={tier}
                    className="space-y-2"
                    onSubmit={(event) =>
                      submit(event, (form) =>
                        model.mutate({ provider, tier, model: String(form.get('model')) })
                      )
                    }
                  >
                    <label
                      className="block text-xs font-semibold capitalize"
                      htmlFor={`${provider}-${tier}`}
                    >
                      {tier}
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id={`${provider}-${tier}`}
                        name="model"
                        defaultValue={String(data[key])}
                        required
                        maxLength={200}
                      />
                      <Button variant="outline" size="lg" disabled={model.isPending}>
                        Save
                      </Button>
                    </div>
                  </form>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border-default bg-surface-card">
        <div className="border-b border-border-subtle px-5 py-4">
          <h2 className="font-display text-xl font-semibold">Model prices</h2>
          <p className="mt-1 text-sm text-text-muted">
            USD per million tokens, versioned by effective date.
          </p>
        </div>
        <form
          className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-6"
          onSubmit={(event) =>
            submit(event, (form) =>
              price.mutate({
                provider: String(form.get('provider')) as 'anthropic' | 'bedrock',
                model: String(form.get('model')),
                inputUsdPerMTok: String(form.get('input')),
                outputUsdPerMTok: String(form.get('output')),
                effectiveFrom: new Date(String(form.get('effectiveFrom'))),
              })
            )
          }
        >
          <select
            name="provider"
            aria-label="Provider"
            className="h-11 rounded-xl border border-border-default bg-surface-page px-3 text-sm"
          >
            {providers.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <Input
            name="model"
            aria-label="Model"
            placeholder="Model identifier"
            required
            maxLength={200}
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
          />
          <Input name="effectiveFrom" aria-label="Effective from" type="datetime-local" required />
          <Button size="lg" disabled={price.isPending}>
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
                <tr key={row.id}>
                  <td className="p-4 capitalize">{row.provider}</td>
                  <td>{row.model}</td>
                  <td className="text-right tabular-nums">${row.inputUsdPerMTok}</td>
                  <td className="text-right tabular-nums">${row.outputUsdPerMTok}</td>
                  <td className="px-4">{row.effectiveFrom.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
