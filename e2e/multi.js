'use strict';

/**
 * One sender, several receivers, in real browsers: one link, each receiver gets every byte (SHA-256
 * checked), starting early works, a receiver that drops out does not stop the others, and the
 * Developers tab lists every connection. Run through `npm run e2e`.
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

async function poll(page, fn, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(60);
  }
  return false;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const text = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).textContent, selector);

// What the app hands to the browser for download, hashed in the page. Chrome throttles bursts of
// automatic downloads, so this checks the app's output instead.
const RECORD_DOWNLOADS = () => {
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
};

async function newPage(browser, { receiver = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: receiver
  });
  const page = await context.newPage();
  if (receiver) {
    await page.addInitScript(RECORD_DOWNLOADS);
    page.on('download', (d) => d.cancel().catch(() => {}));
  }
  return { page, context };
}

async function startSender(browser, count, files) {
  const sender = await newPage(browser);
  const problems = [];
  sender.page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  sender.page.on('pageerror', (e) => problems.push(e.message));
  await sender.page.goto(BASE);
  await sender.page.selectOption('#recipientCount', String(count));
  await sender.page.setInputFiles('#fileInput', files);
  await poll(sender.page, () => document.getElementById('shareLinkInput').value.includes('#'));
  const link = await sender.page.inputValue('#shareLinkInput');
  return { ...sender, link, problems };
}

async function joinReceiver(browser, link) {
  const r = await newPage(browser, { receiver: true });
  await r.page.goto('about:blank');
  await r.page.goto(link);
  await r.page.click('#btnJoinRoom');
  return r;
}

const badge = (page) => text(page, '#transferStatusText');

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

(async () => {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });

  const small = Buffer.from('hello to everyone');
  const medium = crypto.randomBytes(3 * 1024 * 1024 + 11);
  const big = crypto.randomBytes(24 * 1024 * 1024);
  const files = [
    { name: 'hello.txt', mimeType: 'text/plain', buffer: small },
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: medium },
    { name: 'blob.bin', mimeType: 'application/octet-stream', buffer: big }
  ];
  const expected = files.map((f) => ({ name: f.name, sha: sha(f.buffer) }));

  // ---- Scenario 1: three receivers, everyone arrives, sending starts by itself ----
  {
    const sender = await startSender(browser, 3, files);
    check(
      'the recipient picker is hidden once files are chosen',
      await sender.page.isHidden('#recipientsRow')
    );
    check(
      'the share card shows three empty places',
      (await sender.page.locator('#peerSlotList li').count()) === 3
    );
    check(
      'the summary starts at 0 of 3',
      /0 of 3 connected/.test(await text(sender.page, '#peerSlotsSummary'))
    );
    check('Start is disabled while nobody is here', await sender.page.isDisabled('#btnStartNow'));
    check(
      'the link text explains several people',
      /up to 3 people/.test(await text(sender.page, '#shareHelp'))
    );

    await axeAudit(sender.page, 'share card with empty places, light');
    await sender.page.emulateMedia({ colorScheme: 'dark' });
    await sleep(500); // let the theme transition finish before measuring contrast
    await axeAudit(sender.page, 'share card with empty places, dark');
    await sender.page.emulateMedia({ colorScheme: 'light' });

    const receivers = [];
    for (let i = 0; i < 3; i++) receivers.push(await joinReceiver(browser, sender.link));
    check(
      'all three get to sending',
      (
        await Promise.all(
          receivers.map((r) =>
            poll(
              r.page,
              () =>
                ['Receiving', 'Complete'].includes(
                  document.getElementById('transferStatusText').textContent
                ),
              60000
            )
          )
        )
      ).every(Boolean)
    );

    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < 120000) {
      const states = await Promise.all([
        ...receivers.map((r) => badge(r.page)),
        badge(sender.page)
      ]);
      if (states.every((s) => s === 'Complete')) {
        done = true;
        break;
      }
      await sleep(200);
    }
    check('everyone ends on Complete', done);
    await sleep(800);

    for (let i = 0; i < receivers.length; i++) {
      const offered = await receivers[i].page.evaluate(() => Promise.all(window.__offered));
      check(
        `receiver ${i + 1} gets every file, in order, byte for byte`,
        offered.length === 3 &&
          offered.every((o, k) => o.name === expected[k].name && o.sha === expected[k].sha),
        JSON.stringify(offered.map((o) => o.name))
      );
    }
    await axeAudit(sender.page, 'transfer panel listing receivers');
    check(
      'the sender lists three receivers',
      (await sender.page.locator('#peerTransferList li').count()) === 3
    );
    check(
      'all three are marked done',
      (await sender.page.locator('#peerTransferList li[data-state="done"]').count()) === 3
    );
    check(
      'the summary says delivered to 3 of 3',
      /to 3 of 3 people/.test(await text(sender.page, '#transferSubtitle')),
      await text(sender.page, '#transferSubtitle')
    );
    check(
      'the room was single use: a fourth person is refused',
      await (async () => {
        const late = await newPage(browser, { receiver: true });
        await late.page.goto('about:blank');
        await late.page.goto(sender.link);
        await late.page.click('#btnJoinRoom');
        const failed = await poll(
          late.page,
          () => !document.getElementById('alertBox').hidden,
          20000
        );
        const message = failed ? await text(late.page, '#alertText') : '';
        await late.context.close();
        return failed && /expired|already|new one/i.test(message);
      })()
    );

    // Developers tab shows one connection per receiver
    await sender.page.click('#navDevelopers');
    await sleep(500);
    const rows = await sender.page.evaluate(() =>
      [...document.querySelectorAll('#devPeersBody tr')].map((r) => r.textContent)
    );
    check(
      'the Developers tab lists all three connections',
      rows.length === 3 && rows.every((r) => /Person \d/.test(r)),
      rows.join(' | ')
    );
    check(
      'and says which path each used',
      rows.every((r) => /direct/.test(r)),
      rows.join(' | ')
    );
    const logText = await text(sender.page, '#devLog');
    check('the log names the receivers', /\[Person 2\]/.test(logText));
    check(
      'the server check still passes',
      /Checked: the key is in none of the \d+ messages/.test(
        await text(sender.page, '#devKeyCheck')
      )
    );
    const link2key = sender.link.split('.').pop();
    check(
      'the key is not on the Developers tab',
      !(await text(sender.page, '#viewDevelopers')).includes(link2key)
    );

    check(
      'no console or page errors on the sender',
      sender.problems.length === 0,
      sender.problems.join(' | ')
    );
    for (const r of [...receivers, sender]) await r.context.close();
  }

  // ---- Scenario 2: start early with fewer people than planned ----
  {
    const sender = await startSender(browser, 4, files.slice(0, 2));
    const receivers = [
      await joinReceiver(browser, sender.link),
      await joinReceiver(browser, sender.link)
    ];
    await poll(
      sender.page,
      () => /2 of 4 connected/.test(document.getElementById('peerSlotsSummary').textContent),
      60000
    );
    check(
      'two of four connected, Start is available',
      !(await sender.page.isDisabled('#btnStartNow'))
    );
    await sender.page.click('#btnStartNow');
    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < 90000) {
      const states = await Promise.all([
        ...receivers.map((r) => badge(r.page)),
        badge(sender.page)
      ]);
      if (states.every((s) => s === 'Complete')) {
        done = true;
        break;
      }
      await sleep(200);
    }
    check('starting early completes for the people who are there', done);
    await sleep(500);
    check(
      'the summary counts only them',
      /to 2 of 2 people/.test(await text(sender.page, '#transferSubtitle')),
      await text(sender.page, '#transferSubtitle')
    );
    for (const r of receivers) {
      const offered = await r.page.evaluate(() => Promise.all(window.__offered));
      check(
        'and they have both files intact',
        offered.length === 2 && offered.every((o, k) => o.sha === expected[k].sha)
      );
    }
    // The room is locked: someone arriving now cannot join
    const late = await joinReceiver(browser, sender.link);
    check(
      'a latecomer to an early-started room is refused',
      await poll(late.page, () => !document.getElementById('alertBox').hidden, 30000)
    );
    await late.context.close();
    for (const r of [...receivers, sender]) await r.context.close();
  }

  // ---- Scenario 3: one receiver drops out mid-transfer ----
  {
    const dropBuffer = crypto.randomBytes(48 * 1024 * 1024);
    const sender = await startSender(browser, 3, [
      { name: 'big.bin', mimeType: 'application/octet-stream', buffer: dropBuffer }
    ]);
    const receivers = [];
    for (let i = 0; i < 3; i++) receivers.push(await joinReceiver(browser, sender.link));
    await poll(
      receivers[1].page,
      () => document.getElementById('transferStatusText').textContent === 'Receiving',
      60000
    );
    await sleep(300);
    await receivers[1].context.close(); // the second person closes their browser

    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < 120000) {
      const states = await Promise.all([
        badge(receivers[0].page),
        badge(receivers[2].page),
        badge(sender.page)
      ]);
      if (states.every((s) => s === 'Complete')) {
        done = true;
        break;
      }
      await sleep(250);
    }
    check('the others finish when one person drops out', done);
    await sleep(500);
    check(
      'the sender shows who dropped',
      (await sender.page.locator('#peerTransferList li[data-state="failed"]').count()) === 1
    );
    check(
      'and says so in the summary',
      /to 2 of 3 people, 1 dropped/.test(await text(sender.page, '#transferSubtitle')),
      await text(sender.page, '#transferSubtitle')
    );
    for (const i of [0, 2]) {
      const offered = await receivers[i].page.evaluate(() => Promise.all(window.__offered));
      check(
        `receiver ${i + 1} still got the file, byte for byte`,
        offered.length === 1 && offered[0].name === 'big.bin' && offered[0].sha === sha(dropBuffer)
      );
    }
    check('no alert on the sender', await sender.page.isHidden('#alertBox'));
    for (const i of [0, 2]) await receivers[i].context.close();
    await sender.context.close();
  }

  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E multi crashed:', e);
  process.exit(1);
});
