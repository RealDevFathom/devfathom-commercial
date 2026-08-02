import { describe, expect, it } from 'vitest';
import { readAIConfig } from './provider';

describe('readAIConfig', () => {
  it('validates provider-specific configuration in one place', () => {
    expect(
      readAIConfig({
        AI_PROVIDER: 'azure',
        AI_MODEL: 'ask-fathom-gpt-5-mini',
        AZURE_OPENAI_RESOURCE_NAME: 'devfathom-ai',
      })
    ).toEqual({
      provider: 'azure',
      model: 'ask-fathom-gpt-5-mini',
      resourceName: 'devfathom-ai',
    });
    expect(() => readAIConfig({ AI_PROVIDER: 'groq', AI_MODEL: 'model' })).toThrow(
      '[ai:groq] GROQ_API_KEY is required.'
    );
    expect(() => readAIConfig({ AI_PROVIDER: 'unknown', AI_MODEL: 'model' })).toThrow(
      'Unsupported AI_PROVIDER'
    );
  });
});
