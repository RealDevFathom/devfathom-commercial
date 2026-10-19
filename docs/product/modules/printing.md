# Restaurant printing

DevFathom queues ESC/POS kitchen order tickets (KOTs) when an order or course is sent. A kitchen
display (KDS) is optional: a station can use a printer route, a KDS screen, both, or neither.

## Set up a TCP kitchen printer

1. Give the printer a stable address on the restaurant network and enable raw TCP printing on port
   `9100`.
2. In **Restaurant → Devices**, choose **Add print bridge**. Select the branch, name the bridge and
   printer, enter `tcp://192.168.1.50:9100`, and choose 58 mm or 80 mm paper.
3. Copy the one-time bridge enrollment code. It expires after 10 minutes and cannot be exchanged
   twice. This flow is separate from **Enroll this browser**, which supports only POS and KDS.
4. On a machine that can reach both DevFathom and the printer, exchange the code on first start:

   ```sh
   PRINT_BRIDGE_BASE_URL=https://your-devfathom-host.example \
   PRINT_BRIDGE_ENROLLMENT_CODE=pbe_your_one_time_code \
   PRINT_BRIDGE_TOKEN_FILE=/var/lib/devfathom-print-bridge/token \
   npm run restaurant:print-bridge
   ```

   The token-file path must not already exist. The bridge creates it exclusively with mode `0600`
   and never prints the token. On later starts, set `PRINT_BRIDGE_BASE_URL` and
   `PRINT_BRIDGE_TOKEN_FILE`; the bridge rejects files accessible by group or other users.
   `PRINT_BRIDGE_TOKEN` remains available for an injected process secret. Never commit or log
   either credential.

5. In **Settings → Printing**, select the persisted printer for each document type and optional
   station route.

The bridge updates its heartbeat and each printer's ONLINE/OFFLINE state. It claims only jobs for
printers owned by that bridge, writes ESC/POS bytes, and acknowledges success or the safe error.
If the printer is unreachable, the job stays queued and is offered again after the retry lease.
Use **Reprint KOT** on the order console or KDS when a fresh physical copy is needed.

## USB and serial printers

For an OS device node, set the printer connection to an absolute path such as `/dev/usb/lp0` or
`/dev/ttyUSB0`. USB and serial drivers, permissions, and device
names vary by operating system and printer model; verify them with the OS and printer vendor. This
bridge intentionally provides only the vendor-neutral ESC/POS baseline and makes no
physical-printer compatibility claim.
