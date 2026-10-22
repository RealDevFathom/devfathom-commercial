import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ config: vi.fn(), model: vi.fn(), generate: vi.fn() }));
vi.mock('./provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provider')>()),
  readAIConfig: mocks.config,
  createAIModel: mocks.model,
}));
vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof import('ai')>('ai')),
  generateText: mocks.generate,
  Output: { object: vi.fn((value) => value) },
}));

import { generateGrowthRecommendations, type GrowthInput } from './growth-recommendations';

type Fixture = {
  name: string;
  input: GrowthInput;
  providerOutput: unknown | null;
  expected: {
    status: 'READY' | 'INVALID' | 'INSUFFICIENT_DATA';
    failureCode: 'OUTPUT' | 'SPARSE' | null;
    recommendationCount: number;
  };
};

const fixtureDirectory = join(process.cwd(), 'tests/fixtures/ai/winback');
const fixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')) as Fixture);

describe('pharmacy winback evaluation fixtures', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'google');
    vi.resetAllMocks();
    mocks.config.mockReturnValue({ provider: 'google', model: 'fixture-model' });
    mocks.model.mockReturnValue({ provider: 'google', modelId: 'fixture-model', model: {} });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('keeps a checked representative corpus rather than an empty eval directory', () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      'pharmacy retention review from complete aggregate evidence',
      'small pharmacy cohort remains suppressed',
      'provider cannot invent customer evidence',
    ]);
  });

  it.each(fixtures)('$name', async (fixture) => {
    if (fixture.providerOutput)
      mocks.generate.mockResolvedValue({ finishReason: 'stop', output: fixture.providerOutput });

    const result = await generateGrowthRecommendations(fixture.input);

    expect(result).toMatchObject({
      status: fixture.expected.status,
      failureCode: fixture.expected.failureCode,
    });
    expect(result.output?.recommendations.length ?? 0).toBe(fixture.expected.recommendationCount);
    expect(result.input.vertical).toBe('PHARMACY');
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.generate).toHaveBeenCalledTimes(
      fixture.expected.status === 'INSUFFICIENT_DATA' ? 0 : 1
    );
  });

  it.each([undefined, '', 'disabled'])('is off by default with provider %s', async (provider) => {
    vi.stubEnv('AI_PROVIDER', provider);
    const result = await generateGrowthRecommendations(fixtures[0]!.input);
    expect(result).toMatchObject({
      status: 'UNAVAILABLE',
      failureCode: 'CONFIGURATION',
      provider: null,
      model: null,
      output: null,
    });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
