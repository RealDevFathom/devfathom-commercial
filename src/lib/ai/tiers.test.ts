import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BEDROCK_REGION,
  DEFAULT_MODEL_PRICES_USD_PER_MTOK,
  DEFAULT_MODELS,
  bedrockRegion,
  getDefaultModelId,
  haikuLookupsEnabled,
  listPriceFor,
} from './model-defaults';
import { getTierForFeature } from './tiers';

describe('AI tiers', () => {
  it.each(['growth', 'whatsapp', 'retention', 'analytics'])('%s uses standard', (feature) => {
    expect(getTierForFeature(feature)).toBe('standard');
  });

  it('reserves deep for owner reports and the weekly summary, and defaults unknown features to cheap', () => {
    expect(getTierForFeature('periodic-owner-reports')).toBe('deep');
    expect(getTierForFeature('weekly-owner-summary')).toBe('deep');
    expect(getTierForFeature('new-unclassified-feature')).toBe('cheap');
  });

  it('defines the decided defaults for every routed provider and permits per-tier overrides', () => {
    expect(DEFAULT_MODELS).toEqual({
      anthropic: {
        cheap: 'claude-haiku-5-5',
        standard: 'claude-sonnet-5-5',
        deep: 'claude-opus-5-5',
      },
      openai: { cheap: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.1-sol' },
      bedrock: {
        cheap: 'global.anthropic.claude-haiku-5-5',
        standard: 'global.anthropic.claude-sonnet-5-5',
        deep: 'global.anthropic.claude-sonnet-5-5',
      },
    });
    expect(
      getDefaultModelId('openai', 'deep', undefined, { AI_OPENAI_MODEL_DEEP: 'env-model' })
    ).toBe('env-model');
    expect(getDefaultModelId('anthropic', 'standard', { standard: 'database-model' })).toBe(
      'database-model'
    );
  });

  it('never defaults Bedrock to a 4.x or US-only profile, and calls it from ap-southeast-1', () => {
    for (const model of Object.values(DEFAULT_MODELS.bedrock)) {
      expect(model).toMatch(/^global\.anthropic\.claude-[a-z]+-5-5$/);
    }
    expect(DEFAULT_BEDROCK_REGION).toBe('ap-southeast-1');
    expect(bedrockRegion({})).toBe('ap-southeast-1');
    expect(bedrockRegion({ BEDROCK_REGION: 'eu-west-1' })).toBe('eu-west-1');
  });

  it('prices the decided models per million tokens, with no Bedrock premium', () => {
    expect(listPriceFor('anthropic', 'claude-sonnet-5-5')).toEqual({ input: 2, output: 10 });
    expect(listPriceFor('anthropic', 'claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(listPriceFor('anthropic', 'claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5 });
    expect(listPriceFor('openai', 'gpt-6.1-sol')).toEqual({ input: 2, output: 10 });
    expect(listPriceFor('openai', 'gpt-6-luna')).toEqual({ input: 0.1, output: 0.5 });
    expect(listPriceFor('bedrock', 'global.anthropic.claude-sonnet-5-5')).toEqual({
      input: 2,
      output: 10,
    });
    expect(listPriceFor('bedrock', 'global.anthropic.claude-haiku-5-5')).toEqual({
      input: 0.1,
      output: 0.5,
    });
    const keys = Object.keys(DEFAULT_MODEL_PRICES_USD_PER_MTOK);
    expect(keys.filter((key) => /gpt-5\.4|us\.anthropic|-4-\d/.test(key))).toEqual([]);
  });

  it.each([
    [undefined, false],
    ['false', false],
    ['1', false],
    ['yes', false],
    ['true', true],
    [' TRUE ', true],
  ])('AF_HAIKU_LOOKUPS=%j enables the small model: %s', (value, expected) => {
    expect(haikuLookupsEnabled({ AF_HAIKU_LOOKUPS: value })).toBe(expected);
  });
});
