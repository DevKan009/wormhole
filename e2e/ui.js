'use strict';

/**
 * Failure paths, keyboard behaviour and axe accessibility audits in a real browser.
 * Run through `npm run e2e` (it starts the server and sets BASE).
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const os = require('os');

const BASE = process.env.BASE;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'efs-e2e-ui-'));
const OUT = process.env.E2E_SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

async function poll(page, fn, { timeout = 30000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return;
    await sleep(30);
  }
  throw new Error('poll timeout: ' + fn.toString().slice(0, 120));
}

const buf = (n) => Buffer.alloc(n, 7);

async function axeAudit(page, label) {
  await page.evaluate(axeSource);
  const res = await page.evaluate(async () =>
    axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']
      }
    })
  );
  const v = res.violations.map(
    (x) => `${x.id} (${x.impact}) x${x.nodes.length}: ${x.nodes[0].target.join(' ')}`
  );
  check(`axe: ${label}`, v.length === 0, v.join(' | '));
}

async function newPair(browser, scheme) {
  const sctx = await browser.newContext({
    viewport: { width: 700, height: 900 },
    colorScheme: scheme
  });
  const rctx = await browser.newContext({
    viewport: { width: 700, height: 900 },
    colorScheme: scheme,
    acceptDownloads: true
  });
  return { sender: await sctx.newPage(), receiver: await rctx.newPage(), sctx, rctx };
}

async function startSender(sender, files) {
  await sender.goto(BASE);
  await sender.setInputFiles('#fileInput', files);
  await poll(sender, () => document.getElementById('shareLinkInput').value.includes('#'));
  return sender.inputValue('#shareLinkInput');
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });

  // ---- Accessibility audits, light and dark ----
  for (const scheme of ['light', 'dark']) {
    const { sender, receiver, sctx, rctx } = await newPair(browser, scheme);
    await sender.goto(BASE);
    await axeAudit(sender, `${scheme} / send empty`);
    await sender.locator('.privacy summary').click();
    await axeAudit(sender, `${scheme} / privacy open`);
    const link = await startSender(sender, [
      { name: 'a.txt', mimeType: 'text/plain', buffer: buf(1000) },
      { name: 'b.txt', mimeType: 'text/plain', buffer: buf(2000) }
    ]);
    await sender.click('#btnShowQR');
    await axeAudit(sender, `${scheme} / share + QR`);
    await receiver.goto(BASE);
    await receiver.click('#tabReceive');
    await axeAudit(receiver, `${scheme} / receive`);
    await receiver.fill('#receiverLinkInput', 'ABC123');
    await receiver.click('#btnJoinRoom');
    await axeAudit(receiver, `${scheme} / receive inline error`);
    await receiver.goto('about:blank');
    await receiver.goto(link);
    await receiver.click('#btnJoinRoom');
    await poll(
      receiver,
      () => document.getElementById('transferStatusText').textContent === 'Complete'
    );
    await sleep(600); // let the toast finish fading in so axe measures its final colours
    await axeAudit(receiver, `${scheme} / transfer complete`);
    await sctx.close();
    await rctx.close();
  }

  // ---- Keyboard: tab roving with arrow keys ----
  {
    const { sender, sctx, rctx } = await newPair(browser, 'light');
    await sender.goto(BASE);
    await sender.focus('#tabSend');
    await sender.keyboard.press('ArrowRight');
    check(
      'ArrowRight moves to Receive tab',
      (await sender.getAttribute('#tabReceive', 'aria-selected')) === 'true' &&
        (await sender.evaluate(() => document.activeElement.id)) === 'tabReceive'
    );
    check(
      'Receive panel visible, Send hidden',
      (await sender.isVisible('#viewReceive')) && !(await sender.isVisible('#viewSend'))
    );
    await sender.keyboard.press('Home');
    check(
      'Home returns to Send tab',
      (await sender.getAttribute('#tabSend', 'aria-selected')) === 'true'
    );
    // Keyboard path: first the "Send to" picker, then the file input inside the dropzone
    await sender.keyboard.press('Tab');
    const picker = await sender.evaluate(() => document.activeElement.id);
    check('Tab from tablist reaches the recipient picker', picker === 'recipientCount', picker);
    await sender.keyboard.press('Tab');
    const focused = await sender.evaluate(() => document.activeElement.id);
    check('Tab again reaches the file input', focused === 'fileInput', focused);
    const ring = await sender.evaluate(
      () => getComputedStyle(document.getElementById('dropZone')).outlineStyle
    );
    check('Dropzone shows a focus ring for keyboard focus', ring === 'solid', ring);
    await sctx.close();
    await rctx.close();
  }

  // ---- Inline validation, no alert ----
  {
    const { receiver, sctx, rctx } = await newPair(browser, 'light');
    await receiver.goto(BASE);
    await receiver.click('#tabReceive');
    await receiver.fill('#receiverLinkInput', 'ABC123');
    await receiver.click('#btnJoinRoom');
    const hint = await receiver.textContent('#receiveHint');
    check('Bare room code gets an inline explanation', /only the room code/i.test(hint), hint);
    check('...without a page-level alert', await receiver.isHidden('#alertBox'));
    check(
      '...and marks the field invalid',
      (await receiver.getAttribute('#receiverLinkInput', 'aria-invalid')) === 'true'
    );
    await receiver.fill('#receiverLinkInput', 'not a link');
    await receiver.click('#btnJoinRoom');
    check(
      'Garbage input is rejected inline',
      /doesn.t look like a share link/i.test(await receiver.textContent('#receiveHint'))
    );
    await sctx.close();
    await rctx.close();
  }

  // ---- Wrong key: both sides explain, Start over recovers ----
  {
    const { sender, receiver, sctx, rctx } = await newPair(browser, 'light');
    const link = await startSender(sender, [
      { name: 'secret.bin', mimeType: 'application/octet-stream', buffer: buf(300000) }
    ]);
    const bad = link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');
    let wrongKeyDownloads = 0;
    receiver.on('download', () => wrongKeyDownloads++);
    await receiver.goto(bad);
    await receiver.click('#btnJoinRoom');
    await receiver.waitForSelector('#alertBox:not([hidden])', { timeout: 20000 });
    check(
      'Receiver explains the wrong key',
      /decrypt/i.test(await receiver.textContent('#alertText')),
      await receiver.textContent('#alertText')
    );
    await sender.waitForSelector('#alertBox:not([hidden])', { timeout: 20000 });
    check(
      'Sender learns the receiver rejected it',
      /couldn.t verify/i.test(await sender.textContent('#alertText')),
      await sender.textContent('#alertText')
    );
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await receiver.screenshot({ path: path.join(OUT, '10-error-wrong-key.png'), fullPage: true });
    }
    await receiver.click('#btnAlertAction');
    check(
      'Start over hides the alert and restores the form',
      (await receiver.isHidden('#alertBox')) && (await receiver.isEnabled('#btnJoinRoom'))
    );
    check(
      'Wrong-key transfer produced no download',
      wrongKeyDownloads === 0,
      String(wrongKeyDownloads)
    );
    await sctx.close();
    await rctx.close();
  }

  // ---- Link used twice / expired ----
  {
    const { sender, receiver, sctx, rctx } = await newPair(browser, 'light');
    const link = await startSender(sender, [
      { name: 'a.txt', mimeType: 'text/plain', buffer: buf(5000) }
    ]);
    await receiver.goto('about:blank');
    await receiver.goto(link);
    await receiver.click('#btnJoinRoom');
    await poll(
      receiver,
      () => document.getElementById('transferStatusText').textContent === 'Complete'
    );
    const third = await rctx.newPage();
    await third.goto(link);
    await third.click('#btnJoinRoom');
    await third.waitForSelector('#alertBox:not([hidden])', { timeout: 15000 });
    const msg = await third.textContent('#alertText');
    check('A used link says it has expired', /expired or was already used/i.test(msg), msg);
    await sctx.close();
    await rctx.close();
  }

  // ---- Sender disappears mid-transfer ----
  {
    const { sender, receiver, sctx, rctx } = await newPair(browser, 'light');
    const big = path.join(WORK, 'abort.bin');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    const fd = fs.openSync(big, 'w');
    for (let i = 0; i < 150; i++) fs.writeSync(fd, require('crypto').randomBytes(1 << 20));
    fs.closeSync(fd);
    const link = await startSender(sender, [big]);
    let downloads = 0;
    receiver.on('download', () => downloads++);
    await receiver.goto('about:blank');
    await receiver.goto(link);
    await receiver.click('#btnJoinRoom');
    await poll(receiver, () => {
      const el = document.querySelector('.xfer-row .xfer-state');
      return !!el && /^\d+%$/.test(el.textContent) && parseInt(el.textContent) >= 10;
    });
    await sender.close();
    await receiver.waitForSelector('#alertBox:not([hidden])', { timeout: 30000 });
    const msg = await receiver.textContent('#alertText');
    check(
      'Receiver reports a dropped connection',
      /dropped before the transfer finished/i.test(msg),
      msg
    );
    await sleep(500);
    check('No partial download is delivered', downloads === 0, String(downloads));
    check(
      'Row is marked stopped',
      (await receiver.textContent('.xfer-row .xfer-state')) === 'Stopped'
    );
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await receiver.screenshot({ path: path.join(OUT, '11-error-dropped.png'), fullPage: true });
    }
    await sctx.close();
    await rctx.close();
  }

  // ---- Send more files resets the sender cleanly ----
  {
    const { sender, receiver, sctx, rctx } = await newPair(browser, 'light');
    const link = await startSender(sender, [
      { name: 'a.txt', mimeType: 'text/plain', buffer: buf(5000) }
    ]);
    await receiver.goto('about:blank');
    await receiver.goto(link);
    await receiver.click('#btnJoinRoom');
    await poll(
      sender,
      () => document.getElementById('transferStatusText').textContent === 'Complete'
    );
    await sender.click('#btnTransferReset');
    check(
      'Send more files returns to an empty form',
      (await sender.isVisible('#dropZone')) &&
        (await sender.isHidden('#transferPanel')) &&
        (await sender.isHidden('#shareCard'))
    );
    const link2 = await startSender(sender, [
      { name: 'b.txt', mimeType: 'text/plain', buffer: buf(6000) }
    ]);
    check('A fresh room and key are issued', link2 !== link && link2.includes('#'));
    await sctx.close();
    await rctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results)
    console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.ok ? '' : '-> ' + r.detail);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
