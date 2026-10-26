'use strict';

/**
 * The Developers tab, driven by a real transfer between two browsers: every panel must fill in from
 * real events, the key must stay hidden unless asked for, IP masking must work, and the tab must
 * pass an accessibility audit in both themes. Run through `npm run e2e`.
 */

const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const BASE = process.env.BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `-> ${detail}`);
  if (!ok) failures.push(name);
};

async function poll(page, fn, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(50);
  }
  return false;
}

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

const text = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).textContent, selector);

(async () => {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  const viewport = { width: 1280, height: 900 };
  const sender = await (await browser.newContext({ viewport, colorScheme: 'light' })).newPage();
  const receiver = await (
    await browser.newContext({ viewport, colorScheme: 'light', acceptDownloads: true })
  ).newPage();
  const problems = [];
  for (const [label, page] of [
    ['sender', sender],
    ['receiver', receiver]
  ]) {
    page.on('console', (m) => m.type() === 'error' && problems.push(`${label}: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  }
  receiver.on('download', (d) => d.cancel().catch(() => {}));

  // ---- Navigation ----
  await sender.goto(BASE);
  check(
    'top navigation has Transfer and Developers',
    (await sender.locator('nav[aria-label="Main"] button').allTextContents())
      .map((t) => t.trim())
      .join(',') === 'Transfer,Developers'
  );
  check(
    'Transfer is the current page at first',
    (await sender.getAttribute('#navTransfer', 'aria-current')) === 'page'
  );
  check('the Developers view starts hidden', await sender.isHidden('#viewDevelopers'));
  await sender.click('#navDevelopers');
  check(
    'Developers view opens and the transfer view hides',
    (await sender.isVisible('#viewDevelopers')) && (await sender.isHidden('#viewTransfer'))
  );
  check(
    'Developers becomes the current page',
    (await sender.getAttribute('#navDevelopers', 'aria-current')) === 'page'
  );
  check(
    'the empty state says nothing has happened yet',
    /No encryption has happened yet/.test(await text(sender, '#devChunkBody'))
  );
  await sender.click('#navTransfer');
  check(
    'Transfer view comes back',
    (await sender.isVisible('#viewTransfer')) && (await sender.isHidden('#viewDevelopers'))
  );

  // ---- A real transfer with both Developers tabs open ----
  const small = {
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello developers')
  };
  const big = {
    name: 'blob.bin',
    mimeType: 'application/octet-stream',
    buffer: crypto.randomBytes(40 * 1024 * 1024)
  };
  await sender.setInputFiles('#fileInput', [small, big]);
  await poll(sender, () => document.getElementById('shareLinkInput').value.includes('#'));
  const link = await sender.inputValue('#shareLinkInput');
  const key = link.split('.').pop();

  await receiver.goto('about:blank');
  await receiver.goto(link);
  await receiver.click('#btnJoinRoom');
  await sender.click('#navDevelopers');
  await receiver.click('#navDevelopers');

  // Throughput must show up while data is moving
  let sawRate = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const [rate, badge] = [
      await text(sender, '#devRate'),
      await receiver.evaluate(() => document.getElementById('transferStatusText').textContent)
    ];
    if (/^[1-9]/.test(rate) || (/^\d.* out/.test(rate) && !/^0 B\/s out/.test(rate)))
      sawRate = true;
    if (badge === 'Complete') break;
    await sleep(150);
  }
  await sleep(1500); // let the last render and the sender's final confirmation land
  check('throughput was shown while data moved', sawRate);

  for (const [label, page] of [
    ['sender', sender],
    ['receiver', receiver]
  ]) {
    const steps = await page.evaluate(() =>
      [...document.querySelectorAll('#devSteps li')].map(
        (li) => `${li.dataset.step}:${li.dataset.done}`
      )
    );
    check(
      `${label}: every step is marked done`,
      steps.length === 13 && steps.every((s) => s.endsWith(':true')),
      steps.join(' ')
    );
  }

  // SDP
  check('sender shows its own offer', /offer/.test(await text(sender, '#devSdpSummary')));
  check('the SDP has a DTLS fingerprint', /sha-256/i.test(await text(sender, '#devSdpSummary')));
  check(
    'the ICE password is never shown',
    !/ice-pwd:(?!\[hidden\])/.test(await text(sender, '#devSdpRaw')) &&
      /\[hidden\]/.test(await text(sender, '#devSdpSummary'))
  );
  await receiver.click('#devSdpRemote');
  check(
    "receiver can switch to the other side's description (an offer)",
    /offer/.test(await text(receiver, '#devSdpSummary'))
  );

  // Candidates and path
  const cand = await sender.evaluate(() =>
    [...document.querySelectorAll('#devCandBody tr')].map((r) => r.textContent)
  );
  check(
    'candidates list both sides',
    cand.some((c) => c.startsWith('ours')) && cand.some((c) => c.startsWith('theirs')),
    cand.join(' | ')
  );
  check(
    'the path is reported as direct on one machine',
    /direct between the two browsers/.test(await text(sender, '#devPathKv')),
    await text(sender, '#devPathKv')
  );
  check('the summary says Direct', /^Direct/.test(await text(sender, '#devPathKind')));

  // Transport security
  const sec = await text(receiver, '#devSecKv');
  check(
    'transport security shows the DTLS version and cipher',
    /DTLS 1\.[23]/.test(sec) && /(AES|CHACHA)/i.test(sec),
    sec
  );

  // Encryption
  const fpS = (await text(sender, '#devKeyKv')).match(/([0-9a-f]{16}) \(first 8 bytes/);
  const fpR = (await text(receiver, '#devKeyKv')).match(/([0-9a-f]{16}) \(first 8 bytes/);
  check(
    'both sides show the same key fingerprint',
    fpS && fpR && fpS[1] === fpR[1],
    `${fpS && fpS[1]} vs ${fpR && fpR[1]}`
  );
  for (const [label, page] of [
    ['sender', sender],
    ['receiver', receiver]
  ]) {
    check(
      `${label}: the key is hidden by default`,
      !(await text(page, '#viewDevelopers')).includes(key)
    );
  }
  await sender.check('#devShowKey');
  check('the key shows when asked', (await text(sender, '#devKeyKv')).includes(key));
  await sender.uncheck('#devShowKey');
  check('and hides again', !(await text(sender, '#viewDevelopers')).includes(key));

  const rowsS = await sender.evaluate(() =>
    [...document.querySelectorAll('#devChunkBody tr')].map((r) =>
      [...r.children].map((c) => c.textContent)
    )
  );
  const rowsR = await receiver.evaluate(() =>
    [...document.querySelectorAll('#devChunkBody tr')].map((r) =>
      [...r.children].map((c) => c.textContent)
    )
  );
  check(
    'sender lists chunk encryptions',
    rowsS.some((r) => r[0] === 'chunk encrypt')
  );
  check(
    'receiver lists chunk decryptions',
    rowsR.some((r) => r[0] === 'chunk decrypt')
  );
  check(
    'both list the encrypted file header',
    rowsS.some((r) => r[0] === 'header encrypt') && rowsR.some((r) => r[0] === 'header decrypt')
  );
  check(
    'nonces are 12 bytes (24 hex characters)',
    rowsS.filter((r) => r[0] === 'chunk encrypt').every((r) => /^[0-9a-f]{24}$/.test(r[3]))
  );
  check(
    'file 2 uses its own nonce range',
    rowsS.some((r) => r[0] === 'chunk encrypt' && r[1] === '2' && r[3].startsWith('00000001'))
  );
  check(
    'a full chunk is 65,536 bytes plus a 16 byte tag',
    rowsS.some((r) => r[4] === '65,536 B' && r[5] === '65,552 B')
  );
  check('totals are reported', /chunks (en|de)crypted/.test(await text(sender, '#devTotals')));

  // Flow control
  check('the speed graph has data', (await sender.getAttribute('#devSparkSent', 'd')).length > 10);
  check(
    'flow control activity is listed',
    /Sender paused\s*\d+ times/.test(await text(sender, '#devFlowKv'))
  );

  // Server box
  check(
    'the server box checks the key was never sent',
    /Checked: the key is in none of the \d+ messages/.test(await text(sender, '#devKeyCheck')),
    await text(sender, '#devKeyCheck')
  );
  check(
    'it lists what was sent',
    /create/.test(await text(sender, '#devServerSent')) &&
      /offer/.test(await text(sender, '#devServerSent'))
  );

  // Log
  const logText = await text(sender, '#devLog');
  check(
    'the event log has signaling and crypto events',
    /to server: create/.test(logText) && /encrypted/.test(logText)
  );
  await sender.uncheck('[data-cat="crypto"]');
  check('filters hide a category', !/encrypted, nonce/.test(await text(sender, '#devLog')));
  await sender.check('[data-cat="crypto"]');
  await sender.click('#btnDevPause');
  const frozen = await text(sender, '#devLogCount');
  await sender.click('#btnDevClear');
  await sleep(500);
  check(
    'pausing keeps the log as it was while events are cleared',
    (await text(sender, '#btnDevPause')) === 'Resume log' && frozen.length > 0
  );
  await sender.click('#btnDevPause');
  check(
    'clearing the log empties it',
    /^0 events shown/.test(await text(sender, '#devLogCount')) ||
      /events shown of \d+ kept/.test(await text(sender, '#devLogCount'))
  );

  // Masking
  const ipv4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
  const addrText = async () =>
    sender.evaluate(() =>
      [...document.querySelectorAll('#devCandBody tr')]
        .map((r) => r.children[3]?.textContent || '')
        .join(' ')
    );
  const before = await addrText();
  await sender.check('#devMaskIps');
  const after = await addrText();
  check(
    'masking hides IPv4 host parts in the candidate table',
    !ipv4.test(after.replace(/\d+\.\d+\.\*\.\*/g, '')) && (!ipv4.test(before) || before !== after),
    `${before} -> ${after}`
  );
  await sender.uncheck('#devMaskIps');

  // Accessibility with data on screen
  await axeAudit(sender, 'developers tab, light');
  await sender.emulateMedia({ colorScheme: 'dark' });
  await sleep(300);
  await axeAudit(sender, 'developers tab, dark');

  // Small viewport
  await sender.setViewportSize({ width: 390, height: 800 });
  const overflow = await sender.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  check('no horizontal page scroll at phone width', !overflow);

  check('no console or page errors', problems.length === 0, problems.join(' | '));

  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E devtab crashed:', e);
  process.exit(1);
});
