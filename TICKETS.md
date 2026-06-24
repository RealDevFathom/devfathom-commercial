# TICKETS.md — QA defect ticketing reconciliation

Every finding in [`/BUGS.md`](./BUGS.md) (53) filed in **two trackers** with identical content:
- **(A) GitHub Issues** — repo `WhatTheStack1/DevFathom-Hub`, milestone "QA Remediation", labelled `severity:* · type:* · module:* · bug · qa`.
- **(B) Internal DevFathom-Hub app** — Project **"QA Remediation — June 2026"** (INTERNAL) › Board **"QA Findings"** › list **"To Do"** (one Task per bug).

Each pair reconciles 1:1 on the shared **BUG-ID**. The internal task carries its GitHub #/URL; the GitHub issue carries the internal task id — both in their **References** section.

## Totals
- **GitHub:** 53 created · 0 skipped-existing · 0 failed (of 53)
- **Internal:** 53 created · 0 skipped-existing · 0 failed (of 53)
- **Cross-links applied:** 53 (failed 0)
- **Severity → priority (internal):** HIGH→URGENT · MEDIUM→MEDIUM · LOW→LOW
- **Severity → label (GitHub):** HIGH→`severity:high` · MEDIUM→`severity:medium` · LOW→`severity:low`

## Failures
None — all 53 filed on both sides.

## Mapping

| BUG-ID | Sev | Priority | Module | Type | GitHub | GH status | Internal task id | Int status |
|---|---|---|---|---|---|---|---|---|
| FIN-01 | HIGH | URGENT | Finance | Data | [#3](https://github.com/WhatTheStack1/DevFathom-Hub/issues/3) | Created | `cmqq9dzr5000u63twjqd2r921` | Created |
| FIN-02 | HIGH | URGENT | Finance/Dashboard | Data | [#4](https://github.com/WhatTheStack1/DevFathom-Hub/issues/4) | Created | `cmqq9e0s1000y63twvxdef3vq` | Created |
| PROJ-01 | HIGH | URGENT | Projects/Kanban | Functional/Data | [#5](https://github.com/WhatTheStack1/DevFathom-Hub/issues/5) | Created | `cmqq9e1qr001263twd7si3ypn` | Created |
| REST-01 | MEDIUM | MEDIUM | REST/Finance | Security | [#6](https://github.com/WhatTheStack1/DevFathom-Hub/issues/6) | Created | `cmqq9e2lx001663twr51sv726` | Created |
| FIN-03 | MEDIUM | MEDIUM | Dashboard | Functional/Data | [#7](https://github.com/WhatTheStack1/DevFathom-Hub/issues/7) | Created | `cmqq9e3ha001a63twfi5ps4w8` | Created |
| FIN-04 | MEDIUM | MEDIUM | Finance/Dashboard | Data | [#8](https://github.com/WhatTheStack1/DevFathom-Hub/issues/8) | Created | `cmqq9e4bu001e63tw3yt8qlwe` | Created |
| FIN-05 | MEDIUM | MEDIUM | Finance | Functional | [#9](https://github.com/WhatTheStack1/DevFathom-Hub/issues/9) | Created | `cmqq9e596001i63twsimzcvd3` | Created |
| FIN-06 | MEDIUM | MEDIUM | Finance | Data/Functional | [#10](https://github.com/WhatTheStack1/DevFathom-Hub/issues/10) | Created | `cmqq9e6b7001m63tw528qsrmg` | Created |
| FIN-07 | MEDIUM | MEDIUM | REST/Finance | Security/Data | [#11](https://github.com/WhatTheStack1/DevFathom-Hub/issues/11) | Created | `cmqq9e78a001q63tw8qbvewm1` | Created |
| DASH-01 | MEDIUM | MEDIUM | Dashboard/Notes | Security | [#12](https://github.com/WhatTheStack1/DevFathom-Hub/issues/12) | Created | `cmqq9e83o001u63twgbzv4dw2` | Created |
| HR-01 | MEDIUM | MEDIUM | Team/HR | Security | [#13](https://github.com/WhatTheStack1/DevFathom-Hub/issues/13) | Created | `cmqq9e93i001y63tw1r9nlc6n` | Created |
| NOTE-01 | MEDIUM | MEDIUM | Notes | Security | [#14](https://github.com/WhatTheStack1/DevFathom-Hub/issues/14) | Created | `cmqq9e9yw002263twkhi44f1i` | Created |
| RT-01 | MEDIUM | MEDIUM | Meetings | Data | [#15](https://github.com/WhatTheStack1/DevFathom-Hub/issues/15) | Created | `cmqq9eazu002663twrh9hbpc6` | Created |
| RT-02 | MEDIUM | MEDIUM | Realtime/Chat | Security | [#16](https://github.com/WhatTheStack1/DevFathom-Hub/issues/16) | Created | `cmqq9ebue002a63tw67wm5z7z` | Created |
| RT-03 | MEDIUM | MEDIUM | Meetings | Functional/Data | [#17](https://github.com/WhatTheStack1/DevFathom-Hub/issues/17) | Created | `cmqq9ecst002e63tw6viyno42` | Created |
| RT-04 | MEDIUM | MEDIUM | Chat | Functional | [#18](https://github.com/WhatTheStack1/DevFathom-Hub/issues/18) | Created | `cmqq9edp4002i63twarxbi2ht` | Created |
| RT-05 | MEDIUM | MEDIUM | Upload | Security | [#19](https://github.com/WhatTheStack1/DevFathom-Hub/issues/19) | Created | `cmqq9eeme002m63twtadeecs1` | Created |
| REST-04 | MEDIUM | MEDIUM | Platform | Security | [#20](https://github.com/WhatTheStack1/DevFathom-Hub/issues/20) | Created | `cmqq9efh8002q63tweh9qwta2` | Created |
| PROJ-02 | MEDIUM | MEDIUM | Projects/Trello | Data | [#21](https://github.com/WhatTheStack1/DevFathom-Hub/issues/21) | Created | `cmqq9egea002u63tw9fi53vml` | Created |
| PROJ-03 | MEDIUM | MEDIUM | Projects/Kanban | Data loss / UX | [#22](https://github.com/WhatTheStack1/DevFathom-Hub/issues/22) | Created | `cmqq9eh8u002y63twqxv3c6t5` | Created |
| PROJ-04 | MEDIUM | MEDIUM | Projects/Kanban | Functional | [#23](https://github.com/WhatTheStack1/DevFathom-Hub/issues/23) | Created | `cmqq9ei9h003263twu948r8g1` | Created |
| PROJ-05 | MEDIUM | MEDIUM | Projects/Kanban | Data/Authz | [#24](https://github.com/WhatTheStack1/DevFathom-Hub/issues/24) | Created | `cmqq9ej42003663tw9wap25ss` | Created |
| CLI-01 | MEDIUM | MEDIUM | Clients | Error handling / UX | [#25](https://github.com/WhatTheStack1/DevFathom-Hub/issues/25) | Created | `cmqq9ek0a003a63twm9u2o5q1` | Created |
| AI-01 | MEDIUM | MEDIUM | AI Assistant | Functional / Availability | [#26](https://github.com/WhatTheStack1/DevFathom-Hub/issues/26) | Created | `cmqq9el0d003e63twwwf9ujon` | Created |
| AUTH-01 | MEDIUM | MEDIUM | Auth/Settings | Security | [#27](https://github.com/WhatTheStack1/DevFathom-Hub/issues/27) | Created | `cmqq9em4n003i63twz93am8rs` | Created |
| REST-02 | LOW | LOW | REST | Security | [#28](https://github.com/WhatTheStack1/DevFathom-Hub/issues/28) | Created | `cmqq9emz9003m63twdln5rsaq` | Created |
| REST-05 | LOW | LOW | REST | Functional | [#29](https://github.com/WhatTheStack1/DevFathom-Hub/issues/29) | Created | `cmqq9enxp003q63twkvwiizjw` | Created |
| REST-06 | LOW | LOW | REST | Functional | [#30](https://github.com/WhatTheStack1/DevFathom-Hub/issues/30) | Created | `cmqq9eowx003u63twznl6dq8d` | Created |
| REST-07 | LOW | LOW | REST | Validation | [#31](https://github.com/WhatTheStack1/DevFathom-Hub/issues/31) | Created | `cmqq9epws003y63twtw91ikvf` | Created |
| FIN-08 | LOW | LOW | Finance | Data | [#32](https://github.com/WhatTheStack1/DevFathom-Hub/issues/32) | Created | `cmqq9eqvs004263twfp3ogj49` | Created |
| FIN-09 | LOW | LOW | Finance | Data | [#33](https://github.com/WhatTheStack1/DevFathom-Hub/issues/33) | Created | `cmqq9erqb004663twnh2q5cz4` | Created |
| AUTHZ-02 | LOW | LOW | Team | Security / Availability | [#34](https://github.com/WhatTheStack1/DevFathom-Hub/issues/34) | Created | `cmqq9eskx004a63twqvsvhlch` | Created |
| AUTHZ-04 | LOW | LOW | Clients | Security (info) | [#35](https://github.com/WhatTheStack1/DevFathom-Hub/issues/35) | Created | `cmqq9etfq004e63twx0mwcxp3` | Created |
| RT-06 | LOW | LOW | Meetings | Data | [#36](https://github.com/WhatTheStack1/DevFathom-Hub/issues/36) | Created | `cmqq9euaa004i63tw3zs4k7kx` | Created |
| RT-08 | LOW | LOW | Realtime | Functional | [#37](https://github.com/WhatTheStack1/DevFathom-Hub/issues/37) | Created | `cmqq9ev7w004m63twkg1i9paj` | Created |
| RT-09 | LOW | LOW | Chat | Privacy | [#38](https://github.com/WhatTheStack1/DevFathom-Hub/issues/38) | Created | `cmqq9ew2g004q63twdff8dj4r` | Created |
| RT-10 | LOW | LOW | Meetings | Functional | [#39](https://github.com/WhatTheStack1/DevFathom-Hub/issues/39) | Created | `cmqq9ewyo004u63tw65d0sqjn` | Created |
| PROJ-06 | LOW | LOW | Projects | Data | [#40](https://github.com/WhatTheStack1/DevFathom-Hub/issues/40) | Created | `cmqq9exx5004y63twkquvq4uj` | Created |
| PROJ-07 | LOW | LOW | Projects | Business logic | [#41](https://github.com/WhatTheStack1/DevFathom-Hub/issues/41) | Created | `cmqq9eyro005263twz5qzn38u` | Created |
| CON-01 | LOW | LOW | Contracts | Validation | [#42](https://github.com/WhatTheStack1/DevFathom-Hub/issues/42) | Created | `cmqq9ezmi005663twz930oh79` | Created |
| CON-02 | LOW | LOW | Contracts | Logic | [#43](https://github.com/WhatTheStack1/DevFathom-Hub/issues/43) | Created | `cmqq9f0h2005a63tw3emgn0mt` | Created |
| TRELLO-01 | LOW | LOW | Trello import | Robustness | [#44](https://github.com/WhatTheStack1/DevFathom-Hub/issues/44) | Created | `cmqq9f1bw005e63twkrmjc7n7` | Created |
| CLI-02 | LOW | LOW | Clients/Contacts | Validation / UI | [#45](https://github.com/WhatTheStack1/DevFathom-Hub/issues/45) | Created | `cmqq9f26s005i63twtehcdqsu` | Created |
| UX-01 | LOW | LOW | Clients | UX | [#46](https://github.com/WhatTheStack1/DevFathom-Hub/issues/46) | Created | `cmqq9f342005m63twosyv0p1o` | Created |
| HR-02 | LOW | LOW | Team/HR | Validation | [#47](https://github.com/WhatTheStack1/DevFathom-Hub/issues/47) | Created | `cmqq9f3ym005q63twyistt7rb` | Created |
| DASH-02 | LOW | LOW | Dashboard | Info exposure | [#48](https://github.com/WhatTheStack1/DevFathom-Hub/issues/48) | Created | `cmqq9f4x1005u63twr6tx5nqp` | Created |
| AUTH-02 | LOW | LOW | Auth | Security (DiD) | [#49](https://github.com/WhatTheStack1/DevFathom-Hub/issues/49) | Created | `cmqq9f612005y63twul06q3se` | Created |
| SEC-01 | LOW | LOW | Platform/Config | Security | [#50](https://github.com/WhatTheStack1/DevFathom-Hub/issues/50) | Created | `cmqq9f6z8006263twho7w3w6h` | Created |
| SEC-02 | LOW | LOW | Platform/Config | Security | [#51](https://github.com/WhatTheStack1/DevFathom-Hub/issues/51) | Created | `cmqq9f7wk006663twxcve6z6e` | Created |
| SEC-03 | LOW | LOW | Auth/UX | UX / Correctness | [#52](https://github.com/WhatTheStack1/DevFathom-Hub/issues/52) | Created | `cmqq9f8si006a63twyyq7lxnz` | Created |
| AI-02 | LOW | LOW | AI Assistant | Security (test) | [#53](https://github.com/WhatTheStack1/DevFathom-Hub/issues/53) | Created | `cmqq9f9rh006e63twrqps7gjp` | Created |
| AI-03 | LOW | LOW | AI Assistant | Data | [#54](https://github.com/WhatTheStack1/DevFathom-Hub/issues/54) | Created | `cmqq9fb26006i63twqtvwkr6t` | Created |
| AI-04 | LOW | LOW | AI Assistant | Security (info) | [#55](https://github.com/WhatTheStack1/DevFathom-Hub/issues/55) | Created | `cmqq9fbye006m63twzicx2oz8` | Created |

## Reversibility & re-running
- **Remove the internal import in one action:** delete Project **"QA Remediation — June 2026"** (`prisma project.delete`); cascades remove its board, columns, labels, and all 53 tasks. No pre-existing rows were touched.
- **GitHub:** close/delete the issues in milestone "QA Remediation" (e.g. `gh issue list --repo WhatTheStack1/DevFathom-Hub --milestone "QA Remediation"`).
- **Idempotent:** re-running `bun scripts/create-github-issues.ts` and `bun scripts/import-qa-tickets.ts` creates zero duplicates (matched by `(BUG-ID)` in the title) and refreshes content in place.

_Source of truth: `/BUGS.md`. Scripts: `scripts/qa-tickets.json` (data) · `scripts/qa-lib.ts` (render) · `scripts/create-github-issues.ts` · `scripts/import-qa-tickets.ts` · `scripts/finalize-tickets.ts`._
