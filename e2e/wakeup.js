'use strict';

/**
 * Free hosts put idle services to sleep. This suite simulates that in a real browser: the page is
 * loaded, the server goes away, the user picks a file, and the server comes back a few seconds
 * later on the same port. The page must say why it is slow, keep retrying, and then work.
 * Run through `npm run e2e`.
 */

const { chromium } = require('playwright-core');
const { createSignalingServer } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `-> ${detail}`);
  if (!ok) failures.push(name);
};

async function poll(page, fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(40);
  }
  return false;
}

async function start(port = 0) {
  const app = createSignalingServer();
  await new Promise((resolve) => app.server.listen(port, '127.0.0.1', resolve));
  return app;
}

(async () => {
  let app = await start();
  const port = app.server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  const sender = await (await browser.newContext()).newPage();
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const problems = [];
  sender.on('pageerror', (e) => problems.push(e.message));

  await sender.goto(base);
  await sender.evaluate(() => {
    window.__noticeSeen = [];
    new MutationObserver(() => {
      const box = document.getElementById('noticeBox');
      if (!box.hidden) window.__noticeSeen.push(box.textContent.trim());
    }).observe(document.getElementById('noticeBox'), {
      attributes: true,
      childList: true,
      subtree: true
    });
  });

  // The server goes to sleep after the page loaded
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.close(resolve));

  await sender.setInputFiles('#fileInput', [
    { name: 'wake.txt', mimeType: 'text/plain', buffer: Buffer.from('hello after a nap') }
  ]);

  const sawNotice = await poll(sender, () => !document.getElementById('noticeBox').hidden, 15000);
  check('the page explains the delay while the server is down', sawNotice);
  const noticeText = await sender.textContent('#noticeText');
  check(
    'the notice says the server is waking up',
    /waking up the server/i.test(noticeText),
    noticeText
  );
  check('no error is shown while it is still retrying', await sender.isHidden('#alertBox'));

  await sleep(3500); // the server stays down for a few more seconds
  app = await start(port);

  const hasLink = await poll(
    sender,
    () => document.getElementById('shareLinkInput').value.includes('#'),
    30000
  );
  check('the room is created once the server is back', hasLink);
  check('the notice disappears once connected', await sender.isHidden('#noticeBox'));
  check('still no error', await sender.isHidden('#alertBox'));

  // The recovered server is fully usable: finish a transfer
  const link = await sender.inputValue('#shareLinkInput');
  const downloads = [];
  receiver.on('download', async (d) => {
    const stream = await d.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    downloads.push({ name: d.suggestedFilename(), body: Buffer.concat(chunks).toString() });
  });
  await receiver.goto(link);
  await receiver.click('#btnJoinRoom');
  const complete = await poll(
    receiver,
    () => document.getElementById('transferStatusText').textContent === 'Complete',
    30000
  );
  await sleep(500);
  check('a transfer completes on the recovered server', complete);
  check(
    'the file arrives intact',
    downloads.length === 1 &&
      downloads[0].name === 'wake.txt' &&
      downloads[0].body === 'hello after a nap',
    JSON.stringify(downloads)
  );
  check('no page errors', problems.length === 0, problems.join(' | '));

  await browser.close();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.close(resolve));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E wakeup crashed:', e);
  process.exit(1);
});
