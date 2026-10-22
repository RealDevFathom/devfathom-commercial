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

  it('defines Claude defaults for both adapters and permits per-tier overrides', () => {
    expect(DEFAULT_MODELS).toEqual({
      anthropic: {
        cheap: 'claude-haiku-4-5-20251001',
        standard: 'claude-sonnet-4-6',
        deep: 'claude-opus-4-6',
      },
      bedrock: {
        cheap: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        standard: 'anthropic.claude-sonnet-4-6',
        deep: 'apac.anthropic.claude-opus-4-6-v1',
      },
    });
    expect(getDefaultModelId('anthropic', 'standard', { standard: 'database-model' })).toBe(
      'database-model'
    );
  });
});
