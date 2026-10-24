'use strict';

/**
 * Real two-browser transfer: several files (one above the disk-backed threshold, one empty),
 * every byte verified with SHA-256, plus checks that the key never reaches the server.
 * Run through `npm run e2e` (it starts the server and sets BASE).
 */

const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE;
const SHOTS = process.env.E2E_SHOTS || null; // directory for screenshots, optional
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'efs-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `-> ${detail}`);
  if (!ok) failures.push(name);
};

function makeFile(name, size) {
  const file = path.join(WORK, name);
  const fd = fs.openSync(file, 'w');
  const hash = crypto.createHash('sha256');
  for (let off = 0; off < size; off += 1 << 20) {
    const block = crypto.randomBytes(Math.min(1 << 20, size - off));
    fs.writeSync(fd, block);
    hash.update(block);
  }
  fs.closeSync(fd);
  return { name, path: file, size, sha: hash.digest('hex') };
}

async function shot(page, name) {
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  }
}

(async () => {
  const files = [
    makeFile('quarterly-report.pdf', 2 * 1024 * 1024 + 17),
    makeFile('notes.txt', 300 * 1024),
    makeFile('exactly-two-chunks.bin', 131072),
    makeFile(
      'dataset-with-a-really-long-name-that-should-truncate-nicely-in-the-list.bin',
      70 * 1024 * 1024 + 5
    ),
    makeFile('empty.txt', 0)
  ];

  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    // Without this, Chromium hides host candidates behind mDNS names, which not every machine
    // can resolve; two tabs on one machine then fail to connect for reasons unrelated to the app.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  const scheme = process.env.SCHEME || 'light';
  const viewport = { width: Number(process.env.VW || 900), height: Number(process.env.VH || 900) };
  const sender = await (await browser.newContext({ viewport, colorScheme: scheme })).newPage();
  const receiverContext = await browser.newContext({
    viewport,
    colorScheme: scheme,
    acceptDownloads: true
  });
  const receiver = await receiverContext.newPage();

  const problems = [];
  for (const [label, page] of [
    ['sender', sender],
    ['receiver', receiver]
  ]) {
    page.on(
      'console',
      (m) => m.type() === 'error' && problems.push(`${label} console: ${m.text()}`)
    );
    page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
    await page.addInitScript(() => {
      window.__wsSent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        window.__wsSent.push(String(d));
        return send.call(this, d);
      };
    });
  }
  await receiver.addInitScript(() => {
    window.__diskWriters = 0;
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      window.__diskWriters++;
      return create.apply(this, args);
    };
  });

  await sender.goto(BASE);
  await sender.setInputFiles(
    '#fileInput',
    files.map((f) => f.path)
  );
  await sender.waitForSelector('#shareCard:not([hidden])');
  await sender.click('#btnShowQR');
  await sender.waitForSelector('#qrCode svg');
  await shot(sender, '02-send-share.png');
  const link = await sender.inputValue('#shareLinkInput');
  const key = link.split('.').pop();

  const downloads = [];
  receiver.on('download', async (d) => {
    const p = path.join(WORK, `dl-${downloads.length}-${d.suggestedFilename()}`);
    await d.saveAs(p);
    downloads.push({ name: d.suggestedFilename(), path: p });
  });

  await receiver.goto(link);
  await receiver.waitForSelector('#viewReceive:not([hidden])');
  const urlAfterLoad = receiver.url();
  await shot(receiver, '04-receive-link.png');

  const started = Date.now();
  await receiver.click('#btnJoinRoom');
  let midShot = false;
  while (Date.now() - started < 120000) {
    const state = await receiver.evaluate(() => ({
      rows: [...document.querySelectorAll('.xfer-row')].map(
        (r) => `${r.dataset.state}:${r.querySelector('.xfer-state').textContent}`
      ),
      badge: document.getElementById('transferStatusText').textContent,
      failed: !document.getElementById('alertBox').hidden
    }));
    if (
      !midShot &&
      state.rows[3] &&
      /^active:(\d+)%/.test(state.rows[3]) &&
      parseInt(state.rows[3].split(':')[1]) >= 25
    ) {
      await shot(receiver, '05-receive-mid.png');
      midShot = true;
    }
    if (state.failed || state.badge === 'Complete') break;
    await sleep(40);
  }
  await sleep(1500); // let the last downloads flush
  await shot(receiver, '06-receive-done.png');
  await shot(sender, '06b-send-done.png');

  for (const f of files) {
    const d = downloads.find((x) => x.name === f.name);
    const got = d ? fs.readFileSync(d.path) : null;
    check(
      `${f.name.slice(0, 30)} (${f.size} bytes) arrives intact`,
      got &&
        got.length === f.size &&
        crypto.createHash('sha256').update(got).digest('hex') === f.sha,
      got ? `got ${got.length} bytes, hash differs` : 'not downloaded'
    );
  }

  const ui = async (page) =>
    page.evaluate(() => ({
      badge: document.getElementById('transferStatusText').textContent,
      alert: document.getElementById('alertBox').hidden
        ? null
        : document.getElementById('alertText').textContent
    }));
  const [r, s] = [await ui(receiver), await ui(sender)];
  check(
    'receiver ends on Complete with no alert',
    r.badge === 'Complete' && !r.alert,
    JSON.stringify(r)
  );
  check(
    'sender ends on Complete with no alert',
    s.badge === 'Complete' && !s.alert,
    JSON.stringify(s)
  );
  check(
    'the large file used disk-backed storage exactly once',
    (await receiver.evaluate(() => window.__diskWriters)) === 1
  );
  check('the key is removed from the address bar', !urlAfterLoad.includes(key));
  const sent = [
    ...(await sender.evaluate(() => window.__wsSent)),
    ...(await receiver.evaluate(() => window.__wsSent))
  ];
  check('the key never appears in a signaling message', !sent.some((m) => m.includes(key)));
  check(
    'no console or page errors on either side (CSP intact)',
    problems.length === 0,
    problems.join(' | ')
  );

  await browser.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E transfer crashed:', e);
  process.exit(1);
});
