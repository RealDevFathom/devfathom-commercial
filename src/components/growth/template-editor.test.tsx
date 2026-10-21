import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { GrowthTemplate } from '@/lib/growth/view';

import { TemplateEditor } from './template-editor';

const templates: GrowthTemplate[] = [
  {
    id: 'tpl_generic',
    key: 'generic',
    language: 'ur-en',
    body: 'Salaam {{name}}! Reply STOP to opt out.',
  },
];

describe('TemplateEditor', () => {
  it('shows an inline error and does not save an unknown variable', () => {
    const save = vi.fn();
    render(<TemplateEditor templates={templates} save={save} />);
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Salaam {{nope}}. Reply STOP to opt out.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(screen.getByRole('alert').textContent).toMatch(/\{\{nope\}\}/);
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a body that only uses known variables and STOP', async () => {
    const save = vi.fn<(form: FormData) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    render(<TemplateEditor templates={templates} save={save} />);
    const next = 'Salaam {{name}}, {{discount}} at {{business}}. Reply STOP to opt out.';
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: next } });
    expect(screen.getByText(/Ayesha/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await screen.findByText('Template saved.');
    expect(save).toHaveBeenCalledTimes(1);
    expect(String(save.mock.calls[0]?.[0].get('body'))).toBe(next);
  });
});
