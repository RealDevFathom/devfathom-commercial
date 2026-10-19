# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: platform-control-plane-pharmacy-lifecycle.spec.ts >> SuperAdmin completes the audited PHARMACY lifecycle and cross-vertical requests fail closed
- Location: tests/e2e/platform-control-plane-pharmacy-lifecycle.spec.ts:55:5

# Error details

```
error: pharmacy_branch_regulatory_profiles is append-only; create a new effective-dated version
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e2]:
    - link "Skip to platform content" [ref=f1e3] [cursor=pointer]:
      - /url: "#platform-main"
    - generic [ref=f1e4]:
      - banner [ref=f1e5]:
        - link "DevFathom Platform control" [ref=f1e6] [cursor=pointer]:
          - /url: /platform
          - generic [ref=f1e16]:
            - generic [ref=f1e17]: DevFathom
            - generic [ref=f1e18]: Platform control
        - generic [ref=f1e20]:
          - generic [ref=f1e21]: Platform nominal
          - generic [ref=f1e23]: Organizations
        - generic [ref=f1e24]:
          - button "Use dark theme" [ref=f1e25] [cursor=pointer]
          - generic [ref=f1e28]:
            - paragraph [ref=f1e29]: Platform Administrator
            - paragraph [ref=f1e30]: superadmin@platform-e2e.test
          - generic "SUPER ADMIN" [ref=f1e31]: PA
          - button "Sign out" [ref=f1e32] [cursor=pointer]
      - navigation "Platform navigation" [ref=f1e37]:
        - link "01 Control room" [ref=f1e38] [cursor=pointer]:
          - /url: /platform
          - generic [ref=f1e39]: "01"
          - generic [ref=f1e40]: Control room
        - link "02 Organizations" [ref=f1e41] [cursor=pointer]:
          - /url: /platform/organizations
          - generic [ref=f1e42]: "02"
          - generic [ref=f1e43]: Organizations
        - link "03 Deployments" [ref=f1e45] [cursor=pointer]:
          - /url: /platform/deployments
          - generic [ref=f1e46]: "03"
          - generic [ref=f1e47]: Deployments
        - link "04 Jobs" [ref=f1e48] [cursor=pointer]:
          - /url: /platform/jobs
          - generic [ref=f1e49]: "04"
          - generic [ref=f1e50]: Jobs
        - link "05 Sales CRM" [ref=f1e51] [cursor=pointer]:
          - /url: /platform/crm
          - generic [ref=f1e52]: "05"
          - generic [ref=f1e53]: Sales CRM
        - link "06 Commercial" [ref=f1e54] [cursor=pointer]:
          - /url: /platform/commercial
          - generic [ref=f1e55]: "06"
          - generic [ref=f1e56]: Commercial
        - link "07 Modules & plans" [ref=f1e57] [cursor=pointer]:
          - /url: /platform/catalog
          - generic [ref=f1e58]: "07"
          - generic [ref=f1e59]: Modules & plans
        - link "08 Operators" [ref=f1e60] [cursor=pointer]:
          - /url: /platform/operators
          - generic [ref=f1e61]: "08"
          - generic [ref=f1e62]: Operators
        - link "09 Audit ledger" [ref=f1e63] [cursor=pointer]:
          - /url: /platform/audit
          - generic [ref=f1e64]: "09"
          - generic [ref=f1e65]: Audit ledger
        - link "10 Platform settings" [ref=f1e66] [cursor=pointer]:
          - /url: /platform/settings
          - generic [ref=f1e67]: "10"
          - generic [ref=f1e68]: Platform settings
      - main [ref=f1e69]:
        - generic [ref=f1e71]:
          - generic [ref=f1e72]:
            - generic [ref=f1e75]:
              - text: Organizations / e2e-pharmacy-control-plane
              - heading "E2E Pharmacy" [level=1] [ref=f1e76]
              - paragraph [ref=f1e77]: E2E Pharmacy (Private) Limited · Pharmacy · shared deployment · 1/2500 seats
            - generic [ref=f1e78]: ONBOARDING
          - navigation "Organization sections" [ref=f1e81]:
            - link "Lifecycle" [ref=f1e82] [cursor=pointer]:
              - /url: "#lifecycle"
            - link "Profile" [ref=f1e83] [cursor=pointer]:
              - /url: "#profile"
            - link "Modules" [ref=f1e84] [cursor=pointer]:
              - /url: "#modules"
            - link "Limits" [ref=f1e85] [cursor=pointer]:
              - /url: "#limits"
            - link "People" [ref=f1e86] [cursor=pointer]:
              - /url: "#people"
            - link "Brand" [ref=f1e87] [cursor=pointer]:
              - /url: "#brand"
            - link "Email" [ref=f1e88] [cursor=pointer]:
              - /url: "#email"
            - link "Domains" [ref=f1e89] [cursor=pointer]:
              - /url: "#domains"
            - link "Identity" [ref=f1e90] [cursor=pointer]:
              - /url: "#identity"
            - link "SCIM" [ref=f1e91] [cursor=pointer]:
              - /url: "#scim"
            - link "Deployment" [ref=f1e92] [cursor=pointer]:
              - /url: "#deployment"
            - link "Commercial" [ref=f1e93] [cursor=pointer]:
              - /url: "#commercial"
            - link "Audit" [ref=f1e94] [cursor=pointer]:
              - /url: "#audit"
          - generic [ref=f1e95]:
            - generic [ref=f1e96]:
              - generic [ref=f1e97]:
                - generic [ref=f1e98]:
                  - paragraph [ref=f1e99]: Manual control
                  - heading "Lifecycle gate" [level=2] [ref=f1e100]
                  - paragraph [ref=f1e101]: Activation validates package, modules, administrator, and production deployment.
                - generic [ref=f1e102]:
                  - paragraph [ref=f1e103]: Unmet activation gates
                  - list [ref=f1e104]:
                    - listitem [ref=f1e105]:
                      - generic [ref=f1e106]: Add a ready production deployment.
                      - generic [ref=f1e116]:
                        - button "Use shared deployment" [ref=f1e117] [cursor=pointer]
                        - link "Add deployment" [ref=f1e120] [cursor=pointer]:
                          - /url: /platform/deployments?organizationId=cmtkq2k8u004jahtwbwpa0d4f
                - generic [ref=f1e122]:
                  - generic [ref=f1e123]:
                    - generic [ref=f1e124]:
                      - generic [ref=f1e125]: Move to
                      - combobox "Move to" [ref=f1e126]:
                        - option "ACTIVE" [selected]
                        - option "SUSPENDED"
                        - option "TERMINATED"
                    - generic [ref=f1e127]:
                      - generic [ref=f1e128]: Operator reason
                      - textbox "Operator reason Required and written to the immutable lifecycle and audit ledgers." [ref=f1e129]: E2E activation refused on provisional PK-PB rules
                      - generic [ref=f1e130]: Required and written to the immutable lifecycle and audit ledgers.
                  - alert [ref=f1e131]: "Activation preflight failed: pharmacy regulatory profile denied operation (RULE_SET_UNCONFIRMED)."
                  - button "Apply lifecycle change" [ref=f1e133] [cursor=pointer]
              - generic [ref=f1e138]:
                - generic [ref=f1e139]:
                  - generic [ref=f1e140]:
                    - paragraph [ref=f1e141]: Immutable
                    - heading "Organization type" [level=2] [ref=f1e142]
                    - paragraph [ref=f1e143]: The type is chosen once at onboarding. It governs which packages, modules, and workspace surfaces exist, and it cannot be changed after activation.
                  - generic [ref=f1e144]:
                    - generic [ref=f1e145]:
                      - paragraph [ref=f1e146]: Pharmacy
                      - paragraph [ref=f1e147]: PHARMACY
                      - paragraph [ref=f1e148]: Counters, dispensing, inventory, procurement, safety, and reporting.
                    - generic [ref=f1e149]: LOCKED
                  - generic [ref=f1e151]:
                    - paragraph [ref=f1e152]: Early onboarding correction
                    - paragraph [ref=f1e153]: This organization is still in onboarding, has never been activated, and owns no branches or module overrides, so the type may still be corrected to Agency. The replacement package is required in the same command; the correction disappears as soon as setup starts.
                    - generic [ref=f1e155]:
                      - generic [ref=f1e157]:
                        - generic [ref=f1e158]: Agency package
                        - combobox "Agency package A correction must move the organization and its package together." [ref=f1e159]:
                          - option "Agency Suite" [selected]
                          - option "E2E Activation Gate Package"
                          - option "E2E Agency Only"
                        - generic [ref=f1e160]: A correction must move the organization and its package together.
                      - button "Correct type to Agency" [ref=f1e162] [cursor=pointer]
                - generic [ref=f1e167]:
                  - generic [ref=f1e168]:
                    - heading "Workspace profile" [level=3] [ref=f1e169]
                    - paragraph [ref=f1e170]: Commercial assignment, locale, seats, and customer contact.
                  - generic [ref=f1e171]:
                    - generic [ref=f1e172]:
                      - generic [ref=f1e173]: Display name
                      - textbox "Display name" [ref=f1e174]: E2E Pharmacy
                    - generic [ref=f1e175]:
                      - generic [ref=f1e176]: Legal name
                      - textbox "Legal name" [ref=f1e177]: E2E Pharmacy (Private) Limited
                    - generic [ref=f1e178]:
                      - generic [ref=f1e179]: Commercial package
                      - combobox "Commercial package Only active Pharmacy packages can be assigned." [ref=f1e180]:
                        - option "Not set"
                        - option "Pharmacy Chain"
                        - option "Pharmacy Essentials" [selected]
                        - option "Pharmacy Professional"
                      - generic [ref=f1e181]: Only active Pharmacy packages can be assigned.
                    - generic [ref=f1e182]:
                      - generic [ref=f1e183]: Deployment mode
                      - combobox "Deployment mode" [ref=f1e184]:
                        - option "Shared platform" [selected]
                        - option "Dedicated enterprise"
                    - generic [ref=f1e185]:
                      - generic [ref=f1e186]: Seat limit
                      - spinbutton "Seat limit" [ref=f1e187]: "2500"
                    - generic [ref=f1e188]:
                      - generic [ref=f1e189]: Grace period (days)
                      - spinbutton "Grace period (days)" [ref=f1e190]: "0"
                    - generic [ref=f1e191]:
                      - generic [ref=f1e192]: Timezone
                      - combobox "Timezone Type while the list is open to search IANA timezones." [ref=f1e193]:
                        - option "Not set"
                        - option "UTC" [selected]
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
                        - option "Asia/Karachi"
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
                      - generic [ref=f1e194]: Type while the list is open to search IANA timezones.
                    - generic [ref=f1e195]:
                      - generic [ref=f1e196]: Locale
                      - textbox "Locale" [ref=f1e197]: en
                    - generic [ref=f1e198]:
                      - generic [ref=f1e199]: Currency
                      - textbox "Currency" [ref=f1e200]: USD
                    - generic [ref=f1e201]:
                      - generic [ref=f1e202]: Data residency
                      - textbox "Data residency" [ref=f1e203]
                    - generic [ref=f1e204]:
                      - generic [ref=f1e205]: Primary contact
                      - textbox "Primary contact" [ref=f1e206]: Pharmacy Owner
                    - generic [ref=f1e207]:
                      - generic [ref=f1e208]: Primary email
                      - textbox "Primary email" [ref=f1e209]: pharmacy-owner@e2e.invalid
                    - generic [ref=f1e210]:
                      - generic [ref=f1e211]: Operator notes
                      - textbox "Operator notes" [ref=f1e212]
                  - button "Save changes" [ref=f1e214] [cursor=pointer]
              - generic [ref=f1e219]:
                - generic [ref=f1e220]:
                  - paragraph [ref=f1e221]: Entitlements
                  - heading "Modules" [level=2] [ref=f1e222]
                  - paragraph [ref=f1e223]: "Only Pharmacy modules are listed. Each row shows where the effective entitlement comes from: a package default, a live contract, an organization override, or nothing at all."
                - generic [ref=f1e224]:
                  - generic [ref=f1e225]:
                    - generic [ref=f1e226]:
                      - paragraph [ref=f1e227]: Dashboard
                      - paragraph [ref=f1e228]: Core · dashboard
                      - paragraph [ref=f1e229]: "Source: NONE · mandatory"
                    - generic [ref=f1e230]: INACTIVE
                    - button "Enable" [ref=f1e233] [cursor=pointer]
                  - generic [ref=f1e236]:
                    - generic [ref=f1e237]:
                      - paragraph [ref=f1e238]: Administration
                      - paragraph [ref=f1e239]: Core · admin
                      - paragraph [ref=f1e240]: "Source: NONE · mandatory"
                    - generic [ref=f1e241]: INACTIVE
                    - button "Enable" [ref=f1e244] [cursor=pointer]
                  - generic [ref=f1e247]:
                    - generic [ref=f1e248]:
                      - paragraph [ref=f1e249]: Notifications
                      - paragraph [ref=f1e250]: Communication · notifications
                      - paragraph [ref=f1e251]: "Source: NONE · mandatory"
                    - generic [ref=f1e252]: INACTIVE
                    - button "Enable" [ref=f1e255] [cursor=pointer]
                  - generic [ref=f1e258]:
                    - generic [ref=f1e259]:
                      - paragraph [ref=f1e260]: Chat
                      - paragraph [ref=f1e261]: Collaboration · chat
                      - paragraph [ref=f1e262]: "Source: NONE"
                    - generic [ref=f1e263]: INACTIVE
                    - button "Enable" [ref=f1e266] [cursor=pointer]
                  - generic [ref=f1e269]:
                    - generic [ref=f1e270]:
                      - paragraph [ref=f1e271]: Meetings
                      - paragraph [ref=f1e272]: Collaboration · meetings
                      - paragraph [ref=f1e273]: "Source: NONE"
                    - generic [ref=f1e274]: INACTIVE
                    - button "Enable" [ref=f1e277] [cursor=pointer]
                  - generic [ref=f1e280]:
                    - generic [ref=f1e281]:
                      - paragraph [ref=f1e282]: Notes
                      - paragraph [ref=f1e283]: Knowledge · notes
                      - paragraph [ref=f1e284]: "Source: NONE"
                    - generic [ref=f1e285]: INACTIVE
                    - button "Enable" [ref=f1e288] [cursor=pointer]
                  - generic [ref=f1e291]:
                    - generic [ref=f1e292]:
                      - paragraph [ref=f1e293]: Email
                      - paragraph [ref=f1e294]: Communication · email
                      - paragraph [ref=f1e295]: "Source: NONE"
                    - generic [ref=f1e296]: INACTIVE
                    - button "Enable" [ref=f1e299] [cursor=pointer]
                  - generic [ref=f1e302]:
                    - generic [ref=f1e303]:
                      - paragraph [ref=f1e304]: HR
                      - paragraph [ref=f1e305]: People · hr
                      - paragraph [ref=f1e306]: "Source: NONE"
                    - generic [ref=f1e307]: INACTIVE
                    - button "Enable" [ref=f1e310] [cursor=pointer]
                  - generic [ref=f1e313]:
                    - generic [ref=f1e314]:
                      - paragraph [ref=f1e315]: Performance reviews
                      - paragraph [ref=f1e316]: People · reviews
                      - paragraph [ref=f1e317]: "Source: NONE"
                    - generic [ref=f1e318]: INACTIVE
                    - button "Enable" [ref=f1e321] [cursor=pointer]
                  - generic [ref=f1e324]:
                    - generic [ref=f1e325]:
                      - paragraph [ref=f1e326]: API access
                      - paragraph [ref=f1e327]: Developer · api
                      - paragraph [ref=f1e328]: "Source: NONE"
                    - generic [ref=f1e329]: INACTIVE
                    - button "Enable" [ref=f1e332] [cursor=pointer]
                  - generic [ref=f1e335]:
                    - generic [ref=f1e336]:
                      - paragraph [ref=f1e337]: Webhooks
                      - paragraph [ref=f1e338]: Developer · webhooks
                      - paragraph [ref=f1e339]: "Source: NONE"
                    - generic [ref=f1e340]: INACTIVE
                    - button "Enable" [ref=f1e343] [cursor=pointer]
                  - generic [ref=f1e346]:
                    - generic [ref=f1e347]:
                      - paragraph [ref=f1e348]: Audit logs
                      - paragraph [ref=f1e349]: Security · audit
                      - paragraph [ref=f1e350]: "Source: NONE"
                    - generic [ref=f1e351]: INACTIVE
                    - button "Enable" [ref=f1e354] [cursor=pointer]
                  - generic [ref=f1e357]:
                    - generic [ref=f1e358]:
                      - paragraph [ref=f1e359]: White-label branding
                      - paragraph [ref=f1e360]: Configuration · branding
                      - paragraph [ref=f1e361]: "Source: NONE"
                    - generic [ref=f1e362]: INACTIVE
                    - button "Enable" [ref=f1e365] [cursor=pointer]
                  - generic [ref=f1e368]:
                    - generic [ref=f1e369]:
                      - paragraph [ref=f1e370]: Custom domains
                      - paragraph [ref=f1e371]: Configuration · domains
                      - paragraph [ref=f1e372]: "Source: NONE"
                    - generic [ref=f1e373]: INACTIVE
                    - button "Enable" [ref=f1e376] [cursor=pointer]
                  - generic [ref=f1e379]:
                    - generic [ref=f1e380]:
                      - paragraph [ref=f1e381]: Enterprise SSO
                      - paragraph [ref=f1e382]: Security · identity
                      - paragraph [ref=f1e383]: "Source: NONE"
                    - generic [ref=f1e384]: INACTIVE
                    - button "Enable" [ref=f1e387] [cursor=pointer]
                  - generic [ref=f1e390]:
                    - generic [ref=f1e391]:
                      - paragraph [ref=f1e392]: SCIM provisioning
                      - paragraph [ref=f1e393]: Security · scim
                      - paragraph [ref=f1e394]: "Source: NONE"
                    - generic [ref=f1e395]: INACTIVE
                    - button "Enable" [ref=f1e398] [cursor=pointer]
                  - generic [ref=f1e401]:
                    - generic [ref=f1e402]:
                      - paragraph [ref=f1e403]: Data controls
                      - paragraph [ref=f1e404]: Governance · data
                      - paragraph [ref=f1e405]: "Source: NONE"
                    - generic [ref=f1e406]: INACTIVE
                    - button "Enable" [ref=f1e409] [cursor=pointer]
                  - generic [ref=f1e412]:
                    - generic [ref=f1e413]:
                      - paragraph [ref=f1e414]: Pharmacy Core
                      - paragraph [ref=f1e415]: Pharmacy · pharmacy-core
                      - paragraph [ref=f1e416]: "Source: PACKAGE · mandatory"
                    - generic [ref=f1e417]: ACTIVE
                    - paragraph [ref=f1e420]: Always enabled
                  - generic [ref=f1e421]:
                    - generic [ref=f1e422]:
                      - paragraph [ref=f1e423]: Pharmacy Dispensing
                      - paragraph [ref=f1e424]: Pharmacy · pharmacy-dispensing
                      - paragraph [ref=f1e425]: "Source: NONE"
                    - generic [ref=f1e426]: INACTIVE
                    - button "Enable" [ref=f1e429] [cursor=pointer]
                  - generic [ref=f1e432]:
                    - generic [ref=f1e433]:
                      - paragraph [ref=f1e434]: Pharmacy Counter
                      - paragraph [ref=f1e435]: Operations · pharmacy-counter
                      - paragraph [ref=f1e436]: "Source: PACKAGE"
                    - generic [ref=f1e437]: ACTIVE
                    - button "Disable" [ref=f1e440] [cursor=pointer]
                  - generic [ref=f1e443]:
                    - generic [ref=f1e444]:
                      - paragraph [ref=f1e445]: Pharmacy Inventory
                      - paragraph [ref=f1e446]: Inventory · pharmacy-inventory
                      - paragraph [ref=f1e447]: "Source: PACKAGE"
                    - generic [ref=f1e448]: ACTIVE
                    - button "Disable" [ref=f1e451] [cursor=pointer]
                  - generic [ref=f1e454]:
                    - generic [ref=f1e455]:
                      - paragraph [ref=f1e456]: Pharmacy Procurement
                      - paragraph [ref=f1e457]: Procurement · pharmacy-procurement
                      - paragraph [ref=f1e458]: "Source: PACKAGE"
                    - generic [ref=f1e459]: ACTIVE
                    - button "Disable" [ref=f1e462] [cursor=pointer]
                  - generic [ref=f1e465]:
                    - generic [ref=f1e466]:
                      - paragraph [ref=f1e467]: Pharmacy Safety
                      - paragraph [ref=f1e468]: Compliance · pharmacy-safety
                      - paragraph [ref=f1e469]: "Source: NONE"
                    - generic [ref=f1e470]: INACTIVE
                    - button "Enable" [ref=f1e473] [cursor=pointer]
                  - generic [ref=f1e476]:
                    - generic [ref=f1e477]:
                      - paragraph [ref=f1e478]: Pharmacy Finance
                      - paragraph [ref=f1e479]: Finance · pharmacy-finance
                      - paragraph [ref=f1e480]: "Source: PACKAGE"
                    - generic [ref=f1e481]: ACTIVE
                    - button "Disable" [ref=f1e484] [cursor=pointer]
                  - generic [ref=f1e487]:
                    - generic [ref=f1e488]:
                      - paragraph [ref=f1e489]: Pharmacy Reports
                      - paragraph [ref=f1e490]: Reports · pharmacy-reports
                      - paragraph [ref=f1e491]: "Source: PACKAGE"
                    - generic [ref=f1e492]: ACTIVE
                    - button "Disable" [ref=f1e495] [cursor=pointer]
                  - generic [ref=f1e498]:
                    - generic [ref=f1e499]:
                      - paragraph [ref=f1e500]: Pharmacy CRM
                      - paragraph [ref=f1e501]: Customers · pharmacy-crm
                      - paragraph [ref=f1e502]: "Source: NONE"
                    - generic [ref=f1e503]: INACTIVE
                    - button "Enable" [ref=f1e506] [cursor=pointer]
                  - generic [ref=f1e509]:
                    - generic [ref=f1e510]:
                      - paragraph [ref=f1e511]: E2E Activation Gate
                      - paragraph [ref=f1e512]: Delivery · e2e-activation-gate
                      - paragraph [ref=f1e513]: "Source: NONE"
                    - generic [ref=f1e514]: INACTIVE
                    - button "Enable" [ref=f1e517] [cursor=pointer]
              - generic [ref=f1e520]:
                - heading "Limits and usage" [level=2] [ref=f1e522]
                - alert [ref=f1e523]:
                  - paragraph [ref=f1e524]: SOP entitlement configuration
                  - paragraph [ref=f1e525]: "Configuration fault: neither sop.templates.max nor restaurant-core.sop.templates.max is set. Set an explicit non-negative value; zero deliberately disables new templates."
                - generic [ref=f1e526]:
                  - generic [ref=f1e527]:
                    - paragraph [ref=f1e528]: Contract limits
                    - paragraph [ref=f1e530]: No custom limits.
                  - generic [ref=f1e531]:
                    - generic [ref=f1e532]:
                      - generic [ref=f1e533]:
                        - generic [ref=f1e534]: Limit key
                        - textbox "Limit key" [ref=f1e535]:
                          - /placeholder: storage_gb
                      - generic [ref=f1e536]:
                        - generic [ref=f1e537]: Value
                        - spinbutton "Value" [ref=f1e538]
                      - generic [ref=f1e539]:
                        - generic [ref=f1e540]: Period
                        - textbox "Period" [ref=f1e541]:
                          - /placeholder: month
                      - generic [ref=f1e542]:
                        - generic [ref=f1e543]: Source
                        - textbox "Source" [ref=f1e544]: CONTRACT
                    - button "Set limit" [ref=f1e546] [cursor=pointer]
              - generic [ref=f1e551]:
                - generic [ref=f1e552]:
                  - paragraph [ref=f1e553]: Access administration
                  - heading "People and roles" [level=2] [ref=f1e554]
                  - paragraph [ref=f1e555]: Seat state, system role, custom capability bundles, and time-boxed user overrides.
                - group [ref=f1e557]:
                  - generic "Pharmacy Owner pharmacy-owner@e2e.invalid · Organization administrator ADMIN ACTIVE" [ref=f1e558] [cursor=pointer]:
                    - generic [ref=f1e559]:
                      - paragraph [ref=f1e560]: Pharmacy Owner
                      - paragraph [ref=f1e561]: pharmacy-owner@e2e.invalid · Organization administrator
                    - generic [ref=f1e562]: ADMIN
                    - generic [ref=f1e563]: ACTIVE
                  - option "ADMIN" [selected]
                  - option "HR"
                  - option "EMPLOYEE"
                  - option "ACTIVE" [selected]
                  - option "INACTIVE"
                  - option "ON_LEAVE"
                  - option "INVITED"
                  - option "Not set"
                  - option "Organization administrator" [selected]
                  - option "Not set" [selected]
                  - option "LEADERSHIP"
                  - option "ENGINEERING"
                  - option "PRODUCT"
                  - option "QUALITY"
                  - option "MARKETING"
                  - option "DESIGN"
                - generic [ref=f1e565]:
                  - generic [ref=f1e566]:
                    - heading "Custom role" [level=3] [ref=f1e568]
                    - generic [ref=f1e569]:
                      - generic [ref=f1e570]:
                        - generic [ref=f1e571]: Role key
                        - textbox "Role key" [ref=f1e572]:
                          - /placeholder: delivery-lead
                      - generic [ref=f1e573]:
                        - generic [ref=f1e574]: Role name
                        - textbox "Role name" [ref=f1e575]
                      - generic [ref=f1e576]:
                        - generic [ref=f1e577]: Description
                        - textbox "Description" [ref=f1e578]
                      - generic [ref=f1e579]:
                        - generic [ref=f1e580]: Capability rules
                        - textbox "Capability rules" [ref=f1e581]: "[ { \"capability\": \"projects:write\", \"effect\": \"ALLOW\" } ]"
                    - button "Create role" [ref=f1e583] [cursor=pointer]
                  - generic [ref=f1e588]:
                    - heading "User permission override" [level=3] [ref=f1e590]
                    - generic [ref=f1e591]:
                      - generic [ref=f1e592]:
                        - generic [ref=f1e593]: User
                        - combobox "User" [ref=f1e594]:
                          - option "Pharmacy Owner · pharmacy-owner@e2e.invalid" [selected]
                      - generic [ref=f1e595]:
                        - generic [ref=f1e596]: Capability
                        - textbox "Capability" [ref=f1e597]
                      - generic [ref=f1e598]:
                        - generic [ref=f1e599]: Effect
                        - combobox "Effect" [ref=f1e600]:
                          - option "ALLOW" [selected]
                          - option "DENY"
                      - generic [ref=f1e601]:
                        - generic [ref=f1e602]: Expires
                        - textbox "Expires" [ref=f1e603]
                      - generic [ref=f1e604]:
                        - generic [ref=f1e605]: Reason
                        - textbox "Reason" [ref=f1e606]
                    - button "Set override" [ref=f1e608] [cursor=pointer]
                - generic [ref=f1e613]:
                  - paragraph [ref=f1e614]: Role ledger
                  - group [ref=f1e616]:
                    - generic "Organization administrator 1 users ALLOW *" [ref=f1e617] [cursor=pointer]:
                      - generic [ref=f1e618]:
                        - generic [ref=f1e619]: Organization administrator
                        - generic [ref=f1e620]: 1 users
                      - paragraph [ref=f1e621]: ALLOW *
                - generic [ref=f1e622]:
                  - paragraph [ref=f1e623]: User override ledger
                  - paragraph [ref=f1e625]: No user-specific overrides.
              - generic [ref=f1e627]:
                - generic [ref=f1e628]:
                  - heading "Brand and outbound identity" [level=3] [ref=f1e629]
                  - paragraph [ref=f1e630]: Controls workspace colors, logo assets, and support sender presentation.
                - generic [ref=f1e631]:
                  - generic [ref=f1e632]:
                    - generic [ref=f1e633]: Primary color
                    - textbox "Primary color" [ref=f1e634]: "#111110"
                  - generic [ref=f1e635]:
                    - generic [ref=f1e636]: Accent color
                    - textbox "Accent color" [ref=f1e637]: "#ff684f"
                  - generic [ref=f1e638]:
                    - generic [ref=f1e639]: Logo URL
                    - textbox "Logo URL" [ref=f1e640]
                  - generic [ref=f1e641]:
                    - generic [ref=f1e642]: Mark URL
                    - textbox "Mark URL" [ref=f1e643]
                  - generic [ref=f1e644]:
                    - generic [ref=f1e645]: Favicon URL
                    - textbox "Favicon URL" [ref=f1e646]
                  - generic [ref=f1e647]:
                    - generic [ref=f1e648]: Support email
                    - textbox "Support email" [ref=f1e649]
                  - generic [ref=f1e650]:
                    - generic [ref=f1e651]: From name
                    - textbox "From name" [ref=f1e652]
                - button "Save changes" [ref=f1e654] [cursor=pointer]
              - generic [ref=f1e660]:
                - generic [ref=f1e661]:
                  - heading "Organization email delivery" [level=3] [ref=f1e662]
                  - paragraph [ref=f1e663]: Sender identity and provider credentials are organization-scoped. API keys are encrypted before storage and never displayed again.
                - generic [ref=f1e664]:
                  - generic [ref=f1e665]:
                    - generic [ref=f1e666]: Provider
                    - textbox "Provider" [ref=f1e667]: PLATFORM
                  - generic [ref=f1e668]:
                    - generic [ref=f1e669]: From name
                    - textbox "From name" [ref=f1e670]
                  - generic [ref=f1e671]:
                    - generic [ref=f1e672]: From address
                    - textbox "From address" [ref=f1e673]
                  - generic [ref=f1e674]:
                    - generic [ref=f1e675]: Reply-to
                    - textbox "Reply-to" [ref=f1e676]
                  - generic [ref=f1e677]:
                    - generic [ref=f1e678]: Provider API key
                    - textbox "Provider API key Requires PLATFORM_ENCRYPTION_KEY in the runtime." [ref=f1e679]
                    - generic [ref=f1e680]: Requires PLATFORM_ENCRYPTION_KEY in the runtime.
                  - generic [ref=f1e681]:
                    - generic [ref=f1e682]: Provider configuration
                    - textbox "Provider configuration" [ref=f1e683]: "{}"
                  - generic [ref=f1e684]:
                    - generic [ref=f1e685]: Sender domain verified
                    - generic [ref=f1e686]:
                      - checkbox "Sender domain verified Enabled" [ref=f1e687]
                      - text: Enabled
                - button "Save changes" [ref=f1e689] [cursor=pointer]
              - generic [ref=f1e694]:
                - heading "Domains" [level=2] [ref=f1e696]
                - generic [ref=f1e698]:
                  - generic [ref=f1e699]:
                    - generic [ref=f1e700]:
                      - generic [ref=f1e701]: Hostname
                      - textbox "Hostname" [ref=f1e702]:
                        - /placeholder: hub.client.com
                    - generic [ref=f1e703]:
                      - generic [ref=f1e704]: Kind
                      - textbox "Kind" [ref=f1e705]: APP
                    - generic [ref=f1e706]:
                      - generic [ref=f1e707]: Primary domain
                      - generic [ref=f1e708]:
                        - checkbox "Primary domain Enabled" [ref=f1e709]
                        - text: Enabled
                  - button "Add domain" [ref=f1e711] [cursor=pointer]
              - generic [ref=f1e716]:
                - generic [ref=f1e717]:
                  - heading "Identity connections" [level=2] [ref=f1e718]
                  - paragraph [ref=f1e719]: OIDC and SAML enterprise login controls.
                - generic [ref=f1e721]:
                  - generic [ref=f1e722]:
                    - generic [ref=f1e723]:
                      - generic [ref=f1e724]: Connection name
                      - textbox "Connection name" [ref=f1e725]
                    - generic [ref=f1e726]:
                      - generic [ref=f1e727]: Protocol
                      - combobox "Protocol" [ref=f1e728]:
                        - option "OpenID Connect" [selected]
                        - option "SAML 2.0"
                    - generic [ref=f1e729]:
                      - generic [ref=f1e730]: Issuer
                      - textbox "Issuer" [ref=f1e731]
                    - generic [ref=f1e732]:
                      - generic [ref=f1e733]: Client ID
                      - textbox "Client ID" [ref=f1e734]
                    - generic [ref=f1e735]:
                      - generic [ref=f1e736]: Discovery URL
                      - textbox "Discovery URL" [ref=f1e737]
                    - generic [ref=f1e738]:
                      - generic [ref=f1e739]: SSO URL
                      - textbox "SSO URL" [ref=f1e740]
                    - generic [ref=f1e741]:
                      - generic [ref=f1e742]: Entity ID
                      - textbox "Entity ID" [ref=f1e743]
                    - generic [ref=f1e744]:
                      - generic [ref=f1e745]: Client secret
                      - textbox "Client secret" [ref=f1e746]
                    - generic [ref=f1e747]:
                      - generic [ref=f1e748]: IdP certificate
                      - textbox "IdP certificate" [ref=f1e749]
                    - generic [ref=f1e750]:
                      - generic [ref=f1e751]: Domains
                      - textbox "Domains" [ref=f1e752]: "[]"
                    - generic [ref=f1e753]:
                      - generic [ref=f1e754]: Status
                      - combobox "Status" [ref=f1e755]:
                        - option "DRAFT" [selected]
                        - option "ACTIVE"
                        - option "DISABLED"
                        - option "ERROR"
                    - generic [ref=f1e756]:
                      - generic [ref=f1e757]: Role mappings
                      - textbox "Role mappings" [ref=f1e758]: "{}"
                    - generic [ref=f1e759]:
                      - generic [ref=f1e760]: Protocol configuration
                      - textbox "Protocol configuration" [ref=f1e761]: "{ \"roleClaim\": \"groups\" }"
                    - generic [ref=f1e762]:
                      - generic [ref=f1e763]: Allow just-in-time users
                      - generic [ref=f1e764]:
                        - checkbox "Allow just-in-time users Enabled" [checked] [ref=f1e765]
                        - text: Enabled
                    - generic [ref=f1e766]:
                      - generic [ref=f1e767]: Enforce SSO
                      - generic [ref=f1e768]:
                        - checkbox "Enforce SSO Enabled" [ref=f1e769]
                        - text: Enabled
                  - button "Add identity connection" [ref=f1e771] [cursor=pointer]
              - generic [ref=f1e776]:
                - generic [ref=f1e777]:
                  - paragraph [ref=f1e778]: Enterprise provisioning
                  - heading "SCIM 2.0" [level=2] [ref=f1e779]
                  - paragraph [ref=f1e780]: Endpoint /api/scim/v2. Tokens are shown once, stored as hashes, and can be revoked immediately.
                - generic [ref=f1e781]:
                  - generic [ref=f1e782]:
                    - heading "Provisioning token" [level=3] [ref=f1e784]
                    - generic [ref=f1e785]:
                      - generic [ref=f1e786]:
                        - generic [ref=f1e787]: Token name
                        - textbox "Token name" [ref=f1e788]
                      - generic [ref=f1e789]:
                        - generic [ref=f1e790]: Expires
                        - textbox "Expires" [ref=f1e791]
                    - button "Create token" [ref=f1e793] [cursor=pointer]
                  - generic [ref=f1e798]:
                    - paragraph [ref=f1e799]: Active and historical tokens
                    - paragraph [ref=f1e801]: No SCIM tokens issued.
                - generic [ref=f1e802]:
                  - paragraph [ref=f1e803]: Recent provisioning events
                  - generic [ref=f1e804]:
                    - table [ref=f1e805]:
                      - rowgroup [ref=f1e806]:
                        - row [ref=f1e807]:
                          - columnheader "Time" [ref=f1e808]
                          - columnheader "Operation" [ref=f1e809]
                          - columnheader "Resource" [ref=f1e810]
                          - columnheader "External ID" [ref=f1e811]
                          - columnheader "Status" [ref=f1e812]
                      - rowgroup
                    - paragraph [ref=f1e813]: No provisioning activity yet.
              - generic [ref=f1e814]:
                - heading "Deployments" [level=2] [ref=f1e816]
                - generic [ref=f1e818]:
                  - generic [ref=f1e819]:
                    - generic [ref=f1e820]:
                      - paragraph [ref=f1e821]: production
                      - paragraph [ref=f1e822]: SHARED · VERCEL · region pending
                    - generic [ref=f1e823]: PENDING
                  - generic [ref=f1e825]:
                    - generic [ref=f1e826]:
                      - generic [ref=f1e827]:
                        - generic [ref=f1e828]: Status
                        - combobox "Status" [ref=f1e829]:
                          - option "PENDING" [selected]
                          - option "PROVISIONING"
                          - option "READY"
                          - option "DEGRADED"
                          - option "FAILED"
                          - option "DECOMMISSIONED"
                      - generic [ref=f1e830]:
                        - generic [ref=f1e831]: Provider
                        - textbox "Provider" [ref=f1e832]: VERCEL
                      - generic [ref=f1e833]:
                        - generic [ref=f1e834]: Project ID
                        - textbox "Project ID" [ref=f1e835]
                      - generic [ref=f1e836]:
                        - generic [ref=f1e837]: Region
                        - textbox "Region" [ref=f1e838]
                      - generic [ref=f1e839]:
                        - generic [ref=f1e840]: Deployment URL
                        - textbox "Deployment URL" [ref=f1e841]
                      - generic [ref=f1e842]:
                        - generic [ref=f1e843]: Database reference
                        - textbox "Database reference" [ref=f1e844]
                      - generic [ref=f1e845]:
                        - generic [ref=f1e846]: Edge config reference
                        - textbox "Edge config reference" [ref=f1e847]
                      - generic [ref=f1e848]:
                        - generic [ref=f1e849]: Version
                        - textbox "Version" [ref=f1e850]
                    - button "Update deployment" [ref=f1e852] [cursor=pointer]
              - generic [ref=f1e857]:
                - heading "Commercial record" [level=2] [ref=f1e859]
                - generic [ref=f1e860]:
                  - paragraph [ref=f1e862]: Contracts
                  - paragraph [ref=f1e864]: Invoices
              - generic [ref=f1e865]:
                - heading "Lifecycle history" [level=2] [ref=f1e867]
                - generic [ref=f1e869]:
                  - generic [ref=f1e870]: 9/3/2026, 4:23:30 AM
                  - generic [ref=f1e871]:
                    - paragraph [ref=f1e872]: CREATED
                    - paragraph [ref=f1e873]: Organization created by platform operator
                  - generic [ref=f1e874]: ONBOARDING
            - complementary [ref=f1e876]:
              - generic [ref=f1e877]:
                - paragraph [ref=f1e878]: Audited support
                - heading "Enter workspace" [level=2] [ref=f1e879]
                - paragraph [ref=f1e880]: Opens a time-boxed session as the tenant administrator. The reason and every action are recorded.
                - generic [ref=f1e882]:
                  - textbox "Why support access is necessary (recorded in the audit ledger)" [ref=f1e883]
                  - generic [ref=f1e884]:
                    - combobox [ref=f1e885]:
                      - option "15 minutes"
                      - option "30 minutes" [selected]
                      - option "60 minutes"
                    - button "Start audited access" [disabled] [ref=f1e886]
              - generic [ref=f1e891]:
                - paragraph [ref=f1e892]: Tenant administrators
                - generic [ref=f1e894]:
                  - paragraph [ref=f1e895]: Pharmacy Owner
                  - paragraph [ref=f1e896]: pharmacy-owner@e2e.invalid
                  - generic [ref=f1e897]: ACTIVE
              - generic [ref=f1e900]:
                - paragraph [ref=f1e901]: Provisioning identifiers
                - generic [ref=f1e902]:
                  - generic [ref=f1e903]:
                    - term [ref=f1e904]: Organization ID
                    - definition [ref=f1e905]: cmtkq2k8u004jahtwbwpa0d4f
                  - generic [ref=f1e906]:
                    - term [ref=f1e907]: Organization type
                    - definition [ref=f1e908]: Pharmacy immutable
                  - generic [ref=f1e909]:
                    - term [ref=f1e910]: Package
                    - definition [ref=f1e911]: Pharmacy Essentials
                  - generic [ref=f1e912]:
                    - term [ref=f1e913]: Created
                    - definition [ref=f1e914]: 9/3/2026, 4:23:30 AM
  - region "Notifications alt+T":
    - list:
      - listitem [ref=f1e915]:
        - button "Close toast" [ref=f1e916] [cursor=pointer]
        - generic [ref=f1e924]: onboarding record saved
  - alert [ref=f1e926]
```

# Test source

```ts
  117 |   const activation = await transition(
  118 |     page,
  119 |     'ACTIVE',
  120 |     'E2E activation after all pharmacy readiness gates passed'
  121 |   );
  122 |   expect(await activation.json()).toMatchObject({ data: { status: 'ACTIVE' } });
  123 |   await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('ACTIVE');
  124 | 
  125 |   await packageSelectOnProfile(page, pharmacyPackageIds.get('pharmacy-professional')!);
  126 |   // The successful profile command revalidates this server-rendered page. Wait
  127 |   // for a settled detail document before interacting with the independent
  128 |   // lifecycle form, otherwise its first target (GRACE) can replace the chosen
  129 |   // option while the client applies the profile response.
  130 |   await page.reload();
  131 |   expect((await transition(page, 'SUSPENDED', 'E2E pharmacy lifecycle suspension')).status()).toBe(
  132 |     200
  133 |   );
  134 |   await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('SUSPENDED');
  135 |   expect((await transition(page, 'ACTIVE', 'E2E pharmacy lifecycle reactivation')).status()).toBe(
  136 |     200
  137 |   );
  138 |   await expect(page.locator('[data-slot="status-pill"]').first()).toHaveText('ACTIVE');
  139 | 
  140 |   await withAdminDatabase(async (db) => {
  141 |     const organization = await db.query(
  142 |       `SELECT o.status,p.key AS package_key FROM organizations o JOIN platform_packages p ON p.id=o."packageId" WHERE o.id=$1`,
  143 |       [organizationId]
  144 |     );
  145 |     expect(organization.rows).toEqual([{ status: 'ACTIVE', package_key: 'pharmacy-professional' }]);
  146 |     const lifecycle = await db.query(
  147 |       `SELECT action,"fromStatus","toStatus" FROM organization_lifecycle_events WHERE "organizationId"=$1 ORDER BY "createdAt"`,
  148 |       [organizationId]
  149 |     );
  150 |     expect(lifecycle.rows.map((row) => row.action)).toEqual([
  151 |       'CREATED',
  152 |       'ACTIVATED',
  153 |       'SUSPENDED',
  154 |       'RESUMED',
  155 |     ]);
  156 |     const audit = await db.query<{ action: string }>(
  157 |       `SELECT action FROM platform_audit_logs WHERE "organizationId"=$1 AND action IN ('organization.create','organization.update','organization.transition') ORDER BY "createdAt"`,
  158 |       [organizationId]
  159 |     );
  160 |     expect(audit.rows.filter((row) => row.action === 'organization.create')).toHaveLength(1);
  161 |     expect(
  162 |       audit.rows.filter((row) => row.action === 'organization.update').length
  163 |     ).toBeGreaterThanOrEqual(1);
  164 |     expect(audit.rows.filter((row) => row.action === 'organization.transition')).toHaveLength(3);
  165 |   });
  166 | });
  167 | 
  168 | async function transition(page: import('@playwright/test').Page, status: string, reason: string) {
  169 |   const response = page.waitForResponse(
  170 |     (candidate) =>
  171 |       candidate.url().endsWith('/api/platform/control') && candidate.request().method() === 'POST'
  172 |   );
  173 |   await page.getByLabel('Move to').selectOption(status);
  174 |   await page.getByLabel('Operator reason').fill(reason);
  175 |   await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  176 |   return response;
  177 | }
  178 | 
  179 | async function packageSelectOnProfile(page: import('@playwright/test').Page, packageId: string) {
  180 |   const profile = page
  181 |     .locator('form')
  182 |     .filter({ has: page.getByRole('heading', { name: 'Workspace profile' }) });
  183 |   const response = page.waitForResponse(
  184 |     (candidate) =>
  185 |       candidate.url().endsWith('/api/platform/control') && candidate.request().method() === 'POST'
  186 |   );
  187 |   await profile.locator('select[name="packageId"]').selectOption(packageId);
  188 |   await profile.getByRole('button', { name: 'Save changes' }).click();
  189 |   expect((await response).status()).toBe(200);
  190 | }
  191 | 
  192 | async function seedProvisionalProfile(organizationId: string) {
  193 |   await withAdminDatabase(async (db) => {
  194 |     await db.query(
  195 |       `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode",active,"updatedAt") VALUES ('e2e_pharmacy_branch',$1,'MAIN','Main Pharmacy','1 Mall Road','Lahore','PK-PB',true,now())`,
  196 |       [organizationId]
  197 |     );
  198 |     await db.query(
  199 |       `INSERT INTO pharmacy_branch_regulatory_profiles
  200 |        (id,"organizationId","branchId",version,"effectiveFrom","provinceCode","jurisdictionRuleSetId",premises,"licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef","permittedSchedules","qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo","qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy")
  201 |        VALUES ('e2e_pharmacy_profile_provisional',$1,'e2e_pharmacy_branch',1,now()-interval '1 day','PK-PB','pk_pb_provisional_v1','{}','PHARMACY','PB-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://licence',ARRAY['RX'],'QP-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://roster','REGISTERED','{}')`,
  202 |       [organizationId]
  203 |     );
  204 |   });
  205 | }
  206 | 
  207 | async function seedMinimalReadiness(organizationId: string) {
  208 |   await withAdminDatabase(async (db) => {
  209 |     for (const role of PHARMACY_ROLE_TEMPLATES) {
  210 |       await db.query(
  211 |         `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt")
  212 |          VALUES ($1,$2,$3,$4,$5,now())
  213 |          ON CONFLICT ("organizationId",key) DO UPDATE SET name=EXCLUDED.name,"isSystem"=EXCLUDED."isSystem","updatedAt"=now()`,
  214 |         [`e2e_pharmacy_role_${role.key}`, organizationId, role.key, role.name, role.isSystem]
  215 |       );
  216 |     }
> 217 |     await db.query(
      |     ^ error: pharmacy_branch_regulatory_profiles is append-only; create a new effective-dated version
  218 |       `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo"='2026-09-02T01:00:00.000Z' WHERE id='e2e_pharmacy_profile_provisional'`
  219 |     );
  220 |     await db.query(
  221 |       `UPDATE pharmacy_jurisdiction_rule_sets SET "effectiveTo"='2026-09-02T01:00:00.000Z' WHERE id='pk_pb_provisional_v1'`
  222 |     );
  223 |     await db.query(
  224 |       `INSERT INTO pharmacy_jurisdiction_rule_sets
  225 |        (id,code,version,"effectiveFrom","licenceCategories","permittedSchedules","prescriptionOnlyClasses","prescriptionRetentionDays","controlledRegisterFlags","pharmacistCoverageRule","recordRetentionByClass")
  226 |        VALUES ('e2e_pk_pb_confirmed','PK-PB',2,'2026-09-02T01:00:00.000Z','{"provisional":false,"values":["PHARMACY"]}','{"provisional":false,"values":["RX"]}','{"provisional":false,"values":[]}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}','{"provisional":false,"values":{}}')`
  227 |     );
  228 |     await db.query(
  229 |       `INSERT INTO pharmacy_branch_regulatory_profiles
  230 |        (id,"organizationId","branchId",version,"effectiveFrom","provinceCode","jurisdictionRuleSetId",premises,"licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef","permittedSchedules","qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo","qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy")
  231 |        VALUES ('e2e_pharmacy_profile_confirmed',$1,'e2e_pharmacy_branch',2,'2026-09-02T01:00:00.000Z','PK-PB','e2e_pk_pb_confirmed','{}','PHARMACY','PB-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://licence',ARRAY['RX'],'QP-E2E-1',now()-interval '1 day',now()+interval '1 year','evidence://roster','REGISTERED','{}')`,
  232 |       [organizationId]
  233 |     );
  234 |     await db.query(
  235 |       `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES ('e2e_medicine',$1,'E2E Medicine','PHARMACEUTICAL',true,now())`,
  236 |       [organizationId]
  237 |     );
  238 |     await db.query(
  239 |       `INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt") VALUES ('e2e_presentation',$1,'e2e_medicine','10 tablets',now())`,
  240 |       [organizationId]
  241 |     );
  242 |     await db.query(
  243 |       `INSERT INTO pharmacy_pack_levels (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom") VALUES ('e2e_pack',$1,'e2e_presentation','e2e-pack',1,'CARTON',10,now()-interval '1 day')`,
  244 |       [organizationId]
  245 |     );
  246 |     await db.query(
  247 |       `INSERT INTO pharmacy_medicine_provenance (id,"organizationId","medicineId",field,source,"sourceType","retrievedAt",status,"assertedValue") VALUES ('e2e_assertion',$1,'e2e_medicine','productName','E2E','USER',now(),'ACCEPTED','"E2E Medicine"')`,
  248 |       [organizationId]
  249 |     );
  250 |     await db.query(
  251 |       `INSERT INTO pharmacy_medicine_publication_batches (id,"organizationId",status,"publishedBy","publishedAt") VALUES ('e2e_publication',$1,'PUBLISHED','e2e_platform_admin',now())`,
  252 |       [organizationId]
  253 |     );
  254 |     await db.query(
  255 |       `INSERT INTO pharmacy_medicine_publication_entries (id,"organizationId","batchId","assertionId") VALUES ('e2e_publication_entry',$1,'e2e_publication','e2e_assertion')`,
  256 |       [organizationId]
  257 |     );
  258 |     await db.query(
  259 |       `INSERT INTO pharmacy_manufacturing_batches (id,"organizationId","medicineId","batchNumber","expiresAt","updatedAt") VALUES ('e2e_batch',$1,'e2e_medicine','BATCH-1',now()+interval '1 year',now())`,
  260 |       [organizationId]
  261 |     );
  262 |     await db.query(
  263 |       `INSERT INTO pharmacy_inventory_lots (id,"organizationId","branchId","manufacturingBatchId","packLevelId","unitsPerPack","supplierName","supplierInvoiceRef","unitCostMinor","printedMrpMinor","receivedExpiresAt","receivedExpiryPrecision","receivedAt","updatedAt") VALUES ('e2e_lot',$1,'e2e_pharmacy_branch','e2e_batch','e2e_pack',10,'E2E Supplier','INV-1',100,150,now()+interval '1 year','DAY',now(),now())`,
  264 |       [organizationId]
  265 |     );
  266 |     await db.query(
  267 |       `INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,active,"updatedAt") VALUES ('e2e_supplier',$1,'E2E Authorized Supplier',true,true,now())`,
  268 |       [organizationId]
  269 |     );
  270 |     await db.query(
  271 |       `INSERT INTO pharmacy_onboarding_states (id,"organizationId","updatedAt") VALUES ('e2e_onboarding',$1,now())`,
  272 |       [organizationId]
  273 |     );
  274 |     await db.query(
  275 |       `INSERT INTO pharmacy_onboarding_gate_states (id,"organizationId",gate,status,"evidenceRef","branchId","actorId","recordedAt","updatedAt")
  276 |        SELECT 'e2e_gate_'||gate,$1,gate::"PharmacyOnboardingGate",'PASSED','evidence://'||gate,CASE WHEN gate IN ('PREMISES_AND_LICENCES','BRANCHES_AND_LOCATIONS') THEN 'e2e_pharmacy_branch' END,'e2e_platform_admin',now(),now()
  277 |        FROM unnest(enum_range(NULL::"PharmacyOnboardingGate")::text[]) gate`,
  278 |       [organizationId]
  279 |     );
  280 |   });
  281 | }
  282 | 
```