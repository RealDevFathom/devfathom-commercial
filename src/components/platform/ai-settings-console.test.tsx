import type { inferRouterOutputs } from '@trpc/server';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRouter } from '@/server/routers/_app';

import { AiSettingsConsole } from './ai-settings-console';

type SettingsView = inferRouterOutputs<AppRouter>['aiSettings']['get'];
type Callbacks = {
  onSuccess?: (result?: unknown, input?: unknown) => unknown;
  onError?: (error: { message: string }) => void;
};

const MUTATIONS = [
  'setMode',
  'setProviderOrder',
  'setFallbackEnabled',
  'setMonthlyCap',
  'setTierModel',
  'reset',
  'upsertModelPrice',
] as const;

const h = vi.hoisted(() => ({
  view: null as unknown,
  loading: false,
  error: null as null | { message: string },
  invalidate: vi.fn(),
  mutate: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, Callbacks>,
}));

vi.mock('@/lib/trpc', () => {
  const mutation = (name: string) => ({
    useMutation: (options: Callbacks) => {
      h.options[name] = options;
      h.mutate[name] ??= vi.fn();
      return { mutate: h.mutate[name], isPending: false };
    },
  });
  return {
    trpc: {
      useUtils: () => ({
        aiSettings: {
          get: { invalidate: h.invalidate },
          listModelPrices: { invalidate: h.invalidate },
        },
      }),
      aiSettings: {
        get: {
          useQuery: () => ({ data: h.view, isLoading: h.loading, error: h.error }),
        },
        listModelPrices: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
        setMode: mutation('setMode'),
        setProviderOrder: mutation('setProviderOrder'),
        setFallbackEnabled: mutation('setFallbackEnabled'),
        setMonthlyCap: mutation('setMonthlyCap'),
        setTierModel: mutation('setTierModel'),
        reset: mutation('reset'),
        upsertModelPrice: mutation('upsertModelPrice'),
      },
    },
  };
});

const models = (provider: 'anthropic' | 'openai' | 'bedrock') => {
  const defaults = {
    anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    openai: ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'],
    bedrock: [
      'us.anthropic.claude-haiku-5-5',
      'us.anthropic.claude-sonnet-5-5',
      'us.anthropic.claude-opus-5-5',
    ],
  }[provider];
  return (['cheap', 'standard', 'deep'] as const).map((tier, index) => ({
    tier,
    value: defaults[index]!,
    isOverride: false,
    defaultValue: defaults[index]!,
    defaultSource: 'built-in' as const,
  }));
};

function view(): SettingsView {
  const openaiModels = models('openai');
  openaiModels[1] = {
    tier: 'standard',
    value: 'gpt-custom-standard',
    isOverride: true,
    defaultValue: 'gpt-5.4-mini',
    defaultSource: 'built-in',
  };
  return {
    mode: { value: 'Auto', isOverride: false },
    providerOrder: {
      value: ['anthropic', 'openai', 'bedrock'],
      isOverride: false,
      defaultValue: ['anthropic', 'openai', 'bedrock'],
      defaultSource: 'built-in',
    },
    fallbackEnabled: { value: true, isOverride: false },
    chain: ['anthropic', 'openai', 'bedrock'],
    routing: 'active',
    environmentPreferred: null,
    providers: [
      {
        provider: 'anthropic',
        configured: true,
        spentUsd: 190,
        capUsd: 190,
        capIsOverride: false,
        defaultCapUsd: 190,
        defaultCapSource: 'built-in',
        capStatus: 'at',
        models: models('anthropic'),
      },
      {
        provider: 'openai',
        configured: false,
        spentUsd: 12.5,
        capUsd: 75,
        capIsOverride: true,
        defaultCapUsd: 190,
        defaultCapSource: 'built-in',
        capStatus: 'under',
        models: openaiModels,
      },
      {
        provider: 'bedrock',
        configured: true,
        spentUsd: 250,
        capUsd: 300,
        capIsOverride: false,
        defaultCapUsd: 300,
        defaultCapSource: 'environment',
        capStatus: 'near',
        models: models('bedrock'),
      },
    ],
    month: {
      label: '2026-11',
      from: new Date('2026-10-31T19:00:00Z'),
      to: new Date('2026-11-30T19:00:00Z'),
    },
    updatedAt: null,
    updatedBy: null,
    appliesWithinSeconds: 30,
  };
}

const panel = (name: string) => screen.getByRole('group', { name });

beforeEach(() => {
  vi.clearAllMocks();
  h.view = view();
  h.loading = false;
  h.error = null;
  for (const name of MUTATIONS) h.mutate[name] = vi.fn();
});
afterEach(cleanup);

describe('AiSettingsConsole', () => {
  it('shows the effective settings, defaults and overrides', () => {
    render(<AiSettingsConsole />);

    expect(screen.getByText(/apply within 30 seconds/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Auto/ })).toBeChecked();
    expect(screen.getByTestId('ai-chain')).toHaveTextContent('Anthropic → OpenAI → Bedrock');
    expect(screen.getByRole('switch', { name: 'Fall back to the next provider' })).toBeChecked();

    const anthropic = panel('Anthropic');
    expect(within(anthropic).getByText('Configured')).toBeInTheDocument();
    expect(within(anthropic).getByText('At cap · skipped')).toBeInTheDocument();
    expect(within(anthropic).getByLabelText('Monthly cap (USD)')).toHaveValue(190);
    expect(within(anthropic).getByLabelText('Cheap')).toHaveValue('claude-haiku-5-5');
    expect(within(anthropic).getByRole('progressbar', { name: /Anthropic spend/ })).toHaveAttribute(
      'aria-valuenow',
      '100'
    );

    const openai = panel('OpenAI');
    expect(within(openai).getByText('Not configured')).toBeInTheDocument();
    expect(within(openai).getByText(/OPENAI_API_KEY_SECRET_ID/)).toBeInTheDocument();
    expect(within(openai).getByText('Under cap')).toBeInTheDocument();
    expect(within(openai).getByText('$12.50')).toBeInTheDocument();
    expect(within(openai).getByLabelText('Standard')).toHaveValue('gpt-custom-standard');
    expect(within(openai).getByText('gpt-5.4-mini')).toBeInTheDocument();
    // The cap and the standard model are overrides; the rest are defaults.
    expect(within(openai).getAllByText('Override')).toHaveLength(2);

    expect(within(panel('Bedrock')).getByText('Near cap')).toBeInTheDocument();
    expect(within(panel('Bedrock')).getByText(/\(environment\)/)).toBeInTheDocument();
  });

  it('saves the active provider switch', () => {
    render(<AiSettingsConsole />);
    fireEvent.click(screen.getByRole('radio', { name: /^OpenAI/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save active provider' }));
    expect(h.mutate.setMode).toHaveBeenCalledWith({ mode: 'ForceOpenAI' });

    fireEvent.click(screen.getByRole('radio', { name: /^Disabled/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save active provider' }));
    expect(h.mutate.setMode).toHaveBeenLastCalledWith({ mode: 'Disabled' });
  });

  it('reorders and narrows the fallback order before saving it', () => {
    render(<AiSettingsConsole />);
    expect(screen.getByRole('button', { name: 'Move Anthropic up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move OpenAI up' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Bedrock in the order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    expect(h.mutate.setProviderOrder).toHaveBeenCalledWith({
      providerOrder: ['openai', 'anthropic'],
    });
  });

  it('will not save an empty order', () => {
    render(<AiSettingsConsole />);
    for (const name of ['Anthropic', 'OpenAI', 'Bedrock']) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Include ${name} in the order` }));
    }
    expect(screen.getByRole('alert')).toHaveTextContent('Keep at least one provider');
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled();
    expect(h.mutate.setProviderOrder).not.toHaveBeenCalled();
  });

  it('toggles fallback', () => {
    render(<AiSettingsConsole />);
    fireEvent.click(screen.getByRole('switch', { name: 'Fall back to the next provider' }));
    expect(h.mutate.setFallbackEnabled).toHaveBeenCalledWith({ fallbackEnabled: false });
  });

  it('saves a cap and a tier model with the provider and tier', () => {
    render(<AiSettingsConsole />);
    const openai = panel('OpenAI');
    fireEvent.change(within(openai).getByLabelText('Monthly cap (USD)'), {
      target: { value: '250.5' },
    });
    fireEvent.click(within(openai).getByRole('button', { name: 'Save OpenAI monthly cap' }));
    expect(h.mutate.setMonthlyCap).toHaveBeenCalledWith({ provider: 'openai', capUsd: '250.5' });

    const bedrock = panel('Bedrock');
    fireEvent.change(within(bedrock).getByLabelText('Deep'), {
      target: { value: 'us.anthropic.next-deep' },
    });
    fireEvent.click(within(bedrock).getByRole('button', { name: 'Save Bedrock deep model' }));
    expect(h.mutate.setTierModel).toHaveBeenCalledWith({
      provider: 'bedrock',
      tier: 'deep',
      model: 'us.anthropic.next-deep',
    });
  });

  it('returns a single override to its default', () => {
    render(<AiSettingsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the default OpenAI cap' }));
    expect(h.mutate.reset).toHaveBeenCalledWith({ scope: 'cap', provider: 'openai' });
    fireEvent.click(screen.getByRole('button', { name: 'Use the default OpenAI standard model' }));
    expect(h.mutate.reset).toHaveBeenLastCalledWith({
      scope: 'model',
      provider: 'openai',
      tier: 'standard',
    });
    // Defaults offer no reset.
    expect(
      screen.queryByRole('button', { name: 'Use the default Anthropic cap' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use default order' })).not.toBeInTheDocument();
  });

  it('confirms before resetting everything to defaults', () => {
    render(<AiSettingsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    let dialog = screen.getByRole('dialog', { name: 'Reset AI routing to defaults?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(h.mutate.reset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    dialog = screen.getByRole('dialog', { name: 'Reset AI routing to defaults?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to defaults' }));
    expect(h.mutate.reset).toHaveBeenCalledWith({ scope: 'all' });
  });

  it('announces a save and refreshes, or shows the server error', async () => {
    render(<AiSettingsConsole />);
    await act(async () => {
      await h.options.setMode!.onSuccess?.();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved. Changes apply within 30 seconds.');
    expect(h.invalidate).toHaveBeenCalled();

    act(() =>
      h.options.setMonthlyCap!.onError?.({ message: 'USD amount is outside the allowed range.' })
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'USD amount is outside the allowed range.'
    );
  });

  it('explains when AI_PROVIDER bypasses routing', () => {
    h.view = { ...view(), routing: 'bypassed' };
    render(<AiSettingsConsole />);
    expect(screen.getByRole('note')).toHaveTextContent(/outside routing/);
    expect(document.body.textContent).not.toMatch(/azure/i);
  });

  it('renders loading and error states', () => {
    h.loading = true;
    const { unmount } = render(<AiSettingsConsole />);
    expect(screen.getByText('Loading AI settings…')).toBeInTheDocument();
    unmount();

    h.loading = false;
    h.view = undefined;
    h.error = { message: 'You do not have permission for this action.' };
    render(<AiSettingsConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission');
  });
});
