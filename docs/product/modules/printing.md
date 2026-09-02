# Restaurant printing

DevFathom queues ESC/POS kitchen order tickets (KOTs) when an order or course is sent. A kitchen
display (KDS) is optional: a station can use a printer route, a KDS screen, both, or neither.

## Set up a TCP kitchen printer

1. Give the printer a stable address on the restaurant network and enable raw TCP printing on port
   `9100`.
2. In **Settings → Printing**, select the branch and add an enabled **Kitchen printer (KOT)** route
   for the station. Use a printer ID such as `tcp://192.168.1.50:9100`.
3. Issue a dedicated registered-device secret for the same branch through restaurant device
   management. Device secrets are shown once; do not place the secret in source control or logs.
4. On a machine that can reach both DevFathom and the printer, run:

   ```sh
   PRINT_BRIDGE_BASE_URL=https://your-devfathom-host.example \
   PRINT_BRIDGE_TOKEN=rdk_your_one_time_device_secret \
   npm run restaurant:print-bridge
   ```

The bridge long-polls for branch-scoped jobs, writes the ESC/POS bytes, and acknowledges success.
If the printer is unreachable, the job stays queued and is offered again after the retry lease.
Use **Reprint KOT** on the order console or KDS when a fresh physical copy is needed.

## USB and serial printers

For an OS device node, set the printer ID to an absolute path such as `/dev/usb/lp0`, or use
`usb:///dev/usb/lp0` / `serial:///dev/ttyUSB0`. USB and serial drivers, permissions, and device
names vary by operating system and printer model; verify them with the OS and printer vendor. This
bridge intentionally provides only the vendor-neutral ESC/POS baseline and makes no
physical-printer compatibility claim.
