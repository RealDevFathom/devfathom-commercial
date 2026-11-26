# Counter QA for DEV-1041, DEV-1040 and DEV-1042

Chromium used the live counter with a disposable pharmacy, a synthetic cashier session and local PostgreSQL 16. The baseline was develop at `b05d29fcd510dd9780ac07fd67890ece47f8c93f`. The counter uses its existing Studio Button, Input, Label, Switch, SelectField and payment dialog, with the existing surface, border, text and focus tokens.

Each contact sheet contains five rows (375 × 812, 768 × 900, 1024 × 900, 1366 × 768 and 1440 × 900). The columns show light with normal motion, light with reduced motion, dark with normal motion and dark with reduced motion. Captures used Tab and Shift+Tab to establish visible keyboard focus. Every captured main state passed a document-width check.

| Cashier state                                   | Before                         | After                         |
| ----------------------------------------------- | ------------------------------ | ----------------------------- |
| Open drawer, empty bill, search focused         | [Empty](before-empty.webp)     | [Empty](after-empty.webp)     |
| Two lines from scan and search                  | [Bill](before-bill.webp)       | [Bill](after-bill.webp)       |
| Payment sheet, cash received focused            | [Payment](before-payment.webp) | [Payment](after-payment.webp) |
| Enter on an unmatched name with focus in search | [Search](before-search.webp)   | [Search](after-search.webp)   |

At 1366 × 768 and 375 × 812 the search field, cart, bill total and mobile payment control kept their bounding rectangles when the prompt appeared. Typing a partial term and abandoning the prompt sent zero demand writes. Escape returned focus to search after the payment sheet. The patched cashier flow showed Rs 2.50 for one scanned tablet and Rs 3.00 for a searched loose unit, totaling Rs 5.50.

| State at 1366 × 768                                           | Evidence                                                |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| Khata sign-up ready on a verified balance                     | [Customer name, phone and consent](khata-verified.webp) |
| One outstanding balance read, locked fields                   | [Checking](checking.webp)                               |
| Read failed, retry available and fields locked                | [Read failure](read-failed.webp)                        |
| Retry returns a different amount                              | [Announced Rs 5.00](changed.webp)                       |
| Void confirmation reached by Shift+F4 and dismissed by Escape | [Confirmation](void-confirmation.webp)                  |

The recovery exercise held a read in the browser transport, returned a synthetic read error, then supplied a changed cart on manual retry. Chromium observed one automatic and one manual read, zero tender requests and an empty console-error list. The before/after counter matrix used live responses from the disposable database. Permission gates remain covered separately by the restricted-runtime database and component tests.
