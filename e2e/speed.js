'use strict';

/**
 * Many small files, like a phone gallery. Every file must arrive, in order and byte for byte, and
 * the Speed figure must be shown on both sides during the transfer and once it is over. Run
 * through `npm run e2e`.
 */

const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE;
const COUNT = 40;
const SIZE = 700 * 1024;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'efs-speed-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `-> ${detail}`);
  if (!ok) failures.push(name);
};

(async () => {
  const files = [];
  for (let i = 0; i < COUNT; i++) {
    const body = crypto.randomBytes(SIZE + i); // distinct sizes make a swapped order visible
    const file = path.join(WORK, `IMG_${String(i).padStart(3, '0')}.jpg`);
    fs.writeFileSync(file, body);
    files.push({
      name: path.basename(file),
      path: file,
      sha: crypto.createHash('sha256').update(body).digest('hex')
    });
  }

  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  const sender = await (await browser.newContext()).newPage();
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const problems = [];
  for (const page of [sender, receiver]) {
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
  }

  // Chrome throttles bursts of automatic downloads, which is the browser's choice and not the
  // app's. So check what the app hands to the browser: every blob it offers for download, hashed
  // in the page.
  await receiver.addInitScript(() => {
    window.__offered = [];
    const blobs = new Map();
    const create = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      const url = create.call(URL, blob);
      blobs.set(url, blob);
      return url;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const blob = blobs.get(this.href);
      const name = this.download;
      if (blob && name) {
        window.__offered.push(
          blob
            .arrayBuffer()
            .then((buf) => crypto.subtle.digest('SHA-256', buf))
            .then((d) => ({
              name,
              sha: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
            }))
        );
      }
      return click.call(this);
    };
  });

  await sender.goto(BASE);
  await sender.setInputFiles(
    '#fileInput',
    files.map((f) => f.path)
  );
  await sender.waitForSelector('#shareCard:not([hidden])');
  const link = await sender.inputValue('#shareLinkInput');
  await receiver.goto('about:blank');
  await receiver.goto(link);
  await receiver.click('#btnJoinRoom');

  const read = (page) =>
    page.evaluate(() => ({
      badge: document.getElementById('transferStatusText').textContent,
      speed: document.getElementById('metricSpeed').textContent,
      failed: !document.getElementById('alertBox').hidden
    }));
  let samples = 0;
  let withSpeed = 0;
  let last = { sender: null, receiver: null };
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const [r, s] = [await read(receiver), await read(sender)];
    last = { sender: s, receiver: r };
    if (r.badge === 'Receiving') {
      samples++;
      if (r.speed !== '–') withSpeed++;
    }
    if (r.failed || s.failed || (r.badge === 'Complete' && s.badge === 'Complete')) break;
    await sleep(100);
  }
  const offered = await receiver.evaluate(() => Promise.all(window.__offered));

  check(
    'both sides end on Complete',
    last.receiver.badge === 'Complete' && last.sender.badge === 'Complete',
    JSON.stringify(last)
  );
  check(
    `all ${COUNT} files arrive, in order`,
    offered.length === COUNT && offered.every((d, i) => d.name === files[i].name),
    offered.map((d) => d.name).join(',')
  );
  const intact = files.every((f, i) => offered[i] && offered[i].sha === f.sha);
  check('every file is byte for byte identical', intact);
  check(
    'speed is shown for most of the transfer',
    samples > 0 && withSpeed / samples >= 0.7,
    `${withSpeed}/${samples}`
  );
  check(
    'the receiver keeps an average speed when done',
    last.receiver.speed !== '–',
    last.receiver.speed
  );
  check(
    'the sender keeps an average speed when done',
    last.sender.speed !== '–',
    last.sender.speed
  );
  check('no console or page errors', problems.length === 0, problems.join(' | '));

  await browser.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E speed crashed:', e);
  process.exit(1);
});
