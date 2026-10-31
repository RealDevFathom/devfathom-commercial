import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

function context({
  event = 'pull_request',
  action = 'synchronize',
  label = '',
  ready = true,
  pr = 176,
  sha = 'head-a',
  run = 1,
  ref = `refs/pull/${pr}/merge`,
  inputSha = '',
} = {}) {
  return {
    github: {
      event_name: event,
      event: {
        action,
        label: { name: label },
        pull_request: {
          number: event === 'pull_request' ? pr : undefined,
          head: { sha: event === 'pull_request' ? sha : undefined },
          labels: event === 'pull_request' && ready ? [{ name: 'ci-ready' }] : [],
        },
      },
      sha,
      ref,
      run_id: run,
    },
    inputs: { sha: inputSha },
  };
}

type Context = ReturnType<typeof context>;

// These workflow expressions use operators shared with JavaScript. Translate
// GitHub's wildcard projection and supply its two functions to exercise the
// expressions read from the workflows, rather than copying their conditions.
function evaluate(expression: string, values: Context) {
  return runInNewContext(
    expression.replaceAll('labels.*.name', 'labels.map(label => label.name)'),
    {
      ...values,
      contains: (items: string[], value: string) => items.includes(value),
      format: (template: string, value: number) => template.replace('{0}', String(value)),
    }
  );
}

function workflow(file: string) {
  const source = readFileSync(`.github/workflows/${file}.yml`, 'utf8');
  const condition = source.match(/^    if: (.+)$/m)?.[1];
  const group = source.match(/^  group: (.+)$/m)?.[1];
  if (!condition || !group) throw new Error(`Missing gate or concurrency group in ${file}`);

  return {
    enabled: (values: Context) => evaluate(condition, values),
    group: (values: Context) =>
      group.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
        String(evaluate(expression, values))
      ),
  };
}

describe.each(['qa', 'image-build'])('%s PR workflow', (file) => {
  const gate = workflow(file);

  it.each(['opened', 'synchronize', 'reopened'])('gates %s on ci-ready', (action) => {
    expect(gate.enabled(context({ action, ready: false }))).toBe(false);
    expect(gate.enabled(context({ action }))).toBe(true);
  });

  it('runs when ci-ready is added and skips unrelated label events', () => {
    expect(gate.enabled(context({ action: 'labeled', label: 'ci-ready' }))).toBe(true);
    expect(gate.enabled(context({ action: 'labeled', label: 'documentation' }))).toBe(false);
    expect(gate.enabled(context({ action: 'labeled', label: 'documentation', ready: false }))).toBe(
      false
    );
  });

  it('cancels superseded commits within the same PR', () => {
    expect(gate.group(context({ sha: 'head-a' }))).toBe(gate.group(context({ sha: 'head-b' })));
    expect(gate.group(context({ pr: 176 }))).not.toBe(gate.group(context({ pr: 177 })));
  });

  it('keeps ci-ready label runs in the regular PR cancellation group', () => {
    expect(gate.group(context({ action: 'labeled', label: 'ci-ready' }))).toBe(
      gate.group(context())
    );
  });

  it('isolates each ignored label event from running and queued PR checks', () => {
    const ignored = { action: 'labeled', label: 'documentation' };
    expect(gate.group(context(ignored))).not.toBe(gate.group(context()));
    expect(gate.group(context({ ...ignored, run: 1 }))).not.toBe(
      gate.group(context({ ...ignored, run: 2 }))
    );
  });
});

describe('QA non-PR triggers', () => {
  const gate = workflow('qa');

  it.each(['push', 'workflow_dispatch'])('preserves %s execution without a label', (event) => {
    expect(gate.enabled(context({ event, ready: false }))).toBe(true);
  });

  it('groups dispatches by their requested SHA and branch', () => {
    const dispatch = {
      event: 'workflow_dispatch',
      ref: 'refs/heads/develop',
      inputSha: 'requested',
    };
    expect(gate.group(context(dispatch))).toBe('qa-refs/heads/develop-requested');
    expect(gate.group(context({ ...dispatch, sha: 'another-dispatch-commit' }))).toBe(
      gate.group(context(dispatch))
    );
    expect(gate.group(context({ ...dispatch, inputSha: '' }))).toBe('qa-refs/heads/develop-head-a');
  });
});
