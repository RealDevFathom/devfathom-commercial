import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Field, fieldClass } from './field';

describe('Field', () => {
  it('packs its rows to the top so a taller neighbour cannot stretch the control', () => {
    render(
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Evidence type">
          <select name="sourceKind" className={fieldClass}>
            <option value="PAPER_IMAGE">Paper prescription</option>
          </select>
        </Field>
        <Field label="Prescription image" hint="Single-frame JPEG, PNG or WebP.">
          <input name="source" type="file" className={fieldClass} />
        </Field>
      </div>
    );
    const select = screen.getByLabelText('Evidence type');
    const label = select.closest('label')!;
    expect(label.className.split(/\s+/)).toEqual(expect.arrayContaining(['grid', 'content-start']));
    // Height comes from the shared control recipe only, the same as its neighbours.
    expect(select.className).toBe(fieldClass);
    expect(screen.getByLabelText('Prescription image').className).toBe(fieldClass);
  });
});
