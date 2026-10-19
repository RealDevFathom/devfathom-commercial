# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: platform-control-plane.spec.ts >> restaurant onboarding reaches ACTIVE
- Location: tests/e2e/platform-control-plane.spec.ts:226:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Use 24-hour time, e.g. 09:30')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Use 24-hour time, e.g. 09:30')

```

```yaml
- link "Skip to platform content":
  - /url: "#platform-main"
- banner:
  - link "DevFathom Platform control":
    - /url: /platform
  - text: Platform nominal Organizations
  - button "Use dark theme"
  - paragraph: Platform Administrator
  - paragraph: superadmin@platform-e2e.test
  - text: PA
  - button "Sign out"
- navigation "Platform navigation":
  - link "01 Control room":
    - /url: /platform
  - link "02 Organizations":
    - /url: /platform/organizations
  - link "03 Deployments":
    - /url: /platform/deployments
  - link "04 Jobs":
    - /url: /platform/jobs
  - link "05 Sales CRM":
    - /url: /platform/crm
  - link "06 Commercial":
    - /url: /platform/commercial
  - link "07 Modules & plans":
    - /url: /platform/catalog
  - link "08 Operators":
    - /url: /platform/operators
  - link "09 Audit ledger":
    - /url: /platform/audit
  - link "10 Platform settings":
    - /url: /platform/settings
- main:
  - text: Organizations / onboarding
  - heading "Onboard an organization" [level=1]
  - paragraph: Creates the tenant boundary, first administrator, package entitlements, default brand and email records, production deployment, and provisioning job. Activation remains manual.
  - region "Restaurant":
    - paragraph: Step 2 of 2 · organization type
    - heading "Restaurant" [level=2]
    - paragraph: Branches, POS, menu, inventory, SOP, loyalty, and insights. Restaurant Core is always enabled.
    - link "Change type":
      - /url: /platform/organizations/new
  - heading "Organization and tenant owner" [level=3]
  - paragraph: The workspace stays in onboarding until an operator completes activation preflight.
  - text: Display name
  - textbox "Display name": E2E Restaurant
  - text: Legal name
  - textbox "Legal name": E2E Restaurant Limited
  - text: Workspace slug
  - textbox "Workspace slug Lowercase letters, numbers, and hyphens.":
    - /placeholder: northwind-agency
    - text: e2e-restaurant-control-plane
  - text: Lowercase letters, numbers, and hyphens. Deployment mode
  - combobox "Deployment mode":
    - option "Shared platform" [selected]
    - option "Dedicated enterprise"
  - text: Commercial package
  - combobox "Commercial package Only active Restaurant packages are listed.":
    - option "E2E Restaurant Package · 25 default seats" [selected]
    - option "Restaurant Enterprise · 1 default seats"
    - option "Restaurant Essentials · 1 default seats"
    - option "Restaurant Operations · 1 default seats"
  - text: Only active Restaurant packages are listed. Seat limit
  - spinbutton "Seat limit": "25"
  - text: Currency
  - textbox "Currency": USD
  - text: Timezone
  - combobox "Timezone Type while the list is open to search IANA timezones.":
    - option "UTC"
    - option "Africa/Abidjan"
    - option "Africa/Accra"
    - option "Africa/Addis_Ababa"
    - option "Africa/Algiers"
    - option "Africa/Asmera"
    - option "Africa/Bamako"
    - option "Africa/Bangui"
    - option "Africa/Banjul"
    - option "Africa/Bissau"
    - option "Africa/Blantyre"
    - option "Africa/Brazzaville"
    - option "Africa/Bujumbura"
    - option "Africa/Cairo"
    - option "Africa/Casablanca"
    - option "Africa/Ceuta"
    - option "Africa/Conakry"
    - option "Africa/Dakar"
    - option "Africa/Dar_es_Salaam"
    - option "Africa/Djibouti"
    - option "Africa/Douala"
    - option "Africa/El_Aaiun"
    - option "Africa/Freetown"
    - option "Africa/Gaborone"
    - option "Africa/Harare"
    - option "Africa/Johannesburg"
    - option "Africa/Juba"
    - option "Africa/Kampala"
    - option "Africa/Khartoum"
    - option "Africa/Kigali"
    - option "Africa/Kinshasa"
    - option "Africa/Lagos"
    - option "Africa/Libreville"
    - option "Africa/Lome"
    - option "Africa/Luanda"
    - option "Africa/Lubumbashi"
    - option "Africa/Lusaka"
    - option "Africa/Malabo"
    - option "Africa/Maputo"
    - option "Africa/Maseru"
    - option "Africa/Mbabane"
    - option "Africa/Mogadishu"
    - option "Africa/Monrovia"
    - option "Africa/Nairobi"
    - option "Africa/Ndjamena"
    - option "Africa/Niamey"
    - option "Africa/Nouakchott"
    - option "Africa/Ouagadougou"
    - option "Africa/Porto-Novo"
    - option "Africa/Sao_Tome"
    - option "Africa/Tripoli"
    - option "Africa/Tunis"
    - option "Africa/Windhoek"
    - option "America/Adak"
    - option "America/Anchorage"
    - option "America/Anguilla"
    - option "America/Antigua"
    - option "America/Araguaina"
    - option "America/Argentina/La_Rioja"
    - option "America/Argentina/Rio_Gallegos"
    - option "America/Argentina/Salta"
    - option "America/Argentina/San_Juan"
    - option "America/Argentina/San_Luis"
    - option "America/Argentina/Tucuman"
    - option "America/Argentina/Ushuaia"
    - option "America/Aruba"
    - option "America/Asuncion"
    - option "America/Bahia"
    - option "America/Bahia_Banderas"
    - option "America/Barbados"
    - option "America/Belem"
    - option "America/Belize"
    - option "America/Blanc-Sablon"
    - option "America/Boa_Vista"
    - option "America/Bogota"
    - option "America/Boise"
    - option "America/Buenos_Aires"
    - option "America/Cambridge_Bay"
    - option "America/Campo_Grande"
    - option "America/Cancun"
    - option "America/Caracas"
    - option "America/Catamarca"
    - option "America/Cayenne"
    - option "America/Cayman"
    - option "America/Chicago"
    - option "America/Chihuahua"
    - option "America/Ciudad_Juarez"
    - option "America/Coral_Harbour"
    - option "America/Cordoba"
    - option "America/Costa_Rica"
    - option "America/Coyhaique"
    - option "America/Creston"
    - option "America/Cuiaba"
    - option "America/Curacao"
    - option "America/Danmarkshavn"
    - option "America/Dawson"
    - option "America/Dawson_Creek"
    - option "America/Denver"
    - option "America/Detroit"
    - option "America/Dominica"
    - option "America/Edmonton"
    - option "America/Eirunepe"
    - option "America/El_Salvador"
    - option "America/Fort_Nelson"
    - option "America/Fortaleza"
    - option "America/Glace_Bay"
    - option "America/Godthab"
    - option "America/Goose_Bay"
    - option "America/Grand_Turk"
    - option "America/Grenada"
    - option "America/Guadeloupe"
    - option "America/Guatemala"
    - option "America/Guayaquil"
    - option "America/Guyana"
    - option "America/Halifax"
    - option "America/Havana"
    - option "America/Hermosillo"
    - option "America/Indiana/Knox"
    - option "America/Indiana/Marengo"
    - option "America/Indiana/Petersburg"
    - option "America/Indiana/Tell_City"
    - option "America/Indiana/Vevay"
    - option "America/Indiana/Vincennes"
    - option "America/Indiana/Winamac"
    - option "America/Indianapolis"
    - option "America/Inuvik"
    - option "America/Iqaluit"
    - option "America/Jamaica"
    - option "America/Jujuy"
    - option "America/Juneau"
    - option "America/Kentucky/Monticello"
    - option "America/Kralendijk"
    - option "America/La_Paz"
    - option "America/Lima"
    - option "America/Los_Angeles"
    - option "America/Louisville"
    - option "America/Lower_Princes"
    - option "America/Maceio"
    - option "America/Managua"
    - option "America/Manaus"
    - option "America/Marigot"
    - option "America/Martinique"
    - option "America/Matamoros"
    - option "America/Mazatlan"
    - option "America/Mendoza"
    - option "America/Menominee"
    - option "America/Merida"
    - option "America/Metlakatla"
    - option "America/Mexico_City"
    - option "America/Miquelon"
    - option "America/Moncton"
    - option "America/Monterrey"
    - option "America/Montevideo"
    - option "America/Montserrat"
    - option "America/Nassau"
    - option "America/New_York"
    - option "America/Nome"
    - option "America/Noronha"
    - option "America/North_Dakota/Beulah"
    - option "America/North_Dakota/Center"
    - option "America/North_Dakota/New_Salem"
    - option "America/Ojinaga"
    - option "America/Panama"
    - option "America/Paramaribo"
    - option "America/Phoenix"
    - option "America/Port-au-Prince"
    - option "America/Port_of_Spain"
    - option "America/Porto_Velho"
    - option "America/Puerto_Rico"
    - option "America/Punta_Arenas"
    - option "America/Rankin_Inlet"
    - option "America/Recife"
    - option "America/Regina"
    - option "America/Resolute"
    - option "America/Rio_Branco"
    - option "America/Santarem"
    - option "America/Santiago"
    - option "America/Santo_Domingo"
    - option "America/Sao_Paulo"
    - option "America/Scoresbysund"
    - option "America/Sitka"
    - option "America/St_Barthelemy"
    - option "America/St_Johns"
    - option "America/St_Kitts"
    - option "America/St_Lucia"
    - option "America/St_Thomas"
    - option "America/St_Vincent"
    - option "America/Swift_Current"
    - option "America/Tegucigalpa"
    - option "America/Thule"
    - option "America/Tijuana"
    - option "America/Toronto"
    - option "America/Tortola"
    - option "America/Vancouver"
    - option "America/Whitehorse"
    - option "America/Winnipeg"
    - option "America/Yakutat"
    - option "Antarctica/Casey"
    - option "Antarctica/Davis"
    - option "Antarctica/DumontDUrville"
    - option "Antarctica/Macquarie"
    - option "Antarctica/Mawson"
    - option "Antarctica/McMurdo"
    - option "Antarctica/Palmer"
    - option "Antarctica/Rothera"
    - option "Antarctica/Syowa"
    - option "Antarctica/Troll"
    - option "Antarctica/Vostok"
    - option "Arctic/Longyearbyen"
    - option "Asia/Aden"
    - option "Asia/Almaty"
    - option "Asia/Amman"
    - option "Asia/Anadyr"
    - option "Asia/Aqtau"
    - option "Asia/Aqtobe"
    - option "Asia/Ashgabat"
    - option "Asia/Atyrau"
    - option "Asia/Baghdad"
    - option "Asia/Bahrain"
    - option "Asia/Baku"
    - option "Asia/Bangkok"
    - option "Asia/Barnaul"
    - option "Asia/Beirut"
    - option "Asia/Bishkek"
    - option "Asia/Brunei"
    - option "Asia/Calcutta"
    - option "Asia/Chita"
    - option "Asia/Colombo"
    - option "Asia/Damascus"
    - option "Asia/Dhaka"
    - option "Asia/Dili"
    - option "Asia/Dubai"
    - option "Asia/Dushanbe"
    - option "Asia/Famagusta"
    - option "Asia/Gaza"
    - option "Asia/Hebron"
    - option "Asia/Hong_Kong"
    - option "Asia/Hovd"
    - option "Asia/Irkutsk"
    - option "Asia/Jakarta"
    - option "Asia/Jayapura"
    - option "Asia/Jerusalem"
    - option "Asia/Kabul"
    - option "Asia/Kamchatka"
    - option "Asia/Karachi" [selected]
    - option "Asia/Katmandu"
    - option "Asia/Khandyga"
    - option "Asia/Krasnoyarsk"
    - option "Asia/Kuala_Lumpur"
    - option "Asia/Kuching"
    - option "Asia/Kuwait"
    - option "Asia/Macau"
    - option "Asia/Magadan"
    - option "Asia/Makassar"
    - option "Asia/Manila"
    - option "Asia/Muscat"
    - option "Asia/Nicosia"
    - option "Asia/Novokuznetsk"
    - option "Asia/Novosibirsk"
    - option "Asia/Omsk"
    - option "Asia/Oral"
    - option "Asia/Phnom_Penh"
    - option "Asia/Pontianak"
    - option "Asia/Pyongyang"
    - option "Asia/Qatar"
    - option "Asia/Qostanay"
    - option "Asia/Qyzylorda"
    - option "Asia/Rangoon"
    - option "Asia/Riyadh"
    - option "Asia/Saigon"
    - option "Asia/Sakhalin"
    - option "Asia/Samarkand"
    - option "Asia/Seoul"
    - option "Asia/Shanghai"
    - option "Asia/Singapore"
    - option "Asia/Srednekolymsk"
    - option "Asia/Taipei"
    - option "Asia/Tashkent"
    - option "Asia/Tbilisi"
    - option "Asia/Tehran"
    - option "Asia/Thimphu"
    - option "Asia/Tokyo"
    - option "Asia/Tomsk"
    - option "Asia/Ulaanbaatar"
    - option "Asia/Urumqi"
    - option "Asia/Ust-Nera"
    - option "Asia/Vientiane"
    - option "Asia/Vladivostok"
    - option "Asia/Yakutsk"
    - option "Asia/Yekaterinburg"
    - option "Asia/Yerevan"
    - option "Atlantic/Azores"
    - option "Atlantic/Bermuda"
    - option "Atlantic/Canary"
    - option "Atlantic/Cape_Verde"
    - option "Atlantic/Faeroe"
    - option "Atlantic/Madeira"
    - option "Atlantic/Reykjavik"
    - option "Atlantic/South_Georgia"
    - option "Atlantic/St_Helena"
    - option "Atlantic/Stanley"
    - option "Australia/Adelaide"
    - option "Australia/Brisbane"
    - option "Australia/Broken_Hill"
    - option "Australia/Darwin"
    - option "Australia/Eucla"
    - option "Australia/Hobart"
    - option "Australia/Lindeman"
    - option "Australia/Lord_Howe"
    - option "Australia/Melbourne"
    - option "Australia/Perth"
    - option "Australia/Sydney"
    - option "Europe/Amsterdam"
    - option "Europe/Andorra"
    - option "Europe/Astrakhan"
    - option "Europe/Athens"
    - option "Europe/Belgrade"
    - option "Europe/Berlin"
    - option "Europe/Bratislava"
    - option "Europe/Brussels"
    - option "Europe/Bucharest"
    - option "Europe/Budapest"
    - option "Europe/Busingen"
    - option "Europe/Chisinau"
    - option "Europe/Copenhagen"
    - option "Europe/Dublin"
    - option "Europe/Gibraltar"
    - option "Europe/Guernsey"
    - option "Europe/Helsinki"
    - option "Europe/Isle_of_Man"
    - option "Europe/Istanbul"
    - option "Europe/Jersey"
    - option "Europe/Kaliningrad"
    - option "Europe/Kiev"
    - option "Europe/Kirov"
    - option "Europe/Lisbon"
    - option "Europe/Ljubljana"
    - option "Europe/London"
    - option "Europe/Luxembourg"
    - option "Europe/Madrid"
    - option "Europe/Malta"
    - option "Europe/Mariehamn"
    - option "Europe/Minsk"
    - option "Europe/Monaco"
    - option "Europe/Moscow"
    - option "Europe/Oslo"
    - option "Europe/Paris"
    - option "Europe/Podgorica"
    - option "Europe/Prague"
    - option "Europe/Riga"
    - option "Europe/Rome"
    - option "Europe/Samara"
    - option "Europe/San_Marino"
    - option "Europe/Sarajevo"
    - option "Europe/Saratov"
    - option "Europe/Simferopol"
    - option "Europe/Skopje"
    - option "Europe/Sofia"
    - option "Europe/Stockholm"
    - option "Europe/Tallinn"
    - option "Europe/Tirane"
    - option "Europe/Ulyanovsk"
    - option "Europe/Vaduz"
    - option "Europe/Vatican"
    - option "Europe/Vienna"
    - option "Europe/Vilnius"
    - option "Europe/Volgograd"
    - option "Europe/Warsaw"
    - option "Europe/Zagreb"
    - option "Europe/Zurich"
    - option "Indian/Antananarivo"
    - option "Indian/Chagos"
    - option "Indian/Christmas"
    - option "Indian/Cocos"
    - option "Indian/Comoro"
    - option "Indian/Kerguelen"
    - option "Indian/Mahe"
    - option "Indian/Maldives"
    - option "Indian/Mauritius"
    - option "Indian/Mayotte"
    - option "Indian/Reunion"
    - option "Pacific/Apia"
    - option "Pacific/Auckland"
    - option "Pacific/Bougainville"
    - option "Pacific/Chatham"
    - option "Pacific/Easter"
    - option "Pacific/Efate"
    - option "Pacific/Enderbury"
    - option "Pacific/Fakaofo"
    - option "Pacific/Fiji"
    - option "Pacific/Funafuti"
    - option "Pacific/Galapagos"
    - option "Pacific/Gambier"
    - option "Pacific/Guadalcanal"
    - option "Pacific/Guam"
    - option "Pacific/Honolulu"
    - option "Pacific/Kiritimati"
    - option "Pacific/Kosrae"
    - option "Pacific/Kwajalein"
    - option "Pacific/Majuro"
    - option "Pacific/Marquesas"
    - option "Pacific/Midway"
    - option "Pacific/Nauru"
    - option "Pacific/Niue"
    - option "Pacific/Norfolk"
    - option "Pacific/Noumea"
    - option "Pacific/Pago_Pago"
    - option "Pacific/Palau"
    - option "Pacific/Pitcairn"
    - option "Pacific/Ponape"
    - option "Pacific/Port_Moresby"
    - option "Pacific/Rarotonga"
    - option "Pacific/Saipan"
    - option "Pacific/Tahiti"
    - option "Pacific/Tarawa"
    - option "Pacific/Tongatapu"
    - option "Pacific/Truk"
    - option "Pacific/Wake"
    - option "Pacific/Wallis"
  - text: Type while the list is open to search IANA timezones. First branch name
  - textbox "First branch name 2–120 characters. The stable branch code remains MAIN.":
    - /placeholder: Downtown
    - text: Gulberg Flagship
  - text: 2–120 characters. The stable branch code remains MAIN. First branch address
  - textbox "First branch address":
    - /placeholder: Street, city, region
    - text: 42 Main Boulevard, Lahore
  - text: Business-day cutoff
  - textbox "Business-day cutoff Use 24-hour time in the organization timezone, e.g. 09:30.":
    - /placeholder: HH:MM
    - text: 24:30
  - text: Use 24-hour time in the organization timezone, e.g. 09:30. Locale
  - textbox "Locale": en
  - text: Grace period (days)
  - spinbutton "Grace period (days)": "0"
  - text: Data residency
  - textbox "Data residency":
    - /placeholder: EU, US, PK…
  - text: Primary contact
  - textbox "Primary contact"
  - text: Primary contact email
  - textbox "Primary contact email"
  - text: Tenant administrator
  - textbox "Tenant administrator"
  - text: Administrator email
  - textbox "Administrator email"
  - text: Temporary administrator password
  - textbox "Temporary administrator password At least 12 characters. Share through an approved secure channel."
  - text: At least 12 characters. Share through an approved secure channel. Operator notes
  - textbox "Operator notes"
  - button "Create onboarding record"
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  151 |     await db.query(
  152 |       `CREATE OR REPLACE FUNCTION e2e_force_setting_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'e2e.rollback' THEN RAISE EXCEPTION 'forced e2e rollback'; END IF; RETURN NEW; END $$`
  153 |     );
  154 |     await db.query(
  155 |       `CREATE TRIGGER e2e_force_setting_rollback BEFORE INSERT OR UPDATE ON platform_settings FOR EACH ROW EXECUTE FUNCTION e2e_force_setting_rollback()`
  156 |     );
  157 |   });
  158 |   try {
  159 |     for (let replay = 0; replay < 2; replay += 1) {
  160 |       const failed = await request.post('/api/platform/control', {
  161 |         headers: {
  162 |           ...platformMutationHeaders,
  163 |           'x-devfathom-request-id': `${correlation}-rollback`,
  164 |         },
  165 |         data: {
  166 |           action: 'setting.upsert',
  167 |           payload: {
  168 |             key: 'e2e.rollback',
  169 |             category: 'e2e',
  170 |             value: { token: secret },
  171 |             sensitive: false,
  172 |           },
  173 |         },
  174 |         failOnStatusCode: false,
  175 |       });
  176 |       expect(failed.status()).toBe(500);
  177 |       expect(await failed.text()).not.toContain(secret);
  178 |     }
  179 |   } finally {
  180 |     await withAdminDatabase(async (db) => {
  181 |       await db.query('DROP TRIGGER IF EXISTS e2e_force_setting_rollback ON platform_settings');
  182 |       await db.query('DROP FUNCTION IF EXISTS e2e_force_setting_rollback()');
  183 |     });
  184 |   }
  185 | 
  186 |   await withAdminDatabase(async (db) => {
  187 |     const failureRequestId = (suffix: string) =>
  188 |       `pcorr_${createHash('sha256').update(`${correlation}-${suffix}`).digest('hex').slice(0, 32)}`;
  189 |     const denyRequestId = failureRequestId('deny');
  190 |     const invalidRequestId = failureRequestId('invalid');
  191 |     const rollbackRequestId = failureRequestId('rollback');
  192 |     const successRequestId = `${correlation}-success`;
  193 |     const evidence = await db.query<{
  194 |       request_id: string;
  195 |       success: boolean | null;
  196 |       payload: string;
  197 |     }>(
  198 |       `SELECT "requestId" AS request_id, success, row_to_json(a)::text AS payload FROM platform_audit_logs a WHERE "requestId" = ANY($1::text[]) ORDER BY "requestId"`,
  199 |       [[denyRequestId, invalidRequestId, rollbackRequestId, successRequestId]]
  200 |     );
  201 |     const byRequest = new Map(evidence.rows.map((row) => [row.request_id, row]));
  202 |     expect(evidence.rows.filter((row) => row.request_id === denyRequestId)).toHaveLength(1);
  203 |     expect(evidence.rows.filter((row) => row.request_id === invalidRequestId)).toHaveLength(1);
  204 |     expect(evidence.rows.filter((row) => row.request_id === rollbackRequestId)).toHaveLength(1);
  205 |     expect(evidence.rows.filter((row) => row.request_id === successRequestId)).toHaveLength(1);
  206 |     expect(byRequest.get(rollbackRequestId)?.success).toBe(false);
  207 |     expect(byRequest.get(denyRequestId)?.success).toBe(false);
  208 |     expect(byRequest.get(invalidRequestId)?.success).toBe(false);
  209 |     expect(byRequest.get(successRequestId)?.success).toBe(true);
  210 |     expect(JSON.stringify(evidence.rows)).not.toContain(secret);
  211 |     expect(JSON.stringify(evidence.rows)).not.toMatch(/forced e2e rollback|\bat .+\(.+\.ts:/);
  212 |   });
  213 | });
  214 | 
  215 | test('restaurant onboarding time field exposes the HH:MM input contract', async ({ page }) => {
  216 |   await loginPlatform(page);
  217 |   await page.goto('/platform/organizations/new');
  218 |   await page.getByRole('link', { name: /Continue as Restaurant/ }).click();
  219 | 
  220 |   const cutoff = page.locator('input[name="businessDayCutoff"]');
  221 |   await expect(cutoff).toHaveAttribute('placeholder', 'HH:MM');
  222 |   await expect(cutoff).toHaveAttribute('inputmode', 'numeric');
  223 |   await expect(cutoff).toHaveAttribute('maxlength', '5');
  224 | });
  225 | 
  226 | test('restaurant onboarding reaches ACTIVE', async ({ page }) => {
  227 |   const unexpectedErrors: string[] = [];
  228 |   page.on('console', (message) => {
  229 |     if (message.type() === 'error' && !message.text().includes('status of 400'))
  230 |       unexpectedErrors.push(message.text());
  231 |   });
  232 |   page.on('pageerror', (error) => unexpectedErrors.push(error.message));
  233 |   page.on('requestfailed', (request) => {
  234 |     const failure = request.failure()?.errorText ?? 'request failed';
  235 |     if (failure !== 'net::ERR_ABORTED') unexpectedErrors.push(failure);
  236 |   });
  237 |   await loginPlatform(page);
  238 |   await page.goto('/platform/organizations/new');
  239 |   await page.getByRole('link', { name: /Continue as Restaurant/ }).click();
  240 |   await page.getByLabel('Display name').fill('E2E Restaurant');
  241 |   await page.getByLabel('Legal name').fill('E2E Restaurant Limited');
  242 |   await page.getByLabel('Workspace slug').fill(platformFixture.tenant.slug);
  243 |   const timezone = page.locator('select[name="timezone"]');
  244 |   await expect(timezone).toHaveValue('Asia/Karachi');
  245 |   await page.getByLabel('First branch name').fill('Gulberg Flagship');
  246 |   await page.getByLabel('First branch address').fill('42 Main Boulevard, Lahore');
  247 |   const onboardingCutoff = page.locator('input[name="businessDayCutoff"]');
  248 |   await expect(onboardingCutoff).toHaveAttribute('placeholder', 'HH:MM');
  249 |   await onboardingCutoff.fill('24:30');
  250 |   await page.getByRole('button', { name: 'Create onboarding record' }).click();
> 251 |   await expect(page.getByText('Use 24-hour time, e.g. 09:30')).toBeVisible();
      |                                                                ^ Error: expect(locator).toBeVisible() failed
  252 |   await expect(onboardingCutoff).toBeFocused();
  253 |   await onboardingCutoff.fill('04:30');
  254 |   await page.getByLabel('Primary contact', { exact: true }).fill('Restaurant Owner');
  255 |   await page.getByLabel('Primary contact email').fill(platformFixture.tenant.email);
  256 |   await page.getByLabel('Tenant administrator').fill('Restaurant Owner');
  257 |   await page.getByLabel('Administrator email').fill(platformFixture.tenant.email);
  258 |   await page.getByLabel('Temporary administrator password').fill(platformFixture.tenant.password);
  259 |   let injectInvalidTimezone = true;
  260 |   await page.route('**/api/platform/control', async (route) => {
  261 |     const request = route.request();
  262 |     const body = request.postDataJSON() as {
  263 |       action?: string;
  264 |       payload?: Record<string, unknown>;
  265 |     };
  266 |     if (injectInvalidTimezone && body.action === 'organization.create' && body.payload) {
  267 |       injectInvalidTimezone = false;
  268 |       body.payload.timezone = 'Karachi-ish';
  269 |       await route.continue({ postData: JSON.stringify(body) });
  270 |       return;
  271 |     }
  272 |     await route.continue();
  273 |   });
  274 |   await page.getByRole('button', { name: 'Create onboarding record' }).click();
  275 |   await expect(page.getByText('Choose a valid IANA timezone.')).toBeVisible();
  276 |   await expect(timezone).toBeFocused();
  277 |   await timezone.selectOption('Asia/Karachi');
  278 |   await page.getByRole('button', { name: 'Create onboarding record' }).click();
  279 |   await expect(page).toHaveURL(/\/platform\/organizations\/(?!new(?:[/?]|$))[^/?]+/);
  280 |   await withAdminDatabase(async (db) => {
  281 |     const ready = await db.query(
  282 |       `UPDATE organization_deployments SET status='READY'
  283 |         WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)
  284 |           AND environment='production' RETURNING id`,
  285 |       [platformFixture.tenant.slug]
  286 |     );
  287 |     expect(ready.rowCount).toBe(1);
  288 |   });
  289 |   await page.getByLabel('Move to').selectOption('ACTIVE');
  290 |   await page.getByLabel('Operator reason').fill('E2E activation denied before setup');
  291 |   await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  292 |   await expect(page.getByText('Activation preflight failed:', { exact: false })).toBeVisible();
  293 |   await expect(page.getByText('ONBOARDING', { exact: true }).first()).toBeVisible();
  294 | 
  295 |   for (const [kind, reference] of [
  296 |     ['Tax', 'tax-policy-v1'],
  297 |     ['Payment', 'payment-policy-v2'],
  298 |     ['Device', 'device-policy-v3'],
  299 |     ['Operator', 'operator-policy-v4'],
  300 |   ] as const) {
  301 |     const key = kind.toLowerCase();
  302 |     await expect(page.getByText(`${kind} policy reference`, { exact: true })).toBeVisible();
  303 |     await page.locator(`input[name="${key}PolicyReference"]`).fill(reference);
  304 |     const acknowledgement = page.locator(`input[name="${key}Acknowledged"]`);
  305 |     await acknowledgement.focus();
  306 |     await expect(acknowledgement).toBeFocused();
  307 |     await page.keyboard.press('Space');
  308 |     await expect(acknowledgement).toBeChecked();
  309 |   }
  310 |   await page.getByRole('button', { name: 'Save Restaurant readiness' }).click();
  311 |   await expect(page.locator('input[name="taxPolicyReference"]')).toHaveValue('tax-policy-v1');
  312 | 
  313 |   await page.getByLabel('Move to').selectOption('ACTIVE');
  314 |   await page.getByLabel('Operator reason').fill('E2E activation after Restaurant setup');
  315 |   await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  316 |   await expect(page.getByText('ACTIVE', { exact: true }).first()).toBeVisible();
  317 | 
  318 |   await withAdminDatabase(async (db) => {
  319 |     const proof = await db.query<{
  320 |       status: string;
  321 |       vertical: string;
  322 |       branches: number;
  323 |       assignments: number;
  324 |       departments: number;
  325 |       roles: number;
  326 |       modules: number;
  327 |       branch_name: string;
  328 |       address: string;
  329 |       timezone: string;
  330 |       cutoff: string;
  331 |       acknowledgements: number;
  332 |       acknowledgement_actors: number;
  333 |       acknowledgement_timestamps: number;
  334 |     }>(
  335 |       `SELECT o.status, o.vertical,
  336 |         (SELECT count(*)::int FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) branches,
  337 |         (SELECT count(*)::int FROM restaurant_branch_assignments a WHERE a."organizationId"=o.id) assignments,
  338 |         (SELECT count(*)::int FROM organization_departments d WHERE d."organizationId"=o.id) departments,
  339 |         (SELECT count(*)::int FROM organization_roles r WHERE r."organizationId"=o.id) roles,
  340 |         (SELECT count(*)::int FROM platform_package_modules pm WHERE pm."packageId"=o."packageId" AND pm.enabled) modules,
  341 |         (SELECT b.name FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) branch_name,
  342 |         (SELECT b.address FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) address,
  343 |         (SELECT b.timezone FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) timezone,
  344 |         (SELECT b."businessDayCutoff" FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) cutoff,
  345 |         (SELECT count(*)::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id) acknowledgements,
  346 |         (SELECT count(DISTINCT a."acknowledgedById")::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id) acknowledgement_actors,
  347 |         (SELECT count(*)::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id AND a."acknowledgedAt" IS NOT NULL) acknowledgement_timestamps
  348 |        FROM organizations o JOIN platform_packages p ON p.id=o."packageId"
  349 |        WHERE o.slug=$1 AND p.vertical='RESTAURANT'`,
  350 |       [platformFixture.tenant.slug]
  351 |     );
```