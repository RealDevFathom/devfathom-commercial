# Counter v2, phase 3: visual QA evidence

These screenshots come from the running app, not from a mocked harness. The setup was `next dev`,
PostgreSQL 16 with all migrations, and a restricted runtime role (`rolsuper` and `rolbypassrls`
both false). The app ran on the pharmacy counter E2E seed, in the pinned Chromium.

The counter browser lane took them itself: `tests/e2e/pharmacy-counter.spec.ts`, helper `qaShots`
with `dir: QA3_DIR`. Every action came from the keyboard. The lane writes each shot to
`playwright-artifacts/pharmacy-counter-qa-phase-3/`. Each image here lays those shots out in a
grid: widths 1440, 1366, 1024, 768 and 375 down the side, light and dark across. They are reduced
in size and colour depth so the folder stays small.

In every shot:

- reduced motion is on;
- the control named below has keyboard focus, reached with Shift+Tab then Tab;
- the lane asserts the control matches `:focus-visible`, so the ring shown is the one a keyboard
  user sees;
- the lane checks that the document does not scroll sideways.

The floating "N" in the lower corner is the Next.js development indicator. It is not part of the
product.

| Image | Design state | What it shows | Focus on |
| --- | --- | --- | --- |
| `after-payment-paid-so-far.png` | A2 | Take payment after 4.00 in cash. The summary shows "Paid so far 4.00" above the recorded payment, then the balance due. The JazzCash part is being entered. | Transaction ID |
| `after-discount-whole-bill.png` | A4 | The discount sheet, signed in as a cashier. "Apply to": Next item or Whole bill. The supervisor block names who can approve. 10% is being given to the whole bill. | Discount (%) |
| `after-controlled-sheet-ready.png` | A5 | The "Authorise Fathomadol E2E" sheet with the patient, an emergency supply and the approving pharmacist filled in. The footer says it is ready. | Authorise line |
| `after-controlled-pack-waiting.png` | A5 | A serialised (GS1) pack of the controlled medicine, scanned. It waits in the sheet as scanned; nothing is on the bill. The notice behind says to complete the panel and press Authorise line. | Find the patient |
| `after-no-permission-got-it.png` | C6 | A cashier in Returns, with the no-permission card and the full-width "Got it" below it. | Got it |
| `after-status-strip-375.png` | — | At 375 the "Counter status" strip scrolls, so it is a tab stop with the Studio focus ring. Where the pills fit (the lane checks every width), it is not. | Counter status |

The phase 2B images in `../qa-phase-2b/` are the "before" for these panels.

## Keyboard only

The lane drives every new surface without a pointer:

- "Find the patient" opens the checks sheet, and "Authorise Fathomadol E2E" there returns to the
  authorisation.
- Escape on a waiting pack lets it go, with a notice to scan again.
- "Got it" closes the returns sheet.
- The whole-bill discount goes through its approval dialog.

## Not shown

- The "A pharmacist must authorise this line" state, for a member who cannot dispense. The seed's
  cashier has no dispensing access, but the lane does not reach the counter's controlled flow as
  that cashier. The unit tests in `counter-console.test.tsx` cover it.
- Adding the waiting serialised pack. The E2E seed has no registered serialised pack, so the lane
  stops at the waiting state and at letting the pack go. The unit tests cover the add: it sends
  the pack's own payload with the authorisation, and nothing else.
