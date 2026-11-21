import { createRoot, hydrateRoot } from 'react-dom/client';
import { useState } from 'react';
import { SelectField } from '@/components/ui/select-field';

export function FormFixture() {
  const [value, setValue] = useState('b');
  const [disabled, setDisabled] = useState(false);
  return (
    <main>
      <form
        id="parity-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const output = document.querySelector('output')!;
          output.textContent = JSON.stringify(Array.from(data));
          output.dataset.submissions = String(Number(output.dataset.submissions ?? '0') + 1);
        }}
      >
        <label htmlFor="first">First required choice</label>
        <SelectField id="first" name="first" required defaultValue="">
          <option value="">Choose a method</option>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="offline" disabled>
            Unavailable
          </option>
          <optgroup label="Unavailable methods" disabled>
            <option value="wire">Unavailable wire transfer</option>
          </optgroup>
        </SelectField>
        <label htmlFor="second">Second required choice</label>
        <SelectField id="second" name="second" required defaultValue="">
          <option value="">Choose a branch</option>
          <option value="north">North branch</option>
          <option value="south">South branch</option>
        </SelectField>
        <label>
          Controlled choice
          <SelectField
            name="controlled"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="a">Alpha</option>
            <option value="b">Beta</option>
          </SelectField>
        </label>
        <fieldset disabled={disabled}>
          <legend>
            <label>
              Legend choice
              <SelectField name="legend" defaultValue="legend-on">
                <option value="legend-on">Legend enabled</option>
                <option value="legend-other">Other legend value</option>
              </SelectField>
            </label>
          </legend>
          <label htmlFor="disabled-choice">Optional choice</label>
          <SelectField id="disabled-choice" name="optional" defaultValue="yes">
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </SelectField>
        </fieldset>
        <label>
          Optional blank choice
          <SelectField name="blank" defaultValue="">
            <option value="">No optional value</option>
            <option value="filled">A supplied value</option>
          </SelectField>
        </label>
        <label>
          Directly disabled required choice
          <SelectField name="directlyDisabled" required disabled defaultValue="">
            <option value="">Disabled empty value</option>
            <option value="blocked">Unavailable selection</option>
          </SelectField>
        </label>
        <button type="submit">Submit fixture</button>
        <button type="reset">Reset fixture</button>
      </form>
      <button onClick={() => setDisabled((current) => !current)}>Toggle disabled fieldset</button>
      <label htmlFor="external-choice">External form choice</label>
      <SelectField id="external-choice" form="parity-form" name="external" defaultValue="outside">
        <option value="outside">Outside form</option>
        <option value="other">Other</option>
      </SelectField>
      <output />
    </main>
  );
}
if (typeof document !== 'undefined') {
  if (document.documentElement.dataset.render === 'csr') {
    createRoot(document.getElementById('root')!).render(<FormFixture />);
  } else {
    hydrateRoot(document.getElementById('root')!, <FormFixture />);
  }
}
