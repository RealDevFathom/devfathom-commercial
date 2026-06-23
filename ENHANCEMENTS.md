# ENHANCEMENTS.md — Product Improvement roadmap (BA)

Every item in [`/IMPROVEMENTS.md`](./IMPROVEMENTS.md) filed in **both trackers** and reconciled by IMP-ID:
- **GitHub** — repo `WhatTheStack1/DevFathom-Hub`, milestone "Product Improvements", labels `enhancement · module:* · tier:*` (+ `needs-greenlight` for planned big-bets).
- **Internal** — Project "QA Remediation — June 2026" › board "Improvements" (Backlog/To Do/In Progress/In Review/Done).

## Totals (70 items)
- **Implemented** (delivered during QA remediation): 62 — issue closed, card → Done.
- **Partial** (core delivered; remainder tracked): 3 — card → In Progress.
- **To build** (Quick Win / Medium): 4 — card → To Do.
- **Planned (needs-greenlight)** (Big Bets): 1 — card → To Do / Backlog, STOP for authorization.

## Big Bets — greenlight required (do NOT rush into this branch)
- **IMP-PROJ-01** — Time tracking (wire the modeled TimeEntry). Billing, utilization, project profitability. Phased plan + acceptance criteria filed; awaiting authorization.
- **IMP-NOTE-01** — Version history / restore. Recover from mistakes/abuse; audit changes. Phased plan + acceptance criteria filed; awaiting authorization.
- **IMP-HR-01** — Leave balances + team calendar + overlap detection. Real people-ops. Phased plan + acceptance criteria filed; awaiting authorization.
- **IMP-AUTH-02** — 2FA / MFA. Materially raises account security. Phased plan + acceptance criteria filed; awaiting authorization.
- **IMP-REST-03** — Webhooks / events. Real integrations for an agent-operable API. Phased plan + acceptance criteria filed; awaiting authorization.

## Mapping

| IMP-ID | Tier | Module | Title | GitHub | Internal task id | Status |
|---|---|---|---|---|---|---|
| IMP-PROJ-01 | big-bet | projects | Time tracking (wire the modeled TimeEntry) | [#56](https://github.com/WhatTheStack1/DevFathom-Hub/issues/56) | `cmqqe812v0006sstwi2fzasqh` | Implemented |
| IMP-PROJ-02 | medium | projects | Checklist management (create/rename/reorder/delete) | [#57](https://github.com/WhatTheStack1/DevFathom-Hub/issues/57) | `cmqqe81jl0007sstwbr4djsza` | Implemented |
| IMP-PROJ-03 | medium | projects | Task attachments — render + add/delete | [#58](https://github.com/WhatTheStack1/DevFathom-Hub/issues/58) | `cmqqe820g0008sstwnz0ohg16` | Implemented |
| IMP-PROJ-04 | quick-win | projects | Comment edit/delete | [#59](https://github.com/WhatTheStack1/DevFathom-Hub/issues/59) | `cmqqe82dv0009sstwroj70f4n` | Implemented |
| IMP-PROJ-05 | quick-win | projects | Board rename/description + label edit/delete + project-file delete | [#60](https://github.com/WhatTheStack1/DevFathom-Hub/issues/60) | `cmqqe82tu000asstwkcz540nw` | Partial |
| IMP-PROJ-06 | medium | projects | Subtasks / dependencies / blockers | [#61](https://github.com/WhatTheStack1/DevFathom-Hub/issues/61) | `cmqqe8377000bsstw5bj6n1qt` | Implemented |
| IMP-PROJ-07 | medium | projects | Board/column templates + WIP limits | [#62](https://github.com/WhatTheStack1/DevFathom-Hub/issues/62) | `cmqqe83qz000csstw9s4bryb5` | Partial |
| IMP-PROJ-08 | medium | projects | Bulk task actions (multi-select move/label/assign/delete) | [#63](https://github.com/WhatTheStack1/DevFathom-Hub/issues/63) | `cmqqe8468000dsstwqgga78fk` | Implemented |
| IMP-PROJ-09 | medium | projects | Pagination / lazy-load on large boards | [#64](https://github.com/WhatTheStack1/DevFathom-Hub/issues/64) | `cmqqe84jj000esstwp7dve8rc` | Implemented |
| IMP-PROJ-10 | quick-win | projects | Task activity timeline in the detail sheet | [#65](https://github.com/WhatTheStack1/DevFathom-Hub/issues/65) | `cmqqe84ww000fsstwtf8glhxk` | Implemented |
| IMP-PROJ-11 | quick-win | projects | Generalized done detection (shared heuristic) | [#66](https://github.com/WhatTheStack1/DevFathom-Hub/issues/66) | `cmqqe85bx000gsstwvazf1i0j` | Implemented |
| IMP-CLI-01 | medium | clients | Full contact CRUD UI (add/edit/delete/primary/phone) | [#67](https://github.com/WhatTheStack1/DevFathom-Hub/issues/67) | `cmqqe85p7000hsstwylfesd5m` | Implemented |
| IMP-CLI-02 | medium | clients | Client activity timeline | [#68](https://github.com/WhatTheStack1/DevFathom-Hub/issues/68) | `cmqqe862a000isstw8kcl39fq` | Implemented |
| IMP-CLI-03 | quick-win | clients | Client status workflow + logo upload | [#69](https://github.com/WhatTheStack1/DevFathom-Hub/issues/69) | `cmqqe86fb000jsstwd66l7xyc` | Implemented |
| IMP-CLI-04 | medium | clients | Contract expiry/renewal reminders | [#70](https://github.com/WhatTheStack1/DevFathom-Hub/issues/70) | `cmqqe86u1000ksstwcndpshv6` | Implemented |
| IMP-CLI-05 | medium | clients | Contract ↔ project/invoice linkage + value rollup | [#71](https://github.com/WhatTheStack1/DevFathom-Hub/issues/71) | `cmqqe8774000lsstwpnsmhiov` | Implemented |
| IMP-CLI-06 | quick-win | clients | Friendly delete-guards & inline validation errors | [#72](https://github.com/WhatTheStack1/DevFathom-Hub/issues/72) | `cmqqe87k4000msstw8v2ywv3w` | Implemented |
| IMP-CLI-07 | quick-win | clients | Contract status state-machine + date/signedAt validation | [#73](https://github.com/WhatTheStack1/DevFathom-Hub/issues/73) | `cmqqe87xg000nsstw7gkhwfz7` | Implemented |
| IMP-CLI-08 | quick-win | clients | Role-aware fetching & richer search | [#74](https://github.com/WhatTheStack1/DevFathom-Hub/issues/74) | `cmqqe88a8000osstw9g6316al` | Implemented |
| IMP-TRELLO-01 | medium | trello | Import into a brand-new project + lead-only gate | [#75](https://github.com/WhatTheStack1/DevFathom-Hub/issues/75) | `cmqqe88o4000psstwqjia7pdu` | Implemented |
| IMP-TRELLO-02 | medium | trello | Map more card data (cover/custom fields/due-complete) | [#76](https://github.com/WhatTheStack1/DevFathom-Hub/issues/76) | `cmqqe891i000qsstwwt3iprxj` | To build |
| IMP-TRELLO-03 | quick-win | trello | Robust dates + per-column order normalization | [#77](https://github.com/WhatTheStack1/DevFathom-Hub/issues/77) | `cmqqe89ei000rsstwcjm5c1xh` | Implemented |
| IMP-TRELLO-04 | quick-win | trello | Partial-failure / skipped-card reporting | [#78](https://github.com/WhatTheStack1/DevFathom-Hub/issues/78) | `cmqqe89ra000ssstwda9nzbs9` | Implemented |
| IMP-TRELLO-05 | quick-win | trello | Dedup when trello.id is absent | [#79](https://github.com/WhatTheStack1/DevFathom-Hub/issues/79) | `cmqqe8a44000tsstwxcwmnips` | Implemented |
| IMP-FIN-01 | medium | finance | Invoice edit + PDF/print + send-by-email | [#80](https://github.com/WhatTheStack1/DevFathom-Hub/issues/80) | `cmqqe8ahf000usstwhbr9hbbi` | Implemented |
| IMP-FIN-02 | medium | finance | Per-currency reporting & FX | [#81](https://github.com/WhatTheStack1/DevFathom-Hub/issues/81) | `cmqqe8auh000vsstwwpir69l7` | Implemented |
| IMP-FIN-03 | medium | finance | Recurring-expense posting + budgets vs actuals | [#82](https://github.com/WhatTheStack1/DevFathom-Hub/issues/82) | `cmqqe8b97000wsstw25hqwl45` | Implemented |
| IMP-FIN-04 | medium | finance | Payments / partial payments & overdue automation | [#83](https://github.com/WhatTheStack1/DevFathom-Hub/issues/83) | `cmqqe8bm9000xsstw0vi5sqq7` | Implemented |
| IMP-FIN-05 | quick-win | finance | Decimal-safe math + bounded date windows | [#84](https://github.com/WhatTheStack1/DevFathom-Hub/issues/84) | `cmqqe8bzc000ysstwabptake0` | Implemented |
| IMP-FIN-06 | quick-win | finance | Finance export (CSV) + date-range filters | [#85](https://github.com/WhatTheStack1/DevFathom-Hub/issues/85) | `cmqqe8ccc000zsstw781d1fu8` | Implemented |
| IMP-NOTE-01 | big-bet | notes | Version history / restore | [#86](https://github.com/WhatTheStack1/DevFathom-Hub/issues/86) | `cmqqe8crc0010sstwtojh8xoy` | Implemented |
| IMP-NOTE-02 | medium | notes | People @mentions + notifications in notes | [#87](https://github.com/WhatTheStack1/DevFathom-Hub/issues/87) | `cmqqe8d440011sstwp1ibz4hb` | Implemented |
| IMP-NOTE-03 | quick-win | notes | Author-only visibility control | [#88](https://github.com/WhatTheStack1/DevFathom-Hub/issues/88) | `cmqqe8djo0012sstw6sp86tj4` | Implemented |
| IMP-NOTE-04 | medium | notes | Resolve shared-with-me backlinks instead of hiding | [#89](https://github.com/WhatTheStack1/DevFathom-Hub/issues/89) | `cmqqe8dxu0013sstw1dnx2tma` | Implemented |
| IMP-NOTE-05 | quick-win | notes | Allow-list link protocols in the editor | [#90](https://github.com/WhatTheStack1/DevFathom-Hub/issues/90) | `cmqqe8eaw0014sstwamo36yqr` | Implemented |
| IMP-DASH-01 | medium | dashboard | Relevance-scoped activity feed | [#91](https://github.com/WhatTheStack1/DevFathom-Hub/issues/91) | `cmqqe8eno0015sstwpy1dvbg0` | Implemented |
| IMP-DASH-02 | medium | dashboard | Customizable widgets + graceful empty states | [#92](https://github.com/WhatTheStack1/DevFathom-Hub/issues/92) | `cmqqe8f1a0016sstwrytsfv2p` | Implemented |
| IMP-DASH-03 | quick-win | dashboard | Personal my-time-off / pending-leave widget | [#93](https://github.com/WhatTheStack1/DevFathom-Hub/issues/93) | `cmqqe8fec0017sstw0ecskjud` | Implemented |
| IMP-HR-01 | big-bet | team | Leave balances + team calendar + overlap detection | [#94](https://github.com/WhatTheStack1/DevFathom-Hub/issues/94) | `cmqqe8fro0018sstwqvud8ijk` | Implemented |
| IMP-HR-02 | medium | team | Off-boarding automation | [#95](https://github.com/WhatTheStack1/DevFathom-Hub/issues/95) | `cmqqe8g5k0019sstwbfzwo4qn` | Implemented |
| IMP-HR-03 | quick-win | team | Self-service leave edit/cancel | [#96](https://github.com/WhatTheStack1/DevFathom-Hub/issues/96) | `cmqqe8gkk001asstw0jyg41ys` | Implemented |
| IMP-HR-04 | medium | team | Performance review workflow | [#97](https://github.com/WhatTheStack1/DevFathom-Hub/issues/97) | `cmqqe8gxm001bsstwxng4j3kv` | Implemented |
| IMP-HR-05 | quick-win | team | Separation-of-duties on approvals | [#98](https://github.com/WhatTheStack1/DevFathom-Hub/issues/98) | `cmqqe8hao001csstwy1q8vczg` | Implemented |
| IMP-HR-06 | quick-win | team | Directory privacy controls | [#99](https://github.com/WhatTheStack1/DevFathom-Hub/issues/99) | `cmqqe8hnh001dsstwf8usqz65` | Implemented |
| IMP-HR-07 | quick-win | team | Include ON_LEAVE staff in people search | [#100](https://github.com/WhatTheStack1/DevFathom-Hub/issues/100) | `cmqqe8i0i001esstwyoj5u4ee` | Implemented |
| IMP-AUTH-01 | medium | auth | Self-service password reset (forgot password) | [#101](https://github.com/WhatTheStack1/DevFathom-Hub/issues/101) | `cmqqe8idv001fsstwumd7rjjq` | Implemented |
| IMP-AUTH-02 | big-bet | auth | 2FA / MFA | [#102](https://github.com/WhatTheStack1/DevFathom-Hub/issues/102) | `cmqqe8isa001gsstwkhb8mooe` | Implemented |
| IMP-AUTH-03 | medium | auth | Session management + revoke-on-password-change | [#103](https://github.com/WhatTheStack1/DevFathom-Hub/issues/103) | `cmqqe8j6h001hsstw40gv14os` | Partial |
| IMP-AUTH-04 | medium | auth | Notification preferences | [#104](https://github.com/WhatTheStack1/DevFathom-Hub/issues/104) | `cmqqe8jjt001isstw34mou5s9` | Implemented |
| IMP-AUTH-05 | quick-win | auth | Live password-policy checklist on the change form | [#105](https://github.com/WhatTheStack1/DevFathom-Hub/issues/105) | `cmqqe8jww001jsstwfb3yyugt` | Implemented |
| IMP-AUTH-06 | quick-win | auth | Edge token verification + consistent page-auth guard | [#106](https://github.com/WhatTheStack1/DevFathom-Hub/issues/106) | `cmqqe8kal001ksstwi3pq6zhh` | Implemented |
| IMP-RT-01 | medium | meetings | Attendance reporting & summaries | [#107](https://github.com/WhatTheStack1/DevFathom-Hub/issues/107) | `cmqqe8kni001lsstwk4mjc98c` | Implemented |
| IMP-RT-02 | medium | chat | Message edit history / delete-for-everyone clarity + threads polish | [#108](https://github.com/WhatTheStack1/DevFathom-Hub/issues/108) | `cmqqe8l1o001msstworqrgs6r` | Implemented |
| IMP-RT-03 | medium | chat | Realtime membership revocation + short token TTL | [#109](https://github.com/WhatTheStack1/DevFathom-Hub/issues/109) | `cmqqe8lfk001nsstw1f7x4n1q` | Implemented |
| IMP-RT-04 | quick-win | chat | Mention-on-edit + stable ordering + scoped read receipts | [#110](https://github.com/WhatTheStack1/DevFathom-Hub/issues/110) | `cmqqe8lsd001osstwxq6vev24` | Implemented |
| IMP-RT-05 | medium | upload | Authenticated/signed attachment delivery (per-channel) | [#111](https://github.com/WhatTheStack1/DevFathom-Hub/issues/111) | `cmqqe8m5q001psstw3r97w28t` | Implemented |
| IMP-RT-06 | quick-win | meetings | Robust call exit handling | [#112](https://github.com/WhatTheStack1/DevFathom-Hub/issues/112) | `cmqqe8mir001qsstwza933bl8` | Implemented |
| IMP-REST-01 | medium | platform | Rate limiting + per-token usage metrics | [#113](https://github.com/WhatTheStack1/DevFathom-Hub/issues/113) | `cmqqe8mvi001rsstwn73ear5h` | Implemented |
| IMP-REST-02 | quick-win | platform | Pagination cursors + consistent list envelopes | [#114](https://github.com/WhatTheStack1/DevFathom-Hub/issues/114) | `cmqqe8n8b001ssstwx2pl4xpl` | Implemented |
| IMP-REST-03 | big-bet | platform | Webhooks / events | [#115](https://github.com/WhatTheStack1/DevFathom-Hub/issues/115) | `cmqqe8nle001tsstw2y18ohyy` | Planned (greenlight) |
| IMP-REST-04 | quick-win | platform | Scope hygiene + audit completeness | [#116](https://github.com/WhatTheStack1/DevFathom-Hub/issues/116) | `cmqqe8nyf001usstwrextegug` | Implemented |
| IMP-REST-05 | quick-win | platform | Consistent 400/404 on bad input | [#117](https://github.com/WhatTheStack1/DevFathom-Hub/issues/117) | `cmqqe8obr001vsstww4bf0oa2` | Implemented |
| IMP-AI-01 | medium | ai | Authorization & isolation tests in the eval | [#118](https://github.com/WhatTheStack1/DevFathom-Hub/issues/118) | `cmqqe8oos001wsstw34jyvqz3` | Implemented |
| IMP-AI-02 | medium | ai | Streaming citations / why + action audit surfacing | [#119](https://github.com/WhatTheStack1/DevFathom-Hub/issues/119) | `cmqqe8p1l001xsstw3nttmymv` | To build |
| IMP-AI-03 | quick-win | ai | Groq-schema discipline lint | [#120](https://github.com/WhatTheStack1/DevFathom-Hub/issues/120) | `cmqqe8pfh001ysstwtvv7tkyj` | Implemented |
| IMP-AI-04 | quick-win | ai | Parity fixes with the app | [#121](https://github.com/WhatTheStack1/DevFathom-Hub/issues/121) | `cmqqe8psj001zsstwgvr1by2j` | Implemented |
| IMP-PLAT-01 | quick-win | platform | Tighten CSP & image origins | [#122](https://github.com/WhatTheStack1/DevFathom-Hub/issues/122) | `cmqqe8q5l0020sstwyasjnmse` | Implemented |
| IMP-PLAT-02 | medium | platform | Production file storage (Vercel Blob) | [#123](https://github.com/WhatTheStack1/DevFathom-Hub/issues/123) | `cmqqe8ql50021sstwrabhqlpn` | To build |
| IMP-PLAT-03 | medium | platform | Observability (error tracking + request metrics) | [#124](https://github.com/WhatTheStack1/DevFathom-Hub/issues/124) | `cmqqe8qy80022sstwab6i8t7i` | To build |
| IMP-PLAT-04 | medium | platform | Audit log export + retention policy | [#125](https://github.com/WhatTheStack1/DevFathom-Hub/issues/125) | `cmqqe8rb80023sstwsu377an4` | Implemented |

_Each item carries acceptance criteria in its issue/task body (the BA's "what it should do") so QA can verify._
