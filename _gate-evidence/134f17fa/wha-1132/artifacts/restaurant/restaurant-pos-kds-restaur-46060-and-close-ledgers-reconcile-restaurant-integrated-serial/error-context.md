# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: restaurant-pos-kds.spec.ts >> restaurant POS and KDS core flow >> shift, order, KOT, KDS, split tender, drawer and close ledgers reconcile
- Location: tests/e2e/restaurant-pos-kds.spec.ts:55:7

# Error details

```
Error: expect(received).toMatchObject(expected)

- Expected  - 2
+ Received  + 2

  Object {
-   "grossSales": "28.00",
-   "netSales": "28.00",
+   "grossSales": "0.00",
+   "netSales": "0.00",
  }
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - link [ref=e3] [cursor=pointer]:
      - /url: "#pos-main"
      - text: Skip to order pad
    - generic [ref=e4]:
      - banner [ref=e5]:
        - generic [ref=e15]:
          - paragraph [ref=e16]: DevFathom
          - paragraph [ref=e17]: Restaurant POS
        - generic [ref=e18]: Online
      - main [ref=e21]:
        - generic [ref=e23]:
          - generic [ref=e24]:
            - generic [ref=e27]:
              - text: Restaurant POS
              - heading [level=1] [ref=e28]: Order pad
              - paragraph [ref=e29]: Live menu, open checks, kitchen pacing, and table service.
            - generic [ref=e31]:
              - generic [ref=e32]: E2E Operator · Restaurant E2E Operator
              - generic [ref=e34]: Online
              - generic [ref=e36]: Queued 0
              - button [ref=e38]: Switch operator
              - button [ref=e39]: Cash drawer
              - button [ref=e40]: Close day
              - button [ref=e41]: Refund
              - button [ref=e42]: Lock terminal
          - status [ref=e43]:
            - generic [ref=e44]: success
            - paragraph [ref=e46]: Order ready for payment.
          - generic [ref=e47]:
            - generic [ref=e48]:
              - generic [ref=e49]:
                - generic [ref=e51]:
                  - text: New check
                  - heading [level=3] [ref=e52]: Open order
                - generic [ref=e53]:
                  - generic [ref=e54]:
                    - generic [ref=e55]: Channel
                    - combobox [ref=e56]
                  - group [ref=e58]:
                    - generic [ref=e59]: Main dining
                    - generic [ref=e61]:
                      - checkbox [checked] [disabled] [ref=e62]
                      - generic [ref=e63]: Table 12
                      - generic [ref=e64]: Occupied
                  - generic [ref=e65]:
                    - generic [ref=e66]:
                      - generic [ref=e67]: Covers
                      - spinbutton [ref=e68]: "2"
                    - generic [ref=e69]:
                      - generic [ref=e70]: Floor section
                      - combobox [ref=e71]
                  - paragraph [ref=e72]: "Server: E2E Operator"
                  - button [ref=e73]: Send order
              - generic [ref=e74]:
                - generic [ref=e76]:
                  - text: Local draft
                  - heading [level=3] [ref=e77]: Composed order
                - paragraph [ref=e78]: Tap menu items to compose. Nothing is sent until Send order.
              - generic [ref=e79]:
                - generic [ref=e80]:
                  - generic [ref=e81]:
                    - text: Resume
                    - heading [level=3] [ref=e82]: Open orders
                  - button [ref=e84]: Refresh
                - generic [ref=e85]:
                  - button [pressed] [ref=e86]:
                    - generic [ref=e87]: "#3 · 2 items"
                    - generic [ref=e88]: "28"
                  - button [ref=e89]:
                    - generic [ref=e90]: "#2 · 1 item"
                    - generic [ref=e91]: "14"
                  - button [ref=e92]:
                    - generic [ref=e93]: "#1 · 1 item"
                    - generic [ref=e94]: "14"
            - generic [ref=e95]:
              - generic [ref=e96]:
                - generic [ref=e97]:
                  - generic [ref=e98]:
                    - text: Effective menu
                    - heading [level=3] [ref=e99]: Chai Chowk Menu
                  - generic [ref=e101]:
                    - generic [ref=e102]: Live catalog
                    - generic [ref=e104]: Channel open
                - generic [ref=e106]:
                  - region [ref=e108]:
                    - heading [level=3] [ref=e109]: Mains
                    - button [pressed] [ref=e111]:
                      - generic [ref=e112]: Chicken Tikka Bun
                      - generic [ref=e113]: "12.5"
                  - generic [ref=e114]:
                    - paragraph [ref=e115]: Chicken Tikka Bun
                    - generic [ref=e116]:
                      - generic [ref=e117]:
                        - generic [ref=e118]: Quantity
                        - spinbutton [ref=e119]: "2"
                      - generic [ref=e120]:
                        - generic [ref=e121]: Course
                        - spinbutton [ref=e122]: "1"
                      - generic [ref=e123]:
                        - generic [ref=e124]: Seat
                        - spinbutton [ref=e125]: "1"
                    - group [ref=e126]:
                      - generic [ref=e127]: Heat
                      - paragraph [ref=e128]: Required · Choose 1
                      - generic [ref=e130]:
                        - checkbox [checked] [ref=e131]
                        - generic [ref=e132]: Spicy
                        - generic [ref=e133]: "+1.5"
                    - button [ref=e134]: Add to order
              - generic [ref=e135]:
                - generic [ref=e136]:
                  - generic [ref=e137]:
                    - text: Order ticket
                    - heading [level=3] [ref=e138]: Order 3
                  - generic [ref=e139]: PAYMENT_PENDING
                - generic [ref=e142]:
                  - generic [ref=e143]: DINE IN
                  - generic [ref=e144]: Main dining · Table 12
                  - button [ref=e145]: Send whole order
                - button [ref=e147]: Reprint KOT 2
                - generic [ref=e149]:
                  - generic [ref=e150]:
                    - heading [level=3] [ref=e151]: Course 1
                    - generic [ref=e152]:
                      - button [ref=e153]: Hold
                      - button [ref=e154]: Fire
                  - list [ref=e155]:
                    - listitem [ref=e156]:
                      - generic [ref=e157]:
                        - generic [ref=e158]:
                          - paragraph [ref=e159]: 2 × Chicken Tikka Bun · Seat 1
                          - paragraph [ref=e160]: Spicy
                        - generic [ref=e161]: SERVED
                      - button [ref=e164]: Void Chicken Tikka Bun
                      - generic [ref=e165]:
                        - generic [ref=e166]:
                          - generic [ref=e167]: Remake reason for Chicken Tikka Bun
                          - textbox [ref=e168]:
                            - /placeholder: Remake reason
                        - button [disabled]: Request remake
                - generic [ref=e169]:
                  - generic [ref=e170]:
                    - paragraph [ref=e171]: Move table
                    - generic [ref=e172]:
                      - generic [ref=e173]:
                        - generic [ref=e174]: Current table
                        - combobox [ref=e175]
                      - generic [ref=e176]:
                        - generic [ref=e177]: Destination table
                        - combobox [ref=e178]
                    - button [disabled]: Move order
                  - generic [ref=e179]:
                    - paragraph [ref=e180]: Merge tables
                    - group [ref=e181]:
                      - generic [ref=e182]: Additional available tables
                      - paragraph [ref=e183]: No additional tables are available.
                    - button [disabled]: Merge tables
                - generic [ref=e184]:
                  - generic [ref=e185]: Subtotal 28 · Tax 0 · Service 0
                  - button [ref=e186]: Collect payment
  - alert [ref=e187]
  - dialog [ref=e191]:
    - generic [ref=e192]:
      - heading "Collect payment" [level=2] [ref=e193]
      - paragraph [ref=e194]: Cut bills, apply split tenders, and review settled receipts for this order.
    - generic [ref=e195]:
      - generic [ref=e196]:
        - generic [ref=e197]:
          - generic [ref=e198]:
            - text: Settlement
            - heading "Order balance" [level=3] [ref=e199]
          - generic [ref=e200]: settled
        - generic [ref=e203]:
          - generic [ref=e204]:
            - term [ref=e205]: Order total
            - definition [ref=e206]: "28.00"
          - generic [ref=e207]:
            - term [ref=e208]: Accounted on bills
            - definition [ref=e209]: "28.00"
      - generic [ref=e210]:
        - generic [ref=e211]:
          - generic [ref=e212]:
            - text: Bill 1
            - heading "Receipt 1" [level=3] [ref=e213]
          - generic [ref=e214]: SETTLED
        - generic [ref=e217]:
          - generic [ref=e218]:
            - term [ref=e219]: Bill total
            - definition [ref=e220]: "14.00"
          - generic [ref=e221]:
            - term [ref=e222]: Comp total
            - definition [ref=e223]: "0.00"
        - region "Receipt 1" [ref=e224]:
          - generic [ref=e225]:
            - generic [ref=e226]:
              - paragraph [ref=e227]: Receipt 1
              - paragraph [ref=e228]: Gulberg Café · Order 3
              - paragraph [ref=e229]: 2026-09-03 · DINE IN
            - generic [ref=e230]: settled
          - list
          - generic [ref=e232]:
            - generic [ref=e233]:
              - term [ref=e234]: Subtotal
              - definition [ref=e235]: "14.00"
            - generic [ref=e236]:
              - term [ref=e237]: Delivery fee
              - definition [ref=e238]: "0.00"
            - generic [ref=e239]:
              - term [ref=e240]: Service charge
              - definition [ref=e241]: "0.00"
            - generic [ref=e242]:
              - term [ref=e243]: Tax
              - definition [ref=e244]: "0.00"
            - generic [ref=e245]:
              - term [ref=e246]: Comp
              - definition [ref=e247]: "0.00"
            - generic [ref=e248]:
              - term [ref=e249]: Rounding
              - definition [ref=e250]: "0.00"
            - generic [ref=e251]:
              - term [ref=e252]: Total
              - definition [ref=e253]: "14.00"
          - generic [ref=e254]:
            - paragraph [ref=e255]: Tenders
            - generic [ref=e256]:
              - generic [ref=e257]: CASH
              - generic [ref=e258]: "14.00"
              - generic [ref=e259]: Change
              - generic [ref=e260]: "0.00"
      - generic [ref=e261]:
        - generic [ref=e262]:
          - generic [ref=e263]:
            - text: Bill 2
            - heading "Receipt 2" [level=3] [ref=e264]
          - generic [ref=e265]: SETTLED
        - generic [ref=e268]:
          - generic [ref=e269]:
            - term [ref=e270]: Bill total
            - definition [ref=e271]: "14.00"
          - generic [ref=e272]:
            - term [ref=e273]: Comp total
            - definition [ref=e274]: "0.00"
        - region "Receipt 2" [ref=e275]:
          - generic [ref=e276]:
            - generic [ref=e277]:
              - paragraph [ref=e278]: Receipt 2
              - paragraph [ref=e279]: Gulberg Café · Order 3
              - paragraph [ref=e280]: 2026-09-03 · DINE IN
            - generic [ref=e281]: settled
          - list
          - generic [ref=e283]:
            - generic [ref=e284]:
              - term [ref=e285]: Subtotal
              - definition [ref=e286]: "14.00"
            - generic [ref=e287]:
              - term [ref=e288]: Delivery fee
              - definition [ref=e289]: "0.00"
            - generic [ref=e290]:
              - term [ref=e291]: Service charge
              - definition [ref=e292]: "0.00"
            - generic [ref=e293]:
              - term [ref=e294]: Tax
              - definition [ref=e295]: "0.00"
            - generic [ref=e296]:
              - term [ref=e297]: Comp
              - definition [ref=e298]: "0.00"
            - generic [ref=e299]:
              - term [ref=e300]: Rounding
              - definition [ref=e301]: "0.00"
            - generic [ref=e302]:
              - term [ref=e303]: Total
              - definition [ref=e304]: "14.00"
          - generic [ref=e305]:
            - paragraph [ref=e306]: Tenders
            - generic [ref=e307]:
              - generic [ref=e308]: CASH
              - generic [ref=e309]: "14.00"
              - generic [ref=e310]: Change
              - generic [ref=e311]: "0.00"
    - button "Close checkout" [ref=e313]
```

# Test source

```ts
  124 |     ).toBeVisible();
  125 | 
  126 |     await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
  127 |     await page.getByLabel('Quantity').fill('2');
  128 |     await page.getByLabel('Seat').fill('1');
  129 |     await page.getByLabel(new RegExp(fixture.modifier.name)).check();
  130 |     await page.getByRole('button', { name: 'Add to order' }).click();
  131 |     await expect(page.getByText(`2 × ${fixture.menuItem.name}`)).toBeVisible();
  132 |     await expect(
  133 |       page
  134 |         .getByRole('listitem')
  135 |         .filter({ hasText: `2 × ${fixture.menuItem.name}` })
  136 |         .getByText(fixture.modifier.name, { exact: true })
  137 |     ).toBeVisible();
  138 |     await page.getByRole('button', { name: 'Send whole order' }).click();
  139 |     await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
  140 | 
  141 |     const orderButton = page.getByRole('button', { name: /#\d+ · 2 items/ });
  142 |     const orderNumber = String(opened.orderNumber);
  143 | 
  144 |     const terminalBaseUrl = terminalBrowserBaseUrl(baseURL);
  145 |     const kdsContext = await browser.newContext({ baseURL: terminalBaseUrl });
  146 |     await installSeededTerminalCookie(kdsContext, fixture.kds, terminalBaseUrl);
  147 |     const kdsPage = await kdsContext.newPage();
  148 |     const establishedResponse = kdsPage.waitForResponse(
  149 |       (response) =>
  150 |         response.url().endsWith('/api/restaurant/terminal/establish') &&
  151 |         response.request().method() === 'POST'
  152 |     );
  153 |     await kdsPage.goto(new URL('/kds', terminalBaseUrl).href);
  154 |     expect((await establishedResponse).status()).toBe(201);
  155 |     await kdsPage.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
  156 |     await kdsPage.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  157 |     const unlockedResponse = kdsPage.waitForResponse(
  158 |       (response) =>
  159 |         response.url().endsWith('/api/restaurant/terminal/unlock') &&
  160 |         response.request().method() === 'POST'
  161 |     );
  162 |     await kdsPage.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  163 |     expect((await unlockedResponse).status()).toBe(200);
  164 |     await expect(kdsPage.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
  165 |     await assertTerminalSecretIsBrowserIsolated(kdsPage, fixture.kds.secret);
  166 |     await expect(kdsPage.getByText(`Order #${orderNumber}`)).toBeVisible();
  167 |     await kdsPage
  168 |       .getByRole('button', {
  169 |         name: new RegExp(`Start ${fixture.menuItem.name} for order ${orderNumber}`),
  170 |       })
  171 |       .click();
  172 |     await expect(kdsPage.getByText('Item started.')).toBeVisible();
  173 |     await kdsPage
  174 |       .getByRole('button', {
  175 |         name: new RegExp(`Mark ready ${fixture.menuItem.name} for order ${orderNumber}`),
  176 |       })
  177 |       .click();
  178 |     await expect(kdsPage.getByText('Item marked ready.')).toBeVisible();
  179 |     await kdsContext.close();
  180 | 
  181 |     await page.bringToFront();
  182 |     await orderButton.click();
  183 |     await expect(page.getByText('PREPARED')).toBeVisible();
  184 |     await page.getByRole('button', { name: 'Mark served' }).click();
  185 |     await page.getByRole('button', { name: 'Close order' }).click();
  186 |     await expect(page.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();
  187 |     await page.getByRole('button', { name: 'Split bill' }).click();
  188 |     await page.getByLabel('Split method').selectOption('FRACTIONAL');
  189 |     await page.getByLabel('Fractional weights').fill('1,1');
  190 |     await page.getByRole('button', { name: 'Create split bills' }).click();
  191 |     await expect(page.getByText('FRACTIONAL')).toHaveCount(2);
  192 | 
  193 |     const splitAmount = (Number(fixture.expected.twoItemTotal) / 2).toFixed(2);
  194 |     const receipts = page
  195 |       .getByRole('dialog', { name: 'Collect payment' })
  196 |       .getByRole('region', { name: /^Receipt \d+$/ });
  197 |     for (let settled = 1; settled <= 2; settled += 1) {
  198 |       await page.getByLabel('Amount').first().fill(splitAmount);
  199 |       await page.getByLabel('Cash received').first().fill(splitAmount);
  200 |       await page.getByRole('button', { name: 'Apply tender' }).first().click();
  201 |       await expect(receipts).toHaveCount(settled);
  202 |     }
  203 | 
  204 |     const summaryResponse = await request.get(
  205 |       `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(opened.orderId)}`,
  206 |       { headers: pos.headers }
  207 |     );
  208 |     expect(summaryResponse.status()).toBe(200);
  209 |     const summary = await summaryResponse.json();
  210 |     expect(summary).toMatchObject({
  211 |       settled: true,
  212 |       blocker: null,
  213 |       derivedOrderTotal: fixture.expected.twoItemTotal,
  214 |       accountedTotal: fixture.expected.twoItemTotal,
  215 |     });
  216 | 
  217 |     const businessDate = new Date().toISOString().slice(0, 10);
  218 |     const previewResponse = await request.get(
  219 |       `/api/restaurant/cash/day/preview?businessDate=${businessDate}`,
  220 |       { headers: pos.headers }
  221 |     );
  222 |     expect(previewResponse.status()).toBe(200);
  223 |     const preview = await previewResponse.json();
> 224 |     expect(preview.totals).toMatchObject({
      |                            ^ Error: expect(received).toMatchObject(expected)
  225 |       grossSales: fixture.expected.twoItemTotal,
  226 |       netSales: fixture.expected.twoItemTotal,
  227 |     });
  228 |     expect(preview.tenderTotals).toEqual([
  229 |       expect.objectContaining({
  230 |         tenderType: 'CASH',
  231 |         amount: fixture.expected.twoItemTotal,
  232 |         count: 2,
  233 |       }),
  234 |     ]);
  235 | 
  236 |     await post(
  237 |       request,
  238 |       pos,
  239 |       '/api/restaurant/cash/drawer/movement',
  240 |       {
  241 |         drawerSessionId: 'drawer_restaurant_e2e',
  242 |         kind: 'PAID_IN',
  243 |         amount: '5.00',
  244 |         reason: 'E2E exact reconciliation',
  245 |       },
  246 |       e2eIdempotencyKey('drawer-paid-in', opened.orderNumber)
  247 |     );
  248 |     await post(
  249 |       request,
  250 |       pos,
  251 |       '/api/restaurant/cash/drawer/close',
  252 |       {
  253 |         drawerSessionId: 'drawer_restaurant_e2e',
  254 |         countedCash: String(Number(preview.totals.cashExpected) + 5)
  255 |           .concat('.00')
  256 |           .replace('.00.00', '.00'),
  257 |       },
  258 |       e2eIdempotencyKey('drawer-close', opened.orderNumber)
  259 |     );
  260 |     const closeResponse = await post(
  261 |       request,
  262 |       pos,
  263 |       '/api/restaurant/cash/day/close',
  264 |       { businessDate },
  265 |       e2eIdempotencyKey('daily-close', opened.orderNumber)
  266 |     );
  267 |     const close = await closeResponse.json();
  268 |     expect(close.totals.cashVariance).toBe('0.00');
  269 |     expect(close.totals.grossSales).toBe(fixture.expected.twoItemTotal);
  270 |     expect(close.replayed).toBe(false);
  271 | 
  272 |     const kds = await establishKdsFixture(request);
  273 |     expect(kds.deviceId).toBe(fixture.kds.deviceId);
  274 |   });
  275 | });
  276 | 
```