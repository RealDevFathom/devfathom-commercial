import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, getDefaultModelId } from './model-defaults';
import { getTierForFeature } from './tiers';

describe('AI tiers', () => {
  it.each(['growth', 'whatsapp', 'retention', 'analytics'])('%s uses standard', (feature) => {
    expect(getTierForFeature(feature)).toBe('standard');
  });

  it('reserves deep for periodic owner reports and defaults unknown features to cheap', () => {
    expect(getTierForFeature('periodic-owner-reports')).toBe('deep');
    expect(getTierForFeature('new-unclassified-feature')).toBe('cheap');
  });

  it('defines current defaults for every routed provider and permits per-tier overrides', () => {
    expect(DEFAULT_MODELS).toEqual({
      anthropic: {
        cheap: 'claude-haiku-5-5',
        standard: 'claude-sonnet-5-5',
        deep: 'claude-opus-5-5',
      },
      openai: { cheap: 'gpt-5.4-nano', standard: 'gpt-5.4-mini', deep: 'gpt-5.4' },
      bedrock: {
        cheap: 'us.anthropic.claude-haiku-5-5',
        standard: 'us.anthropic.claude-sonnet-5-5',
        deep: 'us.anthropic.claude-opus-5-5',
      },
    });
    expect(
      getDefaultModelId('openai', 'deep', undefined, { AI_OPENAI_MODEL_DEEP: 'env-model' })
    ).toBe('env-model');
    expect(getDefaultModelId('anthropic', 'standard', { standard: 'database-model' })).toBe(
      'database-model'
    );
  });
});
