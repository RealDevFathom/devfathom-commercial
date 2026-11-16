import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JurisdictionRuleSet } from '@/generated/prisma/client';
import { testOnlyRules } from '@/lib/test-support/jurisdiction-rules';
import { JurisdictionRuleSets } from './jurisdiction-rule-sets';
import { RULE_FIELDS, RULE_FIELD_LABELS } from '@/lib/platform/jurisdiction-rules';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const ruleSet: JurisdictionRuleSet = {
  id: 'test_only_v1',
  code: 'TEST_ONLY',
  version: 1,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  createdAt: new Date('2026-01-01'),
  isPlaceholder: false,
  ...testOnlyRules,
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function draft() {
  render(<JurisdictionRuleSets ruleSets={[ruleSet]} />);
  fireEvent.click(screen.getByText('Draft version 2'));
  fireEvent.change(screen.getByLabelText('Effective from'), {
    target: { value: '2099-01-01T12:00' },
  });
  fireEvent.change(screen.getByLabelText('Reviewer name'), {
    target: { value: 'TEST_ONLY reviewer' },
  });
  fireEvent.change(screen.getByLabelText('Reviewer role'), { target: { value: 'TEST_ONLY role' } });
  fireEvent.change(screen.getByLabelText('Publication reason'), {
    target: { value: 'TEST_ONLY approved review' },
  });
  fireEvent.change(screen.getByLabelText('Fresh MFA code'), { target: { value: '123456' } });
}

describe('jurisdiction editor', () => {
  it('shows all published values, dates and seven confirmation states', () => {
    render(<JurisdictionRuleSets ruleSets={[ruleSet]} />);
    expect(screen.getByRole('heading', { name: 'TEST_ONLY · version 1' })).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed')).toHaveLength(7);
    fireEvent.click(screen.getByText('View all published fields and values'));
    expect(screen.getByText(/"TEST_ONLY_LICENCE"/, { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByText('1 Jan 2026, 00:00 UTC')).toHaveAttribute(
      'datetime',
      '2026-01-01T00:00:00.000Z'
    );
  });
  it('starts a separate draft with every field provisional, preserving published values', () => {
    draft();
    for (const field of RULE_FIELDS) {
      expect(
        JSON.parse((screen.getByLabelText(RULE_FIELD_LABELS[field]) as HTMLTextAreaElement).value)
      ).toEqual({ ...testOnlyRules[field], provisional: true });
    }
    expect(ruleSet.licenceCategories).toEqual(testOnlyRules.licenceCategories);
  });
  it('does not offer edits on closed or placeholder versions', () => {
    render(
      <JurisdictionRuleSets
        ruleSets={[
          { ...ruleSet, effectiveTo: new Date('2026-06-01') },
          { ...ruleSet, id: 'placeholder', isPlaceholder: true },
        ]}
      />
    );
    expect(screen.queryByText('Draft version 2')).not.toBeInTheDocument();
  });
  it('explains the empty registry', () => {
    render(<JurisdictionRuleSets ruleSets={[]} />);
    expect(screen.getByText('No rule sets published')).toBeInTheDocument();
  });
  it('focuses nested JSON validation errors and preserves the draft', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        fieldErrors: { 'permittedSchedules.values.0': 'Unsupported schedule.' },
      }),
    });
    draft();
    const field = screen.getByLabelText('Permitted schedules');
    fireEvent.change(field, { target: { value: '{"values":["INVALID"],"provisional":false}' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue('{"values":["INVALID"],"provisional":false}');
    expect(screen.getByText('Unsupported schedule.')).toBeInTheDocument();
  });
  it('requires explicit confirmation and sends reviewer, MFA and all seven fields', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'test_only_v2' } }) });
    draft();
    const submit = screen.getByRole('button', { name: 'Confirm and publish new version' });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.submit(submit.closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.action).toBe('jurisdiction.rules.publish');
    expect(body.payload).toMatchObject({
      previousId: ruleSet.id,
      reviewerName: 'TEST_ONLY reviewer',
      reviewerRole: 'TEST_ONLY role',
      authenticationCode: '123456',
      reason: 'TEST_ONLY approved review',
    });
    for (const field of RULE_FIELDS) expect(body.payload[field].provisional).toBe(true);
  });
});
