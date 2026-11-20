/** Real panel + read-only broadcast server; isolated data and simulated native launcher. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPlugin } from '../src/index.ts';
import { createRequestHandler } from '../src/host-api.ts';
import { BroadcastWindow } from '../src/live/broadcast-window.ts';

if (process.platform !== 'darwin') throw new Error('Run on macOS with Chrome and pnpm build completed.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dafeiyu-landscape-check-'));
const artifacts = process.env.DAFEIYU_STAGE_ARTIFACTS || mkdtempSync(join(tmpdir(), 'dafeiyu-landscape-evidence-'));
mkdirSync(artifacts, { recursive: true });
const exe = join(root, 'lib/DafeiyuBroadcast.app/Contents/MacOS');
mkdirSync(exe, { recursive: true });
symlinkSync(join(repo, 'lib/broadcast-renderer.iife.js'), join(root, 'lib/broadcast-renderer.iife.js'));
symlinkSync(join(repo, 'client'), join(root, 'client'));
mkdirSync(join(root, 'data'));
symlinkSync(join(repo, 'data/models'), join(root, 'data/models'));
symlinkSync(join(repo, 'data/stage-landscape'), join(root, 'data/stage-landscape'));
const addressFile = join(root, 'address');
writeFileSync(join(exe, 'DafeiyuBroadcast'), `#!/usr/bin/env node
process.stdin.once('data', value => { require('node:fs').writeFileSync(${JSON.stringify(addressFile)}, value.toString().trim()); console.log('ready'); });
process.stdin.resume();\n`);
chmodSync(join(exe, 'DafeiyuBroadcast'), 0o755);
process.env.DAFEIYU_DANMAKU_ROOM_ID = 'stage-check';
const handle = createPlugin({ dataDir: join(root, 'data') });
const output = new BroadcastWindow(handle, root);
const handler = createRequestHandler(handle, output);
const server = createServer((req, res) => {
  if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8">
    <style>html,body,#broadcast{height:100%;margin:0}</style><div id="broadcast"></div><script src="/renderer.js"></script>
    <script>const load=window.__ModuleLoader__.load;
    window.__ModuleLoader__.load=(module)=>load({...module,factory(require){const client=module.factory(require);
    return {mountBroadcastWindow(root){client.apply({slots:{inject(name,cb){if(name==='main')cb()},register(_,render){root.render(render())}}})}}}});</script>
    <script src="/client.js"></script>`);
  const file = req.url === '/renderer.js' ? 'lib/broadcast-renderer.iife.js' : req.url === '/client.js' ? 'client/client.js' : null;
  if (file) return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(repo, file)));
  void handler(req, res, async () => { res.writeHead(404).end(); }).catch(() => res.destroy());
});
let browser, timer, page, sampleLevel = .85;
async function waitForMouth(page, opening) {
  await page.waitForFunction((opening) => {
    const canvas = document.querySelector('.dfy-original-stage-mouth');
    if (!canvas || canvas.width !== 1920) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = data.some((value, i) => i % 4 === 3 && value >= 32);
    return alpha === opening;
  }, opening);
}
const owner = '1df9ad3d-a6c5-47ba-b5dc-1a251014a666';
try {
  handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true });
  handle.settings.saveScene({ title: '夏夏的海边直播间' });
  handle.live.session.enterPreview(handle.settings.personaReady());
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.DAFEIYU_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true }); // dsh-skip-sensitive
  const errors = [];
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const roles = page.locator('.dfy-settings-stack select').first();
  await roles.waitFor();
  assert.deepEqual(await roles.locator('option').evaluateAll((items) => items.map((item) => item.value)),
    ['dsh-pet', 'xiaxia', 'lubai', 'guyu', 'beila']);
  assert.deepEqual(await page.getByLabel('默认形象', { exact: true }).locator('option').evaluateAll((items) => items.map((item) => item.value)),
    ['standard', 'rigged']);

  await page.getByRole('button', { name: '直播画面', exact: true }).click();
  await page.locator('.dfy-broadcast[aria-label="直播画面 1080×1920"]').waitFor();
  const stageSettings = page.getByRole('button', { name: '舞台设置', exact: true });
  const drawer = page.getByRole('dialog', { name: '舞台设置' });
  await stageSettings.click();
  await drawer.waitFor();
  assert.equal(await drawer.getByLabel('直播间名称', { exact: true }).inputValue(), '夏夏的直播间');
  assert.ok(await drawer.getByLabel('直播间名称', { exact: true }).getAttribute('readonly') !== null);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.ok(await stageSettings.evaluate((el) => document.activeElement === el));
  await stageSettings.click();
  await page.getByLabel('画面方向', { exact: true }).selectOption('landscape');
  await page.getByLabel('直播公告', { exact: true }).fill('欢迎来到夏夏的直播间！\n一起聊天，一起看海。');
  await page.getByRole('button', { name: '保存舞台设置', exact: true }).click();
  await page.getByText('已保存', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  const stage = page.locator('.dfy-broadcast-landscape');
  await stage.waitFor();

  await stage.getByText('一起聊天，一起看海。', { exact: false }).waitFor();
  await stage.getByText('夏夏的直播间', { exact: true }).waitFor();
  assert.equal(handle.settings.getScene().broadcastLayout, 'landscape');
  await stage.locator('.dfy-stage-matte canvas[data-face-role="xiaxia"]').waitFor();
  const rect = await stage.boundingBox();
  assert.ok(Math.abs(rect.width / rect.height - 16 / 9) < 0.01);
  await stage.locator('.dfy-wide-scene img').evaluate((img) => img.decode());
  await stage.screenshot({ path: join(artifacts, 'landscape-teal.png') });
  for (const theme of ['night', 'warm']) {
    await page.getByRole('button', { name: '舞台设置', exact: true }).click();
    await page.getByLabel('舞台主题', { exact: true }).selectOption(theme);
    await page.getByRole('button', { name: '保存舞台设置', exact: true }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction((theme) => document.querySelector('.dfy-broadcast').dataset.stageTheme === theme, theme);
    await stage.screenshot({ path: join(artifacts, `landscape-${theme}.png`) });
  }
  // Exercise the actual workbench audio clock with known speech PCM.
  handle.settings.saveScene({ roleScenes: { xiaxia: '03-headset-studio' } });
  const mouthCanvas = page.locator('.dfy-original-stage-mouth');
  await mouthCanvas.waitFor();
  const speech = readFileSync(join(repo, 'data/role-voices/references/xiaxia.wav')).toString('base64');
  await page.route('**/api/dafeiyu/preview/role-speech', (route) => route.fulfill({ json: {
    ok: true, result: { audioBase64: speech, source: 'reference', voiceName: '参考语音' },
  } }));
  await page.getByRole('button', { name: '启用播出声音', exact: true }).click();
  await page.getByRole('button', { name: '试播一句', exact: true }).click();
  await waitForMouth(page, true);
  await page.locator('.dfy-broadcast-caption').waitFor({ state: 'hidden' });
  await waitForMouth(page, false);
  await page.getByRole('button', { name: '暂停播出声音', exact: true }).click();
  await page.unroute('**/api/dafeiyu/preview/role-speech');
  handle.settings.saveScene({ roleScenes: {} });
  await stage.locator('.dfy-stage-matte canvas[data-face-role="xiaxia"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await stage.boundingBox();
  assert.ok(narrow.width > 0 && narrow.x >= 0 && narrow.x + narrow.width <= 391);
  assert.ok(Math.abs(narrow.width / narrow.height - 16 / 9) < 0.01);
  await page.screenshot({ path: join(artifacts, 'landscape-mobile.png') });
  await output.open(owner);
  const publish = () => output.publish(owner, { playbackVersion: output.playbackVersion(owner), sampledAt: Date.now(), profileId: handle.settings.getPersonaProfile().id, safe: false, speaking: true, level: sampleLevel, subtitle: '欢迎来到横屏直播舞台。' });
  publish(); timer = setInterval(publish, 40);
  const viewer = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  viewer.on('pageerror', (e) => errors.push(e.message));
  await viewer.goto(readFileSync(addressFile, 'utf8'), { waitUntil: "domcontentloaded" });

  await viewer.locator('.dfy-broadcast-landscape .dfy-stage-matte canvas[data-face-role="xiaxia"]').waitFor();
  await viewer.locator('.dfy-broadcast-caption').waitFor();
  await viewer.locator('.dfy-broadcast-landscape').screenshot({ path: join(artifacts, 'landscape-output.png') });
  // Use the isolated manual adapter; no platform login or public stream is performed.
  await handle.live.session.start('stage-check', { aiLabelVisible: true, stableReleaseAvailable: true, resourceOk: true, personaConfigured: true, platformConfigured: true });
  assert.equal(handle.live.session.operatorConfirmedLive(new Date().toISOString()), 'live_confirmed');
  handle.live.conversation.setAutomatic([]);
  for (const [id, kind, nickname, text] of [['chat-1', 'comment', '海边的朋友', '夏夏晚上好！'], ['gift-1', 'gift', '小海鸥', '送出小心心 ×1']]) {
    assert.equal(handle.live.conversation.receive({ id, roomId: 'stage-check', kind, nickname, text, sentAt: new Date().toISOString() }), true);
  }
  await viewer.locator('.dfy-wide-chat').getByText('夏夏晚上好！', { exact: true }).waitFor();
  await viewer.locator('.dfy-wide-gifts').getByText('送出小心心 ×1', { exact: true }).waitFor();
  await viewer.locator('.dfy-wide-queue').getByText('海边的朋友', { exact: true }).waitFor();
  await viewer.locator('.dfy-wide-gift-alert').getByText('小海鸥', { exact: false }).waitFor();
  await viewer.locator('.dfy-broadcast-landscape').screenshot({ path: join(artifacts, 'landscape-interactions.png') });
  handle.settings.saveScene({ danmakuOverlay: false });
  await viewer.getByText('弹幕展示已关闭', { exact: true }).waitFor();
  assert.equal(await viewer.locator('.dfy-wide-chat').getByText('夏夏晚上好！', { exact: true }).count(), 0);
  handle.settings.saveScene({ broadcastLayout: 'portrait' });
  await viewer.locator('.dfy-broadcast:not(.dfy-broadcast-landscape)').waitFor();
  const portrait = await viewer.locator('.dfy-broadcast').boundingBox();
  assert.ok(Math.abs(portrait.width / portrait.height - 9 / 16) < 0.01, 'Viewer letterboxes rather than stretching');
  handle.settings.savePersona({ profileId: 'dsh-pet', usageRightConfirmed: true });
  handle.settings.saveScene({ broadcastLayout: 'landscape', background: 'teal', danmakuOverlay: true, title: '大肥鱼的海边小屋', notice: '欢迎来海边小屋坐坐！\n发条弹幕和我聊聊天吧。' });
  const pet = viewer.locator('.dfy-room-pet.dfy-broadcast-landscape');
  await pet.locator('canvas[data-face-role="dsh-pet"]').waitFor();
  await pet.locator('.dfy-wide-scene img').evaluate((img) => img.decode());
  await pet.locator('.dfy-broadcast-caption').waitFor();
  assert.ok(handle.live.conversation.receive({ id: 'pet-chat', roomId: 'stage-check', kind: 'comment', nickname: '海边的朋友', text: '今天的海景好漂亮！', sentAt: new Date().toISOString() }));
  await pet.locator('.dfy-wide-chat').getByText('今天的海景好漂亮！', { exact: true }).waitFor();
  await pet.screenshot({ path: join(artifacts, 'landscape-pet.png') });
  for (const profileId of ['lubai', 'guyu', 'beila']) {
    handle.settings.savePersona({ profileId, usageRightConfirmed: true });
    const portraitStage = viewer.locator('.dfy-broadcast-landscape').filter({ has: viewer.locator(`.dfy-stage-matte canvas[data-face-role="${profileId}"]`) });
    await portraitStage.waitFor();
    await portraitStage.locator('.dfy-wide-heading').getByText(handle.settings.getPersonaProfile().name + '的直播间', { exact: true }).waitFor();
    await portraitStage.screenshot({ path: join(artifacts, `landscape-${profileId}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.dfy-broadcast-landscape .dfy-wide-heading').getByText('贝拉的直播间', { exact: true }).waitFor();
  await stageSettings.click();
  assert.equal(await drawer.getByLabel('横屏素材', { exact: true }).locator('option').count(), 1, '贝拉不应混用其他主播原场景');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true });
  await page.locator('.dfy-broadcast-landscape .dfy-wide-heading').getByText('夏夏的直播间', { exact: true }).waitFor();
  await stageSettings.click();
  const source = page.getByLabel('横屏素材', { exact: true });
  await source.selectOption('03-headset-studio');
  assert.deepEqual(await source.locator('option').evaluateAll((items) => items.map((item) => item.value)),
    ['', '01-silver-studio', '03-headset-studio']);
  await page.getByRole('img', { name: '耳机直播间预览' }).evaluate((img) => img.decode());
  assert.equal(await drawer.getByLabel('直播间名称', { exact: true }).inputValue(), '夏夏的直播间');
  await page.screenshot({ path: join(artifacts, 'stage-settings.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await drawer.locator('.dfy-stage-settings').evaluate((el) => el.scrollWidth <= el.clientWidth));
  assert.ok(await drawer.locator('footer').evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(artifacts, 'stage-settings-mobile.png'), animations: 'disabled' });
  await drawer.getByLabel('命名方式', { exact: true }).selectOption('custom');
  await drawer.getByLabel('直播间名称', { exact: true }).fill('晚间特别节目');
  await page.getByRole('button', { name: '保存舞台设置' }).click();
  await page.getByText('已保存', { exact: true }).waitFor();
  assert.equal(handle.settings.getScene().roleScenes.xiaxia, '03-headset-studio');
  assert.equal(handle.settings.getScene().titleMode, 'custom');
  assert.equal(handle.settings.getScene().title, '晚间特别节目');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  for (const target of [page, viewer]) {
    const video = target.locator('video.dfy-original-stage-video');
    await video.waitFor();
    await target.waitForFunction(() => {
      const el = document.querySelector('video.dfy-original-stage-video');
      return el?.muted && el.loop && el.currentTime > 0 && el.videoWidth === 1920;
    });
    assert.equal(await target.locator('.dfy-broadcast-art').count(), 0, 'No separate portrait is layered onto an original');
    await target.locator('.dfy-wide-heading').getByText('晚间特别节目', { exact: true }).waitFor();
  }
  await viewer.locator('.dfy-broadcast-caption').waitFor();
  await viewer.locator('.dfy-broadcast-landscape').screenshot({ path: join(artifacts, 'original-stage.png') });
  await stageSettings.click();
  await drawer.getByLabel('命名方式', { exact: true }).selectOption('role');
  await drawer.getByRole('button', { name: '保存舞台设置', exact: true }).click();
  await drawer.getByText('已保存', { exact: true }).waitFor();
  assert.equal(handle.settings.getScene().title, '晚间特别节目');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await viewer.locator('.dfy-wide-heading').getByText('夏夏的直播间', { exact: true }).waitFor();
  const sources = [
    ['01-silver-studio', 'xiaxia'], ['02-night-sofa', 'guyu'],
    ['04-handheld-lounge', 'lubai'], ['03-headset-studio', 'xiaxia'],
  ];
  for (const [id, profileId] of sources) {
    handle.settings.savePersona({ profileId, usageRightConfirmed: true });
    const chosen = handle.settings.getScene().roleScenes;
    handle.settings.saveScene({ roleScenes: { ...chosen, [profileId]: id } });
    await viewer.waitForFunction((id) => {
      const video = document.querySelector('video.dfy-original-stage-video');
      return video?.src.includes(id) && !video.paused && video.currentTime > 0;
    }, id);
    sampleLevel = 0;
    await waitForMouth(viewer, false);
    sampleLevel = .9;
    const pixelsHandle = await viewer.waitForFunction(() => {
      const video = document.querySelector('video.dfy-original-stage-video');
      const overlay = document.querySelector('.dfy-original-stage-mouth');
      const data = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
      let minX = overlay.width, minY = overlay.height, maxX = 0, maxY = 0, touched = 0;
      for (let y = 0; y < overlay.height; y++) for (let x = 0; x < overlay.width; x++) {
        if (data[(y * overlay.width + x) * 4 + 3] < 16) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); touched += 1;
      }
      if (touched <= 120) return false;
      const w = 148, h = 96, left = Math.round((minX + maxX - w) / 2), top = Math.round((minY + maxY - h) / 2);
      const clip = document.createElement('canvas');
      clip.width = w * 4; clip.height = h * 2;
      const ctx = clip.getContext('2d');
      ctx.drawImage(video, left, top, w, h, 0, 0, w * 2, h * 2);
      ctx.drawImage(video, left, top, w, h, w * 2, 0, w * 2, h * 2);
      ctx.drawImage(overlay, left, top, w, h, w * 2, 0, w * 2, h * 2);
      const raw = ctx.getImageData(0, 0, w * 2, h * 2).data;
      const driven = ctx.getImageData(w * 2, 0, w * 2, h * 2).data;
      let opened = 0;
      for (let i = 0; i < raw.length; i += 4) {
        if (raw[i] + raw[i + 1] + raw[i + 2] - driven[i] - driven[i + 1] - driven[i + 2] > 96) opened++;
      }
      return opened > 30 && { touched, opened, image: clip.toDataURL('image/png').split(',')[1] };
    });
    const pixels = await pixelsHandle.jsonValue();
    await pixelsHandle.dispose();
    assert.ok(pixels.touched < 14_000, `${id}: only the lip patch should be painted, got ${pixels.touched}`);
    writeFileSync(join(artifacts, id + '-mouth.png'), Buffer.from(pixels.image, 'base64'));
  }
  handle.live.session.emergencyStop();
  await viewer.getByText('播出已暂停', { exact: true }).waitFor();
  assert.equal(await viewer.locator('.dfy-wide-panel').count(), 0);
  assert.equal(await viewer.locator('video.dfy-original-stage-video').count(), 0);
  assert.equal(await viewer.locator('.dfy-broadcast-caption').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['right drawer and settings save', 'role and custom room titles', 'host-scoped scenes', 'recorded speech drives local lips', 'four original scenes drive and reset lip patches', 'responsive settings', 'three themes', '16:9 sizing', 'mobile fit', 'independent output', 'subtitles', 'chat and gift transport', 'gift alert', 'portrait matte and pet in room backdrop', 'hide chat', 'portrait letterbox', 'emergency stop'], artifacts }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(0, 4000));
  }
  throw error;
} finally {
  clearInterval(timer);
  await browser?.close();
  output.dispose(); handle.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
