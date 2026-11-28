# DEV-1044 Inventory visual QA

These screenshots use disposable pharmacy fixtures with two branches on PostgreSQL 16.16. They contain no production data. The before run used `develop` at `c87546646fecafcd5acea4374400d99896cbe46c`.

| Studio check                                 | Result                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewports                                    | 375, 768, 1024, and 1440 px                                                                                                                                                                                                                  |
| Themes and motion                            | Light and dark, with normal and reduced motion at every width. All 16 Inventory combinations passed.                                                                                                                                         |
| Keyboard                                     | Tab moved from the Branch selector to Apply branch. Enter opened the selector, Escape closed it and restored focus. The table disclosure toggled from the keyboard with a visible focus outline.                                             |
| Layout                                       | No document, body, or main-canvas horizontal overflow in the finished Inventory screen. Both expanded value tables stayed in their own containers at 375 px. Before the change, long batch choices overflowed the main canvas at that width. |
| Default, active, empty and permission states | The cost and selling price rendered for the authorized user. All branches applied on mobile. The empty branch showed zero products. The storekeeper saw quantities and no money or error.                                                    |
| Related states                               | Focused component tests covered loading, retry, absent valuation, and existing disabled pack actions. This change adds no destructive action or confirmation.                                                                                |
| Console and accessibility                    | No page or console errors in the completed Chromium run. The stock-value panel had no targeted axe WCAG AA violations at 375 px in dark mode.                                                                                                |
| Product parity                               | The tenant screen uses existing Studio cards, stats, selections, and tables. No platform screen or shell changed.                                                                                                                            |
| Finance link                                 | From the mobile all-branches summary, the linked branch report loaded at the exact same valuation instant and matched the Inventory cost for the seeded branch.                                                                              |

## Before and after

| View          | Before                          | After                         |
| ------------- | ------------------------------- | ----------------------------- |
| 375 px light  | [Before](before-375-light.jpg)  | [After](after-375-light.jpg)  |
| 375 px dark   | [Before](before-375-dark.jpg)   | [After](after-375-dark.jpg)   |
| 1440 px light | [Before](before-1440-light.jpg) | [After](after-1440-light.jpg) |
| 1440 px dark  | [Before](before-1440-dark.jpg)  | [After](after-1440-dark.jpg)  |

Additional captures show the [full mobile value card](summary-375-dark.jpg), [expanded value table](tables-375-dark.jpg), [quantities-only storekeeper](staff-375-light.jpg), and [matching Finance report](finance-link-375-light.jpg).
