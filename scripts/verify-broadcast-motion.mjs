/** Isolated renderer/transport check using local recordings and synthetic states. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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
let browser, timer, disposed = false, mode = 'idle';
const shortSubtitle = '谢谢你的提问，我们一起看看。';
let subtitle = shortSubtitle, captionProgress = 0;
const controller = new AbortController();

async function expectRig(page, stage, profileId = 'xiaxia') {
  await page.locator(`${stage} canvas[data-face-rig=full][data-face-role="${profileId}"]`).waitFor();
  assert.equal(await page.locator(`${stage} video`).count(), 0, 'A live rig must own the picture through both idle and speech');
}

function recordedSpeech() {
  const wav = readFileSync(join(repo, 'data/role-voices/references/xiaxia.wav'));
  let rate, pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const bytes = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (tag === 'fmt ') {
      assert.equal(wav.readUInt16LE(start), 1);
      assert.equal(wav.readUInt16LE(start + 2), 1);
      assert.equal(wav.readUInt16LE(start + 14), 16);
      rate = wav.readUInt32LE(start + 4);
    }
    if (tag === 'data') pcm = wav.subarray(start, start + bytes);
    offset = start + bytes + bytes % 2;
  }
  assert.ok(rate && pcm?.length);
  const chunks = [];
  for (let start = 0; start < pcm.length; start += rate) {
    const audio = { type: 'audio', pcm: pcm.subarray(start, start + rate).toString('base64'), sampleRate: rate, voiceName: '测试声线' };
    chunks.push(JSON.stringify(audio));
  }
  return chunks.join('\n') + '\n{"type":"end"}\n';
}

async function expectPicture(page, stage, source) {
  await page.waitForFunction(({ stage, source }) => {
    const area = document.querySelector(stage);
    const avatar = area?.querySelector('.dfy-role-art, .dfy-broadcast-avatar');
    const video = area?.querySelector('video.dfy-idle-scene');
    if (!avatar || !video) return false;
    const style = getComputedStyle(video);
    if (style.transitionDuration !== '0s') throw new Error('Whole-frame video must switch without a crossfade');
    const videoOpacity = Number(style.opacity);
    const avatarVisible = getComputedStyle(avatar).display !== 'none';
    if (source === 'video') return videoOpacity === 1 && !avatarVisible && !video.paused && video.muted && video.videoWidth > 0;
    return videoOpacity === 0 && avatarVisible && video.paused;
  }, { stage, source }, { timeout: 8000 });
}

async function openWorkbench(browser, origin, unavailable) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const previewUrl = origin + '/workbench-check';
  await page.route(previewUrl, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <meta charset="utf-8"><style>html,body,#broadcast{height:100%;margin:0}</style>
    <div id="broadcast"></div><script src="/renderer.js"></script>
    <script>
      const loader = window.__ModuleLoader__;
      const load = loader.load;
      loader.load = (module) => load({ ...module, factory(require) {
        const client = module.factory(require);
        return { mountBroadcastWindow(root) {
          client.apply({ slots: {
            inject(name, register) { if (name === "main") register(); },
            register(_, render) { root.render(render()); },
          } });
        } };
      } });
    </script><script src="/client.js"></script>` }));
  await page.route(origin + '/renderer.js', (route) => route.fulfill({ path: join(repo, 'lib/broadcast-renderer.iife.js') }));
  await page.route(origin + '/client.js', (route) => route.fulfill({ path: join(repo, 'client/client.js') }));
  if (unavailable === 'runtime') await page.route('**/api/dafeiyu/avatar/vendor?name=core', (route) => route.abort());
  if (unavailable === 'prototype') await page.route('**/api/dafeiyu/avatar/prototype?*', (route) => route.abort());
  await page.goto(previewUrl);
  return page;
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upstream = origin + '/api/dafeiyu/broadcast-window/frame';
  handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true });
  handle.live.session.enterPreview(handle.settings.personaReady());
  await output.open(owner);
  const session = output.session;
  const address = session.server.address();
  let playbackVersion = output.playbackVersion(owner);
  const publish = async () => {
    const started = performance.now();
    try {
      const result = await (await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ owner, playbackVersion, profileId: handle.settings.getPersonaProfile().id,
          speaking: mode === 'speaking', listening: mode === 'listening',
          level: mode === 'speaking' ? (Math.sin(started / 70) + 1) * 0.4 : 0,
          form: Math.sin(started / 200) * 0.7, sampledAt: Date.now(), subtitle, captionProgress }),
      })).json();
      playbackVersion = result.playbackVersion;
    } catch (error) { if (!disposed) throw error; }
    if (!disposed) timer = setTimeout(() => { void publish(); }, Math.max(0, 16 - (performance.now() - started)));
  };
  void publish();
  browser = await chromium.launch({ executablePath: process.env.DAFEIYU_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?token=${session.token}`);
  const broadcastArt = '.dfy-broadcast-art';
  await expectRig(page, broadcastArt);
  const avatar = await page.locator(`${broadcastArt} canvas[data-face-rig=full]`).elementHandle();
  await page.screenshot({ path: join(artifacts, 'idle.png') });
  mode = 'listening';
  await page.waitForTimeout(150);
  await expectRig(page, broadcastArt);
  await page.screenshot({ path: join(artifacts, 'listening.png') });
  mode = 'speaking';
  await page.locator('.dfy-broadcast-caption').waitFor();
  await expectRig(page, broadcastArt);
  assert.ok(await avatar.evaluate((el) => el.isConnected), 'Idle and speech must retain the same canvas');
  await page.waitForFunction(() => window.__dafeiyuMotionMetrics().samples >= 15);
  await page.screenshot({ path: join(artifacts, 'speaking.png') });
  const metrics = await page.evaluate(() => window.__dafeiyuMotionMetrics());
  const caption = page.locator('.dfy-broadcast-caption');
  const shortHeight = await caption.evaluate((el) => el.offsetHeight);
  subtitle = '这一段回复包含多行文字，用来确认字幕区域保持固定大小。'.repeat(6) + 'abcdefghijklmn'.repeat(12) + '这是回复的最后一句。';
  const captionViewport = caption.locator('.dfy-caption-scroll');
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.dfy-broadcast-caption .dfy-caption-scroll');
    return viewport.textContent.endsWith('这是回复的最后一句。') && viewport.scrollHeight > viewport.clientHeight;
  });
  assert.equal(await caption.evaluate((el) => el.offsetHeight), shortHeight);
  assert.equal(await captionViewport.evaluate((el) => el.scrollWidth), await captionViewport.evaluate((el) => el.clientWidth));
  assert.equal(await captionViewport.evaluate((el) => el.scrollTop), 0);
  assert.match(await caption.evaluate((el) => getComputedStyle(el).backdropFilter), /blur/);
  captionProgress = .55;
  await page.waitForFunction(() => {
    const el = document.querySelector('.dfy-broadcast-caption .dfy-caption-scroll');
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const target = Math.floor((.55 * el.scrollHeight - .55 * el.clientHeight) / line) * line;
    return target > 0 && Math.abs(el.scrollTop - target) < 1;
  });
  await page.screenshot({ path: join(artifacts, 'long-caption.png') });
  captionProgress = .99;
  await page.waitForFunction(() => {
    const el = document.querySelector('.dfy-broadcast-caption .dfy-caption-scroll');
    return el.scrollHeight - el.clientHeight - el.scrollTop < 1;
  });
  subtitle = shortSubtitle;
  captionProgress = 0;

  if (process.argv.includes('--body-demo')) {
    mode = 'idle';
    await page.locator('.dfy-broadcast-caption').waitFor({ state: 'detached' });
    await page.evaluate(() => {
      const art = document.querySelector('.dfy-broadcast-avatar');
      const base = art.querySelector('img.dfy-rig-surface');
      const overlay = art.querySelector('canvas');
      const output = document.createElement('canvas');
      output.width = 360;
      output.height = 640;
      const ctx = output.getContext('2d');
      const crop = base.naturalHeight * output.width / output.height;
      const left = (base.naturalWidth - crop) / 2;
      const stream = output.captureStream(24);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      let frame;
      const draw = () => {
        for (const surface of [base, overlay]) ctx.drawImage(surface, left, 0, crop, base.naturalHeight, 0, 0, output.width, output.height);
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = 'rgba(18,34,48,.75)';
        ctx.fillRect(248, 20, 94, 28);
        ctx.fillStyle = '#fff';
        ctx.fillText('AI 生成内容', 258, 39);
        frame = requestAnimationFrame(draw);
      };
      window.__bodyDemo = new Promise((resolve) => {
        recorder.onstop = async () => {
          cancelAnimationFrame(frame);
          stream.getTracks().forEach((track) => track.stop());
          const data = new Uint8Array(await new Blob(chunks).arrayBuffer());
          resolve(Array.from(data));
        };
      });
      draw();
      recorder.start();
      setTimeout(() => recorder.stop(), 4900);
    });
    await page.waitForTimeout(550);
    mode = 'listening';
    await page.waitForTimeout(1500);
    mode = 'speaking';
    await page.waitForTimeout(2100);
    mode = 'idle';
    writeFileSync(join(artifacts, 'body-demo.webm'), Buffer.from(await page.evaluate(() => window.__bodyDemo)));
  }

  const workbench = await openWorkbench(browser, origin);
  workbench.on('pageerror', (error) => errors.push(error.message));
  const previewArt = '.dfy-role-stage';
  await expectRig(workbench, previewArt);
  let releaseVoice;
  const voiceReady = new Promise((resolve) => { releaseVoice = resolve; });
  const speechFixture = recordedSpeech();
  await workbench.route('**/api/dafeiyu/preview/role-speech', async (route) => {
    await voiceReady;
    await route.fulfill({ contentType: 'application/x-ndjson', body: speechFixture });
  });
  await workbench.getByText('声音试听', { exact: true }).click();
  await workbench.getByRole('button', { name: '试听互动声线' }).click();
  await expectRig(workbench, previewArt);
  releaseVoice();
  await workbench.getByText('正在朗读 · 测试声线（本地参考音色）', { exact: true }).waitFor();
  await expectRig(workbench, previewArt);
  await workbench.getByRole('button', { name: '停止朗读' }).click();
  await expectRig(workbench, previewArt);
  await workbench.emulateMedia({ reducedMotion: 'reduce' });
  await expectRig(workbench, previewArt);
  await workbench.emulateMedia({ reducedMotion: 'no-preference' });
  await expectRig(workbench, previewArt);
  await workbench.getByRole('button', { name: '直播画面', exact: true }).click();
  await expectRig(workbench, broadcastArt);
  await workbench.getByRole('button', { name: '启用播出声音', exact: true }).click();
  await workbench.getByRole('button', { name: '试播一句', exact: true }).click();
  await expectRig(workbench, broadcastArt);
  await workbench.locator('.dfy-broadcast-caption').waitFor();
  await workbench.waitForTimeout(450);
  await workbench.screenshot({ path: join(artifacts, 'recorded-speech.png') });
  await workbench.locator('.dfy-broadcast-caption').waitFor({ state: 'detached' });
  await expectRig(workbench, broadcastArt);

  mode = 'idle';
  for (const profileId of ['lubai', 'guyu', 'beila']) {
    handle.settings.savePersona({ profileId, usageRightConfirmed: true });
    await expectRig(page, broadcastArt, profileId);
    await page.screenshot({ path: join(artifacts, `${profileId}-idle.png`) });
    mode = 'speaking';
    await page.locator('.dfy-broadcast-caption').waitFor();
    await expectRig(page, broadcastArt, profileId);
    await page.screenshot({ path: join(artifacts, profileId + '.png') });
    mode = 'idle';
  }
  handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true });
  await expectRig(page, broadcastArt);
  handle.live.session.emergencyStop();
  await page.getByText('播出已暂停').waitFor({ timeout: 1000 });
  assert.equal(await page.locator(broadcastArt).count(), 0, 'The safe screen must remove both picture sources');
  await page.screenshot({ path: join(artifacts, 'safe.png') });
  handle.live.session.enterPreview(handle.settings.personaReady());
  mode = 'speaking';
  await page.waitForTimeout(250);
  disposed = true; clearTimeout(timer); controller.abort();
  await page.getByText('播出已暂停').waitFor({ timeout: 2500 });

  await page.close();
  output.close(owner);
  const opened = workbench.waitForResponse((res) => res.url().endsWith('/broadcast-window/open'));
  await workbench.getByRole('button', { name: '打开独立播出窗口' }).click();
  const openedVersion = (await (await opened).json()).playbackVersion;
  const native = output.session;
  const realOutput = await browser.newPage({ viewport: { width: 540, height: 960 } });
  realOutput.on('pageerror', (error) => errors.push(error.message));
  await realOutput.goto(`http://127.0.0.1:${native.server.address().port}/?token=${native.token}`);
  await expectRig(realOutput, broadcastArt);
  const enableAudio = workbench.getByRole('button', { name: '启用播出声音', exact: true });
  if (await enableAudio.isVisible()) await enableAudio.click();
  const timedCaption = workbench.waitForRequest((request) => {
    if (!request.url().endsWith('/broadcast-window/frame')) return false;
    const frame = request.postDataJSON();
    return frame.speaking && frame.captionProgress > .05 && frame.captionProgress < 1;
  });
  await workbench.getByRole('button', { name: '试播一句', exact: true }).click();
  await realOutput.locator('.dfy-broadcast-caption').waitFor();
  await timedCaption;
  const interrupted = workbench.waitForResponse((res) => res.url().endsWith('/broadcast-window/interrupt'));
  await workbench.getByRole('button', { name: '暂停播出声音' }).click();
  const interruptVersion = (await (await interrupted).json()).playbackVersion;
  assert.equal(interruptVersion, openedVersion + 1);
  await expectRig(realOutput, broadcastArt);
  await workbench.getByRole('button', { name: '显示播出窗口' }).waitFor();
  const oldFrame = await (await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: native.owner, playbackVersion: openedVersion, profileId: 'xiaxia',
      speaking: true, level: 1, subtitle: '迟到的帧', sampledAt: Date.now() }),
  })).json();
  assert.deepEqual(oldFrame, { ok: true, open: true, accepted: false, playbackVersion: interruptVersion });
  assert.equal(await realOutput.getByText('迟到的帧').count(), 0);

  await workbench.getByRole('button', { name: '工作台', exact: true }).click();
  await workbench.getByRole('combobox', { name: '预览角色' }).selectOption('xiaxia-3d');
  const xiaxia3d = '[data-rigged-role="xiaxia-3d"][data-rigged-status="ready"] canvas';
  await workbench.locator(xiaxia3d).waitFor();
  const xiaxia3dCanvas = realOutput.locator(xiaxia3d);
  await xiaxia3dCanvas.waitFor();
  const resolution = await xiaxia3dCanvas.evaluate((canvas) => [canvas.width, canvas.height]);
  assert.deepEqual(resolution, [1080, 1920], 'Portrait broadcast should render at full output resolution');
  const artworkOnly = '.dfy-broadcast-caption, .dfy-room-overlay, .dfy-pet-ai { visibility: hidden !important }';
  const idle = await xiaxia3dCanvas.screenshot({ path: join(artifacts, 'xiaxia-3d-idle.png'), style: artworkOnly });
  await workbench.getByRole('button', { name: '直播画面', exact: true }).click();
  await workbench.locator(xiaxia3d).waitFor();
  await workbench.getByRole('button', { name: '启用播出声音', exact: true }).click();
  if (process.argv.includes('--rigged-demo')) {
    await realOutput.evaluate((selector) => {
      const stream = document.querySelector(selector).captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      window.__xiaxia3dDemo = new Promise((resolve, reject) => {
        recorder.onerror = (event) => reject(event.error);
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
        };
      });
      recorder.start();
      setTimeout(() => recorder.stop(), 8100);
    }, xiaxia3d);
  }
  await workbench.getByRole('button', { name: '试播一句', exact: true }).click();
  await realOutput.locator('.dfy-broadcast-caption').getByText(/我是夏夏/).waitFor();
  await realOutput.waitForTimeout(645);
  const speaking = await xiaxia3dCanvas.screenshot({ path: join(artifacts, 'xiaxia-3d-speaking.png'), style: artworkOnly });
  if (process.argv.includes('--rigged-demo')) {
    await realOutput.locator('.dfy-broadcast-caption').waitFor({ state: 'detached' });
    writeFileSync(join(artifacts, 'xiaxia-3d-demo.webm'), Buffer.from(await realOutput.evaluate(() => window.__xiaxia3dDemo), 'base64'));
  } else {
    await workbench.getByRole('button', { name: '暂停播出声音' }).click();
  }
  await realOutput.waitForTimeout(780);
  const settled = await xiaxia3dCanvas.screenshot({ path: join(artifacts, 'xiaxia-3d-settled.png'), style: artworkOnly });
  const differences = await realOutput.evaluate(async ({ idle, speaking, settled, portrait }) => {
    const pixels = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      // The captured PNG is untagged while the original carries video color
      // metadata. Compare the stored RGB samples in the common canvas space.
      const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
      const surface = document.createElement('canvas');
      surface.width = img.width;
      surface.height = img.height;
      const ctx = surface.getContext('2d');
      ctx.drawImage(img, 0, 0);
      img.close();
      return ctx.getImageData(0, 0, surface.width, surface.height);
    };
    const [first, second, last, source] = await Promise.all([pixels(idle), pixels(speaking), pixels(settled), pixels(portrait)]);
    const sourceScale = source.height / first.height;
    const cropLeft = (source.width - first.width * sourceScale) / 2;
    const reference = new ImageData(first.width, first.height);
    // Compare pixel centers through the same centered crop as the stage.
    // Canvas drawImage can round the fractional crop's starting column.
    for (let y = 0; y < first.height; y++) {
      const v = Math.max(0, Math.min(source.height - 1, (y + .5) * sourceScale - .5));
      const top = Math.floor(v), bottom = Math.min(top + 1, source.height - 1);
      for (let x = 0; x < first.width; x++) {
        const u = cropLeft + (x + .5) * sourceScale - .5;
        const left = Math.floor(u), right = left + 1;
        const out = (y * first.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const sample = (row, col) => source.data[(row * source.width + col) * 4 + channel];
          const a = sample(top, left) * (right - u) + sample(top, right) * (u - left);
          const b = sample(bottom, left) * (right - u) + sample(bottom, right) * (u - left);
          reference.data[out + channel] = a * (1 - (v - top)) + b * (v - top);
        }
      }
    }
    const compare = (other, left, top, right, bottom, threshold = 0) => {
      let sum = 0, changed = 0, total = 0;
      for (let y = Math.floor(top * first.height); y < bottom * first.height; y++) {
        for (let x = Math.floor(left * first.width); x < right * first.width; x++) {
          const at = (y * first.width + x) * 4;
          const r = Math.abs(first.data[at] - other.data[at]);
          const g = Math.abs(first.data[at + 1] - other.data[at + 1]);
          const b = Math.abs(first.data[at + 2] - other.data[at + 2]);
          sum += r + g + b;
          if (Math.max(r, g, b) > threshold) changed++;
          total++;
        }
      }
      return { mean: sum / (3 * total), changed };
    };
    return {
      background: compare(second, .85, .20, .98, .40).changed,
      chair: compare(second, .015, .467, .087, .515).changed,
      bodyDuringSpeech: compare(second, 0, .48, 1, 1).changed,
      handDuringSpeech: compare(second, 0, .89, .16, 1).changed,
      returnedBody: compare(last, 0, .48, 1, 1).changed,
      bodyReference: compare(reference, 0, .48, 1, 1).mean,
      handReference: compare(reference, 0, .89, .16, 1).mean,
      mouth: compare(second, .46, .385, .59, .44, 10).changed,
    };
  }, {
    idle: idle.toString('base64'), speaking: speaking.toString('base64'), settled: settled.toString('base64'),
    portrait: readFileSync(join(repo, 'data/models/eciyuan-xiaxia/portrait-frame.png')).toString('base64'),
  });
  assert.equal(differences.background, 0, 'Room pixels must stay fixed during speech');
  assert.equal(differences.chair, 0, 'The chair must stay fixed during speech');
  assert.equal(differences.bodyDuringSpeech, 0, 'The original seated posture must stay fixed during speech');
  assert.equal(differences.handDuringSpeech, 0, 'The original hand must stay fixed during speech');
  assert.equal(differences.returnedBody, 0, 'The original posture must stay fixed after speaking');
  assert.ok(differences.bodyReference < 2, `Body must match the source image (${differences.bodyReference})`);
  assert.ok(differences.handReference < 2, `Visible hand must match the source image (${differences.handReference})`);
  assert.ok(differences.mouth > 25, 'Speech must still animate the lips in the actual render');
  await workbench.getByRole('button', { name: '工作台', exact: true }).click();
  await workbench.getByRole('combobox', { name: '预览角色' }).selectOption('xiaxia');
  await expectRig(workbench, previewArt);
  await expectRig(realOutput, broadcastArt);
  await workbench.close();
  const fallbackPreview = await openWorkbench(browser, origin, 'runtime');
  fallbackPreview.on('pageerror', (error) => errors.push(error.message));
  await fallbackPreview.emulateMedia({ reducedMotion: 'reduce' });
  await fallbackPreview.locator(`${previewArt} canvas[data-face-role="xiaxia"][data-face-rig="prototype"]`).waitFor();
  await fallbackPreview.close();
  const clipFallback = await openWorkbench(browser, origin, 'prototype');
  clipFallback.on('pageerror', (error) => errors.push(error.message));
  await expectPicture(clipFallback, previewArt, 'video');
  await clipFallback.emulateMedia({ reducedMotion: 'reduce' });
  await expectPicture(clipFallback, previewArt, 'avatar');
  await clipFallback.close();
  const riggedFallback = await openWorkbench(browser, origin);
  riggedFallback.on('pageerror', (error) => errors.push(error.message));
  await riggedFallback.route('**/api/dafeiyu/avatar/rigged?id=xiaxia-3d&asset=model', (route) => route.abort());
  await riggedFallback.getByRole('combobox', { name: '预览角色' }).selectOption('xiaxia-3d');
  const poster = riggedFallback.locator('[data-rigged-status="failed"] img.dfy-rigged-poster');
  await poster.waitFor();
  assert.ok(await poster.evaluate((img) => img.naturalWidth > 0));
  await riggedFallback.close();
  if (errors.length) throw new Error(errors.join('\n'));
  if (!metrics.samples) throw new Error('No render samples collected');
  const result = { scope: 'Workbench and broadcast continuity; recorded speech, synthetic states and SSE', metrics, xiaxia: { ...differences, resolution }, errors, artifacts };
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  disposed = true; clearTimeout(timer); controller.abort();
  await browser?.close(); output.dispose(); handle.dispose();
  server.closeAllConnections(); server.close();
  rmSync(root, { recursive: true, force: true });
}
