/** Isolated renderer/transport check. No TTS, microphone, live room, or production data. */
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPlugin } from '../src/index.ts';
import { BroadcastWindow } from '../src/live/broadcast-window.ts';
import { createRequestHandler } from '../src/host-api.ts';

if (process.platform !== 'darwin') throw new Error('This check targets the macOS broadcast window.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dafeiyu-motion-check-'));
const artifacts = mkdtempSync(join(tmpdir(), 'dafeiyu-motion-evidence-'));
const exe = join(root, 'lib/DafeiyuBroadcast.app/Contents/MacOS');
mkdirSync(exe, { recursive: true });
symlinkSync(join(repo, 'lib/broadcast-renderer.iife.js'), join(root, 'lib/broadcast-renderer.iife.js'));
symlinkSync(join(repo, 'client'), join(root, 'client'));
// Substitute only the native launcher; the HTTP stage and client renderer are production code.
writeFileSync(join(exe, 'DafeiyuBroadcast'), '#!/usr/bin/env node\nprocess.stdin.once("data",()=>console.log("ready")); process.stdin.resume();\n');
chmodSync(join(exe, 'DafeiyuBroadcast'), 0o755);
mkdirSync(join(root, 'data'));
symlinkSync(join(repo, 'data/models'), join(root, 'data/models'));
const handle = createPlugin({ dataDir: join(root, 'data') });
const output = new BroadcastWindow(handle, root);
const handler = createRequestHandler(handle, output);
const server = createServer((req, res) => {
  void handler(req, res, async () => { res.writeHead(404).end(); }).catch(() => res.destroy());
});
const owner = '1df9ad3d-a6c5-47ba-b5dc-1a251014a666';
let browser, timer, disposed = false, mode = 'listening';
const controller = new AbortController();
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const upstream = `http://127.0.0.1:${server.address().port}/api/dafeiyu/broadcast-window/frame`;
  handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true });
  handle.live.session.enterPreview(handle.settings.personaReady());
  await output.open(owner);
  const session = output.session;
  const address = session.server.address();
  const publish = async () => {
    const started = performance.now();
    try {
      await (await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ owner, profileId: handle.settings.getPersonaProfile().id,
          speaking: mode === 'speaking', listening: mode === 'listening',
          level: mode === 'speaking' ? (Math.sin(started / 70) + 1) * 0.4 : 0,
          form: Math.sin(started / 200) * 0.7, sampledAt: Date.now(), subtitle: '谢谢你的提问，我们一起看看。' }),
      })).text();
    } catch (error) { if (!disposed) throw error; }
    if (!disposed) timer = setTimeout(() => { void publish(); }, Math.max(0, 16 - (performance.now() - started)));
  };
  void publish();
  browser = await chromium.launch({ executablePath: process.env.DAFEIYU_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?token=${session.token}`);
  await page.waitForSelector('canvas[data-face-rig=full]');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(artifacts, 'listening.png') });
  mode = 'speaking';
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(artifacts, 'speaking.png') });
  const metrics = await page.evaluate(() => window.__dafeiyuMotionMetrics());
  mode = 'listening';
  for (const profileId of ['lubai', 'guyu', 'beila']) {
    handle.settings.savePersona({ profileId, usageRightConfirmed: true });
    await page.waitForTimeout(1800);
    await page.waitForSelector('canvas[data-face-rig=full][data-face-role="' + profileId + '"]');
    await page.screenshot({ path: join(artifacts, profileId + '.png') });
  }
  handle.live.session.emergencyStop();
  await page.getByText('播出已暂停').waitFor({ timeout: 1000 });
  await page.screenshot({ path: join(artifacts, 'safe.png') });
  handle.live.session.enterPreview(handle.settings.personaReady());
  mode = 'speaking';
  await page.waitForTimeout(250);
  disposed = true; clearTimeout(timer); controller.abort();
  await page.getByText('播出已暂停').waitFor({ timeout: 2500 });
  if (errors.length) throw new Error(errors.join('\n'));
  if (!metrics.samples) throw new Error('No render samples collected');
  const result = { scope: 'Synthetic frame upload + SSE + render callback; not audio/video sync certification', metrics, errors, artifacts };
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  disposed = true; clearTimeout(timer); controller.abort();
  await browser?.close(); output.dispose(); handle.dispose();
  server.closeAllConnections(); server.close();
  rmSync(root, { recursive: true, force: true });
}
