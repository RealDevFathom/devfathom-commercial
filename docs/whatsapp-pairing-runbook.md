# Pairing a pilot pharmacy WhatsApp number

Evolution API runs as one private Fargate task. Web tasks call it at `http://evolution.devfathom.local:8080`. It is not on the public load balancer. The API key is `AUTHENTICATION_API_KEY` in Secrets Manager (`devfathom/stg/evolution-api-key` on staging, `devfathom/prd/evolution-api-key` on production). Read it in the console when you pair. Do not paste it into chat, tickets, or shell history.

Run the curls below from a shell that can resolve `evolution.devfathom.local` (the app security group). ECS Exec is off, so do not publish port 8080 on the load balancer to reach it. Set:

```bash
export EVOLUTION_URL=http://evolution.devfathom.local:8080
export EVOLUTION_API_KEY='…'   # from Secrets Manager, this shell only
```

Every request sends `apikey: $EVOLUTION_API_KEY`.

One Evolution task hosts every pharmacy. A deploy or restart drops Baileys sessions, because they live on the task disk. Re-pair after any Evolution rollout. Do not roll that service while someone is scanning a QR.

## Dedicated number

Use a SIM and WhatsApp Business account that belong to the pharmacy. Leave the owner's personal WhatsApp on their own phone.

- Handset stays at the shop, charged, on Wi-Fi. The phone is the primary device. Evolution is only a linked device.
- Profile name is the pharmacy name. Photo is the shop. Add the address and opening hours.
- One Evolution instance per number. Name it once and keep it: `pilot-<pharmacy-slug>`, lowercase, no spaces.

## Warm it up

Do this before the first QR scan. A brand-new number that links a bot and messages customers the same day gets restricted.

1. Install WhatsApp Business and finish the profile.
2. For 3–7 days, use it like the counter already uses a phone: the owner, one staff member, and one supplier they already talk to. A handful of real chats a day is enough.
3. No broadcast lists, no groups, no shortened links, and no Evolution yet.

## QR pairing

On the pharmacy phone: WhatsApp Business → **Settings → Linked devices → Link a device**. The QR expires in well under a minute. Generate it only when that screen is open.

```bash
curl -sS -X POST "$EVOLUTION_URL/instance/create" \
  -H "apikey: $EVOLUTION_API_KEY" -H "content-type: application/json" \
  -d '{"instanceName":"pilot-rahim-store","integration":"WHATSAPP-BAILEYS","qrcode":true}'

curl -sS "$EVOLUTION_URL/instance/connect/pilot-rahim-store" \
  -H "apikey: $EVOLUTION_API_KEY"
```

The connect response has a `base64` PNG. Open that image next to the phone and scan it. If it expires, call connect again. Do not create a second instance.

Confirm, then send one message to a staff number that agreed to the test:

```bash
curl -sS "$EVOLUTION_URL/instance/connectionState/pilot-rahim-store" \
  -H "apikey: $EVOLUTION_API_KEY"

curl -sS -X POST "$EVOLUTION_URL/message/sendText/pilot-rahim-store" \
  -H "apikey: $EVOLUTION_API_KEY" -H "content-type: application/json" \
  -d '{"number":"923001234567","text":"Rahim Store test. Reply STOP to opt out."}'
```

`state` should be `open`. Numbers are country code plus national number, no `+` and no leading zero (`92300…` for Pakistan).

## Dropped session

`connectionState` of `close`, a linked device that disappeared on the phone, or any Evolution task replacement. Logs are in `/devfathom/stg/evolution` (production: `/devfathom/prd/evolution`).

1. On the phone, remove the dead linked device if it is still listed.
2. Restart the instance once, then fetch a new QR and scan it. Same instance name.

```bash
curl -sS -X PUT "$EVOLUTION_URL/instance/restart/pilot-rahim-store" \
  -H "apikey: $EVOLUTION_API_KEY"

curl -sS "$EVOLUTION_URL/instance/connect/pilot-rahim-store" \
  -H "apikey: $EVOLUTION_API_KEY"
```

3. Check `connectionState` until it is `open`. Send one staff test message before any customer message.

Logout (`DELETE /instance/logout/pilot-rahim-store`) only when retiring that number.

## Staying off the ban list

These are pilot caps we enforce. They are not a published WhatsApp quota.

- **Opt-in only.** The customer asked for WhatsApp from this pharmacy (at the counter is fine). Write down name, number, and date. No bought lists and no “people in the area.”
- **Per number.** Week one: at most about 30 customer messages a day on that line. Space them out. Wait a random 15–90 seconds between sends so they are not a metronome. Raise the cap only after several quiet days.
- **Quiet hours.** No automated sends from 21:00 to 09:00 Pakistan time (PKT, UTC+5, no daylight saving). A person at the counter can still reply to someone who wrote in.
- **Opt-out.** Treat `STOP`, `UNSUBSCRIBE`, `بند`, and `رک جاؤ` as opt-out. Send one confirmation, then never message that number again. Put the hint in the first template (“Reply STOP to opt out”).
- **No cold bulk.** One customer, one reason. No blast to every number captured at the till.
- **Personal templates.** The body names the person and the real order or reminder. The same paragraph sent to many numbers, all-caps, prize wording, and shortened links are how new lines get reported.
