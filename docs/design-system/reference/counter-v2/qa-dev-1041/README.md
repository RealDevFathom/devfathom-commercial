# Pharmacy counter QA

Chromium used the live counter with a disposable pharmacy, a synthetic cashier session and local PostgreSQL 16. The baseline was develop at `b05d29fcd510dd9780ac07fd67890ece47f8c93f`. The counter uses its existing Studio Button, Input, Label, Switch, SelectField and payment dialog, with the existing surface, border, text and focus tokens.

Each contact sheet contains five rows (375 × 812, 768 × 900, 1024 × 900, 1366 × 768 and 1440 × 900). The columns show light with normal motion, light with reduced motion, dark with normal motion and dark with reduced motion. Captures used Tab and Shift+Tab to establish visible keyboard focus. Every captured main state passed a document-width check.

| Cashier state                                   | Before                         | After                         |
| ----------------------------------------------- | ------------------------------ | ----------------------------- |
| Open drawer, empty bill, search focused         | [Empty](before-empty.webp)     | [Empty](after-empty.webp)     |
| Two lines from scan and search                  | [Bill](before-bill.webp)       | [Bill](after-bill.webp)       |
| Payment sheet, cash received focused            | [Payment](before-payment.webp) | [Payment](after-payment.webp) |
| Enter on an unmatched name with focus in search | [Search](before-search.webp)   | [Search](after-search.webp)   |

At 1366 × 768 and 375 × 812 the search field, cart, bill total and mobile payment control kept their bounding rectangles when the prompt appeared. Typing alone sent zero demand writes. After Enter, each viewport sent one marked automatic UNKNOWN capture. Escape and a repeat of the same term sent no additional writes. In the after screenshots the scanned box is Rs 250.00 and the searched bottle is Rs 180.00. A separate bill with that barcode and a typed tablet totaled Rs 252.50.

| State at 1366 × 768                                           | Evidence                                                |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| Khata sign-up ready on a verified balance                     | [Customer name, phone and consent](khata-verified.webp) |
| Manual balance retry in progress, locked fields               | [Checking](checking.webp)                               |
| Read failed, retry available and fields locked                | [Read failure](read-failed.webp)                        |
| Retry returns a different amount                              | [Announced Rs 5.00](changed.webp)                       |
| Void confirmation reached by Shift+F4 and dismissed by Escape | [Confirmation](void-confirmation.webp)                  |

With the cash field focused, Chromium crossed the real 30-second freshness interval. The input stayed enabled with the same value and bounding rectangle, and the sheet kept its height. Take payment made an uncached read. A changed response announced Rs 5.00 and sent zero tender requests. In the recovery captures, the payment-time read failed, the cashier requested a retry, and the new balance was announced. Chromium counted two reads and zero tender requests. The before/after counter matrix used live responses from the disposable database. Permission gates remain covered separately by the restricted-runtime database and component tests.

## Manual payments and Khata account search

Each sheet below contains the 375, 768, 1024 and 1440 pixel widths in light and dark themes with both motion preferences. The captures used seeded customers and local cashier transactions. Chromium reported no console errors or horizontal document overflow. Keyboard input moved from the bill into payment, selected the tender and reached its input.

| Cashier state                        | Before                                     | After                                     |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------- |
| Card, blank slip and approval fields | [Card](before-Card.webp)                   | [Card](after-Card.webp)                   |
| Bank transfer, blank reference       | [Bank transfer](before-Bank-transfer.webp) | [Bank transfer](after-Bank-transfer.webp) |
| Khata account picker                 | [Khata](before-Khata.webp)                 | [Khata](after-Khata.webp)                 |

The cashier completed separate Rs 2.50 card and transfer sales with blank details and saw “No slip details” and “No transfer details” on the receipts. Selecting Khata focused the search field. An unmatched name or phone number carried over into sign-up. A separate sealed-stock fixture sold one tablet at Rs 1.00 and completed a cash sale without a pack-breaking prompt.

## Selling a loose tablet from sealed stock

The cashier requested one tablet from a new ten-tablet box. On develop, F5 selected Unit and adding the item produced the Inventory warning. In the patched counter, Unit was the default and the same action added a Rs 1.00 line. Chromium captured the counter with keyboard focus in search at all five widths, in both themes and motion modes, and then completed the patched sale with exact cash. The ledger recorded one pack opening with zero quantity change. The completed sale left nine open tablets and zero sealed packs.

| Before                                               | After                                       |
| ---------------------------------------------------- | ------------------------------------------- |
| [Counter refused the loose unit](before-sealed.webp) | [One tablet on the bill](after-sealed.webp) |
