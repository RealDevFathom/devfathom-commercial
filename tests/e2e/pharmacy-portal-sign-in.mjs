/**
 * Start the local app with PHARMACY_PORTAL_LOG_SYNTHETIC_CODES=1, a demo
 * pharmacy on a disposable loopback database and a synthetic customer whose
 * phone is in the reserved fictional range used by portalSyntheticSender.
 * Mint a link for that customer. Supply its full URL in a private file, and
 * run this script with the URL-file and the isolated server-log path.
 */
import { open, readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';

async function signIn() {
  const [, , linkFile, logFile] = process.argv;
  const url = new URL((await readFile(linkFile, 'utf8')).trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname.endsWith('.localhost') ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/my-pharmacy\/join\/pcl_[0-9a-hjkmnp-tv-z]{26}$/.test(url.pathname)
  )
    throw new Error('Expected a local synthetic join URL with a port.');

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'],
  });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    page.setDefaultTimeout(90_000);
    await page.goto(url.href);
    const log = await open(logFile, 'r');
    try {
      let position = (await log.stat()).size;
      const response = page.waitForResponse(
        (r) => r.url() === new URL('/api/pharmacy/portal/start', url).href
      );
      await page.getByRole('button', { name: 'Send me a code' }).click();
      if ((await response).status() !== 202) throw new Error('Code request failed.');
      const buffer = Buffer.alloc(4096);
      let output = '';
      const deadline = Date.now() + 30_000;
      let code;
      while (!code && Date.now() < deadline) {
        const { bytesRead } = await log.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        output = (output + buffer.toString('utf8', 0, bytesRead)).slice(-8192);
        code = /^Synthetic portal code: (\d{6})\r?$/m.exec(output)?.[1];
        if (!code) await wait(100);
      }
      if (!code) throw new Error('Local synthetic delivery was unavailable.');
      await page.getByLabel('Six-digit code').fill(code);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(new URL('/my-pharmacy', url).href);
      await page.getByRole('heading', { name: /^Hello, / }).waitFor();
    } finally {
      await log.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await signIn();
  console.log('Synthetic customer signed in and reached the customer home.');
} catch {
  // Browser errors and call logs can include the join URL, code or a customer name.
  console.error(
    'Local portal sign-in failed. Check fixture setup, browser availability and delivery.'
  );
  process.exitCode = 1;
}
