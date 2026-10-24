'use strict';

/**
 * Starts the app on a free port and runs the browser suites against it.
 *
 *   npm run e2e
 *
 * Needs a Chromium-based browser installed (Chrome by default). To use another one, for example
 * Microsoft Edge:  E2E_CHANNEL=msedge npm run e2e
 * To keep screenshots:  E2E_SHOTS=./e2e-shots npm run e2e
 */

const { spawn } = require('child_process');
const path = require('path');
const { createSignalingServer } = require('../server');

const SUITES = ['transfer.js', 'ui.js', 'speed.js', 'wakeup.js'];

function runSuite(file, env) {
  return new Promise((resolve) => {
    console.log(`\n=== ${file} ===`);
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      stdio: 'inherit',
      env: { ...process.env, ...env }
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  const app = createSignalingServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://localhost:${app.server.address().port}`;

  let allOk = true;
  for (const suite of SUITES) {
    allOk = (await runSuite(suite, { BASE: base })) && allOk;
  }

  await new Promise((resolve) => app.close(resolve));
  console.log(allOk ? '\nAll browser suites passed.' : '\nBrowser suites FAILED.');
  process.exit(allOk ? 0 : 1);
})();
